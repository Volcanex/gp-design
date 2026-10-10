/**
 * Shared image -> layer pipeline for File > Open, drag-drop, and Paste (both
 * the internal raster-clipboard path and the OS-clipboard fallback, which
 * both route through importImageFile). Builds an addAsset + addLayer(scene)
 * + addObject edit batch and pushes it through history as ONE undo step,
 * exactly like any other content command (see registry.ts's layer.new/
 * duplicate).
 *
 * Imports are OBJECTS, not full-canvas layers: a bare `core.image` layer's
 * shader samples uv across the WHOLE canvas (stretching any non-canvas-
 * aspect image) and layers have no on-canvas manipulation (only scene
 * objects get move/resize/rotate handles, see select-tool.ts). So every
 * import creates one fresh core.scene layer holding a single image object,
 * sized to the image's native pixel dimensions (contain-fit, never
 * stretched, only shrunk if larger than the canvas, see fitImageSize) and
 * centred on the canvas. The object is selected and the move tool activated
 * immediately after, so the next drag moves it. See src/ui/CLAUDE.md's
 * "imports are objects" note. video-import.ts's baked clip layers are the
 * one deliberate exception (full-canvas is correct there); don't reuse this
 * import path's shape for that.
 *
 * Downscaling: only kicks in when a dimension exceeds MAX_IMAGE_DIM. When it
 * does, the pixels are re-encoded via canvas so doc.assets stays consistent
 * with the object's actual resolution: storing the original oversized bytes
 * next to a shrunk width/height would desync the asset from what core.scene
 * uploads to the GPU.
 */

import type { AppCtx } from '../types';
import type { DocEdit, LayerId, LayerNode, ObjectNode } from '@engine';
import { layerId, assetId, objectId, identityTransform, createObject, findLayer } from '@engine';
import { showStatusMessage, viewState, selectionState, toolState } from '../stores';
import { history } from './app-history';
import { patchCommand } from './command';

const MAX_IMAGE_DIM = 4096;

interface DecodedImage {
  mime: string;
  data: ArrayBuffer;
  width: number;
  height: number;
}

/** Marks a failure as having happened inside decodeImage (bad/corrupt bytes,
 * createImageBitmap rejecting) so importImageFile's catch can tell that
 * apart from a downstream failure (history push, engine render): those
 * mean the image decoded fine and blaming decode misdirects debugging. */
class ImageDecodeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ImageDecodeError';
  }
}

/** Exported so the asset picker's importNew('image') (effect-dialog.ts) can
 * reuse the decode/downscale path without duplicating it. It needs the
 * bytes to addAsset directly, not addLayer. */
export async function decodeImage(blob: Blob): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width <= MAX_IMAGE_DIM && bitmap.height <= MAX_IMAGE_DIM) {
      return { mime: blob.type || 'image/png', data: await blob.arrayBuffer(), width: bitmap.width, height: bitmap.height };
    }
    const scale = MAX_IMAGE_DIM / Math.max(bitmap.width, bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable for downscale');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const resized = await canvas.convertToBlob({ type: 'image/png' });
    return { mime: 'image/png', data: await resized.arrayBuffer(), width, height };
  } finally {
    bitmap.close();
  }
}

/** Mirrors registry.ts's siblingInsertPoint: new layer lands just above the
 * active one, in ITS OWN sibling list (its parent group, or the document
 * root), not just doc.layers. Otherwise importing while a nested layer is
 * active would silently drop the new layer at the document root instead of
 * next to it. */
function siblingInsertPoint(app: AppCtx): { parent: LayerId | null; index: number } {
  const doc = app.engine.getDocument();
  const active = viewState.get().activeLayer;
  if (!active) return { parent: null, index: doc.layers.length };
  const found = findLayer(doc, layerId(active));
  if (!found) return { parent: null, index: doc.layers.length };
  return { parent: found.parentId, index: found.index + 1 };
}

/** Contain-fit: native size unless it overflows the canvas on either axis,
 * in which case both dimensions scale down uniformly (aspect preserved) so
 * the larger axis exactly fits. Never stretched, never upscaled. */
function fitImageSize(width: number, height: number, canvasWidth: number, canvasHeight: number): { width: number; height: number } {
  const scale = Math.min(1, canvasWidth / width, canvasHeight / height);
  return { width: width * scale, height: height * scale };
}

export async function importImageAsLayer(app: AppCtx, blob: Blob, name: string): Promise<void> {
  let decoded: DecodedImage;
  try {
    decoded = await decodeImage(blob);
  } catch (err) {
    throw new ImageDecodeError(err);
  }
  const { mime, data, width, height } = decoded;
  const id = assetId(crypto.randomUUID());
  const doc = app.engine.getDocument();
  const fitted = fitImageSize(width, height, doc.canvas.width, doc.canvas.height);
  const object: ObjectNode = createObject({
    id: objectId(crypto.randomUUID()),
    name,
    content: { type: 'image', asset: id },
    // Content box resolves to the asset's NATIVE width/height (contentBoxOf,
    // core/transform2d.ts); scaleX/scaleY (equal, so aspect can't skew) apply
    // fitImageSize's shrink-if-needed on top of that.
    transform: {
      x: doc.canvas.width / 2,
      y: doc.canvas.height / 2,
      rotation: 0,
      scaleX: fitted.width / width,
      scaleY: fitted.height / height,
      anchorX: 0.5,
      anchorY: 0.5,
    },
  });
  const layer: LayerNode = {
    id: layerId(crypto.randomUUID()),
    kind: 'layer',
    name,
    enabled: true,
    source: { type: 'core.scene', params: {} },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'live',
  };
  const { parent, index } = siblingInsertPoint(app);
  const edits: DocEdit[] = [
    { op: 'addAsset', id, asset: { type: 'image', mime, data, width, height } },
    { op: 'addLayer', parent, index, layer },
    { op: 'addObject', layer: layer.id, parent: null, index: 0, object },
  ];
  history.push(app, patchCommand('Import Image', edits));
  viewState.update((s) => ({ ...s, activeLayer: layer.id }));
  selectionState.set({ objects: [object.id], marquee: null });
  toolState.update((s) => ({ ...s, active: 'move' }));
}

/** File.open and drag-and-drop both funnel through this so a bad image
 * surfaces in the statusbar instead of dying silently in the console. */
export async function importImageFile(app: AppCtx, blob: Blob, name: string): Promise<void> {
  try {
    await importImageAsLayer(app, blob, name);
  } catch (err) {
    console.error('[gdesign] import image failed', err);
    showStatusMessage(err instanceof ImageDecodeError ? "Couldn't decode image" : "Couldn't import image");
  }
}

/** The asset picker's importNew('image') (effect-dialog.ts's opts.assets):
 * decodes and registers an `image`-type asset directly via addAsset, one
 * undo step. No layer, since a chain param's asset ref doesn't need one.
 * Returns null (and surfaces the statusbar toast) on a bad file instead of
 * throwing, so a picker popover can just no-op rather than needing its own
 * try/catch. */
export async function importImageAsset(app: AppCtx, blob: Blob): Promise<{ asset: string } | null> {
  let decoded: DecodedImage;
  try {
    decoded = await decodeImage(blob);
  } catch (err) {
    console.error('[gdesign] import image asset failed', err);
    showStatusMessage("Couldn't decode image");
    return null;
  }
  const { mime, data, width, height } = decoded;
  const id = assetId(crypto.randomUUID());
  history.push(app, patchCommand('Import Image Asset', [{ op: 'addAsset', id, asset: { type: 'image', mime, data, width, height } }]));
  return { asset: id };
}
