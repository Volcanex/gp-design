/**
 * MSDF atlas + pipeline + glyph-quad rendering, extracted out of core.text so
 * core.scene's text objects can draw strings into an ALREADY-OPEN render
 * pass (core.text historically opened its own pass per render(); scene.ts
 * needs many heterogeneous draws, shape/text/image, sharing one pass on one
 * target). text.ts now wraps this as a thin SourceInstance; this module owns
 * the atlas fetch, the MSDF pipeline, and per-string vertex-buffer geometry
 * (keyed by string: geometry is pen-space and size-independent, ../builtin/
 * text-layout.ts's doc comment explains why).
 *
 * Transform: reuses transform2d.ts's formula (TRANSFORM_VS_BODY) verbatim so
 * a text object's on-screen position always agrees with hitTest's inverse
 * transform. The uniform struct here duplicates that layout's first five
 * fields (resolution/anchor/translate/scale/rotation) by NAME, not by
 * shared WGSL text, because it needs a real `screenPxRange` field in that
 * slot for the fragment shader. Keep this struct's field order in sync
 * with scene-transform-uniform.ts's TRANSFORM_WGSL_FIELDS if that changes.
 */

import { TRANSFORM_VS_BODY } from './scene-transform-uniform';
import { layoutText, quadsToVertexData, type BmFontData } from './text-layout';

export interface TextDrawOptions {
  /** Doc-space position of the anchor point (transform2d.ts convention). */
  translate: readonly [number, number];
  /** Anchor point in CONTENT-BOX px (final glyph-run size, before
   * extraScale), what contentBoxOf-based callers naturally have. draw()
   * converts to pen-space internally: the shared TRANSFORM_VS_BODY subtracts
   * the anchor from pen-space localPos BEFORE scaling, so a box-px anchor
   * passed straight through got multiplied by size/atlasSize a second time:
   * invisible near the atlas's baked size (42), but a size-120 text
   * drifted ~120px up-left of its transform (the live bug this fixed). */
  anchorLocal: readonly [number, number];
  /** Font size in px; combined with the atlas's baked size for the final scale. */
  size: number;
  color: readonly [number, number, number, number];
  /** Extra multiplier on top of the size/atlas-size scale (object scaleX/scaleY). Default [1,1]. */
  extraScale?: readonly [number, number];
  rotation?: number;
}

export interface TextGpu {
  readonly ready: Promise<void>;
  isReady(): boolean;
  draw(rp: GPURenderPassEncoder, targetWidth: number, targetHeight: number, text: string, opts: TextDrawOptions): void;
  dispose(): void;
}

const shaderWgsl = `
struct Uniforms {
  resolution: vec2f,
  anchor: vec2f,
  translate: vec2f,
  scale: vec2f,
  rotation: f32,
  screenPxRange: f32,
  _pad0: f32,
  _pad1: f32,
  color: vec4f,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var atlasSamp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@location(0) localPos: vec2f, @location(1) uv: vec2f) -> VSOut {
  ${TRANSFORM_VS_BODY}
  var out: VSOut;
  out.pos = clip;
  out.uv = uv;
  return out;
}

fn median3(v: vec3f) -> f32 {
  return max(min(v.x, v.y), min(max(v.x, v.y), v.z));
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let s = textureSample(atlasTex, atlasSamp, in.uv);
  let sd = median3(s.rgb);
  let dist = (sd - 0.5) * u.screenPxRange;
  let alpha = clamp(dist + 0.5, 0.0, 1.0);
  return vec4f(u.color.rgb, u.color.a * alpha);
}
`;

const UNIFORM_SIZE = 64;
const VERTEX_STRIDE = 16; // (pos.xy, uv.xy) as float32x2 + float32x2

