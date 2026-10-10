import { describe, expect, it } from 'vitest';
import { paramsUbo } from '../../src/engine/gpu/params-ubo';
import type { ParamsSchema, ResolvedParams } from '../../src/engine/params/schema';

// Sorted key order: amount, colour, enabled, mode, tint
const schema: ParamsSchema = {
  mode: { kind: 'enum', default: 'a', options: ['a', 'b', 'c'] },
  amount: { kind: 'float', default: 1 },
  enabled: { kind: 'bool', default: false },
  tint: { kind: 'vec3', default: [0, 0, 0] },
  colour: { kind: 'color', default: [0, 0, 0, 1] },
};

describe('ParamsUbo', () => {
  it('emits deterministic struct text in sorted key order', () => {
    const text = paramsUbo.structWgsl(schema);
    expect(text).toBe(
      'struct Params {\n' +
      '  amount: f32,\n' +
      '  colour: vec4f,\n' +
      '  enabled: u32,\n' +
      '  mode: u32,\n' +
      '  tint: vec3f,\n' +
      '}',
    );
  });

  it('lays out offsets per WGSL uniform alignment and pads size to 16', () => {
    // amount(f32 @0,size4) colour(vec4f align16 -> @16,size16) enabled(u32 @32,size4)
    // mode(u32 @36,size4) tint(vec3f align16 -> @48,size12) -> cursor 60 -> padded 64
    const size = paramsUbo.byteSize(schema);
    expect(size).toBe(64);

    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    const values: ResolvedParams = {
      amount: 2.5,
      colour: [0.1, 0.2, 0.3, 1],
      enabled: true,
      mode: 'c',
      tint: [1, 2, 3],
    };
    paramsUbo.pack(schema, values, view);

    expect(view.getFloat32(0, true)).toBeCloseTo(2.5);
    expect(view.getFloat32(16, true)).toBeCloseTo(0.1);
    expect(view.getFloat32(20, true)).toBeCloseTo(0.2);
    expect(view.getFloat32(24, true)).toBeCloseTo(0.3);
    expect(view.getFloat32(28, true)).toBeCloseTo(1);
    expect(view.getUint32(32, true)).toBe(1); // enabled -> true
    expect(view.getUint32(36, true)).toBe(2); // mode 'c' -> index 2
    expect(view.getFloat32(48, true)).toBeCloseTo(1);
    expect(view.getFloat32(52, true)).toBeCloseTo(2);
    expect(view.getFloat32(56, true)).toBeCloseTo(3);
  });

  it('skips asset params entirely (texture binding, not a uniform)', () => {
    const withAsset: ParamsSchema = {
      ...schema,
      logo: { kind: 'asset', assetType: 'image' },
    };
    expect(paramsUbo.byteSize(withAsset)).toBe(paramsUbo.byteSize(schema));
    expect(paramsUbo.structWgsl(withAsset)).not.toContain('logo');
  });

  it('never emits a zero-byte struct for an empty schema', () => {
    expect(paramsUbo.byteSize({})).toBe(16);
    expect(paramsUbo.structWgsl({})).toContain('struct Params {');
  });

  it('packs a 0/1 NUMBER into a bool field (not the default): the mask-invert regression', () => {
    const boolOnly: ParamsSchema = { invert: { kind: 'bool', default: false } };
    const size = paramsUbo.byteSize(boolOnly);
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    paramsUbo.pack(boolOnly, { invert: 1 } as unknown as ResolvedParams, view);
    expect(view.getUint32(0, true)).toBe(1);
    paramsUbo.pack(boolOnly, { invert: 0 } as unknown as ResolvedParams, view);
    expect(view.getUint32(0, true)).toBe(0);
  });
});
