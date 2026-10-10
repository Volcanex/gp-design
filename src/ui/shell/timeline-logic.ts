/**
 * Pure timeline math + track editing helpers: no DOM, no engine imports
 * beyond types. timeline.ts (DOM/pointer handling) and params-form.ts (the
 * diamond-click keyframe authoring on source-param rows) both import this
 * rather than duplicating track-splicing logic.
 *
 * `resolveTrackAt` is a deliberate UI-side MIRROR of engine/params/resolve.ts's
 * evalTrack (linear/hold/cubic + clamp-outside-range), kept here rather than
 * exported from the engine because engine/ is off-limits for this workstream
 * (frozen-contract boundary). It is display-only: what a form row shows at
 * the playhead. Actual playback always resolves through the engine's own
 * evalTrack; if that function's easing math ever changes, update this copy
 * too (Contract changelog in src/engine/CLAUDE.md is the tripwire to watch).
 */

import type { Keyframe, ParamsSchema, ParamValue, ParamValues, Seconds } from '@engine';

export interface Lane {
  key: string;
  label: string;
  kind: string;
  track: Keyframe[];
}

/** Timeline's visible time range always covers the doc duration, the loop's
 * end, and a 2s floor (so a brand-new live/infinite doc with no loop still
 * shows a usable ruler instead of a zero-width one). */
export function visibleEnd(duration: Seconds | undefined, loopTo: Seconds | undefined): Seconds {
  return Math.max(duration ?? 0, loopTo ?? 0, 2);
}

export function timeToX(t: Seconds, width: number, end: Seconds): number {
  if (end <= 0 || width <= 0) return 0;
  return (t / end) * width;
}

export function xToTime(x: number, width: number, end: Seconds): Seconds {
  if (width <= 0) return 0;
  return Math.max(0, (x / width) * end);
}

export function quantiseToFrame(t: Seconds, fps: number): Seconds {
  if (!Number.isFinite(fps) || fps <= 0) return t;
  return Math.round(t * fps) / fps;
}

function ease(t: number, kind: Keyframe['ease']): number {
  if (kind === 'cubic') return t * t * (3 - 2 * t);
  return t;
}

function lerpValue(a: number | readonly number[], b: number | readonly number[], t: number): number | readonly number[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.map((av, i) => av + ((b[i] ?? av) - av) * t);
  }
  return (a as number) + ((b as number) - (a as number)) * t;
}

/** Display-only mirror of engine/params/resolve.ts's evalTrack (see file header). */
export function resolveTrackAt(track: Keyframe[], time: Seconds): number | readonly number[] {
  if (track.length === 0) return 0;
  if (track.length === 1 || time <= track[0]!.t) return track[0]!.v;
  const last = track[track.length - 1]!;
  if (time >= last.t) return last.v;

  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid]!.t <= time) lo = mid; else hi = mid;
  }
  const a = track[lo]!;
  const b = track[hi]!;
  if (a.ease === 'hold') return a.v;
  const span = b.t - a.t;
  const t = span > 0 ? (time - a.t) / span : 0;
  return lerpValue(a.v, b.v, ease(t, a.ease));
}

/** Insert-or-replace-by-exact-time, kept sorted by t. Replacing preserves the
 * existing key's ease unless a new one is supplied. */
export function trackWithKeyAt(
  track: Keyframe[], t: Seconds, v: Keyframe['v'], newEase?: Keyframe['ease'],
): Keyframe[] {
  const idx = track.findIndex((k) => k.t === t);
  if (idx >= 0) {
    const next = [...track];
    next[idx] = { ...next[idx]!, v, ...(newEase !== undefined ? { ease: newEase } : {}) };
    return next;
  }
  const next = [...track, { t, v, ...(newEase !== undefined ? { ease: newEase } : {}) }];
  next.sort((a, b) => a.t - b.t);
  return next;
}

export interface KeyMoveResult {
  track: Keyframe[];
  /** Where the moved key landed after re-sorting. The caller's selection
   * should follow this, not the original index. */
  index: number;
}

/** Retimes the key at `index`, preserving its value/ease, and re-sorts. */
export function trackWithKeyMoved(track: Keyframe[], index: number, newT: Seconds): KeyMoveResult {
  const key = track[index];
  if (!key) return { track, index };
  const moved: Keyframe = { ...key, t: newT };
  const rest = track.filter((_, i) => i !== index);
  const insertAt = rest.findIndex((k) => k.t > newT);
  const next = insertAt === -1 ? [...rest, moved] : [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
  return { track: next, index: next.indexOf(moved) };
}

/** Removing the last remaining key collapses the param back to that key's
 * static value (schema.ts has no "empty track" concept: a track always
 * has >=1 key or doesn't exist as a track at all). */
export function trackWithKeyRemoved(track: Keyframe[], index: number): Keyframe[] | number | readonly number[] {
  const removed = track[index];
  if (!removed) return track;
  const next = track.filter((_, i) => i !== index);
  return next.length === 0 ? removed.v : next;
}

function isTrack(value: ParamValue | undefined): value is { track: Keyframe[] } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'track' in value;
}

/** One lane per source param currently holding a {track} value, NOT every
 * animatable param, only ones actually keyframed (a static animatable param
 * has nothing to show on a timeline yet). */
export function lanesFor(params: ParamValues, schema: ParamsSchema): Lane[] {
  const lanes: Lane[] = [];
  for (const key of Object.keys(schema)) {
    const raw = params[key];
    if (!isTrack(raw)) continue;
    const spec = schema[key]!;
    lanes.push({ key, label: spec.label ?? key, kind: spec.kind, track: raw.track });
  }
  return lanes;
}
