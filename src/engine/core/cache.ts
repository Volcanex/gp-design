/**
 * Revision tracker: monotonic per-node counters the renderer/UI use to
 * decide "did this subtree change since I last drew it". Deliberately
 * simple: no dependency graph, just bump-and-compare.
 */

import type { LayerId } from './types';
import type { DocumentJSON, LayerNode } from '../doc/json';
import { findLayer } from '../doc/document';

export interface RevisionTracker {
  bump(id: string): void;
  get(id: string): number;
  /** Max revision across `layerId` and every descendant (groups only nest). */
  subtreeRev(doc: DocumentJSON, layerId: LayerId): number;
}

export function createRevisionTracker(): RevisionTracker {
  const revisions = new Map<string, number>();

  const get = (id: string) => revisions.get(id) ?? 0;

  return {
    bump(id: string) { revisions.set(id, get(id) + 1); },
    get,
    subtreeRev(doc: DocumentJSON, layerId: LayerId): number {
      const found = findLayer(doc, layerId);
      if (!found) return get(layerId);
      let max = get(layerId);
      if (found.node.kind === 'group') {
        const walkChildren = (nodes: LayerNode[]) => {
          for (const child of nodes) {
            max = Math.max(max, get(child.id));
            if (child.kind === 'group') walkChildren(child.children);
          }
        };
        walkChildren(found.node.children);
      }
      return max;
    },
  };
}
