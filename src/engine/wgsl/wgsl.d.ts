/**
 * Ambient module declarations for WGSL snippet source files. Snippets are
 * imported as raw text (`?raw`) so include-impl.ts can concatenate their
 * source untransformed: no bundler plugin required, `?raw` is built into
 * Vite/Vitest's asset pipeline. See CLAUDE.md / task report for why plain
 * `*.wgsl` imports (no query) aren't used: Vite treats unknown extensions
 * as URL assets by default, not inlined text.
 */

declare module '*.wgsl' {
  const src: string;
  export default src;
}

declare module '*.wgsl?raw' {
  const src: string;
  export default src;
}
