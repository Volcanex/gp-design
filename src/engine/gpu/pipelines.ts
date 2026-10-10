/**
 * Pass wgsl bodies are fragment/compute-only text; this assembles the full
 * shader module around them and caches the resulting pipeline. Pipeline
 * layout is built explicitly from bindings.ts's layoutFor (not `layout:
 * 'auto'`) so the layout is guaranteed to match the bind groups the executor
 * builds via bindings.ts's groupsFor. See bindings.ts header for why that's
 * safe across separately-created layout objects.
 *
 * Convention owned by this file (pass.ts only specifies bindings, not entry
 * points): a render pass's wgsl exports `fn fs_main(in: VSOut) -> @location(0)
 * vec4f`; a compute pass's wgsl exports `fn cs_main(@builtin(global_invocation_id)
 * id: vec3u)`.
 */

import type { PassDescriptor } from '../passes/pass';
import type { CreatePipelineCache, PipelineCache } from './interfaces';
import { createBindings } from './bindings';

const FULLSCREEN_TRIANGLE_VERTEX_WGSL = `
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
`;

/**
 * Binding declarations are derived from the descriptor here, mirroring
 * bindings.ts's layoutFor order exactly: group(0) engine+params uniforms,
 * group(1) (inputN, sampN) pairs for declared inputs then asset params
 * (sorted keys), group(2) compute output. Pass WGSL references these names.
 */
const bindingDeclsWgsl = (desc: PassDescriptor): string => {
  const lines = [
    '@group(0) @binding(0) var<uniform> engine: Engine;',
    '@group(0) @binding(1) var<uniform> params: Params;',
  ];
  const assetCount = Object.keys(desc.params)
    .sort()
    .filter((k) => desc.params[k]!.kind === 'asset').length;
  const totalInputs = desc.inputs.length + assetCount;
  for (let i = 0; i < totalInputs; i++) {
    lines.push(`@group(1) @binding(${i * 2}) var input${i}: texture_2d<f32>;`);
    lines.push(`@group(1) @binding(${i * 2 + 1}) var samp${i}: sampler;`);
  }
  if (desc.kind === 'compute') {
    lines.push('@group(2) @binding(0) var out_tex: texture_storage_2d<rgba16float, write>;');
  }
  return lines.join('\n');
};

const assembleRender = (desc: PassDescriptor, extraWgsl: string): string =>
  `${FULLSCREEN_TRIANGLE_VERTEX_WGSL}\n${extraWgsl}\n${bindingDeclsWgsl(desc)}\n${desc.wgsl}`;

const assembleCompute = (desc: PassDescriptor, extraWgsl: string): string =>
  `${extraWgsl}\n${bindingDeclsWgsl(desc)}\n${desc.wgsl}`;

export const createPipelineCache: CreatePipelineCache = (device: GPUDevice): PipelineCache => {
  const bindings = createBindings(device);
  const renderCache = new Map<string, GPURenderPipeline>();
  const computeCache = new Map<string, GPUComputePipeline>();

  return {
    render(desc, target, variantKey, extraWgsl) {
      const key = `${desc.id}:${target}:${variantKey}`;
      let pipeline = renderCache.get(key);
      if (pipeline) return pipeline;

      const module = device.createShaderModule({ code: assembleRender(desc, extraWgsl) });
      const layout = device.createPipelineLayout({ bindGroupLayouts: bindings.layoutFor(desc) });
      pipeline = device.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: target }] },
        // No blend state, no depth: compositing/blending is a distinct pass step.
      });
      renderCache.set(key, pipeline);
      return pipeline;
    },

    compute(desc, variantKey, extraWgsl) {
      const key = `${desc.id}::${variantKey}`;
      let pipeline = computeCache.get(key);
      if (pipeline) return pipeline;

      const module = device.createShaderModule({ code: assembleCompute(desc, extraWgsl) });
      const layout = device.createPipelineLayout({ bindGroupLayouts: bindings.layoutFor(desc) });
      pipeline = device.createComputePipeline({
        layout,
        compute: { module, entryPoint: 'cs_main' },
      });
      computeCache.set(key, pipeline);
      return pipeline;
    },
  };
};
