import { describe, it, expect } from 'vitest';
import { createWgslIncludes, resolveIncludes } from '../../src/engine/wgsl/include-impl';

describe('WgslIncludes', () => {
  it('resolves a snippet with no deps to just its own code', () => {
    const includes = createWgslIncludes();
    includes.register({ id: 'a', code: 'fn a() {}' });
    expect(includes.resolve(['a'])).toBe('fn a() {}');
  });

  it('orders a dependency before its dependent (topo sort)', () => {
    const includes = createWgslIncludes();
    includes.register({ id: 'base', code: 'fn base() {}' });
    includes.register({ id: 'derived', code: 'fn derived() {}', deps: ['base'] });
    const out = includes.resolve(['derived']);
    expect(out.indexOf('fn base()')).toBeLessThan(out.indexOf('fn derived()'));
  });

  it('resolves transitive deps not present in the requested id list', () => {
    const includes = createWgslIncludes();
    includes.register({ id: 'root', code: 'fn root() {}' });
    includes.register({ id: 'mid', code: 'fn mid() {}', deps: ['root'] });
    includes.register({ id: 'leaf', code: 'fn leaf() {}', deps: ['mid'] });
    const out = includes.resolve(['leaf']);
    expect(out).toContain('fn root()');
    expect(out).toContain('fn mid()');
    expect(out).toContain('fn leaf()');
    expect(out.indexOf('fn root()')).toBeLessThan(out.indexOf('fn mid()'));
    expect(out.indexOf('fn mid()')).toBeLessThan(out.indexOf('fn leaf()'));
  });

  it('dedupes a snippet reachable both directly and transitively', () => {
    const includes = createWgslIncludes();
    includes.register({ id: 'common', code: 'fn common() {}' });
    includes.register({ id: 'oklab', code: 'fn oklab() {}', deps: ['common'] });
    const out = includes.resolve(['common', 'oklab']);
    expect(out.match(/fn common\(\)/g)).toHaveLength(1);
    expect(out.match(/fn oklab\(\)/g)).toHaveLength(1);
  });

  it('dedupes when the same id is requested twice in one call', () => {
    const includes = createWgslIncludes();
    includes.register({ id: 'a', code: 'fn a() {}' });
    const out = includes.resolve(['a', 'a']);
    expect(out.match(/fn a\(\)/g)).toHaveLength(1);
  });

  it('throws a helpful error for an unknown id', () => {
    const includes = createWgslIncludes();
    includes.register({ id: 'known', code: '' });
    expect(() => includes.resolve(['missing'])).toThrow(/missing/);
    expect(() => includes.resolve(['missing'])).toThrow(/known/);
  });

  it('throws on a direct cycle', () => {
    const includes = createWgslIncludes();
    includes.register({ id: 'a', code: 'fn a() {}', deps: ['b'] });
    includes.register({ id: 'b', code: 'fn b() {}', deps: ['a'] });
    expect(() => includes.resolve(['a'])).toThrow(/cycle/i);
  });

  it('throws on an indirect (transitive) cycle', () => {
    const includes = createWgslIncludes();
    includes.register({ id: 'a', code: '', deps: ['b'] });
    includes.register({ id: 'b', code: '', deps: ['c'] });
    includes.register({ id: 'c', code: '', deps: ['a'] });
    expect(() => includes.resolve(['a'])).toThrow(/cycle/i);
  });

  it('throws on duplicate registration', () => {
    const includes = createWgslIncludes();
    includes.register({ id: 'a', code: '' });
    expect(() => includes.register({ id: 'a', code: '' })).toThrow(/already registered/);
  });

  describe('the real singleton (resolveIncludes)', () => {
    it('resolves all real builtin snippets with real transitive deps', () => {
      const out = resolveIncludes(['blend', 'oklab', 'bluenoise', 'srgb']);
      expect(out).toContain('fn porter_duff_over');
      expect(out).toContain('fn oklab_to_linear_srgb');
      expect(out).toContain('fn linear_srgb_to_oklab');
      expect(out).toContain('fn ign');
      expect(out).toContain('fn srgb_encode');
      // 'oklab' depends on 'common' (cbrt): must be pulled in and ordered first.
      expect(out).toContain('fn cbrt');
      expect(out.indexOf('fn cbrt')).toBeLessThan(out.indexOf('fn oklab_to_linear_srgb'));
    });

    it('resolves the noise include (simplex/fbm/curl) through its common dependency without a cycle', () => {
      const out = resolveIncludes(['noise']);
      expect(out).toContain('fn simplex2d');
      expect(out).toContain('fn fbm');
      expect(out).toContain('fn curl_fbm');
      // noise depends on 'common' for hash21 (noise_seed_offset): pulled in and ordered first.
      expect(out).toContain('fn hash21');
      expect(out.indexOf('fn hash21')).toBeLessThan(out.indexOf('fn simplex2d'));
    });
  });
});
