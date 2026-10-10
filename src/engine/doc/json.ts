/**
 * FROZEN CONTRACT (F0). DocumentJSON is THE serialisable format: what saves
 * to disk, what crosses the (future) worker boundary, and what a nested-doc
 * Object carries. Everything here must survive structuredClone(). A vitest
 * test enforces deep equality after a round trip. No classes, no functions,
 * no GPU handles, ever.
 */

import type { AssetId, LayerId, ObjectId, Seconds, Transform2D } from '../core/types';
import type { Chain } from '../passes/chain';
import type { ParamValues, ParamValue } from '../params/schema';

export interface ShapeSpec {
  shape: 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'rounded-rect';
  /** 'polygon' only: explicit vertex list (local content-box space).
   * Takes precedence over `sides` when present. Lets a 'polygon' shape
   * carry an arbitrary (freehand-drawn) outline, not just a regular n-gon. */
  points?: readonly (readonly [number, number])[];
  width: number;
  height: number;
  /** 'polygon' only, ignored when `points` is set: regular n-gon side count. */
  sides?: number;
  /** 'star' only: point count. Named distinctly from `points` above (that
   * field is a vertex-coordinate list, this is a count) to avoid the two
   * colliding on one flat interface. */
  starPoints?: number;
  /** 'star' only: inner-vertex radius as a fraction (0..1) of the outer radius. */
  innerRatio?: number;
  /** 'rounded-rect' only: corner radius in local content-box px. */
  radius?: number;
}

export interface TextSpec {
  text: string;
  font: AssetId | 'default';
  size: number;
}

export interface ObjectStyle {
  /** OKLab + alpha. */
  fill?: readonly [number, number, number, number];
  stroke?: readonly [number, number, number, number];
  strokeWidth?: number;
}

export type ObjectContent =
  | { type: 'shape'; shape: ShapeSpec }
  | { type: 'text'; text: TextSpec }
  | { type: 'image'; asset: AssetId }
  | { type: 'document'; doc: DocumentJSON }
  /** Live web component: stub until M5+. Burn flips it to pixels. */
  | { type: 'live'; component: string };

/** Lives inside a Scene source. DISTINCT from Layer. Do not unify. */
export interface ObjectNode {
  id: ObjectId;
  name: string;
  enabled: boolean;
  transform: Transform2D;
  content: ObjectContent;
  style: ObjectStyle;
  chain?: Chain;
  liveness: 'live' | 'baked';
  children?: ObjectNode[];
}

export interface BakedClip {
  clip: AssetId;
  frames: number;
  fps: number;
}

export interface Layer {
  id: LayerId;
  kind: 'layer';
  name: string;
  enabled: boolean;
  /** SourceDescriptor registry key + its config. */
  source: { type: string; params: ParamValues };
  chain: Chain;
  /** Blend registry key. */
  blendMode: string;
  /** Animatable 0..1. */
  opacity: ParamValue;
  transform: Transform2D;
  liveness: 'live' | 'baked';
  baked?: BakedClip;
  /**
   * MASKS block (additive, 2026-07-07, architect-approved; see
   * src/engine/CLAUDE.md's mask contract). `asset` is a raster asset id
   * (same format paint layers use, doc.assets[asset].type === 'raster'):
   * its L channel IS the mask value, 1 = opaque/keep, 0 = hidden. Absent =
   * no mask, every existing document stays valid.
   */
  mask?: { asset: string; enabled: boolean; invert: boolean };
}

export interface LayerGroup {
  id: LayerId;
  kind: 'group';
  name: string;
  enabled: boolean;
  children: LayerNode[];
  chain: Chain;
  blendMode: string;
  opacity: ParamValue;
}

export type LayerNode = Layer | LayerGroup;

export type AssetJSON =
  | { type: 'image'; mime: string; data: ArrayBuffer; width: number; height: number }
  | { type: 'lut'; data: ArrayBuffer; size: number }
  | { type: 'font'; family: string; atlas: ArrayBuffer; metrics: unknown }
  /** Raster/paint layer backing store: rgba16float pixels. */
  | { type: 'raster'; data: ArrayBuffer; width: number; height: number }
  /** format absent = rgba16float (existing docs/burns unchanged); rgba8unorm is a smaller-footprint variant. */
  | { type: 'clip'; frames: ArrayBuffer[]; width: number; height: number; fps: number; format?: 'rgba16float' | 'rgba8unorm' };

export interface DocumentJSON {
  version: 1;
  canvas: {
    width: number;
    height: number;
    workingFormat: 'rgba16float';
    outputColorSpace: 'srgb' | 'display-p3';
  };
  /** duration undefined = live/infinite piece. */
  clock: { fps: number; duration?: Seconds };
  layers: LayerNode[];
  /** Document-level grade. Dither/quantise live in the present pass, not here. */
  postChain: Chain;
  assets: Record<string, AssetJSON>;
}

export const emptyDocument = (width = 1280, height = 720): DocumentJSON => ({
  version: 1,
  canvas: { width, height, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
  clock: { fps: 30 },
  layers: [],
  postChain: [],
  assets: {},
});
