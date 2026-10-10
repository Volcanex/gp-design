/**
 * Pure doc-space bounds lookup for the selection overlay (select-tool.ts).
 * EngineHost is FROZEN and has no "give me this object's screen rect" call,
 * so this reads straight out of DocumentJSON via @engine's exported pure
 * helpers (sceneObjects/walkObjects/findObjectInTree/contentBoxOf/
 * transformedCorners): same tree-walk and transform math the engine's
 * scene source and hitTest use, so the overlay never disagrees with what's
 * actually on screen.
 */

import type { DocumentJSON, Layer, LayerId, ObjectId, ObjectNode } from '@engine';
import { sceneObjects, findObjectInTree, contentBoxOf, transformedCorners } from '@engine';

export function findSceneObject(doc: DocumentJSON, layer: LayerId, id: ObjectId): ObjectNode | null {
  const layerNode = doc.layers.find((l): l is Layer => l.kind === 'layer' && l.id === layer);
  if (!layerNode) return null;
  const objects = sceneObjects(layerNode);
  if (!objects) return null;
  return findObjectInTree(objects, id)?.node ?? null;
}

/** The object's content-box corners in DOC space (pre-zoom/pan), TL/TR/BR/BL. */
export function objectDocCorners(doc: DocumentJSON, layer: LayerId, id: ObjectId): [number, number][] | null {
  const node = findSceneObject(doc, layer, id);
  if (!node) return null;
  const box = contentBoxOf(node.content, { getAsset: (assetId) => doc.assets[assetId] });
  return transformedCorners(node.transform, box);
}

/**
 * doc-space corners -> px relative to the CANVAS ELEMENT's own top-left.
 * Deliberately zoom-only (no pan): the canvas is flex-centred by CSS and
 * panned via a `transform: translate(...)`, so its actual on-screen
 * position can't be derived from panX/panY alone. The caller must read
 * the live canvas.getBoundingClientRect() (same approach viewport.ts's
 * toDocPoint uses) and add that offset itself. Keeping this helper
 * DOM-free is why it stops at "canvas-local px".
 */
export function docCornersToCanvasPx(corners: readonly [number, number][], zoom: number): [number, number][] {
  return corners.map(([x, y]) => [x * zoom, y * zoom]);
}
