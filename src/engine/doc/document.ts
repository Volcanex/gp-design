/**
 * THE mutation engine. `applyEdit`/`applyEdits` are the ONLY way to change a
 * DocumentJSON. Every op returns its own inverse so undo is just replaying
 * inverses (host/protocol.ts's contract).
 *
 * Scene-object storage: a Layer's scene objects live at
 * `layer.source.params['scene']` as an `ObjectNode[]`. ObjectNode is plain
 * JSON (no classes/functions), so this is structurally a valid ParamValue.
 * TypeScript just doesn't have a union member that says so, hence the casts
 * in `sceneObjects`/`setSceneObjects` below. Do not add a real `scene: ...`
 * field to ParamValue; params/schema.ts is a frozen contract.
 */

import type { AssetRef, LayerId, ObjectId, Rect } from '../core/types';
import type { Chain, EffectInstance } from '../passes/chain';
import type { DocumentJSON, Layer, LayerGroup, LayerNode, ObjectNode, ObjectStyle, AssetJSON } from './json';
import type { DocEdit, NodePath } from '../host/protocol';
import type { ParamValue, ParamValues } from '../params/schema';
import { findObjectInTree, walkObjects } from './object';

// ---------------------------------------------------------------------------
// Tree utilities

export interface LayerLocation {
  node: LayerNode;
  parent: LayerNode[];
  index: number;
  /** null when parent is the document root (doc.layers). */
  parentId: LayerId | null;
}

/** Depth-first walk over the layer tree, visiting every node exactly once. */
export function walkLayers(
  doc: DocumentJSON,
  cb: (node: LayerNode, parent: LayerNode[], index: number) => void,
): void {
  const walk = (nodes: LayerNode[]) => {
    nodes.forEach((node, index) => {
      cb(node, nodes, index);
      if (node.kind === 'group') walk(node.children);
    });
  };
  walk(doc.layers);
}

/** Every node id (layer AND group) currently in the tree: the eviction
 * walk's notion of "still exists", used by core/engine.ts's reconcile() to
 * decide which per-layer GPU caches (sourceCache, clipTextureCache,
 * maskTextureCache) to drop. Group ids are harmless to include even though
 * those caches never key off one. */
export function liveLayerIds(doc: DocumentJSON): Set<LayerId> {
  const ids = new Set<LayerId>();
  walkLayers(doc, (node) => { ids.add(node.id); });
  return ids;
}

/** Given the id set a per-layer GPU cache currently holds, which of them no
 * longer correspond to a node in `doc`, i.e. should be evicted. Pure: no
 * GPU, no side effects, safe for unit tests. */
export function evictedLayerIds(doc: DocumentJSON, cachedIds: Iterable<LayerId>): LayerId[] {
  const live = liveLayerIds(doc);
  return Array.from(cachedIds).filter((id) => !live.has(id));
}

function isAssetRef(v: ParamValue): v is AssetRef {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'asset' in v
    && typeof (v as { asset: unknown }).asset === 'string';
}

function collectChainAssetRefs(chain: Chain | undefined, ids: Set<string>): void {
  if (!chain) return;
  for (const fx of chain) {
    for (const v of Object.values(fx.params)) {
      if (isAssetRef(v)) ids.add(v.asset);
    }
  }
}

function collectObjectAssetRefs(objects: ObjectNode[] | null | undefined, ids: Set<string>): void {
  if (!objects) return;
  walkObjects(objects, (node) => {
    if (node.content.type === 'image') ids.add(node.content.asset);
    if (node.content.type === 'text' && node.content.text.font !== 'default') ids.add(node.content.text.font);
    collectChainAssetRefs(node.chain, ids);
  });
}

/** Every asset id still reachable from `doc`: a layer's source params, its
 * mask, any chain's asset-kind param (layer/group/document-post/object),
 * and scene object image/font content. Used to decide which entries in
 * core/asset-textures.ts's cache (asset-kind chain params only) are safe to
 * release; deliberately broader than that one cache's actual key space
 * (source params, masks, baked clips) so an id is never dropped while
 * anything at all still points at it. */
