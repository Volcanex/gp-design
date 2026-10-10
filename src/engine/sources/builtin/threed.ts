import type { SourceDescriptor, SourceInstance, SourceCreateContext, FrameContext } from '../source';
import type { ResolvedParams } from '../../params/schema';
import type { PooledBuffer } from '../../gpu/pool';
import { generateCube, generateTorus, generateIcosphere, type MeshData } from './mesh-gen';

/**
 * core.3d: a 3D scene is just a Source. Depth is entirely internal: the
 * instance owns a depth24plus texture for its own render pass, and hands
 * the compositor a flat OKLab colour buffer (alpha 0 background, alpha 1
 * on the mesh). No depth ever leaves this file; layer chains (dither etc.)
 * apply to the flattened result like any other source.
 */

export interface ThreeDParams extends ResolvedParams {
  model: string;
  spin: number;
  fov: number;
  distance: number;
  colorA: readonly [number, number, number, number];
  colorB: readonly [number, number, number, number];
  light: readonly [number, number, number];
}

type Mat4 = Float32Array; // column-major, 16 elements

function matMultiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function rotationY(theta: number): Mat4 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // prettier-ignore
  return new Float32Array([
     c, 0, -s, 0,
     0, 1,  0, 0,
     s, 0,  c, 0,
     0, 0,  0, 1,
  ]);
}

function lookAt(eye: [number, number, number], target: [number, number, number], up: [number, number, number]): Mat4 {
  const sub = (a: number[], b: number[]): [number, number, number] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
  const norm = (v: [number, number, number]): [number, number, number] => {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  };
  const cross = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: [number, number, number], b: [number, number, number]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);

  // prettier-ignore
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

/** Vertical-fov perspective, WebGPU clip space (z in [0,1]). */
function perspective(fovYRadians: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (near * far) / (near - far), 0,
  ]);
}

const shaderWgsl = `
struct Uniforms {
  mvp: mat4x4f,
  rot: mat4x4f,
  light: vec4f,
  colorA: vec4f,
  colorB: vec4f,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) normalWorld: vec3f,
}

@vertex
fn vs_main(@location(0) localPos: vec3f, @location(1) localNormal: vec3f) -> VSOut {
  var out: VSOut;
  out.pos = u.mvp * vec4f(localPos, 1.0);
  out.normalWorld = normalize((u.rot * vec4f(localNormal, 0.0)).xyz);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let n = normalize(in.normalWorld);
  let l = normalize(u.light.xyz);
  let ndl = dot(n, l);
  // Half-lambert: softens the terminator so the unlit side isn't pure colorB.
  let half = ndl * 0.5 + 0.5;
  let lab = mix(u.colorB.xyz, u.colorA.xyz, clamp(half, 0.0, 1.0));
  return vec4f(lab, 1.0);
}
`;

const UNIFORM_SIZE = 64 + 64 + 16 + 16 + 16; // mvp + rot + light + colorA + colorB

// Warm (orange-ish, +a/+b) vs cool (blue-ish, -b) OKLab defaults.
const DEFAULT_COLOR_A: readonly [number, number, number, number] = [0.75, 0.09, 0.12, 1];
const DEFAULT_COLOR_B: readonly [number, number, number, number] = [0.55, -0.02, -0.16, 1];

function meshFor(model: string): MeshData {
  switch (model) {
    case 'torus':
      return generateTorus();
    case 'icosphere':
      return generateIcosphere();
    case 'cube':
    default:
      return generateCube();
  }
}

