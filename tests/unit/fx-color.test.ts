import { describe, it, expect } from 'vitest';
import { effects } from '../../src/engine/registry/effects';
import { resolveParams } from '../../src/engine/params/resolve';
import '../../src/engine/registry/builtins';

const EXPECTED: Record<string, { menuPath: string; colorSpace?: 'rgb' }> = {
  'core.temperature': { menuPath: 'Adjustments/Temperature & Tint' },
  'core.vibrance': { menuPath: 'Adjustments/Vibrance' },
  'core.gamma': { menuPath: 'Adjustments/Gamma' },
  'core.threshold': { menuPath: 'Adjustments/Threshold' },
  'core.channel-mixer': { menuPath: 'Adjustments/Channel Mixer', colorSpace: 'rgb' },
  'core.duotone': { menuPath: 'Effects/Color/Duotone' },
  'core.solarize': { menuPath: 'Effects/Color/Solarize', colorSpace: 'rgb' },
};

describe('FX-COLOR builtins', () => {
  it('registers all 7 effects with the expected menu path and color space', () => {
    for (const [id, expected] of Object.entries(EXPECTED)) {
      const desc = effects.get(id);
      expect(desc, `effect '${id}'`).toBeDefined();
      expect(desc!.metadata.menuPath).toBe(expected.menuPath);
      expect(desc!.metadata.colorSpace).toBe(expected.colorSpace);
    }
  });

  it('resolveParams fills in schema defaults for every effect with no stored values', () => {
    expect(resolveParams(effects.require('core.temperature').params, {}, 0)).toEqual({
      temperature: 0, tint: 0,
    });
    expect(resolveParams(effects.require('core.vibrance').params, {}, 0)).toEqual({
      vibrance: 0, saturation: 0,
    });
    expect(resolveParams(effects.require('core.gamma').params, {}, 0)).toEqual({ gamma: 1 });
    expect(resolveParams(effects.require('core.threshold').params, {}, 0)).toEqual({
      threshold: 0.5, softness: 0, invert: false,
    });
    expect(resolveParams(effects.require('core.channel-mixer').params, {}, 0)).toEqual({
      redRow: [1, 0, 0], greenRow: [0, 1, 0], blueRow: [0, 0, 1], constants: [0, 0, 0],
    });
    const duotoneDefaults = resolveParams(effects.require('core.duotone').params, {}, 0);
    expect(duotoneDefaults.balance).toBe(0);
    expect(duotoneDefaults.amount).toBe(1);
    expect(duotoneDefaults.colorA).toEqual([0.28, 0.02, -0.22, 1]);
    expect(duotoneDefaults.colorB).toEqual([0.95, 0.015, 0.04, 1]);
    expect(resolveParams(effects.require('core.solarize').params, {}, 0)).toEqual({
      threshold: 0.5, amount: 1,
    });
  });

  it('float/vec3/color params are marked animatable where sensible; invert is a plain bool', () => {
    const tempParam = effects.require('core.temperature').params.temperature!;
    expect(tempParam.kind === 'float' && tempParam.animatable).toBe(true);
    const tintParam = effects.require('core.temperature').params.tint!;
    expect(tintParam.kind === 'float' && tintParam.animatable).toBe(true);

    const redRowParam = effects.require('core.channel-mixer').params.redRow!;
    expect(redRowParam.kind === 'vec3' && redRowParam.animatable).toBe(true);

    const thresh = effects.require('core.threshold').params;
    expect(thresh.invert!.kind).toBe('bool');
  });
});