export function liveAssetIds(doc: DocumentJSON): Set<string> {
  const ids = new Set<string>();
  collectChainAssetRefs(doc.postChain, ids);
  walkLayers(doc, (node) => {
    collectChainAssetRefs(node.chain, ids);
    if (node.kind === 'layer') {
      if (node.mask) ids.add(node.mask.asset);
      if (node.baked) ids.add(node.baked.clip);
      for (const v of Object.values(node.source.params)) {
        if (isAssetRef(v)) ids.add(v.asset);
      }
      collectObjectAssetRefs(sceneObjects(node), ids);
    }
  });
  return ids;
}

/** Given the id set core/asset-textures.ts's cache currently holds, which of
 * them are no longer referenced anywhere in `doc`, i.e. should be evicted.
 * Pure, mirrors evictedLayerIds. */
export function evictedAssetIds(doc: DocumentJSON, cachedIds: Iterable<string>): string[] {
  const live = liveAssetIds(doc);
  return Array.from(cachedIds).filter((id) => !live.has(id));
}

export function findLayer(doc: DocumentJSON, id: LayerId): LayerLocation | null {
  const search = (nodes: LayerNode[], parentId: LayerId | null): LayerLocation | null => {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      if (node.id === id) return { node, parent: nodes, index: i, parentId };
      if (node.kind === 'group') {
        const found = search(node.children, node.id);
        if (found) return found;
      }
    }
    return null;
  };
  return search(doc.layers, null);
}

/** Children array of a LayerGroup, or null if `id` is missing/not a group. */
function findGroupChildren(doc: DocumentJSON, id: LayerId): LayerNode[] | null {
  const found = findLayer(doc, id);
  if (!found || found.node.kind !== 'group') return null;
  return found.node.children;
}

export function findObject(
  doc: DocumentJSON,
  layerId: LayerId,
  objectId: ObjectId,
): { node: ObjectNode; parent: ObjectNode[]; index: number } | null {
  const layer = findLayer(doc, layerId);
  if (!layer || layer.node.kind !== 'layer') return null;
  const objects = sceneObjects(layer.node);
  if (!objects) return null;
  return findObjectInTree(objects, objectId);
}

/** Search every layer's scene for an object id, without knowing its layer. */
function findObjectAnywhere(
  doc: DocumentJSON,
  objectId: ObjectId,
): { node: ObjectNode; parent: ObjectNode[]; index: number; layerId: LayerId } | null {
  let found: { node: ObjectNode; parent: ObjectNode[]; index: number; layerId: LayerId } | null = null;
  walkLayers(doc, (node) => {
    if (found || node.kind !== 'layer') return;
    const objects = sceneObjects(node);
    if (!objects) return;
    const hit = findObjectInTree(objects, objectId);
    if (hit) found = { ...hit, layerId: node.id };
  });
  return found;
}

/**
 * Scene objects for a Layer, or null if this layer's source carries none.
 * See module doc comment for why the cast is safe.
 */
export function sceneObjects(layer: Layer): ObjectNode[] | null {
  const raw = layer.source.params['scene'];
  if (raw === undefined) return null;
  return raw as unknown as ObjectNode[];
}

function setSceneObjects(layer: Layer, objects: ObjectNode[]): void {
  layer.source.params['scene'] = objects as unknown as ParamValue;
}

function findEffect(
  doc: DocumentJSON,
  owner: LayerId | ObjectId,
  instance: string,
): { chain: EffectInstance[]; index: number } | null {
  const layer = findLayer(doc, owner as LayerId);
  if (layer && (layer.node.kind === 'layer' || layer.node.kind === 'group')) {
    const index = layer.node.chain.findIndex((fx) => fx.id === instance);
    if (index >= 0) return { chain: layer.node.chain, index };
  }
  const object = findObjectAnywhere(doc, owner as ObjectId);
  if (object && object.node.chain) {
    const index = object.node.chain.findIndex((fx) => fx.id === instance);
    if (index >= 0) return { chain: object.node.chain, index };
  }
  return null;
}

