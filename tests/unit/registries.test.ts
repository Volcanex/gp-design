import { describe, it, expect } from 'vitest';
import { effects } from '../../src/engine/registry/effects';
import { sources } from '../../src/engine/registry/sources';
import { blends } from '../../src/engine/registry/blends';
import { exportTargets } from '../../src/engine/registry/exports';
import '../../src/engine/registry/builtins';

const EXPECTED_EFFECT_IDS = [
  'core.blit',
  'core.composite',
  'core.to-rgb',
  'core.from-rgb',
  'core.exposure',
  'core.quantise',
  'core.dither',
  // registered indirectly via sourceFromPass / image's internal blit pass
  'core.solid',
  'core.plasma',
  'core.nested-doc',
  'core.image.blit',
  'core.noise',
  // core.feedback registers its internal transform pass manually (mirrors
  // core.image.blit), same id as the source itself (see feedback.ts).
  'core.feedback',
  // core.text and core.scene are NOT here: both own their GPURenderPipeline
  // directly (SourceInstance, not sourceFromPass), so neither registers a
  // PassDescriptor with the effects registry. See sources/builtin/text.ts
  // and sources/builtin/scene.ts.
];

const EXPECTED_SOURCE_IDS = [
  'core.solid',
  'core.image',
  'core.plasma',
  'core.text',
  'core.scene',
  'core.nested-doc',
  'core.noise',
  'core.feedback',
  // ADJUST block
  'core.adjustment',
];

const EXPECTED_BLEND_IDS = [
  'normal', 'darken', 'lighten', 'add', 'multiply',
  // FX-BLENDGEN block
  'screen', 'overlay', 'soft-light', 'difference', 'color', 'luminosity', 'hue', 'saturation',
];

const EXPECTED_EXPORT_TARGET_IDS = ['png', 'video', 'live-embed', 'png-sequence'];

/**
 * WGSL keywords + reserved words (spec §Keywords and Appendix "Reserved
 * Words", plus predeclared type/address-space identifiers): using one of
 * these as a ParamsSchema key means params-ubo.ts emits a `struct Params`
 * field with that name, which fails shader compilation. Per the CLAUDE.md
 * gotcha, a failed compile does NOT throw (the pass just renders black),
 * so this collided twice already (core.gradient's `from`/`to`/`type`, see
 * git history) before anyone noticed. Not a byte-for-byte transcription of
 * the spec appendix (that list is long and can drift across WGSL versions);
 * covers the actual keyword set plus every reserved word this repo has been
 * bitten by or came close to.
 */
const WGSL_RESERVED_WORDS = new Set([
  // keywords
  'alias', 'break', 'case', 'const', 'const_assert', 'continue', 'continuing',
  'default', 'diagnostic', 'discard', 'else', 'enable', 'false', 'fn', 'for',
  'function', 'if', 'let', 'loop', 'override', 'requires', 'return', 'struct',
  'switch', 'true', 'var', 'while',
  // address spaces / access modes (also keyword-ish, appear in reserved list)
  'private', 'workgroup', 'uniform', 'storage', 'handle', 'read', 'write',
  'read_write',
  // reserved words this repo has actually hit or is one typo away from
  'from', 'to', 'type', 'target', 'filter', 'ref', 'self', 'this', 'super',
  'class', 'interface', 'implements', 'extends', 'import', 'export', 'module',
  'namespace', 'package', 'new', 'delete', 'typeof', 'instanceof', 'void',
  'null', 'asm', 'auto', 'catch', 'do', 'enum', 'explicit', 'extern', 'friend',
  'goto', 'inline', 'mutable', 'operator', 'premerge', 'priv', 'protected',
  'public', 'regardless', 'register', 'restrict', 'set', 'shared', 'sizeof',
  'static', 'static_assert', 'template', 'throw', 'trait', 'try', 'typedef',
  'typeid', 'typename', 'union', 'unless', 'unsafe', 'using', 'virtual',
  'volatile', 'where', 'with', 'yield',
]);

