/**
 * core.scene: renders a Layer's ObjectNode[] (document.ts's `sceneObjects`,
 * stored at `layer.source.params['scene']`; schema-less, passed through
 * resolveParams verbatim per the established core.text convention, see
 * text.ts's design note).
 *
 * One open render pass per render() call; every object (shape/text/image/
 * placeholder) draws into it via its own tiny pipeline, in tree order
 * (parents then children, matching doc/object.ts's walkObjects: later =
 * on top, same z-order convention as the layer compositor). Object chains
 * (`node.chain`) are NOT rendered yet. TODO, flagged in the phase report;
 * shipping correct transform + content + style first per the brief.
 *
 * GPU resources (vertex/uniform buffers, image textures) are cached per
 * ObjectId + role so a frame only rewrites uniform data, never
 * creates/destroys GPU objects on the steady-state render path, except
 * when a shape's underlying geometry actually changes (rare; same
 * destroy-old-then-create-new pattern as image.ts's ensureUploaded, safe
 * because it only happens across frames, never mid-frame). Entries for
 * objects deleted from the scene are evicted at the top of each render()
 * (evictDeletedObjects). Disabled objects keep theirs, so visibility
 * toggles don't churn buffers.
 */

import type { SourceDescriptor, SourceInstance, SourceCreateContext, FrameContext } from '../source';
import type { ResolvedParams } from '../../params/schema';
import type { PooledBuffer } from '../../gpu/pool';
import type { AssetJSON, ObjectContent, ObjectNode } from '../../doc/json';
import type { AssetId, ObjectId, Seconds } from '../../core/types';
import { decodeImageAsset, createPlaceholderTexture } from '../../core/image-decode';
import { contentBoxOf, hitTestBox } from '../../core/transform2d';
import { shapePath, fillTriangles, strokeTriangles } from './scene-geometry';
import { TRANSFORM_WGSL_FIELDS, TRANSFORM_VS_BODY, writeTransformUniform } from './scene-transform-uniform';
import { createTextGpu, type TextGpu } from './text-gpu';
import { resolveIncludes } from '../../wgsl/include-impl';

const SHAPE_UNIFORM_SIZE = 64; // 48 (transform) + 16 (color)
const IMAGE_UNIFORM_SIZE = 48; // transform only

const shapeShaderWgsl = `
struct Uniforms {
  ${TRANSFORM_WGSL_FIELDS}
  color: vec4f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs_main(@location(0) localPos: vec2f) -> @builtin(position) vec4f {
  ${TRANSFORM_VS_BODY}
  return clip;
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return u.color;
}
`;

const imageShaderWgsl = `
struct Uniforms {
  ${TRANSFORM_WGSL_FIELDS}
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

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

${resolveIncludes(['oklab', 'srgb'])}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let s = textureSample(tex, samp, in.uv);
  return vec4f(linear_srgb_to_oklab(srgb_decode(s.rgb)), s.a);
}
`;

/** Objects flattened in render order (parent then children), skipping any
 * subtree rooted at a disabled node. */
