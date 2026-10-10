/**
 * Schema -> WGSL `struct Params` text + std140-compatible packed bytes.
 * Field order is sorted keys (deterministic across struct text and packing).
 * `asset` params are texture bindings (group(1)), not uniforms. Skipped here.
 */

import type { ParamSpec, ParamsSchema, ResolvedParams } from '../params/schema';

type LaidOutField = {
  key: string;
  spec: ParamSpec;
  wgslType: string;
  offset: number;
  size: number;
};

const alignUp = (n: number, align: number) => Math.ceil(n / align) * align;

/** WGSL uniform alignment rules (align, size), asset excluded by caller. */
function layoutOf(spec: ParamSpec): { align: number; size: number; wgslType: string } {
  switch (spec.kind) {
    case 'float': return { align: 4, size: 4, wgslType: 'f32' };
    case 'int': return { align: 4, size: 4, wgslType: 'i32' };
    case 'bool': return { align: 4, size: 4, wgslType: 'u32' };
    case 'enum': return { align: 4, size: 4, wgslType: 'u32' };
    case 'vec2': return { align: 8, size: 8, wgslType: 'vec2f' };
    case 'vec3': return { align: 16, size: 12, wgslType: 'vec3f' };
    case 'vec4': return { align: 16, size: 16, wgslType: 'vec4f' };
    case 'color': return { align: 16, size: 16, wgslType: 'vec4f' };
    case 'asset': return { align: 0, size: 0, wgslType: '' };
  }
}

function layoutParams(schema: ParamsSchema): { fields: LaidOutField[]; byteSize: number } {
  const keys = Object.keys(schema).filter((k) => schema[k]!.kind !== 'asset').sort();
  const fields: LaidOutField[] = [];
  let cursor = 0;
  for (const key of keys) {
    const spec = schema[key]!;
    const { align, size, wgslType } = layoutOf(spec);
    const offset = alignUp(cursor, align);
    fields.push({ key, spec, wgslType, offset, size });
    cursor = offset + size;
  }
  const byteSize = Math.max(16, alignUp(cursor, 16));
  return { fields, byteSize };
}

export class ParamsUboImpl {
  structWgsl(schema: ParamsSchema): string {
    const { fields } = layoutParams(schema);
    if (fields.length === 0) {
      return 'struct Params {\n  _unused: f32,\n}';
    }
    const lines = fields.map((f) => `  ${f.key}: ${f.wgslType},`);
    return `struct Params {\n${lines.join('\n')}\n}`;
  }

  byteSize(schema: ParamsSchema): number {
    return layoutParams(schema).byteSize;
  }

  pack(schema: ParamsSchema, values: ResolvedParams, out: DataView): void {
    const { fields } = layoutParams(schema);
    for (const f of fields) {
      const value = values[f.key];
      switch (f.spec.kind) {
        case 'float':
          out.setFloat32(f.offset, typeof value === 'number' ? value : f.spec.default, true);
          break;
        case 'int':
          out.setInt32(f.offset, typeof value === 'number' ? value : f.spec.default, true);
          break;
        case 'bool': {
          // Accept 0/1 numbers too: a caller writing `{ invert: flag ? 1 : 0 }`
          // used to silently pack the DEFAULT instead (the mask-invert bug:
          // the toggle flipped the doc but never the render).
          const b = typeof value === 'boolean' ? value
            : typeof value === 'number' ? value !== 0
            : f.spec.default;
          out.setUint32(f.offset, b ? 1 : 0, true);
          break;
        }
        case 'enum': {
          const s = typeof value === 'string' ? value : f.spec.default;
          const idx = f.spec.options.indexOf(s);
          out.setUint32(f.offset, idx >= 0 ? idx : 0, true);
          break;
        }
        case 'vec2':
        case 'vec3':
        case 'vec4': {
          const arr = Array.isArray(value) ? value : f.spec.default;
          const n = f.spec.kind === 'vec2' ? 2 : f.spec.kind === 'vec3' ? 3 : 4;
          for (let i = 0; i < n; i++) out.setFloat32(f.offset + i * 4, (arr[i] as number) ?? 0, true);
          break;
        }
        case 'color': {
          const arr = Array.isArray(value) ? value : f.spec.default;
          for (let i = 0; i < 4; i++) out.setFloat32(f.offset + i * 4, (arr[i] as number) ?? 0, true);
          break;
        }
        case 'asset':
          break;
      }
    }
  }
}

export const paramsUbo = new ParamsUboImpl();

/** group(0) binding(0): fixed 16-byte engine uniform, always at the front of the ring-buffer slot. */
export const engineStructWgsl =
  'struct Engine {\n  time: f32,\n  frame: u32,\n  width: f32,\n  height: f32,\n}';
export const ENGINE_STRUCT_SIZE = 16;

export function packEngineUniform(
  out: DataView,
  time: number,
  frame: number,
  width: number,
  height: number,
  byteOffset = 0,
): void {
  out.setFloat32(byteOffset, time, true);
  out.setUint32(byteOffset + 4, frame >>> 0, true);
  out.setFloat32(byteOffset + 8, width, true);
  out.setFloat32(byteOffset + 12, height, true);
}
