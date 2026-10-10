/**
 * FROZEN CONTRACT (F0). The wire format between UI and engine. Every type
 * here must be structured-clone-safe: at M7 this becomes the Comlink/Worker
 * boundary verbatim. applyEdits is the ONLY mutation channel: edits-as-data
 * is what makes undo (inverse edits), history, and plugin transport free.
 */

import type { LayerId, ObjectId, Rect, Seconds, Transform2D } from '../core/types';
import type { Chain } from '../passes/chain';
import type { LayerNode, ObjectNode } from '../doc/json';
import type { ParamValue, ParamsSchema } from '../params/schema';

/** Path to an editable node: a layer, an object in a scene, or an effect instance. */
export type NodePath =
  | { kind: 'layer'; id: LayerId }
  | { kind: 'object'; layer: LayerId; id: ObjectId }
  | { kind: 'effect'; owner: LayerId | ObjectId; instance: string }
  | { kind: 'document' };

export type DocEdit =
  | { op: 'setParam'; target: NodePath; key: string; value: ParamValue }
  | { op: 'addLayer'; parent: LayerId | null; index: number; layer: LayerNode }
  | { op: 'removeLayer'; id: LayerId }
  | { op: 'reorderLayer'; id: LayerId; parent: LayerId | null; index: number }
  | { op: 'setBlend'; id: LayerId; mode: string }
  | { op: 'setOpacity'; id: LayerId; value: ParamValue }
  | { op: 'setChain'; target: NodePath; chain: Chain }
  | { op: 'setTransform'; id: LayerId | ObjectId; transform: Transform2D }
  | { op: 'setEnabled'; id: LayerId | ObjectId; enabled: boolean }
  | { op: 'renameNode'; id: LayerId | ObjectId; name: string }
  | { op: 'addObject'; layer: LayerId; parent: ObjectId | null; index: number; object: ObjectNode }
  | { op: 'removeObject'; layer: LayerId; id: ObjectId }
  /** Replaces a raster asset region after a committed stroke. */
  | { op: 'commitRaster'; layer: LayerId; asset: string; data: ArrayBuffer; region: Rect }
  /** Registers/removes an entry in doc.assets (image import, baked clips). */
  | { op: 'addAsset'; id: string; asset: import('../doc/json').AssetJSON }
  | { op: 'removeAsset'; id: string }
  /** Replaces doc.clock wholesale (see doc/json.ts's DocumentJSON['clock']). */
  | { op: 'setDocClock'; clock: { fps: number; duration?: Seconds } }
  /**
   * MASKS block (additive, 2026-07-07, architect-approved). Replaces a
   * layer's `mask` wholesale; `null` removes it. Inverse carries the old
   * value (undefined mask -> null), so undo is exact either way.
   */
  | { op: 'setMask'; id: LayerId; mask: { asset: string; enabled: boolean; invert: boolean } | null };

export type ClockCommand =
  | { cmd: 'play' }
  | { cmd: 'pause' }
  | { cmd: 'seek'; time: Seconds }
  | { cmd: 'setFps'; fps: number }
  /** Set/clear transport looping. undefined clears; loop only wraps during playback, seek stays free. */
  | { cmd: 'setLoop'; range: { from: Seconds; to: Seconds } | undefined };

export interface BurnRequest {
  target: LayerId | ObjectId;
  mode: 'still' | 'clip';
  /** clip mode only. */
  range?: { from: Seconds; to: Seconds; fps?: number };
}

export interface BurnResult {
  edits: DocEdit[];
}

export interface ExportRequest {
  target: 'png' | 'video' | 'live-embed' | 'png-sequence';
  range?: { from: Seconds; to: Seconds };
  options?: Record<string, string | number | boolean>;
}

export interface ExportResult {
  mime: string;
  data: ArrayBuffer;
  fileName: string;
}

export interface ReadbackRequest {
  region?: Rect;
  /** 'float' needs f16 readback support (caps); 'quantised' always works. */
  via: 'float' | 'quantised';
}

export interface ReadbackResult {
  width: number;
  height: number;
  /** float → Float32Array buffer; quantised → Uint8Array buffer. RGBA order, display space. */
  data: ArrayBuffer;
  via: 'float' | 'quantised';
}

export interface HitResult {
  layer: LayerId | null;
  object: ObjectId | null;
}

export interface PassTiming {
  pass: string;
  node: string;
  gpuMs: number | null;
}

export type EngineEvent =
  | { type: 'frame'; time: Seconds; frame: number; timings?: PassTiming[] }
  | { type: 'clock'; playing: boolean; time: Seconds }
  | { type: 'document-changed'; edits: DocEdit[]; origin: 'ui' | 'engine' }
  | { type: 'caps'; caps: import('../core/types').EngineCaps }
  | { type: 'error'; message: string; fatal: boolean }
  /** Emission wired by a later export-milestone agent. The type exists so callers can listen now. */
  | { type: 'export-progress'; done: number; total: number; label: string };

export type EngineEventType = EngineEvent['type'];

/** Registry metadata surfaced to the UI: menus and forms build from these. */
export interface EffectMeta {
  id: string;
  label: string;
  category: string;
  menuPath?: string;
  params: ParamsSchema;
}

export interface SourceMeta {
  id: string;
  label: string;
  liveByDefault: boolean;
  params: ParamsSchema;
}

export interface BlendMeta {
  id: string;
  label: string;
}

/** Stroke streaming for paint tools (raster source). */
export interface StrokePoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface StrokeConfig {
  layer: LayerId;
  brush: 'round';
  size: number;
  /** OKLab + alpha. */
  color: readonly [number, number, number, number];
  mode: 'paint' | 'erase';
}
