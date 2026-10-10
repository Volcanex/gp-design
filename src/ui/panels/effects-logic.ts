/**
 * Pure helpers for the Effects panel, split out for unit testing without
 * lit-html or an engine (mirrors layers-logic.ts's split).
 *
 * Chain storage order is append order (index 0 = first applied); the panel
 * displays newest-applied-first (top = last-applied), so display row i is
 * chain index `chain.length - 1 - i`, the same top-first/bottom-first
 * inversion layers-logic.ts's displayOrder uses for doc.layers. reorderedChain
 * avoids re-deriving that index math directly (the layers-panel family has
 * shipped two off-by-one drag bugs from doing exactly that): it moves the
 * dragged entry within the DISPLAYED (reversed) list using the same
 * "splice out, splice back in" idiom the layers-logic exhaustive test checks
 * against, then reverses back to chain (storage) order.
 */

import type { Chain, DocumentJSON, LayerId, LayerNode, NodePath, ObjectId, ObjectNode } from '@engine';
import { objectId, sceneObjects, findObjectInTree } from '@engine';
import { findLayerNode } from '../dialogs/dialog-shell';

/** Chain (append order) -> display order (newest/top-first). */
export function displayChain(chain: Chain): Chain {
  return [...chain].reverse();
}

export function toggledChain(chain: Chain, instanceId: string): Chain {
  return chain.map((fx) => (fx.id === instanceId ? { ...fx, enabled: !fx.enabled } : fx));
}

export function removedChain(chain: Chain, instanceId: string): Chain {
  return chain.filter((fx) => fx.id !== instanceId);
}

/** fromRow/dropRow are DISPLAY (top-first) row indices. */
export function reorderedChain(chain: Chain, fromRow: number, dropRow: number): Chain {
  const display = displayChain(chain);
  const total = display.length;
  if (total === 0) return chain;
  const from = Math.max(0, Math.min(total - 1, fromRow));
  const to = Math.max(0, Math.min(total - 1, dropRow));
  const next = [...display];
  const [dragged] = next.splice(from, 1);
  next.splice(to, 0, dragged!);
  return next.reverse();
}

/**
 * Resolves the chain a NodePath addresses, mirroring engine/doc/document.ts's
 * resolveChainContainer (that one is engine-internal; the UI needs a
 * read-only equivalent to show a chain before any edit is made). Returns
 * null when the target doesn't resolve (deleted layer/object, or an
 * 'effect' target: a single instance, not a whole chain).
 */
export function chainForTarget(doc: DocumentJSON, target: NodePath): Chain | null {
  if (target.kind === 'document') return doc.postChain;
  if (target.kind === 'layer') {
    const node = findLayerNode(doc.layers, target.id);
    return node ? node.chain : null;
  }
  if (target.kind === 'object') {
    const layer = findLayerNode(doc.layers, target.layer);
    if (!layer || layer.kind !== 'layer') return null;
    const objects = sceneObjects(layer);
    if (!objects) return null;
    const found = findObjectInTree(objects, target.id);
    return found ? found.node.chain ?? [] : null;
  }
  return null;
}

function findObjectAndLayerInLayerNode(node: LayerNode, id: ObjectId): { node: ObjectNode; layer: LayerId } | null {
  if (node.kind === 'layer') {
    const objects = sceneObjects(node);
    const hit = objects ? findObjectInTree(objects, id) : null;
    return hit ? { node: hit.node, layer: node.id } : null;
  }
  for (const child of node.children) {
    const found = findObjectAndLayerInLayerNode(child, id);
    if (found) return found;
  }
  return null;
}

/** The single selected object, anywhere in the doc's scene layers (recursing
 * through groups), along with the id of the layer whose scene it lives in
 * (setParam/setTransform's object targets need that layer id). Null when
 * zero or more than one object is selected. Any content type. */
export function findSelectedObject(
  doc: DocumentJSON, selectedIds: readonly string[],
): { node: ObjectNode; layer: LayerId } | null {
  if (selectedIds.length !== 1) return null;
  const id = objectId(selectedIds[0]!);
  for (const layerNode of doc.layers) {
    const hit = findObjectAndLayerInLayerNode(layerNode, id);
    if (hit) return hit;
  }
  return null;
}

/** findSelectedObject, narrowed to a text object. Null otherwise
 * (including when nothing/more-than-one object is selected). */
export function findSelectedTextObject(doc: DocumentJSON, selectedIds: readonly string[]): ObjectNode | null {
  const found = findSelectedObject(doc, selectedIds);
  return found && found.node.content.type === 'text' ? found.node : null;
}