export function createTextGpu(device: GPUDevice, atlasBasePath = '/assets/msdf/jetbrains-mono'): TextGpu {
  let atlasTexture: GPUTexture | null = null;
  let atlasView: GPUTextureView | null = null;
  let font: BmFontData | null = null;
  let sampler: GPUSampler | null = null;
  let pipeline: GPURenderPipeline | null = null;
  let uniformBuffer: GPUBuffer | null = null;
  let bindGroup: GPUBindGroup | null = null;

  // LRU-capped: unbounded, this map kept a GPUBuffer per unique string ever
  // rendered. Live-edited/animated text leaked geometry for the session.
  // Map iteration order is insertion order; hits re-insert to mark recency.
  const geometry = new Map<string, { buffer: GPUBuffer; vertexCount: number }>();
  const GEOMETRY_CACHE_MAX = 256;

  const ready = (async () => {
    const [atlasResp, fontResp] = await Promise.all([
      fetch(`${atlasBasePath}/atlas.png`),
      fetch(`${atlasBasePath}/font.json`),
    ]);
    if (!atlasResp.ok || !fontResp.ok) {
      throw new Error(`text-gpu: failed to load atlas (${atlasResp.status}/${fontResp.status})`);
    }
    const [blob, fontJson] = await Promise.all([atlasResp.blob(), fontResp.json()]);
    font = fontJson as BmFontData;

    const bitmap = await createImageBitmap(blob);
    atlasTexture = device.createTexture({
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: atlasTexture }, [bitmap.width, bitmap.height]);
    atlasView = atlasTexture.createView();

    sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const module = device.createShaderModule({ code: shaderWgsl });
    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: VERTEX_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'float32x2' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float', blend: undefined }] },
    });

    uniformBuffer = device.createBuffer({ size: UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: atlasView },
        { binding: 2, resource: sampler },
      ],
    });
  })();
  ready.catch((err) => console.error(err));

  function ensureGeometry(str: string): { buffer: GPUBuffer; vertexCount: number } | null {
    const cached = geometry.get(str);
    if (cached) {
      geometry.delete(str);
      geometry.set(str, cached);
      return cached;
    }
    if (geometry.size >= GEOMETRY_CACHE_MAX) {
      const [oldestKey, oldest] = geometry.entries().next().value!;
      geometry.delete(oldestKey);
      // The evicted buffer may have been drawn into a not-yet-submitted
      // encoder this frame (scene text draws share one open pass).
      // Destroying it now would invalidate those commands. Defer until the
      // queue has consumed everything currently in flight.
      device.queue.onSubmittedWorkDone().then(() => oldest.buffer.destroy());
    }
    const quads = layoutText(font!, str);
    const vertexCount = quads.length * 6;
    if (vertexCount === 0) return null;
    const data = quadsToVertexData(quads);
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    const entry = { buffer, vertexCount };
    geometry.set(str, entry);
    return entry;
  }

  return {
    ready,
    isReady() {
      return !!(font && pipeline && bindGroup && atlasTexture);
    },
    draw(rp, targetWidth, targetHeight, text, opts) {
      if (!this.isReady()) return;
      const g = ensureGeometry(text);
      if (!g) return;

      const scale = opts.size / font!.info.size;
      const extraScale = opts.extraScale ?? [1, 1];
      const uniformData = new ArrayBuffer(UNIFORM_SIZE);
      const view = new DataView(uniformData);
      view.setFloat32(0, targetWidth, true);
      view.setFloat32(4, targetHeight, true);
      // Box-px anchor -> pen-space (see TextDrawOptions.anchorLocal): the
      // vertex body subtracts it from pen-space localPos before scaling.
      view.setFloat32(8, opts.anchorLocal[0] / scale, true);
      view.setFloat32(12, opts.anchorLocal[1] / scale, true);
      view.setFloat32(16, opts.translate[0], true);
      view.setFloat32(20, opts.translate[1], true);
      view.setFloat32(24, scale * extraScale[0], true);
      view.setFloat32(28, scale * extraScale[1], true);
      view.setFloat32(32, opts.rotation ?? 0, true);
      view.setFloat32(36, font!.distanceField.distanceRange * scale, true);
      view.setFloat32(48, opts.color[0], true);
      view.setFloat32(52, opts.color[1], true);
      view.setFloat32(56, opts.color[2], true);
      view.setFloat32(60, opts.color[3], true);
      device.queue.writeBuffer(uniformBuffer!, 0, uniformData);

      rp.setPipeline(pipeline!);
      rp.setBindGroup(0, bindGroup!);
      rp.setVertexBuffer(0, g.buffer);
      rp.draw(g.vertexCount);
    },
    dispose() {
      for (const g of geometry.values()) g.buffer.destroy();
      geometry.clear();
      uniformBuffer?.destroy();
      atlasTexture?.destroy();
    },
  };
}
