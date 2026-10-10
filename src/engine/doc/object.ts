/**
 * ObjectNode factories and tree utilities. Objects nest via `children` and
 * live inside a Layer's scene source (see document.ts `sceneObjects`). This
 * module only knows about the ObjectNode tree shape, never about layers.
 */

import type { ObjectId } from '../core/types';
import { identityTransform } from '../core/types';
import type { ObjectNode, ObjectContent, ObjectStyle } from './json';

export interface CreateObjectPartial {
  id: ObjectId;
  name: string;
  content: ObjectContent;
  style?: ObjectStyle;
  enabled?: boolean;
  transform?: ReturnType<typeof identityTransform>;
  liveness?: 'live' | 'baked';
  children?: ObjectNode[];
}

export function createObject(partial: CreateObjectPartial): ObjectNode {
  const node: ObjectNode = {
    id: partial.id,
    name: partial.name,
    enabled: partial.enabled ?? true,
    transform: partial.transform ?? identityTransform(),
    content: partial.content,
    style: partial.style ?? {},
    liveness: partial.liveness ?? 'live',
  };
  if (partial.children) node.children = partial.children;
  return node;
}

export interface ObjectLocation {
  node: ObjectNode;
  parent: ObjectNode[];
  index: number;
}

/** Depth-first walk over an object tree, visiting every node exactly once. */
export function walkObjects(
  objects: ObjectNode[],
  cb: (node: ObjectNode, parent: ObjectNode[], index: number) => void,
): void {
  objects.forEach((node, index) => {
    cb(node, objects, index);
    if (node.children) walkObjects(node.children, cb);
  });
}

/** Find a node anywhere in an object tree by id. */
export function findObjectInTree(objects: ObjectNode[], id: ObjectId): ObjectLocation | null {
  let found: ObjectLocation | null = null;
  for (let i = 0; i < objects.length; i += 1) {
    const node = objects[i]!;
    if (node.id === id) return { node, parent: objects, index: i };
    if (node.children) {
      found = findObjectInTree(node.children, id);
      if (found) return found;
    }
  }
  return found;
}