function resolveChainContainer(
  doc: DocumentJSON,
  target: NodePath,
): { get: () => Chain; set: (chain: Chain) => void } | null {
  if (target.kind === 'layer') {
    const found = findLayer(doc, target.id);
    if (!found) return null;
    const node = found.node;
    return { get: () => node.chain, set: (chain) => { node.chain = chain; } };
  }
  if (target.kind === 'object') {
    const found = findObject(doc, target.layer, target.id);
    if (!found) return null;
    const node = found.node;
    return { get: () => node.chain ?? [], set: (chain) => { node.chain = chain; } };
  }
  if (target.kind === 'document') {
    return { get: () => doc.postChain, set: (chain) => { doc.postChain = chain; } };
  }
  // 'effect' targets a single instance, not a whole chain. Not addressable here.
  return null;
}

function findLayerOrObjectField(
  doc: DocumentJSON,
  id: LayerId | ObjectId,
): { setEnabled: (v: boolean) => boolean; setName: (v: string) => string } | null {
  const layer = findLayer(doc, id as LayerId);
  if (layer) {
    const node = layer.node;
    return {
      setEnabled: (v) => { const old = node.enabled; node.enabled = v; return old; },
      setName: (v) => { const old = node.name; node.name = v; return old; },
    };
  }
  const object = findObjectAnywhere(doc, id as ObjectId);
  if (object) {
    const node = object.node;
    return {
      setEnabled: (v) => { const old = node.enabled; node.enabled = v; return old; },
      setName: (v) => { const old = node.name; node.name = v; return old; },
    };
  }
  return null;
}

/**
 * Internal-only convention: passing `undefined` (cast to ParamValue) means
 * "delete this key". Used to invert setParam edits that introduced a key
 * which previously did not exist. DocEdit has no dedicated remove-param op.
 */
function setParamValue(params: ParamValues, key: string, value: ParamValue): void {
  if (value === undefined) delete params[key];
  else params[key] = value;
}

// ---------------------------------------------------------------------------
// applyEdit

