/**
 * The one non-Pass render step: OKLab accumulator -> display. Self-contained
 * on purpose (no wgsl/snippets imports: another track owns those) since this
 * isn't part of the pass registry's group(0)/group(1)/group(2) convention,
 * just a one-shot fullscreen blit with its own bind group layout.
 *
 * present() and toQuantised() share one shader module; only the target
 * format differs (context's presentFormat vs. a pooled rgba8unorm target),
 * so "exported pixels = seen pixels" holds by construction, not by care.
 */

import type { BufferPool, PooledBuffer } from './pool';
import type { CreatePresenter, DeviceBundle, Presenter } from './interfaces';

const BLUE_NOISE_SIZE = 64;
const GOLDEN_RATIO = 0.6180339887498949;

// Interleaved gradient noise (Jimenez 2014): cheap, good spectral properties
// for ordered dithering, no need to ship an actual blue-noise texture asset.
function interleavedGradientNoise(x: number, y: number): number {
  const v = 52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1);
  return v - Math.floor(v);
}

function buildBlueNoiseTexture(device: GPUDevice): GPUTexture {
  const size = BLUE_NOISE_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Slightly decorrelated per channel so RGB don't dither in lockstep.
      const r = interleavedGradientNoise(x, y);
      const g = interleavedGradientNoise(x + 17, y + 29);
      const b = interleavedGradientNoise(x + 41, y + 7);
      data[i] = Math.round(r * 255);
      data[i + 1] = Math.round(g * 255);
      data[i + 2] = Math.round(b * 255);
      data[i + 3] = 255;
    }
  }
  const texture = device.createTexture({
    size: [size, size],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: size * 4, rowsPerImage: size },
    [size, size],
  );
  return texture;
}

/**
 * Linear sRGB -> linear Display P3, both D65. Derived by composing the
 * standard linear-sRGB -> CIE XYZ (D65) matrix with the standard
 * CIE XYZ (D65) -> linear-P3 matrix (no chromatic adaptation needed: same
 * white point on both sides). Result is the well-known combined constant.
 */
const OKLAB_TO_LINEAR_AND_P3_WGSL = `
fn oklab_to_linear_srgb(lab: vec3f) -> vec3f {
  let l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  let m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  let s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  );
}

fn linear_srgb_to_linear_p3(c: vec3f) -> vec3f {
  return vec3f(
    dot(c, vec3f(0.8224621, 0.1775380, 0.0000001)),
    dot(c, vec3f(0.0331941, 0.9668058, 0.0000001)),
    dot(c, vec3f(0.0170827, 0.0723974, 0.9105199)),
  );
}

fn srgb_transfer_encode(c: vec3f) -> vec3f {
  let clamped = clamp(c, vec3f(0.0), vec3f(1.0));
  let lo = clamped * 12.92;
  let hi = 1.055 * pow(clamped, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, clamped <= vec3f(0.0031308));
}
`;

const PRESENT_WGSL = `
${OKLAB_TO_LINEAR_AND_P3_WGSL}

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs_main(@builtin(vertex_index) idx: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut;
  out.pos = vec4f(p[idx], 0.0, 1.0);
  out.uv = p[idx] * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
  return out;
}

struct PresentUniform {
  ditherOffset: vec2f,
  useP3: u32,
  _pad: u32,
}

@group(0) @binding(0) var accumSampler: sampler;
@group(0) @binding(1) var accumTexture: texture_2d<f32>;
@group(0) @binding(2) var noiseSampler: sampler;
@group(0) @binding(3) var noiseTexture: texture_2d<f32>;
@group(0) @binding(4) var<uniform> u: PresentUniform;

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let oklab = textureSample(accumTexture, accumSampler, in.uv);
  var linear = oklab_to_linear_srgb(oklab.rgb);
  if (u.useP3 != 0u) {
    linear = linear_srgb_to_linear_p3(linear);
  }

  // Blue-noise texture tiles at BLUE_NOISE_SIZE px; wrap sampler handles the tiling.
  let noiseUv = in.pos.xy / ${BLUE_NOISE_SIZE}.0 + u.ditherOffset;
  let noise = textureSample(noiseTexture, noiseSampler, noiseUv).rgb;
  let dither = (noise - vec3f(0.5)) / 255.0;

  let encoded = srgb_transfer_encode(linear + dither);
  return vec4f(encoded, oklab.a);
}
`;

export const createPresenter: CreatePresenter = (bundle: DeviceBundle, pool: BufferPool): Presenter => {
  const device = bundle.device;
  const module = device.createShaderModule({ code: PRESENT_WGSL });

  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });

  const pipelineFor = (() => {
    const cache = new Map<GPUTextureFormat, GPURenderPipeline>();
    return (target: GPUTextureFormat): GPURenderPipeline => {
      let pipeline = cache.get(target);
      if (pipeline) return pipeline;
      pipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: target }] },
      });
      cache.set(target, pipeline);
      return pipeline;
    };
  })();

  const accumSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const noiseSampler = device.createSampler({
    magFilter: 'nearest',
    minFilter: 'nearest',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
  const noiseTexture = buildBlueNoiseTexture(device);
  const noiseView = noiseTexture.createView();

  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const outputColorSpace = (): 'srgb' | 'display-p3' =>
    bundle.context?.getConfiguration()?.colorSpace ?? 'srgb';

  const writeUniform = (frame: number) => {
    const offset = (frame * GOLDEN_RATIO) % 1;
    const data = new ArrayBuffer(16);
    const view = new DataView(data);
    view.setFloat32(0, offset, true);
    view.setFloat32(4, offset, true);
    view.setUint32(8, outputColorSpace() === 'display-p3' ? 1 : 0, true);
    view.setUint32(12, 0, true);
    device.queue.writeBuffer(uniformBuffer, 0, data);
  };

  const draw = (accumulator: PooledBuffer, targetView: GPUTextureView, target: GPUTextureFormat, frame: number) => {
    writeUniform(frame);
    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: accumSampler },
        { binding: 1, resource: accumulator.view },
        { binding: 2, resource: noiseSampler },
        { binding: 3, resource: noiseView },
        { binding: 4, resource: { buffer: uniformBuffer } },
      ],
    });
    const enc = device.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store' }],
    });
    rp.setPipeline(pipelineFor(target));
    rp.setBindGroup(0, bindGroup);
    rp.draw(3);
    rp.end();
    device.queue.submit([enc.finish()]);
  };

  return {
    present(accumulator, _time, frame) {
      if (!bundle.context) return; // headless: nothing to present to
      const target = bundle.context.getCurrentTexture();
      draw(accumulator, target.createView(), bundle.presentFormat, frame);
    },

    toQuantised(accumulator, quantPool) {
      const out = quantPool.borrow({
        width: accumulator.key.width,
        height: accumulator.key.height,
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
      draw(accumulator, out.view, 'rgba8unorm', 0);
      return out;
    },
  };
};
