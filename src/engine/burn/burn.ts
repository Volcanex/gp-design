/**
 * Burn: live -> baked. Orchestrates the frame-pull (via an injected
 * BurnRenderer, so this stays testable without a GPU; see
 * tests/unit/burn-edits.test.ts) and constructs the UNAPPLIED DocEdit batch,
 * same convention as localHost.ts's endStroke: the caller (localHost.burn(),
 * then the UI's patchCommand in app/commands/registry.ts) applies it exactly
 * once via applyEdits, so undo is replaying the returned inverses.
 *
 * Source-swap edit-op route: DocEdit has no dedicated `setSource`/
 * `setLiveness` op (host/protocol.ts is frozen this phase), so both modes
 * swap the layer via `removeLayer` + `addLayer` of a mutated clone (same id,
 * same position): one atomic pair that covers source, chain, liveness, and
 * baked all at once, rather than three-plus ops chasing fields the frozen
 * DocEdit union can't address individually. A cleaner long-term shape would
 * add a single `{ op: 'setLayerSource'; id: LayerId; source; chain; liveness;
 * baked? }` edit: it would preserve the layer's object identity across the
 * swap (removeLayer+addLayer currently round-trips index/parentId lookup)
 * and shrink the undo batch from two ops to one. Left as a proposal for
 * architect sign-off since it touches the frozen protocol.
 */

import type { LayerId, Seconds, AssetId } from '../core/types';
import { assetId } from '../core/types';
import type { BurnRequest, BurnResult, DocEdit } from '../host/protocol';
import type { DocumentJSON, Layer } from '../doc/json';
import { findLayer } from '../doc/document';

/** One rendered frame of a burn target: raw rgba16float bytes (matches
 * AssetJSON 'raster'/'clip' data layout) + the dimensions they were captured at. */
export interface BurnFrame {
  data: ArrayBuffer;
  width: number;
  height: number;
}

/**
 * Renders the target's own content (source + chain, NOT blend/opacity:
 * those stay live on the layer, applied when compositing onto its parent)
 * at `time`, and reads it back. Returns null if `target` doesn't resolve to
 * a renderable layer. Injected: localHost.ts wires the real
 * core/engine.ts renderSubtree() + GPU readback; burn-edits.test.ts fakes it.
 */
export type BurnRenderer = (target: LayerId, time: Seconds) => Promise<BurnFrame | null>;

let counter = 0;
/** Collision-safe within a session: monotonic counter, not wall-clock (two
 * burns in the same millisecond would otherwise collide). */
function freshAssetId(prefix: string, layer: LayerId): AssetId {
  counter += 1;
  return assetId(`${prefix}-${layer}-${counter}`);
}

/**
 * Clones the target layer, lets `mutate` rewrite its source/chain/liveness/
 * baked fields, and returns the removeLayer+addLayer pair that swaps it in
 * at the same position. Null if `target` isn't a Layer (a group, or missing).
 * Burning a group/object is out of scope this phase (see report).
 */
function swapLayerEdits(doc: DocumentJSON, target: LayerId, mutate: (clone: Layer) => void): DocEdit[] | null {
  const found = findLayer(doc, target);
  if (!found || found.node.kind !== 'layer') return null;
  const clone: Layer = structuredClone(found.node);
  mutate(clone);
  return [
    { op: 'removeLayer', id: target },
    { op: 'addLayer', parent: found.parentId, index: found.index, layer: clone },
  ];
}

async function burnStill(doc: DocumentJSON, target: LayerId, time: Seconds, render: BurnRenderer): Promise<BurnResult> {
  const frame = await render(target, time);
  if (!frame) return { edits: [] };

  const asset = freshAssetId('burn-still', target);
  const swap = swapLayerEdits(doc, target, (clone) => {
    clone.source = { type: 'core.raster', params: { asset: { asset } } };
    clone.chain = [];
    clone.liveness = 'baked';
    delete clone.baked;
  });
  if (!swap) return { edits: [] };

  return {
    edits: [
      { op: 'addAsset', id: asset, asset: { type: 'raster', data: frame.data, width: frame.width, height: frame.height } },
      ...swap,
    ],
  };
}

async function burnClip(
  doc: DocumentJSON,
  target: LayerId,
  range: NonNullable<BurnRequest['range']>,
  render: BurnRenderer,
): Promise<BurnResult> {
  const fps = range.fps ?? doc.clock.fps;
  const frameCount = Math.max(1, Math.round((range.to - range.from) * fps) + 1);

  const frames: ArrayBuffer[] = [];
  let width = 0;
  let height = 0;
  for (let i = 0; i < frameCount; i += 1) {
    const t = range.from + i / fps;
    const frame = await render(target, t);
    if (!frame) return { edits: [] };
    frames.push(frame.data);
    width = frame.width;
    height = frame.height;
  }

  const asset = freshAssetId('burn-clip', target);
  const swap = swapLayerEdits(doc, target, (clone) => {
    clone.liveness = 'baked';
    clone.baked = { clip: asset, frames: frames.length, fps };
    clone.chain = [];
  });
  if (!swap) return { edits: [] };

  return {
    edits: [
      { op: 'addAsset', id: asset, asset: { type: 'clip', frames, width, height, fps } },
      ...swap,
    ],
  };
}

/**
 * Entry point localHost.ts's burn() delegates to. `req.target` is typed
 * LayerId | ObjectId in the frozen protocol; only a LayerId that resolves to
 * a Layer (not a group) is handled this phase. Anything else is a no-op
 * ({ edits: [] }), matching the UI's existing "no-op for now" fallback in
 * app/commands/registry.ts (mergeDown/flatten).
 *
 * `currentTime` is the live playhead (BurnRequest carries no time field of
 * its own: 'still' always bakes "now"); 'clip' ignores it and walks
 * `req.range` instead.
 */
export async function burn(
  doc: DocumentJSON,
  req: BurnRequest,
  currentTime: Seconds,
  render: BurnRenderer,
): Promise<BurnResult> {
  const target = req.target as LayerId;
  if (req.mode === 'clip') {
    if (!req.range) return { edits: [] };
    return burnClip(doc, target, req.range, render);
  }
  return burnStill(doc, target, currentTime, render);
}