function flattenEnabled(nodes: ObjectNode[]): ObjectNode[] {
  const out: ObjectNode[] = [];
  const walk = (list: ObjectNode[]) => {
    for (const node of list) {
      if (!node.enabled) continue;
      out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

const DEFAULT_FILL: readonly [number, number, number, number] = [0, 0, 0, 1];
const PLACEHOLDER_FILL: readonly [number, number, number, number] = [0.5, 0, 0, 0.55];

function flatVertexData(flat: number[]): Float32Array {
  return new Float32Array(flat);
}

interface CachedVertexBuffer {
  key: string;
  buffer: GPUBuffer;
  vertexCount: number;
}

interface CachedUniform {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

interface CachedImage {
  assetId: string;
  texture: GPUTexture;
  view: GPUTextureView;
  /** The view drawImage's bindGroup was last built against, compared to
   * `view` each draw so a texture swap (decode landing, or asset changed)
   * rebuilds the bindGroup instead of sampling a stale/destroyed texture. */
  boundView: GPUTextureView | null;
  bindGroup: GPUBindGroup | null;
  uniformBuffer: GPUBuffer | null;
}

export const scene: SourceDescriptor = {
  id: 'core.scene',
  label: 'Scene',
  params: {},
  liveByDefault: true,
  create(ctx: SourceCreateContext): SourceInstance {
    const device = ctx.device;

    let shapePipeline: GPURenderPipeline | null = null;
    let imagePipeline: GPURenderPipeline | null = null;
    const textGpu: TextGpu = createTextGpu(device);

    const vertexCache = new Map<string, CachedVertexBuffer>();
    const shapeUniformCache = new Map<string, CachedUniform>();
    const imageCache = new Map<string, CachedImage>();
    let sharedPlaceholder: { texture: GPUTexture; view: GPUTextureView } | null = null;
    const decodingFor = new Map<string, string>(); // node.id -> asset id currently decoding
    const warnedFor = new Map<string, string>(); // node.id -> asset id last warned about

    let lastNodes: ObjectNode[] = [];

    /** Frees cached GPU resources for objects no longer in the scene (the
     * "never evicted" TODO in the header, now fixed). Walks ALL nodes,
     * disabled included, so toggling visibility doesn't churn buffers; only
     * genuine deletion evicts. Runs at the top of render(), before this
     * frame's pass opens, so nothing destroyed here is referenced by an
     * unsubmitted encoder (last frame's was submitted inside its own scope). */
    function evictDeletedObjects(nodes: ObjectNode[]): void {
      const liveIds = new Set<string>();
      const walk = (list: ObjectNode[]) => {
        for (const node of list) {
          liveIds.add(node.id);
          if (node.children) walk(node.children);
        }
      };
      walk(nodes);

      for (const [key, vb] of vertexCache) {
        if (liveIds.has(key.slice(0, key.lastIndexOf(':')))) continue;
        vb.buffer.destroy();
        vertexCache.delete(key);
      }
      for (const [key, u] of shapeUniformCache) {
        if (liveIds.has(key.slice(0, key.lastIndexOf(':')))) continue;
        u.buffer.destroy();
        shapeUniformCache.delete(key);
      }
      for (const [nodeId, img] of imageCache) {
        if (liveIds.has(nodeId)) continue;
        if (img.texture !== sharedPlaceholder?.texture) img.texture.destroy();
        img.uniformBuffer?.destroy();
        imageCache.delete(nodeId);
      }
      for (const nodeId of decodingFor.keys()) if (!liveIds.has(nodeId)) decodingFor.delete(nodeId);
      for (const nodeId of warnedFor.keys()) if (!liveIds.has(nodeId)) warnedFor.delete(nodeId);
    }

    function ensurePipelines(): void {
      if (shapePipeline && imagePipeline) return;
      const shapeModule = device.createShaderModule({ code: shapeShaderWgsl });
      shapePipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: shapeModule,
          entryPoint: 'vs_main',
          buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
        },
        fragment: { module: shapeModule, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
      });

      const imageModule = device.createShaderModule({ code: imageShaderWgsl });
      imagePipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: imageModule,
          entryPoint: 'vs_main',
          buffers: [
            {
              arrayStride: 16,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32x2' },
              ],
            },
          ],
        },
        fragment: { module: imageModule, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
      });
    }

    /**
     * floatsPerVertex defaults to 2 (shape geometry: x,y; fillTriangles/
     * strokeTriangles' output). The image quad packs x,y,u,v (4 floats/
     * vertex, stride 16 in imageShaderWgsl). Passing the wrong count here
     * doubles vertexCount, which WebGPU's draw-call validation rejects
     * (invalidating the whole command buffer for that submission, so the
     * frame silently falls back to stale/recycled target content; this was
     * the "pasting images flashes" bug, not a caching issue).
     */
    function ensureVertexBuffer(cacheKey: string, dataKey: string, build: () => number[], floatsPerVertex = 2): CachedVertexBuffer | null {
      const cached = vertexCache.get(cacheKey);
      if (cached && cached.key === dataKey) return cached;
      cached?.buffer.destroy();
      const flat = build();
      const vertexCount = flat.length / floatsPerVertex;
      if (vertexCount === 0) {
        vertexCache.delete(cacheKey);
        return null;
      }
      const data = flatVertexData(flat);
      const buffer = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(buffer.getMappedRange()).set(data);
      buffer.unmap();
      const entry: CachedVertexBuffer = { key: dataKey, buffer, vertexCount };
      vertexCache.set(cacheKey, entry);
      return entry;
    }

    function ensureShapeUniform(cacheKey: string): CachedUniform {
      const cached = shapeUniformCache.get(cacheKey);
      if (cached) return cached;
      const buffer = device.createBuffer({ size: SHAPE_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const bindGroup = device.createBindGroup({
        layout: shapePipeline!.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer } }],
      });
      const entry = { buffer, bindGroup };
      shapeUniformCache.set(cacheKey, entry);
      return entry;
    }

    function drawShapeGeometry(
      rp: GPURenderPassEncoder,
      cacheKey: string,
      vb: CachedVertexBuffer,
      resolution: readonly [number, number],
      anchor: readonly [number, number],
      translate: readonly [number, number],
      scale: readonly [number, number],
      rotation: number,
      color: readonly [number, number, number, number],
    ): void {
      const uniform = ensureShapeUniform(cacheKey);
      const data = new ArrayBuffer(SHAPE_UNIFORM_SIZE);
      const view = new DataView(data);
      writeTransformUniform(view, 0, resolution, anchor, translate, scale, rotation);
      view.setFloat32(48, color[0], true);
      view.setFloat32(52, color[1], true);
      view.setFloat32(56, color[2], true);
      view.setFloat32(60, color[3], true);
      device.queue.writeBuffer(uniform.buffer, 0, data);

      rp.setPipeline(shapePipeline!);
      rp.setBindGroup(0, uniform.bindGroup);
      rp.setVertexBuffer(0, vb.buffer);
      rp.draw(vb.vertexCount);
    }

    /** ctx.getAsset() hands back the raw AssetJSON (still-encoded bytes), not
     * a decoded bitmap. Decode is async, so a placeholder is served per node
     * until it lands (and forever, for a missing/wrong-type/undecodable
     * asset: a bad asset must never fail a frame). Shared decode primitives
     * with core.image (core/image-decode.ts); this source keeps its own
     * per-node cache since core.image only ever holds one image at a time. */
    /** Caches a fresh entry pointing at the shared placeholder texture under
     * `nodeId`, so repeated ensureImage() calls for the same still-pending
     * (or still-missing) asset return the same object, and so its
     * bindGroup, once built, isn't rebuilt every frame. */
    function cachePlaceholder(nodeId: string, assetId: string): CachedImage {
      if (!sharedPlaceholder) sharedPlaceholder = createPlaceholderTexture(device);
      const entry: CachedImage = {
        assetId,
        texture: sharedPlaceholder.texture,
        view: sharedPlaceholder.view,
        boundView: null,
        bindGroup: null,
        uniformBuffer: null,
      };
      imageCache.set(nodeId, entry);
      return entry;
    }

    function beginImageDecode(nodeId: string, assetId: string, asset: Extract<AssetJSON, { type: 'image' }>): void {
      if (decodingFor.get(nodeId) === assetId) return;
      decodingFor.set(nodeId, assetId);
      decodeImageAsset(device, asset)
        .then(({ texture, view }) => {
          const prev = imageCache.get(nodeId);
          imageCache.set(nodeId, { assetId, texture, view, boundView: null, bindGroup: null, uniformBuffer: null });
          if (prev) {
            // prev.texture is the SHARED placeholder while this node was
            // pending (cachePlaceholder hands every pending node the same
            // GPUTexture). Destroying it here would invalidate every other
            // node still showing it (any other paste/import still
            // decoding), sampling a destroyed texture next frame. Only a
            // genuinely per-node decoded texture is safe to destroy; the
            // placeholder is only ever destroyed once, in dispose().
            if (prev.texture !== sharedPlaceholder?.texture) prev.texture.destroy();
            prev.uniformBuffer?.destroy();
          }
        })
        .catch((err) => console.warn(`core.scene: image decode failed for asset "${assetId}"`, err))
        .finally(() => {
          if (decodingFor.get(nodeId) === assetId) decodingFor.delete(nodeId);
        });
    }

    /** Never throws: a missing/wrong-type/undecodable asset renders the
     * placeholder and warns once instead of killing the frame. */
    function ensureImage(node: ObjectNode, assetRef: AssetId): CachedImage {
      const key = node.id;
      const existing = imageCache.get(key);
      if (existing && existing.assetId === assetRef) return existing;

      const asset = ctx.getAsset(assetRef) as AssetJSON | undefined;
      if (!asset || asset.type !== 'image') {
        if (warnedFor.get(key) !== assetRef) {
          warnedFor.set(key, assetRef);
          console.warn(
            asset
              ? `core.scene: asset "${assetRef}" has type "${asset.type}", expected "image"`
              : `core.scene: asset "${assetRef}" missing from document`,
          );
        }
        return existing ?? cachePlaceholder(key, assetRef);
      }
      warnedFor.delete(key);
      beginImageDecode(key, assetRef, asset);
      return existing ?? cachePlaceholder(key, '');
    }

    function drawImage(
      rp: GPURenderPassEncoder,
      node: ObjectNode,
      width: number,
      height: number,
      resolution: readonly [number, number],
      anchor: readonly [number, number],
      translate: readonly [number, number],
      scale: readonly [number, number],
      rotation: number,
      assetRef: AssetId,
    ): void {
      const img = ensureImage(node, assetRef);
      // Rebuild the bindGroup whenever the texture view it samples has
      // changed underneath it: a decode landing (or the shared placeholder
      // being created) swaps `view` without necessarily replacing the cache
      // entry object, so an identity check alone would sample a stale view.
      if (!img.uniformBuffer || !img.bindGroup || img.boundView !== img.view) {
        const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        const uniformBuffer = img.uniformBuffer ?? device.createBuffer({ size: IMAGE_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const bindGroup = device.createBindGroup({
          layout: imagePipeline!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: img.view },
            { binding: 2, resource: sampler },
          ],
        });
        img.uniformBuffer = uniformBuffer;
        img.bindGroup = bindGroup;
        img.boundView = img.view;
      }

      const vb = ensureVertexBuffer(`${node.id}:image`, `${width}x${height}`, () => [
        0, 0, 0, 0,
        width, 0, 1, 0,
        width, height, 1, 1,
        0, 0, 0, 0,
        width, height, 1, 1,
        0, height, 0, 1,
      ], 4); // x,y,u,v per vertex, not the shape-geometry default of x,y
      if (!vb) return;

      const data = new ArrayBuffer(IMAGE_UNIFORM_SIZE);
      const view = new DataView(data);
      writeTransformUniform(view, 0, resolution, anchor, translate, scale, rotation);
      device.queue.writeBuffer(img.uniformBuffer, 0, data);

      rp.setPipeline(imagePipeline!);
      rp.setBindGroup(0, img.bindGroup);
      rp.setVertexBuffer(0, vb.buffer);
      rp.draw(vb.vertexCount);
    }

    function drawObject(rp: GPURenderPassEncoder, node: ObjectNode, resolution: readonly [number, number]): void {
      const box = contentBoxOf(node.content, { getAsset: (id) => ctx.getAsset(id) as AssetJSON | undefined });
      const anchor: [number, number] = [node.transform.anchorX * box.width, node.transform.anchorY * box.height];
      const translate: [number, number] = [node.transform.x, node.transform.y];
      const scale: [number, number] = [node.transform.scaleX, node.transform.scaleY];
      const rotation = node.transform.rotation;

      const content: ObjectContent = node.content;
      switch (content.type) {
        case 'shape': {
          const path = shapePath(content.shape);
          const key = JSON.stringify(content.shape);
          if (node.style.fill) {
            const vb = ensureVertexBuffer(`${node.id}:fill`, key, () => fillTriangles(path));
            if (vb) drawShapeGeometry(rp, `${node.id}:fill`, vb, resolution, anchor, translate, scale, rotation, node.style.fill ?? DEFAULT_FILL);
          }
          if (node.style.stroke) {
            const thickness = node.style.strokeWidth ?? 2;
            const strokeKey = `${key}:${thickness}`;
            const vb = ensureVertexBuffer(`${node.id}:stroke`, strokeKey, () => strokeTriangles(path, thickness));
            if (vb) drawShapeGeometry(rp, `${node.id}:stroke`, vb, resolution, anchor, translate, scale, rotation, node.style.stroke);
          }
          break;
        }
        case 'text': {
          textGpu.draw(rp, resolution[0], resolution[1], content.text.text, {
            translate,
            anchorLocal: anchor,
            size: content.text.size,
            color: node.style.fill ?? DEFAULT_FILL,
            extraScale: scale,
            rotation,
          });
          break;
        }
        case 'image': {
          ensurePipelines();
          drawImage(rp, node, box.width, box.height, resolution, anchor, translate, scale, rotation, content.asset);
          break;
        }
        case 'document':
        case 'live': {
          // Stub: nested docs and live components render as a labelled
          // placeholder rect until M8/the live seam lands (per phase brief).
          // TODO: render `content.type`/component name as a text label,
          // punted to keep this phase's scope to transform+content+style.
          const path = shapePath({ shape: 'rect', width: box.width, height: box.height });
          const vb = ensureVertexBuffer(`${node.id}:placeholder`, `${box.width}x${box.height}`, () => fillTriangles(path));
          if (vb) drawShapeGeometry(rp, `${node.id}:placeholder`, vb, resolution, anchor, translate, scale, rotation, PLACEHOLDER_FILL);
          break;
        }
        default: {
          const _exhaustive: never = content;
          return _exhaustive;
        }
      }
    }

    return {
      render(frameCtx: FrameContext, params: ResolvedParams, target: PooledBuffer) {
        ensurePipelines();
        const nodes = ((params as unknown as { scene?: ObjectNode[] }).scene ?? []) as ObjectNode[];
        lastNodes = nodes;
        evictDeletedObjects(nodes);
        const flat = flattenEnabled(nodes);
        const resolution: [number, number] = [target.key.width, target.key.height];

        const rp = frameCtx.encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
        });
        for (const node of flat) drawObject(rp, node, resolution);
        rp.end();
      },

      hitTest(x: number, y: number, _time: Seconds): ObjectId | null {
        const flat = flattenEnabled(lastNodes);
        for (let i = flat.length - 1; i >= 0; i -= 1) {
          const node = flat[i]!;
          const box = contentBoxOf(node.content, { getAsset: (id) => ctx.getAsset(id) as AssetJSON | undefined });
          if (hitTestBox([x, y], node.transform, box)) return node.id;
        }
        return null;
      },

      dispose() {
        for (const vb of vertexCache.values()) vb.buffer.destroy();
        for (const u of shapeUniformCache.values()) u.buffer.destroy();
        // Multiple nodes can share the placeholder texture (cachePlaceholder):
        // destroy each node's own decoded texture, but the placeholder
        // only once.
        for (const img of imageCache.values()) {
          if (img.texture !== sharedPlaceholder?.texture) img.texture.destroy();
          img.uniformBuffer?.destroy();
        }
        sharedPlaceholder?.texture.destroy();
        sharedPlaceholder = null;
        textGpu.dispose();
      },
    };
  },
};
