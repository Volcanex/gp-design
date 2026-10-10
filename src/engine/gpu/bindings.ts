/**
 * Derives bind group layouts + bind groups from the fixed convention in
 * passes/pass.ts. Explicit (non-'auto') layouts are used deliberately: two
 * GPUBindGroupLayout objects created with identical descriptors are
 * spec-compatible even though they're different JS objects, so pipelines.ts
 * (which builds its GPUPipelineLayout from this same layoutFor) and the
 * executor (which builds bind groups from groupsFor) never need to share an
 * object reference, only the same derivation logic, which lives here.
 */

import type { PassDescriptor, PassInputDecl } from '../passes/pass';
import type { BindingsFactory } from './interfaces';
import type { PooledBuffer } from './pool';
import { ENGINE_STRUCT_SIZE } from './params-ubo';

const stageFor = (desc: PassDescriptor): GPUShaderStageFlags =>
  desc.kind === 'compute' ? GPUShaderStage.COMPUTE : GPUShaderStage.FRAGMENT;

const samplerTypeFor = (filter: PassInputDecl['filter']): GPUSamplerBindingType =>
  filter === 'nearest' ? 'non-filtering' : 'filtering';

const samplerDescFor = (filter: PassInputDecl['filter']): GPUSamplerDescriptor =>
  filter === 'nearest'
    ? { magFilter: 'nearest', minFilter: 'nearest' }
    : { magFilter: 'linear', minFilter: 'linear' };

/** Asset-kind params are texture bindings appended after declared inputs, in schema key order. */
function assetInputsOf(desc: PassDescriptor): PassInputDecl[] {
  return Object.keys(desc.params)
    .filter((k) => desc.params[k]!.kind === 'asset')
    .sort()
    .map((k) => ({ name: k, filter: 'linear' as const }));
}

export function createBindings(device: GPUDevice): BindingsFactory {
  const samplers = new Map<string, GPUSampler>();
  const samplerFor = (filter: PassInputDecl['filter']): GPUSampler => {
    const key = filter ?? 'linear';
    let s = samplers.get(key);
    if (!s) {
      s = device.createSampler(samplerDescFor(filter));
      samplers.set(key, s);
    }
    return s;
  };

  const layoutFor = (desc: PassDescriptor): GPUBindGroupLayout[] => {
      const stage = stageFor(desc);

      const group0 = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: stage, buffer: { type: 'uniform' } },
          { binding: 1, visibility: stage, buffer: { type: 'uniform' } },
        ],
      });

      const allInputs = [...desc.inputs, ...assetInputsOf(desc)];
      const group1Entries: GPUBindGroupLayoutEntry[] = [];
      let binding = 0;
      for (const input of allInputs) {
        group1Entries.push({
          binding: binding++,
          visibility: stage,
          texture: { sampleType: 'float' },
        });
        group1Entries.push({
          binding: binding++,
          visibility: stage,
          sampler: { type: samplerTypeFor(input.filter) },
        });
      }
      const group1 = device.createBindGroupLayout({ entries: group1Entries });

      const layouts = [group0, group1];
      if (desc.kind === 'compute') {
        const group2 = device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.COMPUTE,
              storageTexture: { access: 'write-only', format: 'rgba16float' },
            },
          ],
        });
        layouts.push(group2);
      }
      return layouts;
  };

  const groupsFor = (
      desc: PassDescriptor,
      uniforms: GPUBuffer,
      uniformsOffset: number,
      uniformsSize: number,
      inputs: PooledBuffer[],
      computeTarget?: PooledBuffer,
    ): GPUBindGroup[] => {
      const [layout0, layout1, layout2] = layoutFor(desc);

      const group0 = device.createBindGroup({
        layout: layout0!,
        entries: [
          { binding: 0, resource: { buffer: uniforms, offset: uniformsOffset, size: ENGINE_STRUCT_SIZE } },
          {
            // Params live at the NEXT 256-byte slot, not at +ENGINE_STRUCT_SIZE:
            // every buffer-binding offset must independently satisfy the
            // 256-byte uniform alignment. Convention shared with
            // core/frame.ts (PARAMS_SLOT_OFFSET). Keep in sync.
            binding: 1,
            resource: {
              buffer: uniforms,
              offset: uniformsOffset + 256,
              size: uniformsSize - 256,
            },
          },
        ],
      });

      const allInputDecls = [...desc.inputs, ...assetInputsOf(desc)];
      const group1Entries: GPUBindGroupEntry[] = [];
      let binding = 0;
      for (let i = 0; i < allInputDecls.length; i++) {
        const decl = allInputDecls[i]!;
        const buf = inputs[i];
        if (!buf) {
          if (decl.optional) { binding += 2; continue; }
          throw new Error(`bindings.groupsFor: missing required input "${decl.name}" for pass "${desc.id}"`);
        }
        group1Entries.push({ binding: binding++, resource: buf.view });
        group1Entries.push({ binding: binding++, resource: samplerFor(decl.filter) });
      }
      const group1 = device.createBindGroup({ layout: layout1!, entries: group1Entries });

      const groups = [group0, group1];
      if (desc.kind === 'compute') {
        if (!computeTarget) {
          throw new Error(`bindings.groupsFor: compute pass "${desc.id}" requires a computeTarget`);
        }
        groups.push(
          device.createBindGroup({
            layout: layout2!,
            entries: [{ binding: 0, resource: computeTarget.view }],
          }),
        );
      }
      return groups;
  };

  return { layoutFor, groupsFor };
}