function clearOnly(encoder: GPUCommandEncoder, target: PooledBuffer): void {
  const rp = encoder.beginRenderPass({
    colorAttachments: [{ view: target.view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
  });
  rp.end();
}

export const threed: SourceDescriptor = {
  id: 'core.3d',
  label: '3D',
  params: {
    model: { kind: 'enum', default: 'cube', options: ['cube', 'torus', 'icosphere'] },
    spin: { kind: 'float', default: 0.5, min: 0, max: 4, unit: 'rev/sec', animatable: true },
    fov: { kind: 'float', default: 50, min: 20, max: 120 },
    distance: { kind: 'float', default: 3, min: 1, max: 10 },
    colorA: { kind: 'color', default: DEFAULT_COLOR_A, space: 'oklab' },
    colorB: { kind: 'color', default: DEFAULT_COLOR_B, space: 'oklab' },
    light: { kind: 'vec3', default: [0.5, 0.8, 0.3] },
  },
  liveByDefault: true,
  create(ctx: SourceCreateContext): SourceInstance {
    const device = ctx.device;

    const module = device.createShaderModule({ code: shaderWgsl });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float', blend: undefined }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    const uniformBuffer = device.createBuffer({ size: UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });

    // Meshes are static per model: generate once, cache by name.
    const meshCache = new Map<string, { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; indexCount: number }>();
    function getMesh(model: string): { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; indexCount: number } {
      const cached = meshCache.get(model);
      if (cached) return cached;
      const mesh = meshFor(model);
      const vertexBuffer = device.createBuffer({
        size: mesh.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(vertexBuffer.getMappedRange()).set(mesh.vertices);
      vertexBuffer.unmap();

      const indexBuffer = device.createBuffer({
        size: mesh.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint32Array(indexBuffer.getMappedRange()).set(mesh.indices);
      indexBuffer.unmap();

      const entry = { vertexBuffer, indexBuffer, indexCount: mesh.indexCount };
      meshCache.set(model, entry);
      return entry;
    }

    // Depth buffer is internal to this source, recreated only when the
    // target's dimensions change.
    let depthTexture: GPUTexture | null = null;
    let depthView: GPUTextureView | null = null;
    let depthWidth = 0;
    let depthHeight = 0;
    function ensureDepth(width: number, height: number): GPUTextureView {
      if (depthTexture && depthWidth === width && depthHeight === height) return depthView!;
      depthTexture?.destroy();
      depthTexture = device.createTexture({
        size: [width, height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      depthView = depthTexture.createView();
      depthWidth = width;
      depthHeight = height;
      return depthView;
    }

    return {
      render(frameCtx: FrameContext, params: ResolvedParams, target: PooledBuffer) {
        const p = params as unknown as ThreeDParams;
        const { vertexBuffer, indexBuffer, indexCount } = getMesh(p.model);
        const depth = ensureDepth(target.key.width, target.key.height);

        const rotation = frameCtx.time * p.spin * Math.PI * 2;
        const model = rotationY(rotation);
        const view = lookAt([0, 0, p.distance], [0, 0, 0], [0, 1, 0]);
        const aspect = target.key.width / target.key.height;
        const proj = perspective((p.fov * Math.PI) / 180, aspect, 0.1, 100);
        const mvp = matMultiply(proj, matMultiply(view, model));

        const uniformData = new ArrayBuffer(UNIFORM_SIZE);
        new Float32Array(uniformData, 0, 16).set(mvp);
        new Float32Array(uniformData, 64, 16).set(model);
        const view4 = new Float32Array(uniformData, 128, 4);
        view4.set([p.light[0], p.light[1], p.light[2], 0]);
        new Float32Array(uniformData, 144, 4).set(p.colorA);
        new Float32Array(uniformData, 160, 4).set(p.colorB);
        frameCtx.device.queue.writeBuffer(uniformBuffer, 0, uniformData);

        if (indexCount === 0) {
          clearOnly(frameCtx.encoder, target);
          return;
        }

        const rp = frameCtx.encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
          depthStencilAttachment: { view: depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        });
        rp.setPipeline(pipeline);
        rp.setBindGroup(0, bindGroup);
        rp.setVertexBuffer(0, vertexBuffer);
        rp.setIndexBuffer(indexBuffer, 'uint32');
        rp.drawIndexed(indexCount);
        rp.end();
      },
      dispose() {
        uniformBuffer.destroy();
        depthTexture?.destroy();
        for (const { vertexBuffer, indexBuffer } of meshCache.values()) {
          vertexBuffer.destroy();
          indexBuffer.destroy();
        }
      },
    };
  },
};
