/** Minimal observable store: the whole UI re-render mechanism. */

export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(fn: (cur: T) => T): void;
  subscribe(cb: (value: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<(v: T) => void>();
  const broken = new WeakSet<(v: T) => void>();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      // Subscribers are panel renders. One throwing must not stop the
      // others, and must not propagate into whatever event handler or
      // engine callback called set() (see localHost.ts's emit for the same
      // rule on the engine side). Logged once per subscriber.
      for (const cb of subs) {
        try {
          cb(value);
        } catch (err) {
          if (broken.has(cb)) continue;
          broken.add(cb);
          console.error('[gdesign] store subscriber threw (further errors from it are suppressed)', err);
        }
      }
    },
    update(fn) {
      this.set(fn(value));
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
