/**
 * FROZEN CONTRACT (F0). Interface; implementation in Phase 1 (track C).
 * Snippets are named WGSL fragments with declared deps; buildShader
 * topo-sorts, dedupes, concatenates, and prepends the generated Params
 * struct so pass WGSL can reference `params.*` and snippet functions.
 */

export interface WgslSnippet {
  id: string;
  deps?: string[];
  code: string;
}

export interface WgslIncludes {
  register(snippet: WgslSnippet): void;
  /** Resolve snippet ids (+ transitive deps) into one preamble string. */
  resolve(ids: string[]): string;
}
