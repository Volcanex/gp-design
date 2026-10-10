/**
 * FROZEN CONTRACT (F0). Params schemas drive BOTH the generated WGSL uniform
 * struct (gpu/params-ubo.ts) and auto-generated UI forms (ui/forms/).
 * A new effect ships a schema and gets storage, packing, and UI for free.
 */

import type { AssetRef, Seconds } from '../core/types';

export type ParamSpec =
  | { kind: 'float'; default: number; min?: number; max?: number; step?: number;
      unit?: string; animatable?: boolean; label?: string }
  | { kind: 'int'; default: number; min?: number; max?: number; label?: string }
  | { kind: 'bool'; default: boolean; label?: string }
  | { kind: 'enum'; default: string; options: readonly string[]; label?: string }
  | { kind: 'vec2' | 'vec3' | 'vec4'; default: readonly number[]; min?: number;
      max?: number; animatable?: boolean; label?: string }
  | { kind: 'color'; default: readonly [number, number, number, number];
      space?: 'oklab' | 'srgb'; animatable?: boolean; label?: string }
  /** Becomes a texture binding in group(1), not a uniform. */
  | { kind: 'asset'; assetType: 'image' | 'lut' | 'font'; label?: string };

export type ParamsSchema = Record<string, ParamSpec>;

/** Keyframed animation lives IN the stored value, JSON-native. */
export interface Keyframe {
  t: Seconds;
  v: number | readonly number[];
  ease?: 'linear' | 'hold' | 'cubic';
}

/**
 * Procedural oscillator, evaluated per-frame by params/resolve.ts's evalLfo.
 * v1 scope: only 'float' ParamSpecs route this to a live value; vec/color
 * specs holding an lfo value fall back to their default (documented in
 * resolveParams).
 */
export interface Lfo {
  shape: 'sine' | 'triangle' | 'square' | 'noise';
  freq: number;
  amp: number;
  offset: number;
  phase: number;
}

export type ParamValue =
  | number
  | boolean
  | string
  | readonly number[]
  | AssetRef
  | { track: Keyframe[] }
  | { lfo: Lfo };

export type ParamValues = Record<string, ParamValue>;

/** Post keyframe-eval: flat values the GPU/UI layers consume. */
export type ResolvedParam = number | boolean | string | readonly number[] | AssetRef;
export type ResolvedParams = Record<string, ResolvedParam>;
