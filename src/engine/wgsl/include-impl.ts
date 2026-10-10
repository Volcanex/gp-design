import type { WgslIncludes, WgslSnippet } from './include';

import commonWgsl from './snippets/common.wgsl?raw';
import srgbWgsl from './snippets/srgb.wgsl?raw';
import oklabWgsl from './snippets/oklab.wgsl?raw';
import blendWgsl from './snippets/blend.wgsl?raw';
import bluenoiseWgsl from './snippets/bluenoise.wgsl?raw';
import noiseWgsl from './snippets/noise.wgsl?raw';

/** Exported so tests can build isolated instances instead of sharing the
 * preloaded singleton (register() throws on duplicate ids). */
export function createWgslIncludes(): WgslIncludes {
  const snippets = new Map<string, WgslSnippet>();

  function register(snippet: WgslSnippet): void {
    if (snippets.has(snippet.id)) {
      throw new Error(`wgsl snippet '${snippet.id}' already registered`);
    }
    snippets.set(snippet.id, snippet);
  }

  function resolve(ids: string[]): string {
    const resolved = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    function visit(id: string): void {
      if (resolved.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`wgsl include cycle detected at '${id}'`);
      }
      const snippet = snippets.get(id);
      if (!snippet) {
        throw new Error(`unknown wgsl include '${id}' (known: ${[...snippets.keys()].join(', ')})`);
      }
      visiting.add(id);
      for (const dep of snippet.deps ?? []) visit(dep);
      visiting.delete(id);
      resolved.add(id);
      order.push(id);
    }

    for (const id of ids) visit(id);
    return order.map((id) => snippets.get(id)!.code).join('\n\n');
  }

  return { register, resolve };
}

export const includes: WgslIncludes = createWgslIncludes();

includes.register({ id: 'common', code: commonWgsl });
includes.register({ id: 'srgb', code: srgbWgsl });
includes.register({ id: 'oklab', code: oklabWgsl, deps: ['common'] });
includes.register({ id: 'blend', code: blendWgsl });
includes.register({ id: 'bluenoise', code: bluenoiseWgsl });
// FX-BLENDGEN block (own this block; see gdesign-wt/blendgen).
includes.register({ id: 'noise', code: noiseWgsl, deps: ['common'] });
// end FX-BLENDGEN block

export function resolveIncludes(ids: string[]): string {
  return includes.resolve(ids);
}
