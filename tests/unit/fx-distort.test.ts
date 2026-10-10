import { describe, it, expect } from 'vitest';
import { effects } from '../../src/engine/registry/effects';
import '../../src/engine/registry/builtins';

const IDS = [
  'core.wave',
  'core.twirl',
  'core.kaleidoscope',
  'core.tile-mirror',
  'core.chromatic-aberration',
  'core.sharpen',
  'core.glow',
];

describe('FX-DISTORT block registration', () => {
  it('registers every distort/focus effect id', () => {
    for (const id of IDS) {
      expect(effects.get(id), `effect '${id}'`).toBeDefined();
    }
  });

  it('every pass declares a menuPath under Effects/', () => {
    for (const id of IDS) {
      const desc = effects.require(id);
      expect(desc.metadata.menuPath, id).toMatch(/^Effects\//);
    }
  });

  it('every pass declares exactly one input (input0)', () => {
    for (const id of IDS) {
      const desc = effects.require(id);
      expect(desc.inputs.map((i) => i.name)).toEqual(['input0']);
    }
  });

  it('core.chromatic-aberration is the only one that declares colorSpace: rgb', () => {
    expect(effects.require('core.chromatic-aberration').metadata.colorSpace).toBe('rgb');
    for (const id of IDS.filter((i) => i !== 'core.chromatic-aberration')) {
      expect(effects.require(id).metadata.colorSpace, id).toBeUndefined();
    }
  });

  it('kaleidoscope segments is an int param bounded 2..24', () => {
    const spec = effects.require('core.kaleidoscope').params.segments;
    expect(spec).toMatchObject({ kind: 'int', min: 2, max: 24 });
  });

  it('wave and tile-mirror enum params list their documented options', () => {
    const waveMode = effects.require('core.wave').params.mode;
    expect(waveMode).toMatchObject({ kind: 'enum', options: ['wave', 'ripple'] });

    const tileMode = effects.require('core.tile-mirror').params.mode;
    expect(tileMode).toMatchObject({ kind: 'enum', options: ['mirrorX', 'mirrorY', 'tile'] });
  });

  it('sharpen lumaOnly is a bool param', () => {
    expect(effects.require('core.sharpen').params.lumaOnly).toMatchObject({ kind: 'bool' });
  });

  it('no schema uses the reserved WGSL words type/target/override/enable as a key', () => {
    const reserved = new Set(['type', 'target', 'override', 'enable']);
    for (const id of IDS) {
      const desc = effects.require(id);
      for (const key of Object.keys(desc.params)) {
        expect(reserved.has(key), `${id}.${key}`).toBe(false);
      }
    }
  });
});