export function applyEdit(doc: DocumentJSON, edit: DocEdit): DocEdit | null {
  switch (edit.op) {
    case 'setParam': {
      const { target, key } = edit;
      // 'object' targets have no generic ParamValues bag in the frozen
      // ObjectNode contract (doc/json.ts). A small, named set of keys is
      // special-cased below instead of adding one; everything else on an
      // object target is still a no-op. Sanctioned keys (mirrored in
      // src/ui/CLAUDE.md's Object-panel section): 'content.text' (the text
      // tool's string edits), 'content.size' (text-only, ObjectContent's
      // TextSpec.size), 'content.fill' (shape fill OR text colour: both
      // live in ObjectStyle.fill, not per-content-type, so one key covers
      // both; not content-type-gated the way the other two are).
      if (target.kind === 'object' && key === 'content.text') {
        const found = findObject(doc, target.layer, target.id);
        const content = found?.node.content;
        if (!found || !content || content.type !== 'text') return null;
        const old = content.text.text;
        found.node.content = { type: 'text', text: { ...content.text, text: String(edit.value) } };
        return { op: 'setParam', target, key, value: old };
      }
      if (target.kind === 'object' && key === 'content.size') {
        const found = findObject(doc, target.layer, target.id);
        const content = found?.node.content;
        if (!found || !content || content.type !== 'text') return null;
        const old = content.text.size;
        found.node.content = { type: 'text', text: { ...content.text, size: Number(edit.value) } };
        return { op: 'setParam', target, key, value: old };
      }
      if (target.kind === 'object' && key === 'content.fill') {
        const found = findObject(doc, target.layer, target.id);
        if (!found) return null;
        const old = found.node.style.fill;
        const value = edit.value as ObjectStyle['fill'] | undefined;
        if (value === undefined) delete found.node.style.fill;
        else found.node.style = { ...found.node.style, fill: value };
        return { op: 'setParam', target, key, value: old as unknown as ParamValue };
      }
      let params: ParamValues | null = null;
      if (target.kind === 'layer') {
        const found = findLayer(doc, target.id);
        if (found && found.node.kind === 'layer') params = found.node.source.params;
      } else if (target.kind === 'effect') {
        const fx = findEffect(doc, target.owner, target.instance);
        if (fx) params = fx.chain[fx.index]!.params;
      }
      // 'document' targets have no generic ParamValues bag either: no-op.
      if (!params) return null;
      const hadKey = key in params;
      const old = params[key];
      setParamValue(params, key, edit.value);
      return { op: 'setParam', target, key, value: hadKey ? (old as ParamValue) : (undefined as unknown as ParamValue) };
    }

    case 'addLayer': {
      const destArr = edit.parent === null ? doc.layers : findGroupChildren(doc, edit.parent);
      if (!destArr) return null;
      const index = Math.max(0, Math.min(edit.index, destArr.length));
      destArr.splice(index, 0, edit.layer);
      return { op: 'removeLayer', id: edit.layer.id };
    }

    case 'removeLayer': {
      const found = findLayer(doc, edit.id);
      if (!found) return null;
      const removed = found.parent.splice(found.index, 1)[0]!;
      return { op: 'addLayer', parent: found.parentId, index: found.index, layer: removed };
    }

    case 'reorderLayer': {
      const found = findLayer(doc, edit.id);
      if (!found) return null;
      const destArr = edit.parent === null ? doc.layers : findGroupChildren(doc, edit.parent);
      if (!destArr) return null;
      const { parentId: oldParentId, index: oldIndex } = found;
      found.parent.splice(found.index, 1);
      const destIndex = Math.max(0, Math.min(edit.index, destArr.length));
      destArr.splice(destIndex, 0, found.node);
      return { op: 'reorderLayer', id: edit.id, parent: oldParentId, index: oldIndex };
    }

    case 'setBlend': {
      const found = findLayer(doc, edit.id);
      if (!found) return null;
      const node = found.node;
      const old = node.blendMode;
      node.blendMode = edit.mode;
      return { op: 'setBlend', id: edit.id, mode: old };
    }

    case 'setOpacity': {
      const found = findLayer(doc, edit.id);
      if (!found) return null;
      const node = found.node;
      const old = node.opacity;
      node.opacity = edit.value;
      return { op: 'setOpacity', id: edit.id, value: old };
    }

    case 'setChain': {
      const container = resolveChainContainer(doc, edit.target);
      if (!container) return null;
      const old = container.get();
      container.set(edit.chain);
      return { op: 'setChain', target: edit.target, chain: old };
    }

    case 'setTransform': {
      const layer = findLayer(doc, edit.id as LayerId);
      if (layer && layer.node.kind === 'layer') {
        const node = layer.node;
        const old = node.transform;
        node.transform = edit.transform;
        return { op: 'setTransform', id: edit.id, transform: old };
      }
      const object = findObjectAnywhere(doc, edit.id as ObjectId);
      if (object) {
        const node = object.node;
        const old = node.transform;
        node.transform = edit.transform;
        return { op: 'setTransform', id: edit.id, transform: old };
      }
      return null;
    }

    case 'setEnabled': {
      const field = findLayerOrObjectField(doc, edit.id);
      if (!field) return null;
      const old = field.setEnabled(edit.enabled);
      return { op: 'setEnabled', id: edit.id, enabled: old };
    }

    case 'renameNode': {
      const field = findLayerOrObjectField(doc, edit.id);
      if (!field) return null;
      const old = field.setName(edit.name);
      return { op: 'renameNode', id: edit.id, name: old };
    }

    case 'addObject': {
      const layer = findLayer(doc, edit.layer);
      if (!layer || layer.node.kind !== 'layer') return null;
      let destArr: ObjectNode[] | null;
      if (edit.parent === null) {
        destArr = sceneObjects(layer.node);
        if (!destArr) {
          destArr = [];
          setSceneObjects(layer.node, destArr);
        }
      } else {
        const parentLoc = findObject(doc, edit.layer, edit.parent);
        if (!parentLoc) return null;
        if (!parentLoc.node.children) parentLoc.node.children = [];
        destArr = parentLoc.node.children;
      }
      const index = Math.max(0, Math.min(edit.index, destArr.length));
      destArr.splice(index, 0, edit.object);
      return { op: 'removeObject', layer: edit.layer, id: edit.object.id };
    }

    case 'removeObject': {
      const found = findObject(doc, edit.layer, edit.id);
      if (!found) return null;
      const parentId = findParentObjectId(doc, edit.layer, found.parent);
      const removed = found.parent.splice(found.index, 1)[0]!;
      // Mirror addLayer's lazy-creation of an empty scene/children array:
      // collapse back to "absent" when it empties out, so undo is a true no-op.
      if (found.parent.length === 0) {
        if (parentId === null) {
          delete (findLayer(doc, edit.layer)!.node as Layer).source.params['scene'];
        } else {
          delete findObject(doc, edit.layer, parentId)!.node.children;
        }
      }
      return { op: 'addObject', layer: edit.layer, parent: parentId, index: found.index, object: removed };
    }

    case 'commitRaster': {
      return applyCommitRaster(doc, edit);
    }

    case 'addAsset': {
      if (doc.assets[edit.id]) return null;
      doc.assets[edit.id] = edit.asset;
      return { op: 'removeAsset', id: edit.id };
    }

    case 'removeAsset': {
      const existing = doc.assets[edit.id];
      if (!existing) return null;
      delete doc.assets[edit.id];
      return { op: 'addAsset', id: edit.id, asset: existing };
    }

    case 'setDocClock': {
      const old = doc.clock;
      doc.clock = edit.clock;
      return { op: 'setDocClock', clock: old };
    }

    // MASKS block (additive, 2026-07-07, architect-approved).
    case 'setMask': {
      const found = findLayer(doc, edit.id);
      if (!found || found.node.kind !== 'layer') return null;
      const node = found.node;
      const old = node.mask ?? null;
      if (edit.mask === null) delete node.mask;
      else node.mask = edit.mask;
      return { op: 'setMask', id: edit.id, mask: old };
    }

    default: {
      const _exhaustive: never = edit;
      return _exhaustive;
    }
  }
}

