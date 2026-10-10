/**
 * FROZEN CONTRACT (F0). One generic registry; effects, sources, blend modes
 * and export targets are instances of it (registry/{effects,sources,blends,
 * exports}.ts, Phase 1, track C). Adding anything = register(data).
 */

export interface Registry<T extends { id: string }> {
  register(item: T): void;
  get(id: string): T | undefined;
  /** Throws with a helpful message listing known ids. */
  require(id: string): T;
  list(): readonly T[];
  onChange(cb: () => void): () => void;
}

export function createRegistry<T extends { id: string }>(kind: string): Registry<T> {
  const items = new Map<string, T>();
  const listeners = new Set<() => void>();
  return {
    register(item) {
      if (items.has(item.id)) throw new Error(`${kind} '${item.id}' already registered`);
      items.set(item.id, item);
      listeners.forEach((cb) => cb());
    },
    get: (id) => items.get(id),
    require(id) {
      const item = items.get(id);
      if (!item) {
        throw new Error(`unknown ${kind} '${id}' (known: ${[...items.keys()].join(', ')})`);
      }
      return item;
    },
    list: () => [...items.values()],
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Blend modes are data: a WGSL fn body spliced into the composite template. */
export interface BlendModeDef {
  id: string;
  label: string;
  /** `fn blend(base: vec4f, src: vec4f) -> vec3f`: OKLab in, blended Lab out. */
  wgsl: string;
}

/** Export targets are data too. */
export interface ExportTargetDef {
  id: string;
  label: string;
  mime: string;
  /**
   * Implemented in export/*.ts; typed loosely here to stay clone-free.
   * onProgress is optional. Targets that don't loop frames (e.g. png)
   * still call it once at 0/1 and 1/1 so listeners see a consistent shape.
   */
  run: (
    req: unknown,
    pull: (time: number) => Promise<unknown>,
    onProgress?: (done: number, total: number, label: string) => void,
  ) => Promise<unknown>;
}
