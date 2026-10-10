/**
 * Generic guarded pub/sub, extracted out of localHost.ts so the "a listener
 * that throws must not break the emitter" contract has one implementation
 * and one direct unit test (tests/unit/emit-resilience.test.ts) instead of
 * living only inside the GPU-backed host.
 *
 * A listener is UI code (full lit-html panel renders on 'frame' and
 * 'clock'). One throw there must not escape emit(): in localHost.ts's
 * tick(), that would skip the requestAnimationFrame re-arm and freeze
 * rendering for the session with no message. Each callback is guarded on
 * its own so the others still run, and a callback that already threw once
 * is silenced (WeakSet-tracked) rather than logging at frame rate forever.
 */

export interface Emitter<E extends { type: string }> {
  on(event: E['type'], cb: (e: E) => void): () => void;
  emit(e: E): void;
}

export function createEmitter<E extends { type: string }>(): Emitter<E> {
  const listeners = new Map<E['type'], Set<(e: E) => void>>();
  const brokenListeners = new WeakSet<(e: E) => void>();

  return {
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => listeners.get(event)!.delete(cb);
    },
    emit(e) {
      const set = listeners.get(e.type);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(e);
        } catch (err) {
          if (brokenListeners.has(cb)) continue;
          brokenListeners.add(cb);
          console.error(`[gdesign] '${e.type}' listener threw (further errors from it are suppressed)`, err);
        }
      }
    },
  };
}