/** Id of the ObjectNode whose `children` array is `parent`, or null if it's the layer's top-level scene. */
function findParentObjectId(doc: DocumentJSON, layerId: LayerId, parent: ObjectNode[]): ObjectId | null {
  const layer = findLayer(doc, layerId);
  if (!layer || layer.node.kind !== 'layer') return null;
  const top = sceneObjects(layer.node);
  if (top === parent) return null;
  let found: ObjectId | null = null;
  if (top) {
    walkObjects(top, (node) => {
      if (node.children === parent) found = node.id;
    });
  }
  return found;
}

const RASTER_BYTES_PER_PIXEL = 8; // rgba16float: 4 channels * 2 bytes

function applyCommitRaster(
  doc: DocumentJSON,
  edit: Extract<DocEdit, { op: 'commitRaster' }>,
): DocEdit | null {
  const asset = doc.assets[edit.asset];
  if (!asset || asset.type !== 'raster') return null;
  const { region } = edit;
  const stride = asset.width * RASTER_BYTES_PER_PIXEL;
  const rowBytes = region.width * RASTER_BYTES_PER_PIXEL;
  const dest = new Uint8Array(asset.data);
  const src = new Uint8Array(edit.data);
  const oldRegionBytes = new Uint8Array(region.height * rowBytes);
  for (let row = 0; row < region.height; row += 1) {
    const destOffset = (region.y + row) * stride + region.x * RASTER_BYTES_PER_PIXEL;
    oldRegionBytes.set(dest.subarray(destOffset, destOffset + rowBytes), row * rowBytes);
    dest.set(src.subarray(row * rowBytes, row * rowBytes + rowBytes), destOffset);
  }
  return {
    op: 'commitRaster',
    layer: edit.layer,
    asset: edit.asset,
    data: oldRegionBytes.buffer,
    region: { ...region } as Rect,
  };
}

// ---------------------------------------------------------------------------
// applyEdits

/** Applies edits in order; returns their inverses in REVERSE order (undo = apply the result). */
export function applyEdits(doc: DocumentJSON, edits: DocEdit[]): DocEdit[] {
  const inverses: DocEdit[] = [];
  for (const edit of edits) {
    const inverse = applyEdit(doc, edit);
    if (inverse) inverses.unshift(inverse);
  }
  return inverses;
}