describe('builtin registries', () => {
  it('registers every expected effect id', () => {
    for (const id of EXPECTED_EFFECT_IDS) {
      expect(effects.get(id), `effect '${id}'`).toBeDefined();
    }
  });

  it('registers every expected source id', () => {
    for (const id of EXPECTED_SOURCE_IDS) {
      expect(sources.get(id), `source '${id}'`).toBeDefined();
    }
  });

  it('registers every expected blend mode id', () => {
    for (const id of EXPECTED_BLEND_IDS) {
      expect(blends.get(id), `blend mode '${id}'`).toBeDefined();
    }
  });

  it('every blend mode wgsl defines a blend() function', () => {
    for (const mode of blends.list()) {
      expect(mode.wgsl).toMatch(/fn blend\(base: vec4f, src: vec4f\) -> vec3f/);
    }
  });

  it('require() throws with the known-ids list for a bad effect id', () => {
    expect(() => effects.require('core.nonexistent')).toThrow(/unknown effect 'core.nonexistent'/);
    expect(() => effects.require('core.nonexistent')).toThrow(/core\.blit/);
  });

  it('require() throws with the known-ids list for a bad source id', () => {
    expect(() => sources.require('core.nonexistent')).toThrow(/unknown source 'core.nonexistent'/);
  });

  it('require() throws with the known-ids list for a bad blend mode id', () => {
    expect(() => blends.require('nonexistent')).toThrow(/unknown blend mode 'nonexistent'/);
  });

  it('registers every expected export target id', () => {
    for (const id of EXPECTED_EXPORT_TARGET_IDS) {
      expect(exportTargets.get(id), `export target '${id}'`).toBeDefined();
    }
  });

  it('sourceFromPass-wrapped sources default liveByDefault to true; image is false', () => {
    expect(sources.require('core.plasma').liveByDefault).toBe(true);
    expect(sources.require('core.solid').liveByDefault).toBe(true);
    expect(sources.require('core.image').liveByDefault).toBe(false);
  });

  // FX-BLENDGEN block
  it('core.feedback is the only source that opts into wantsBackdrop', () => {
    expect(sources.require('core.feedback').wantsBackdrop).toBe(true);
    for (const source of sources.list()) {
      if (source.id === 'core.feedback') continue;
      expect(source.wantsBackdrop, `source '${source.id}'`).toBeFalsy();
    }
  });

  // Reserved-word / bool-misuse guards. See WGSL_RESERVED_WORDS's doc
  // comment. Both classes fail silently (black render, no thrown error), so
  // these are the only backstop.
  it('no registered effect or source ParamsSchema key is a WGSL reserved word', () => {
    for (const effect of effects.list()) {
      for (const key of Object.keys(effect.params)) {
        expect(WGSL_RESERVED_WORDS.has(key), `effect '${effect.id}' param '${key}'`).toBe(false);
      }
    }
    for (const source of sources.list()) {
      for (const key of Object.keys(source.params)) {
        expect(WGSL_RESERVED_WORDS.has(key), `source '${source.id}' param '${key}'`).toBe(false);
      }
    }
  });

  it('no bool-kind param is used as a bare WGSL boolean (must compare against 0u/false)', () => {
    // Imperfect static check (misses e.g. a bool splice into another
    // fn/macro), but catches the common `if (params.x)` / `!params.x` /
    // `select(a, b, params.x)` forms that have shipped broken twice.
    for (const effect of effects.list()) {
      const boolKeys = Object.keys(effect.params).filter((k) => effect.params[k]!.kind === 'bool');
      for (const key of boolKeys) {
        const bare = new RegExp(`if\\s*\\(\\s*params\\.${key}\\s*\\)|!\\s*params\\.${key}\\b|,\\s*params\\.${key}\\s*\\)`);
        expect(bare.test(effect.wgsl), `effect '${effect.id}' bool param '${key}' used bare (need '!= 0u')`).toBe(false);
      }
    }
  });
});
