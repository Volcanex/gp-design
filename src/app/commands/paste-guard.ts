/**
 * Tracks when main.ts's window 'paste' listener last imported an OS image
 * file directly, so registry.ts's edit.paste doesn't ALSO fire its own
 * internal-clipboard/OS-clipboard fallback for the same paste gesture.
 * Needed because Firefox denies navigator.clipboard.read() outright (the
 * paste event's clipboardData is the only way to see an OS image there)
 * while Chromium would otherwise let edit.paste's own OS-read path race the
 * same paste. A 150ms window comfortably covers one synchronous event tick
 * plus the listener's async import kicking off.
 */

const WINDOW_MS = 150;

let lastHandledAt = -Infinity;

export function markPasteHandled(): void {
  lastHandledAt = performance.now();
}

export function wasPasteRecentlyHandled(withinMs = WINDOW_MS): boolean {
  return performance.now() - lastHandledAt < withinMs;
}
