/**
 * Pure helpers for the layers panel, split out for unit testing without
 * lit-html or an engine.
 */

import type { DocumentJSON, LayerNode } from '@engine';
import type { LayerId } from '@engine';

export interface DisplayRow {
  node: LayerNode;
  depth: number;
  parentId: LayerId | null;
}

/**
 * Doc storage is bottom-first (index 0 = bottom of the stack); the panel
 * shows top-first, so this walks each sibling list in reverse.
 *
 * `collapsed` (group ids whose children are hidden in the panel) is
 * optional and defaults to "nothing collapsed": every existing caller
 * that doesn't know about collapse state keeps its current behaviour.
 */
export function displayOrder(doc: DocumentJSON, collapsed?: ReadonlySet<LayerId>): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const walk = (nodes: LayerNode[], depth: number, parentId: LayerId | null) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]!;
      rows.push({ node, depth, parentId });
      if (node.kind === 'group' && !collapsed?.has(node.id)) walk(node.children, depth + 1, node.id);
    }
  };
  walk(doc.layers, 0, null);
  return rows;
}

/** Next layer id when walking the displayed (top-first) row list. dir -1 =
 * toward the top (selectAbove), +1 = toward the bottom (selectBelow). */
export function activeWalk(doc: DocumentJSON, current: LayerId | null, dir: -1 | 1): LayerId | null {
  const rows = displayOrder(doc);
  if (rows.length === 0) return null;
  if (current === null) return rows[0]!.node.id;
  const idx = rows.findIndex((r) => r.node.id === current);
  if (idx === -1) return rows[0]!.node.id;
  const next = idx + dir;
  if (next < 0 || next >= rows.length) return current;
  return rows[next]!.node.id;
}

function isSelfOrDescendant(node: LayerNode, id: LayerId): boolean {
  if (node.id === id) return true;
  if (node.kind === 'group') return node.children.some((c) => isSelfOrDescendant(c, id));
  return false;
}

/**
 * Depth-aware drop resolution for the layers panel's drag-reorder. `rows`
 * is the CURRENT display list (top-first, as produced by `displayOrder`,
 * collapsed groups already excluded: dropTarget itself has no notion of
 * collapse, it just works over whatever rows it's given); `dropRow` is the
 * row index the pointer is currently over; `dragId` is the layer being
 * dragged. Returns the `{parent, index}` a `reorderLayer` DocEdit should
 * use, or null for a no-op drop (dragging a group onto itself or one of
 * its own descendants).
 *
 * Two drop modes:
 *  - Hovering a GROUP row drops INTO it, as its new top child (index =
 *    the group's children.length, since children arrays are bottom-first:
 *    appending puts the dragged node at the top of that group's stack).
 *  - Hovering any other row inserts among ITS siblings (parent = that
 *    row's parentId), at the position implied by the row's place in the
 *    top-first sibling order.
 *
 * Index math mirrors the single-array formula this replaced
 * (see git history / src/ui/CLAUDE.md): `document.ts`'s reorderLayer
 * removes the dragged node from its CURRENT parent array first, then
 * splices it into the destination array, so when the destination is the
 * SAME array the dragged node is already in, the destination's length at
 * insertion time is one less than what's currently visible (one entry is
 * about to disappear from it); when the destination is a DIFFERENT array,
 * its length is unchanged (the dragged node isn't in it yet). Given a
 * destination array of length L (as it will be at the moment of
 * insertion) and a target row position `local` (0 = top) within that same
 * array's current display order, the equivalent doc-index is `L - local`
 * (append works out to `local = 0` when the destination gains a brand-new
 * top; the same-array case additionally has `local` count the dragged
 * node itself, per the `-1`).
 */
export function dropTarget(
  rows: DisplayRow[],
  dropRow: number,
  dragId: LayerId,
): { parent: LayerId | null; index: number } | null {
  if (rows.length === 0) return null;
  const dragRow = rows.find((r) => r.node.id === dragId);
  if (!dragRow) return null;

  const clamped = Math.max(0, Math.min(rows.length - 1, dropRow));
  const target = rows[clamped]!;

  const destParent = target.node.kind === 'group' ? target.node.id : target.parentId;
  if (destParent !== null && isSelfOrDescendant(dragRow.node, destParent)) return null;

  if (target.node.kind === 'group') {
    const total = target.node.children.length;
    const sameParent = dragRow.parentId === target.node.id;
    return { parent: target.node.id, index: sameParent ? total - 1 : total };
  }

  const siblings = rows.filter((r) => r.parentId === target.parentId);
  const local = siblings.findIndex((r) => r.node.id === target.node.id);
  const total = siblings.length;
  const sameParent = dragRow.parentId === target.parentId;
  const destLen = sameParent ? total - 1 : total;
  return { parent: target.parentId, index: destLen - local };
}
