import { describe, it, expect } from 'vitest';
import { resolveParams, evalLfo } from '../../src/engine/params/resolve';
import type { ParamsSchema, Lfo } from '../../src/engine/params/schema';

const schema: ParamsSchema = {
  exposure: { kind: 'float', default: 0, min: -5, max: 5, animatable: true },
  enabled: { kind: 'bool', default: true },
  mode: { kind: 'enum', default: 'a', options: ['a', 'b'] },
  offset: { kind: 'vec2', default: [0, 0], animatable: true },
  lut: { kind: 'asset', assetType: 'lut' },
};

describe('resolveParams', () => {
  it('falls back to schema defaults when a value is missing', () => {
    const resolved = resolveParams(schema, {}, 0);
    expect(resolved.exposure).toBe(0);
    expect(resolved.enabled).toBe(true);
    expect(resolved.mode).toBe('a');
    expect(resolved.offset).toEqual([0, 0]);
  });

  it('leaves asset-kind params absent when unset (no default exists)', () => {
    const resolved = resolveParams(schema, {}, 0);
    expect('lut' in resolved).toBe(false);
  });

  it('passes through non-animated stored values', () => {
    const resolved = resolveParams(schema, { exposure: 3, mode: 'b' }, 0);
    expect(resolved.exposure).toBe(3);
    expect(resolved.mode).toBe('b');
  });

  it('clamps before the first and after the last keyframe', () => {
    const values = { exposure: { track: [{ t: 1, v: 2 }, { t: 2, v: 4 }] } };
    expect(resolveParams(schema, values, 0).exposure).toBe(2);
    expect(resolveParams(schema, values, 5).exposure).toBe(4);
  });

  it('interpolates linear segments', () => {
    const values = { exposure: { track: [{ t: 0, v: 0, ease: 'linear' as const }, { t: 2, v: 4 }] } };
    expect(resolveParams(schema, values, 1).exposure).toBe(2);
  });

  it('holds flat across a hold segment', () => {
    const values = { exposure: { track: [{ t: 0, v: 1, ease: 'hold' as const }, { t: 2, v: 9 }] } };
    expect(resolveParams(schema, values, 1.9).exposure).toBe(1);
  });

  it('eases cubic (smoothstep) segments', () => {
    const values = { exposure: { track: [{ t: 0, v: 0, ease: 'cubic' as const }, { t: 1, v: 10 }] } };
    const mid = resolveParams(schema, values, 0.5).exposure as number;
    // smoothstep(0.5) === 0.5 exactly, so midpoint of the value range too.
    expect(mid).toBeCloseTo(5, 5);
    const quarter = resolveParams(schema, values, 0.25).exposure as number;
    const linearQuarter = 2.5;
    expect(quarter).toBeLessThan(linearQuarter); // smoothstep eases in, slower start
  });

  it('interpolates vector params component-wise', () => {
    const values = { offset: { track: [{ t: 0, v: [0, 0] }, { t: 2, v: [4, -4] }] } };
    expect(resolveParams(schema, values, 1).offset).toEqual([2, -2]);
  });

  it('passes through a schema-less key verbatim (e.g. core.text\'s free-string "text" param)', () => {
    const resolved = resolveParams(schema, { exposure: 1, text: 'HI' }, 0);
    expect(resolved.text).toBe('HI');
    expect(resolved.exposure).toBe(1);
  });

  it('does not choke on a schema-less key holding a track object', () => {
    const values = { untracked: { track: [{ t: 0, v: 1 }] } };
    expect(() => resolveParams(schema, values, 0)).not.toThrow();
    expect('untracked' in resolveParams(schema, values, 0)).toBe(false);
  });

  it('resolves an lfo value to a live number for a float spec', () => {
    const values = { exposure: { lfo: { shape: 'sine' as const, freq: 1, amp: 2, offset: 1, phase: 0 } } };
    expect(resolveParams(schema, values, 0).exposure).toBeCloseTo(1, 10);
    expect(resolveParams(schema, values, 0.25).exposure).toBeCloseTo(3, 10);
  });

  it('falls back to the default for an lfo value on a non-float spec (v1 scope)', () => {
    const values = { offset: { lfo: { shape: 'sine' as const, freq: 1, amp: 1, offset: 0, phase: 0 } } };
    expect(resolveParams(schema, values, 0.25).offset).toEqual([0, 0]);
  });

  it('does not choke on a schema-less key holding an lfo object', () => {
    const values = { untracked: { lfo: { shape: 'noise' as const, freq: 1, amp: 1, offset: 0, phase: 0 } } };
    expect(() => resolveParams(schema, values, 0)).not.toThrow();
    expect('untracked' in resolveParams(schema, values, 0)).toBe(false);
  });
});

describe('evalLfo', () => {
  const base: Omit<Lfo, 'shape'> = { freq: 1, amp: 1, offset: 0, phase: 0 };

  it('sine: offset + amp*sin(2*pi*freq*t + phase)', () => {
    expect(evalLfo({ shape: 'sine', ...base }, 0)).toBeCloseTo(0, 10);
    expect(evalLfo({ shape: 'sine', ...base }, 0.25)).toBeCloseTo(1, 10);
    expect(evalLfo({ shape: 'sine', ...base, offset: 2, amp: 0.5 }, 0.25)).toBeCloseTo(2.5, 10);
  });

  it('triangle: ramps linearly between -amp+offset and amp+offset each period', () => {
    expect(evalLfo({ shape: 'triangle', ...base }, 0)).toBeCloseTo(-1, 10);
    expect(evalLfo({ shape: 'triangle', ...base }, 0.5)).toBeCloseTo(1, 10);
    expect(evalLfo({ shape: 'triangle', ...base }, 0.25)).toBeCloseTo(0, 10);
  });

  it('square: alternates between -amp+offset and amp+offset at the half period', () => {
    expect(evalLfo({ shape: 'square', ...base }, 0)).toBeCloseTo(1, 10);
    expect(evalLfo({ shape: 'square', ...base }, 0.6)).toBeCloseTo(-1, 10);
  });

  it('noise: deterministic (same t -> same value) and seedable via phase', () => {
    const a = evalLfo({ shape: 'noise', ...base }, 1.23);
    const b = evalLfo({ shape: 'noise', ...base }, 1.23);
    expect(a).toBe(b);
    const seeded = evalLfo({ shape: 'noise', ...base, phase: 5 }, 1.23);
    expect(seeded).not.toBe(a);
  });
});
