/**
 * Keyframe evaluation: turns a schema + stored ParamValues (which may hold
 * `{ track: Keyframe[] }`) into flat ResolvedParams for a given time. Pure
 * CPU math. The GPU-bound UBO packer (gpu/params-ubo.ts) consumes the
 * output of this, not the raw stored values.
 */

import type { Seconds } from '../core/types';
import type {
  Keyframe, Lfo, ParamSpec, ParamsSchema, ParamValue, ParamValues, ResolvedParam, ResolvedParams,
} from './schema';

function isTrack(value: ParamValue): value is { track: Keyframe[] } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'track' in value;
}

function isLfo(value: ParamValue): value is { lfo: Lfo } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'lfo' in value;
}

function frac01(x: number): number {
  const f = x - Math.floor(x);
  return f < 0 ? f + 1 : f;
}

/** Deterministic hash-based value noise, smoothly interpolated, seedable via the input offset. */
function hashNoise(x: number): number {
  const hash1 = (n: number): number => {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return 2 * (s - Math.floor(s)) - 1;
  };
  const i = Math.floor(x);
  const f = x - i;
  const t = f * f * (3 - 2 * f); // smoothstep
  return hash1(i) + (hash1(i + 1) - hash1(i)) * t;
}

/** Pure: evaluates an Lfo at `time`. All four shapes are deterministic functions of time. */
export function evalLfo(lfo: Lfo, time: Seconds): number {
  const { shape, freq, amp, offset, phase } = lfo;
  if (shape === 'sine') return offset + amp * Math.sin(2 * Math.PI * freq * time + phase);
  if (shape === 'noise') return offset + amp * hashNoise(freq * time + phase);
  const cyclePos = frac01(freq * time + phase / (2 * Math.PI));
  if (shape === 'triangle') return offset + amp * (cyclePos < 0.5 ? 4 * cyclePos - 1 : 3 - 4 * cyclePos);
  return offset + amp * (cyclePos < 0.5 ? 1 : -1); // square
}

function ease(t: number, kind: Keyframe['ease']): number {
  if (kind === 'cubic') return t * t * (3 - 2 * t); // smoothstep
  return t; // linear (default)
}

function lerpValue(a: number | readonly number[], b: number | readonly number[], t: number): number | readonly number[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.map((av, i) => av + ((b[i] ?? av) - av) * t);
  }
  return (a as number) + ((b as number) - (a as number)) * t;
}

/** Binary-search the track for `time`, apply easing, clamp outside the range. */
function evalTrack(track: Keyframe[], time: Seconds): number | readonly number[] {
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

export function resolveParams(schema: ParamsSchema, values: ParamValues, time: Seconds): ResolvedParams {
  const resolved: ResolvedParams = {};
  for (const key of Object.keys(schema)) {
    const spec: ParamSpec = schema[key]!;
    const stored = values[key];
    if (stored !== undefined && isTrack(stored)) {
      resolved[key] = evalTrack(stored.track, time) as ResolvedParam;
      continue;
    }
    if (stored !== undefined && isLfo(stored)) {
      // v1 scope: lfo only resolves to a live value for float specs; other
      // kinds have no numeric slot to evaluate into, so fall back to default.
      if (spec.kind === 'float') {
        resolved[key] = evalLfo(stored.lfo, time);
        continue;
      }
      if ('default' in spec) resolved[key] = spec.default;
      continue;
    }
    if (stored !== undefined) {
      resolved[key] = stored as ResolvedParam;
      continue;
    }
    // 'asset' specs carry no default; leave the key absent when unset.
    if ('default' in spec) resolved[key] = spec.default;
  }
  // Schema-less params (e.g. core.text's free-string 'text', which has no
  // ParamSpec kind to declare) pass through verbatim rather than being
  // dropped: they're still valid ParamValues, just not GPU-uniform-backed
  // or animatable (no spec means no track evaluation).
  for (const key of Object.keys(values)) {
    if (key in schema) continue;
    const stored = values[key];
    if (stored !== undefined && !isTrack(stored) && !isLfo(stored)) resolved[key] = stored as ResolvedParam;
  }
  return resolved;
}
