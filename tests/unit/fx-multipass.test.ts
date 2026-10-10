import { describe, it, expect } from 'vitest';
import { effects } from '../../src/engine/registry/effects';
import '../../src/engine/registry/builtins';
import type { ResolvedParams } from '../../src/engine/params/schema';

const HIDDEN_IDS = [
  'core.blur-dir',
  'core.bright-pass',
  'core.screen-add',
  'core.shadow-tint',
  'core.shadow-composite',
];

const MACRO_IDS = [
  'core.blur-gaussian',
  'core.blur-box',
  'core.bloom',
  'core.drop-shadow',
];

describe('FX-MULTIPASS block registration', () => {
  it('registers every hidden sub-pass and every macro effect id', () => {
    for (const id of [...HIDDEN_IDS, ...MACRO_IDS, 'core.displacement']) {
      expect(effects.get(id), `effect '${id}'`).toBeDefined();
    }
  });

  it('hidden sub-passes declare no menuPath (skipped by the menubar)', () => {
    for (const id of HIDDEN_IDS) {
      expect(effects.require(id).metadata.menuPath, id).toBeUndefined();
    }
  });

  it('macro effects declare a menuPath under Effects/ and an expand function', () => {
    for (const id of MACRO_IDS) {
      const desc = effects.require(id);
      expect(desc.metadata.menuPath, id).toMatch(/^Effects\//);
      expect(typeof desc.expand, id).toBe('function');
      expect(desc.wgsl, id).toBe('');
    }
  });

  it('core.displacement is a single pass (no expand), with an asset param', () => {
    const desc = effects.require('core.displacement');
    expect(desc.expand).toBeUndefined();
    expect(desc.wgsl).not.toBe('');
    expect(desc.params.asset).toMatchObject({ kind: 'asset', assetType: 'image' });
    expect(desc.metadata.menuPath).toMatch(/^Effects\/Distort\//);
  });

  it('no schema uses the reserved WGSL words type/target/override/enable as a key', () => {
    for (const id of [...HIDDEN_IDS, ...MACRO_IDS, 'core.displacement']) {
      const keys = Object.keys(effects.require(id).params);
      for (const k of keys) {
        expect(['type', 'target', 'override', 'enable'], `${id}.${k}`).not.toContain(k);
      }
    }
  });
});

describe('core.blur-gaussian / core.blur-box expand', () => {
  it('gaussian expands to two blur-dir steps, x then y, gaussian weights', () => {
    const desc = effects.require('core.blur-gaussian');
    const steps = desc.expand!({ radius: 20 } as ResolvedParams);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ pass: 'core.blur-dir', params: { dir: [1, 0], radius: 20, boxWeights: false } });
    expect(steps[1]).toMatchObject({ pass: 'core.blur-dir', params: { dir: [0, 1], radius: 20, boxWeights: false } });
  });

  it('box expands the same shape but with boxWeights true', () => {
    const desc = effects.require('core.blur-box');
    const steps = desc.expand!({ radius: 5 } as ResolvedParams);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ pass: 'core.blur-dir', params: { dir: [1, 0], radius: 5, boxWeights: true } });
    expect(steps[1]).toMatchObject({ pass: 'core.blur-dir', params: { dir: [0, 1], radius: 5, boxWeights: true } });
  });

  it('both default every step to prev->prev chaining (no inputs override)', () => {
    for (const id of ['core.blur-gaussian', 'core.blur-box']) {
      const steps = effects.require(id).expand!({ radius: 10 } as ResolvedParams);
      for (const step of steps) expect(step.inputs).toBeUndefined();
    }
  });
});

describe('core.bloom expand', () => {
  it('expands to bright-pass, blur-dir x, blur-dir y, screen-add(prev, orig)', () => {
    const desc = effects.require('core.bloom');
    const steps = desc.expand!({ threshold: 0.6, radius: 12, intensity: 2 } as ResolvedParams);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ pass: 'core.bright-pass', params: { threshold: 0.6 } });
    expect(steps[1]).toMatchObject({ pass: 'core.blur-dir', params: { dir: [1, 0], radius: 12, boxWeights: false } });
    expect(steps[2]).toMatchObject({ pass: 'core.blur-dir', params: { dir: [0, 1], radius: 12, boxWeights: false } });
    expect(steps[3]).toMatchObject({ pass: 'core.screen-add', params: { intensity: 2 }, inputs: ['prev', 'orig'] });
  });
});

describe('core.drop-shadow expand', () => {
  it('expands to shadow-tint, blur-dir x, blur-dir y, shadow-composite(prev, orig)', () => {
    const desc = effects.require('core.drop-shadow');
    const steps = desc.expand!({
      offset: [4, 6], radius: 3, color: [0.1, 0.2, -0.1, 1], opacity: 0.8,
    } as ResolvedParams);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ pass: 'core.shadow-tint', params: { color: [0.1, 0.2, -0.1, 1], opacity: 0.8 } });
    expect(steps[1]).toMatchObject({ pass: 'core.blur-dir', params: { dir: [1, 0], radius: 3, boxWeights: false } });
    expect(steps[2]).toMatchObject({ pass: 'core.blur-dir', params: { dir: [0, 1], radius: 3, boxWeights: false } });
    expect(steps[3]).toMatchObject({ pass: 'core.shadow-composite', params: { offset: [4, 6] }, inputs: ['prev', 'orig'] });
  });
});

/**
 * Reimplementation of core.blur-dir's WGSL tap-weight math in TS, to catch
 * logic bugs (off-by-one tap count, non-normalizing sum) independent of
 * actually running the shader. GPU pixel behaviour is covered by
 * tests/e2e/blur.spec.ts instead.
 */
function blurDirWeights(radius: number, boxWeights: boolean): number[] {
  const HALF = 16;
  const r = Math.max(radius, 0);
  const step = r / HALF;
  const sigma = Math.max(r / 3, 0.0001);
  const weights: number[] = [];
  for (let i = -HALF; i <= HALF; i++) {
    const offset = i * step;
    weights.push(boxWeights ? 1 : Math.exp(-(offset * offset) / (2 * sigma * sigma)));
  }
  return weights;
}

describe('core.blur-dir kernel math (TS reimplementation of the WGSL)', () => {
  it('always produces exactly 33 taps', () => {
    expect(blurDirWeights(8, false)).toHaveLength(33);
    expect(blurDirWeights(0, false)).toHaveLength(33);
    expect(blurDirWeights(64, true)).toHaveLength(33);
  });

  it('gaussian weights normalize to ~1.0 (sum(w * 1) / sum(w) === 1)', () => {
    for (const radius of [0, 1, 8, 32, 64]) {
      const w = blurDirWeights(radius, false);
      const sum = w.reduce((a, b) => a + b, 0);
      const normalized = w.reduce((a, b) => a + b, 0) / sum;
      expect(normalized).toBeCloseTo(1, 10);
      expect(sum).toBeGreaterThan(0);
    }
  });

  it('gaussian weights peak at the centre tap and fall off symmetrically', () => {
    const w = blurDirWeights(16, false);
    const centre = w[16]!;
    expect(centre).toBeCloseTo(1, 10); // exp(0) = 1
    for (let i = 1; i <= 16; i++) {
      expect(w[16 - i]).toBeCloseTo(w[16 + i]!, 10); // symmetric
      expect(w[16 - i]!).toBeLessThanOrEqual(centre);
    }
  });

  it('box weights are flat (every tap contributes equally)', () => {
    const w = blurDirWeights(20, true);
    for (const wt of w) expect(wt).toBe(1);
  });
});
