import { describe, it, expect } from 'vitest';
import { effects } from '../../src/engine/registry/effects';
import '../../src/engine/registry/builtins';

const EXPECTED = [
  { id: 'core.vignette', menuPath: 'Effects/Stylize/Vignette' },
  { id: 'core.pixelate', menuPath: 'Effects/Stylize/Pixelate' },
  { id: 'core.scanlines', menuPath: 'Effects/Stylize/Scanlines' },
  { id: 'core.halftone', menuPath: 'Effects/Stylize/Halftone' },
  { id: 'core.grain', menuPath: 'Effects/Noise/Film Grain' },
  { id: 'core.dither-ordered', menuPath: 'Effects/Dither/Ordered (Bayer)' },
  { id: 'core.edge-detect', menuPath: 'Effects/Stylize/Edge Detect' },
];

describe('FX-STYLIZE builtins', () => {
  it('registers every expected effect id at the expected menu path', () => {
    for (const { id, menuPath } of EXPECTED) {
      const pass = effects.require(id);
      expect(pass.metadata.menuPath, id).toBe(menuPath);
      expect(pass.metadata.category).toBe('core');
    }
  });

  it('every pass declares input0, a fs_main fragment entry point, and non-empty params/wgsl', () => {
    for (const { id } of EXPECTED) {
      const pass = effects.require(id);
      expect(pass.kind, id).toBe('render');
      expect(pass.inputs.some((i) => i.name === 'input0'), id).toBe(true);
      expect(pass.wgsl, id).toMatch(/fn fs_main\(in: VSOut\) -> @location\(0\) vec4f/);
    }
  });

  it('pixelate declares its input as a nearest sampler', () => {
    const pass = effects.require('core.pixelate');
    expect(pass.inputs.find((i) => i.name === 'input0')?.filter).toBe('nearest');
  });

  it('enum params expose their default among their options', () => {
    const halftone = effects.require('core.halftone');
    const modeSpec = halftone.params.mode!;
    if (modeSpec.kind === 'enum') {
      expect(modeSpec.options).toContain(modeSpec.default);
    } else {
      throw new Error('expected core.halftone.mode to be an enum param');
    }

    const ditherOrdered = effects.require('core.dither-ordered');
    const matrixSpec = ditherOrdered.params.matrix!;
    if (matrixSpec.kind === 'enum') {
      expect(matrixSpec.options).toContain(matrixSpec.default);
    } else {
      throw new Error('expected core.dither-ordered.matrix to be an enum param');
    }

    const edgeDetect = effects.require('core.edge-detect');
    const edgeModeSpec = edgeDetect.params.mode!;
    if (edgeModeSpec.kind === 'enum') {
      expect(edgeModeSpec.options).toContain(edgeModeSpec.default);
    } else {
      throw new Error('expected core.edge-detect.mode to be an enum param');
    }
  });

  it('grain and dither-ordered declare the "common" wgsl include (hash21/quantise_channel/AB_RANGE)', () => {
    expect(effects.require('core.grain').includes).toContain('common');
    expect(effects.require('core.dither-ordered').includes).toContain('common');
  });

  it('vignette center is a vec2 param defaulting to the canvas centre', () => {
    const centerSpec = effects.require('core.vignette').params.center!;
    expect(centerSpec.kind).toBe('vec2');
    if (centerSpec.kind === 'vec2') {
      expect(centerSpec.default).toEqual([0.5, 0.5]);
    }
  });
});
