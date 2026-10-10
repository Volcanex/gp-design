/**
 * Command dispatcher. execute() always tries shellExecute (track A's
 * panel/view/tool/color UI commands) first, then falls through to the
 * document-editing table owned here. Unknown ids warn and no-op: this is
 * called from keymaps and menus, it must never throw.
 */

import type { AppCtx, Command } from '../types';
import type { AssetJSON, DocEdit, DocumentJSON, LayerId, LayerNode, ObjectId, ObjectNode } from '@engine';
import {
  layerId, objectId, assetId, identityTransform, createObject, createGroup, findLayer as findLayerLocation,
  sceneObjects, findObjectInTree, walkObjects,
} from '@engine';
import { shellExecute } from '../../ui/shell/shell-commands';
import {
  openEffectDialog, openLayerProperties, openExportVideoDialog, openNewDocumentDialog, loadFreshDocument,
  openImportVideoDialog,
} from '../../ui/dialogs';
import { history } from './app-history';
import { patchCommand, uiCommand } from './command';
import { viewState, selectionState, toolState, showStatusMessage } from '../stores';
import { displayOrder, activeWalk } from '../../ui/panels/layers-logic';
import { importImageFile } from './image-import';
import { serializeDocument, deserializeDocument } from './doc-serialize';
import { resolvePaintLayer, commitStrokeEdits } from '../../ui/canvas/paint-layer';
import { whiteMaskBytes } from '../../ui/canvas/mask-paint';
import { wasPasteRecentlyHandled } from './paste-guard';

interface CommandDef {
  label: string;
  run(app: AppCtx, args?: unknown): void;
}

/**
 * Internal clipboard, tagged by what was last copied/cut: 'object' (the
 * most specific, wins Copy when there's a selection) > 'layer' (whole
 * subtree, active layer) > 'raster' (Copy Merged's quantised pixels).
 * edit.paste's precedence (see src/ui/CLAUDE.md) picks ONE of these, or
 * falls through to the OS clipboard.
 */
type InternalClipboard =
  | { kind: 'raster'; width: number; height: number; data: ArrayBuffer }
  | { kind: 'layer'; node: LayerNode; assets: Record<string, AssetJSON> }
  | { kind: 'object'; objects: ObjectNode[] };

let clipboard: InternalClipboard | null = null;
let lastEffect: { id: string; params?: unknown } | null = null;

/** Every asset id a layer subtree's sources (recursing into groups) or baked
 * clip reference, walked so a layer copy/paste can carry its assets along
 * without a dangling `{asset: id}` pointing at nothing in the new document.
 * Deliberately source params + baked.clip only (not chain params). Mirrors
 * what a pasted layer actually needs to render before its chain is
 * reasoned about. */
function collectSourceAssetIds(node: LayerNode, ids: Set<string>): void {
  if (node.kind === 'group') {
    node.children.forEach((child) => collectSourceAssetIds(child, ids));
    return;
  }
  for (const value of Object.values(node.source.params)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'asset' in value && typeof (value as { asset: unknown }).asset === 'string') {
      ids.add((value as { asset: string }).asset);
    }
  }
  if (node.baked?.clip) ids.add(node.baked.clip);
}

function snapshotLayerAssets(app: AppCtx, node: LayerNode): Record<string, AssetJSON> {
  const doc = app.engine.getDocument();
  const ids = new Set<string>();
  collectSourceAssetIds(node, ids);
  const assets: Record<string, AssetJSON> = {};
  for (const id of ids) {
    const asset = doc.assets[id];
    if (asset) assets[id] = structuredClone(asset);
  }
  return assets;
}

/** Search every layer's scene (any depth, through groups) for an object id,
 * without knowing its layer up front: Copy/Cut work from
 * selectionState.objects alone. Mirrors document.ts's own (module-private)
 * findObjectAnywhere. */
function findObjectAnywhere(doc: DocumentJSON, id: ObjectId): { node: ObjectNode; layerId: LayerId } | null {
  let found: { node: ObjectNode; layerId: LayerId } | null = null;
  const walk = (nodes: LayerNode[]) => {
    for (const node of nodes) {
      if (found) return;
      if (node.kind === 'group') { walk(node.children); continue; }
      const objects = sceneObjects(node);
      if (!objects) continue;
      const hit = findObjectInTree(objects, id);
      if (hit) found = { node: hit.node, layerId: node.id };
    }
  };
  walk(doc.layers);
  return found;
}

/** Every scene object id across every ENABLED scene layer, any depth
 * (including inside enabled groups): edit.selectAll's target set. Mirrors
 * the same enabled-layer/group descent findObjectAnywhere (above),
 * select-tool.ts's marquee, and localHost.ts's hitTest all use. */
function allSceneObjectIds(doc: DocumentJSON): string[] {
  const ids: string[] = [];
  const walk = (nodes: LayerNode[]) => {
    for (const node of nodes) {
      if (!node.enabled) continue;
      if (node.kind === 'group') { walk(node.children); continue; }
      const objects = sceneObjects(node);
      if (!objects) continue;
      walkObjects(objects, (o) => ids.push(o.id));
    }
  };
  walk(doc.layers);
  return ids;
}

/**
 * A batch of edits with NO merge identity: every call is its OWN undo
 * step, unlike patchCommand's single-edit setTransform coalescing. Used by
 * edit.nudge: reusing patchCommand's generic `setTransform:${id}` identity
 * would risk silently merging a nudge into an unrelated PRIOR command on
 * the same object (a drag or handle-resize that happened to end just
 * before) since that identity only keys on object id, not on "why". Per-
 * keypress undo steps are simpler and were called out as acceptable for
 * this pass (see src/ui/CLAUDE.md).
 */
function nudgeCommand(edits: DocEdit[]): Command {
  let inverse: DocEdit[] | null = null;
  return {
    label: 'Nudge',
    run(app) {
      const inv = app.engine.applyEdits(edits);
      if (inverse === null) inverse = inv;
    },
    undo(app) {
      app.engine.applyEdits(inverse ?? []);
    },
  };
}

function cloneObjectWithFreshIds(node: ObjectNode): ObjectNode {
  const clone = structuredClone(node);
  const assignIds = (n: ObjectNode) => {
    n.id = objectId(crypto.randomUUID());
    n.children?.forEach(assignIds);
  };
  assignIds(clone);
  return clone;
}

/** Copy Merged's quantised RGBA8 readback IS display-referred, exactly what
 * a PNG is, so internal raster paste and the OS-clipboard PNG write share
 * this one encode path instead of inventing a second colour conversion. */
async function rasterClipboardToPng(clip: Extract<InternalClipboard, { kind: 'raster' }>): Promise<Blob | null> {
  const canvas = new OffscreenCanvas(clip.width, clip.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imageData = new ImageData(new Uint8ClampedArray(clip.data.slice(0)), clip.width, clip.height);
  ctx.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Shared by file.export, the export-video dialog's OK handler, and file.save.
 * `data` may be a pre-built Blob (file.save's chunked serializeDocument
 * output) instead of one ArrayBuffer: `new Blob([data], ...)` accepts
 * either as a BlobPart without ever materializing a combined string/buffer.
 */
export function downloadExportResult(result: { mime: string; data: ArrayBuffer | Blob; fileName: string }): void {
  const blob = new Blob([result.data], { type: result.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** Track C's effect dialogs call this on OK so edit.repeatEffect knows what to redo. */
export function setLastEffect(id: string, params?: unknown): void {
  lastEffect = { id, params };
}

function findLayer(nodes: LayerNode[], id: LayerId): LayerNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === 'group') {
      const hit = findLayer(node.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

function cloneWithFreshIds(node: LayerNode): LayerNode {
  const clone = structuredClone(node);
  const assignIds = (n: LayerNode) => {
    n.id = layerId(crypto.randomUUID());
    if (n.kind === 'group') n.children.forEach(assignIds);
  };
  assignIds(clone);
  return clone;
}

function newSolidLayer(name: string): LayerNode {
  return {
    id: layerId(crypto.randomUUID()),
    kind: 'layer',
    name,
    enabled: true,
    source: { type: 'core.solid', params: { color: [0.5, 0, 0, 1] } },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'baked',
  };
}

// ADJUST block (own this function + its command below; see gdesign-wt/adjust).
function newAdjustmentLayer(name: string): LayerNode {
  return {
    id: layerId(crypto.randomUUID()),
    kind: 'layer',
    name,
    enabled: true,
    source: { type: 'core.adjustment', params: {} },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'live', // adjustment layers can't be baked (see src/engine/CLAUDE.md)
  };
}
// end ADJUST block

function newSceneLayer(name: string): LayerNode {
  return {
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
}

// --- Insert-source block (Insert menu: Plasma Layer / Gradient Layer) -----
// Params are left {} deliberately: resolveParams (engine/params/resolve.ts)
// fills any unset key from the source's own ParamsSchema default, so these
// don't need to duplicate plasma.ts/gradient.ts's defaults here.

function newPlasmaLayer(name: string): LayerNode {
  return {
    id: layerId(crypto.randomUUID()),
    kind: 'layer',
    name,
    enabled: true,
    source: { type: 'core.plasma', params: {} },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'live', // genuinely time-varying (engine.time-driven field). Never bake
  };
}

function newGradientLayer(name: string): LayerNode {
  return {
    id: layerId(crypto.randomUUID()),
    kind: 'layer',
    name,
    enabled: true,
    source: { type: 'core.gradient', params: {} },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'baked', // static two-color fill unless its params get keyframed, like core.solid
  };
}
// --- end insert-source block ----------------------------------------------

// --- FX-BLENDGEN block (Insert menu: Noise Layer / Feedback Layer). Own
// this block; see gdesign-wt/blendgen. Same {} params convention as above.

function newNoiseLayer(name: string): LayerNode {
  return {
    id: layerId(crypto.randomUUID()),
    kind: 'layer',
    name,
    enabled: true,
    source: { type: 'core.noise', params: {} },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'live', // time-varying (engine.time-driven field). Never bake, like core.plasma
  };
}

function newFeedbackLayer(name: string): LayerNode {
  return {
    id: layerId(crypto.randomUUID()),
    kind: 'layer',
    name,
    enabled: true,
    source: { type: 'core.feedback', params: {} },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'live', // accumulates its own prior frame. Never bake
  };
}
// --- end FX-BLENDGEN block --------------------------------------------------

/**
 * Scene layer to insert an object into: the active layer if it's already a
 * core.scene layer, else the topmost core.scene layer in the doc (made
 * active), else a freshly created one (its own undo step). Mirrors
 * paint-layer.ts's resolvePaintLayer so object-insert tools never silently
 * refuse just because activeLayer happens to point at (say) the raster
 * layer a brush stroke just landed on. See src/ui/CLAUDE.md's activeLayer
 * section.
 */
function resolveSceneLayer(app: AppCtx): LayerId {
  const doc = app.engine.getDocument();
  const active = viewState.get().activeLayer;
  const isScene = (id: string | null) =>
    id !== null && doc.layers.some((l) => l.id === id && l.kind === 'layer' && l.source.type === 'core.scene');

  if (isScene(active)) return layerId(active as string);

  const topmostScene = [...doc.layers].reverse().find((l) => l.kind === 'layer' && l.source.type === 'core.scene');
  if (topmostScene) {
    viewState.update((s) => ({ ...s, activeLayer: topmostScene.id }));
    return layerId(topmostScene.id);
  }

  const layer = newSceneLayer(`Scene ${doc.layers.length + 1}`);
  const { parent, index } = siblingInsertPoint(app);
  history.push(app, patchCommand('New Scene Layer', [{ op: 'addLayer', parent, index, layer }]));
  viewState.update((s) => ({ ...s, activeLayer: layer.id }));
  return layer.id;
}

/** New objects land at a fixed visible spot rather than (0,0) (which, with
 * the default centre anchor, would place most of the shape off-canvas at
 * the document's top-left corner): a sensible, if arbitrary, default until
 * there's a "drop where you clicked" insert flow. */
const INSERT_TRANSFORM = { x: 640, y: 360, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 };

/** Returns the inserted object's (layer, id) so callers that need to act on
 * it further (open the text editor, etc.) don't have to re-derive it. Never
 * refuses: resolveSceneLayer always produces a target. */
function insertObject(app: AppCtx, factory: () => ReturnType<typeof createObject>): { layer: LayerId; id: string } {
  const target = resolveSceneLayer(app);
  const node = factory();
  history.push(app, patchCommand('Insert Object', [{ op: 'addObject', layer: target, parent: null, index: Number.MAX_SAFE_INTEGER, object: node }]));
  selectionState.set({ objects: [node.id], marquee: null });
  return { layer: target, id: node.id };
}

/** Shared by the Insert menu's fixed-position rect/ellipse and the Shapes
 * tool's drag-to-size variant below. */
function shapeTransform(x: number, y: number, width: number, height: number) {
  return { x: x + width / 2, y: y + height / 2, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 };
}

// --- SHAPES block (richer scene shape primitives) ---------------------------

export type ShapeKind = 'rect' | 'ellipse' | 'polygon' | 'star' | 'rounded-rect';

const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  polygon: 'Polygon',
  star: 'Star',
  'rounded-rect': 'Rounded Rectangle',
};

/** Same defaults as the fixed-size Insert-menu commands below (hexagon,
 * 5-point star, radius 12), sized to the drag rectangle. */
function shapeSpecFor(kind: ShapeKind, width: number, height: number) {
  switch (kind) {
    case 'polygon':
      return { shape: 'polygon' as const, width, height, sides: 6 };
    case 'star':
      return { shape: 'star' as const, width, height, starPoints: 5, innerRatio: 0.5 };
    case 'rounded-rect':
      return { shape: 'rounded-rect' as const, width, height, radius: 12 };
    default:
      return { shape: kind, width, height };
  }
}

const SHAPE_FILL: Record<ShapeKind, readonly [number, number, number, number]> = {
  rect: [0.6, 0.05, -0.05, 1],
  ellipse: [0.6, -0.05, 0.05, 1],
  polygon: [0.6, 0.05, 0.05, 1],
  star: [0.6, -0.05, -0.05, 1],
  'rounded-rect': [0.6, 0, 0.08, 1],
};

/** Shapes tool: drag rectangle in doc space -> a sized+positioned scene
 * object, one undo step, selected. Same insertObject plumbing the Insert
 * menu commands use, parameterised by the drag geometry instead of a fixed
 * INSERT_TRANSFORM. `kind` is whichever shape the Insert menu last created
 * (toolState.lastShape). See src/ui/CLAUDE.md's Shapes-tool section. */
export function insertDraggedShape(
  app: AppCtx,
  kind: ShapeKind,
  rect: { x: number; y: number; width: number; height: number },
): void {
  insertObject(app, () => createObject({
    id: objectId(crypto.randomUUID()),
    name: SHAPE_NAMES[kind],
    content: { type: 'shape', shape: shapeSpecFor(kind, rect.width, rect.height) },
    style: { fill: SHAPE_FILL[kind] },
    transform: shapeTransform(rect.x, rect.y, rect.width, rect.height),
  }));
}

// --- end SHAPES block --------------------------------------------------

/** Text tool: click inserts an (initially empty) text object at that point.
 * Caller (text-tool.ts) opens the floating editor on the returned id right
 * after: this is the only way a user can type text at all (Insert > Text
 * makes the literal, uneditable "Text"). */
export function insertTextAt(app: AppCtx, pt: { x: number; y: number }): { layer: LayerId; id: string } {
  return insertObject(app, () => createObject({
    id: objectId(crypto.randomUUID()),
    name: 'Text',
    content: { type: 'text', text: { text: '', font: 'default', size: 48 } },
    style: { fill: [0.9, 0, 0, 1] },
    transform: { x: pt.x, y: pt.y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
  }));
}

/**
 * Where "insert new layer above active" lands: the active node's OWN
 * sibling list (its parent group's `children`, or the document root if
 * it has none) directly above it. Uses findLayer (which walks the full
 * tree and reports parentId) rather than a doc.layers-only search, so a
 * new layer inserted while a nested layer is active lands next to that
 * layer inside its group instead of silently falling back to the document
 * root (image-import.ts's topLevelIndex mirrors this).
 */
function siblingInsertPoint(app: AppCtx): { parent: LayerId | null; index: number } {
  const doc = app.engine.getDocument();
  const active = viewState.get().activeLayer;
  if (!active) return { parent: null, index: doc.layers.length };
  const found = findLayerLocation(doc, layerId(active));
  if (!found) return { parent: null, index: doc.layers.length };
  return { parent: found.parentId, index: found.index + 1 };
}

const table: Record<string, CommandDef> = {
  'edit.undo': {
    label: 'Undo',
    run(app) { history.undo(app); },
  },
  'edit.redo': {
    label: 'Redo',
    run(app) { history.redo(app); },
  },
  'layer.new': {
    label: 'New Layer',
    run(app) {
      const doc = app.engine.getDocument();
      const layer = newSolidLayer(`Layer ${doc.layers.length + 1}`);
      const { parent, index } = siblingInsertPoint(app);
      history.push(app, patchCommand('New Layer', [{ op: 'addLayer', parent, index, layer }]));
      viewState.update((s) => ({ ...s, activeLayer: layer.id }));
    },
  },
  // ADJUST block (own this command; see gdesign-wt/adjust).
  'layer.newAdjustment': {
    label: 'New Adjustment Layer',
    run(app) {
      const doc = app.engine.getDocument();
      const layer = newAdjustmentLayer(`Adjustment ${doc.layers.length + 1}`);
      const { parent, index } = siblingInsertPoint(app);
      history.push(app, patchCommand('New Adjustment Layer', [{ op: 'addLayer', parent, index, layer }]));
      viewState.update((s) => ({ ...s, activeLayer: layer.id }));
    },
  },
  // end ADJUST block
  'layer.duplicate': {
    label: 'Duplicate Layer',
    run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      const doc = app.engine.getDocument();
      const source = findLayer(doc.layers, layerId(active));
      if (!source) return;
      const clone = cloneWithFreshIds(source);
      clone.name = `${source.name} copy`;
      const { parent, index } = siblingInsertPoint(app);
      history.push(app, patchCommand('Duplicate Layer', [{ op: 'addLayer', parent, index, layer: clone }]));
      viewState.update((s) => ({ ...s, activeLayer: clone.id }));
    },
  },
  'layer.delete': {
    label: 'Delete Layer',
    run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      const doc = app.engine.getDocument();
      const next = activeWalk(doc, layerId(active), 1);
      history.push(app, patchCommand('Delete Layer', [{ op: 'removeLayer', id: layerId(active) }]));
      viewState.update((s) => ({ ...s, activeLayer: next === active ? null : next }));
    },
  },
  'layer.mergeDown': {
    label: 'Merge Down',
    async run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      const result = await app.engine.burn({ target: layerId(active), mode: 'still' });
      if (result.edits.length === 0) {
        console.info('[gdesign] burn lands Phase 3: merge down is a no-op for now');
        return;
      }
      history.push(app, patchCommand('Merge Down', result.edits));
    },
  },
  'layer.flatten': {
    label: 'Flatten Image',
    async run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      const result = await app.engine.burn({ target: layerId(active), mode: 'still' });
      if (result.edits.length === 0) {
        console.info('[gdesign] burn lands Phase 3: flatten is a no-op for now');
        return;
      }
      history.push(app, patchCommand('Flatten Image', result.edits));
    },
  },
  'layer.toggleVisibility': {
    label: 'Toggle Visibility',
    run(app, args) {
      const id = layerId((args as { id?: string } | undefined)?.id ?? viewState.get().activeLayer ?? '');
      if (!id) return;
      const doc = app.engine.getDocument();
      const node = findLayer(doc.layers, id);
      if (!node) return;
      const edit: DocEdit = { op: 'setEnabled', id, enabled: !node.enabled };
      history.push(app, patchCommand('Toggle Visibility', [edit]));
    },
  },
  'layer.selectAbove': {
    label: 'Select Layer Above',
    run(app) {
      const doc = app.engine.getDocument();
      const current = viewState.get().activeLayer;
      const next = activeWalk(doc, current ? layerId(current) : null, -1);
      viewState.update((s) => ({ ...s, activeLayer: next }));
    },
  },
  'layer.selectBelow': {
    label: 'Select Layer Below',
    run(app) {
      const doc = app.engine.getDocument();
      const current = viewState.get().activeLayer;
      const next = activeWalk(doc, current ? layerId(current) : null, 1);
      viewState.update((s) => ({ ...s, activeLayer: next }));
    },
  },
  'layer.properties': {
    label: 'Layer Properties',
    run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      openLayerProperties(app, active);
    },
  },

  // --- Layer groups (Wave 3) --------------------------------------------
  'layer.group': {
    label: 'Group',
    run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      const doc = app.engine.getDocument();
      const found = findLayerLocation(doc, layerId(active));
      if (!found) return;
      const group = createGroup({ id: layerId(crypto.randomUUID()), name: 'Group' });
      // Insert the (empty) group as the active layer's next-higher sibling,
      // then reorder the active layer INTO it as its sole child: one
      // patchCommand, two edits, applyEdits gives us the paired inverses so
      // undo un-nests in a single step. Grouping a group nests it (allowed:
      // createGroup's node is itself a valid LayerNode child).
      const edits: DocEdit[] = [
        { op: 'addLayer', parent: found.parentId, index: found.index + 1, layer: group },
        { op: 'reorderLayer', id: layerId(active), parent: group.id, index: 0 },
      ];
      history.push(app, patchCommand('Group', edits));
    },
  },
  'layer.ungroup': {
    label: 'Ungroup',
    run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      const doc = app.engine.getDocument();
      const found = findLayerLocation(doc, layerId(active));
      if (!found || found.node.kind !== 'group') return;
      const group = found.node;
      // Move each child out to the group's own parent/index, bottom-up, so
      // their relative order survives the flatten (see registry.ts's
      // layer.ungroup doc comment / src/ui/CLAUDE.md), then drop the now-
      // empty group. One patchCommand (reorders + the final removeLayer)
      // so undo restores the group and every child's position in one step.
      const edits: DocEdit[] = group.children.map((child, i) => ({
        op: 'reorderLayer' as const,
        id: child.id,
        parent: found.parentId,
        index: found.index + i,
      }));
      edits.push({ op: 'removeLayer', id: group.id });
      history.push(app, patchCommand('Ungroup', edits));
      viewState.update((s) => ({ ...s, activeLayer: null }));
    },
  },
  // -----------------------------------------------------------------------

  // --- MASKS block (Layers menu: Add/Remove Mask, Enable/Disable, Invert) -
  'layer.addMask': {
    label: 'Add Mask',
    /** Creates a new OPAQUE-WHITE raster asset (canvas-sized, an all-keep
     * mask changes nothing until painted on) and points the active layer's
     * mask at it, as ONE patchCommand (addAsset + setMask) so undo removes
     * both in a single step. No-ops if there's no active layer or it
     * already has a mask (Add Mask isn't a replace). */
    run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      const doc = app.engine.getDocument();
      const target = findLayer(doc.layers, layerId(active));
      if (!target || target.kind !== 'layer' || target.mask) return;
      const id = assetId(`mask-${crypto.randomUUID().slice(0, 8)}`);
      const { width, height } = doc.canvas;
      const edits: DocEdit[] = [
        { op: 'addAsset', id, asset: { type: 'raster', data: whiteMaskBytes(width, height), width, height } },
        { op: 'setMask', id: layerId(active), mask: { asset: id, enabled: true, invert: false } },
      ];
      history.push(app, patchCommand('Add Mask', edits));
    },
  },
  'layer.removeMask': {
    label: 'Remove Mask',
    run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      const doc = app.engine.getDocument();
      const target = findLayer(doc.layers, layerId(active));
      if (!target || target.kind !== 'layer' || !target.mask) return;
      history.push(app, patchCommand('Remove Mask', [{ op: 'setMask', id: layerId(active), mask: null }]));
      // exitMaskEditing: viewState.maskEditing is cleared by paint-layer.ts's
      // resolveStrokeTarget the next time a stroke is attempted, but clear it
      // here too so the statusbar hint and mask chip don't lag a frame.
      viewState.update((s) => (s.maskEditing === active ? { ...s, maskEditing: null } : s));
    },
  },
  'layer.enableMask': {
    label: 'Enable Mask',
    run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      const doc = app.engine.getDocument();
      const target = findLayer(doc.layers, layerId(active));
      if (!target || target.kind !== 'layer' || !target.mask) return;
      history.push(app, patchCommand('Enable Mask', [{ op: 'setMask', id: layerId(active), mask: { ...target.mask, enabled: true } }]));
    },
  },
  'layer.disableMask': {
    label: 'Disable Mask',
    run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      const doc = app.engine.getDocument();
      const target = findLayer(doc.layers, layerId(active));
      if (!target || target.kind !== 'layer' || !target.mask) return;
      history.push(app, patchCommand('Disable Mask', [{ op: 'setMask', id: layerId(active), mask: { ...target.mask, enabled: false } }]));
    },
  },
  'layer.toggleMaskInvert': {
    label: 'Invert Mask',
    run(app) {
      const active = viewState.get().activeLayer;
      if (!active) return;
      const doc = app.engine.getDocument();
      const target = findLayer(doc.layers, layerId(active));
      if (!target || target.kind !== 'layer' || !target.mask) return;
      history.push(app, patchCommand('Invert Mask', [{ op: 'setMask', id: layerId(active), mask: { ...target.mask, invert: !target.mask.invert } }]));
    },
  },
  // --- end MASKS block ----------------------------------------------------

  'scene.newLayer': {
    label: 'New Scene Layer',
    run(app) {
      const doc = app.engine.getDocument();
      const layer = newSceneLayer(`Scene ${doc.layers.length + 1}`);
      const { parent, index } = siblingInsertPoint(app);
      history.push(app, patchCommand('New Scene Layer', [{ op: 'addLayer', parent, index, layer }]));
      viewState.update((s) => ({ ...s, activeLayer: layer.id }));
    },
  },
  'source.insertPlasma': {
    label: 'Insert Plasma Layer',
    run(app) {
      const doc = app.engine.getDocument();
      const layer = newPlasmaLayer(`Plasma ${doc.layers.length + 1}`);
      const { parent, index } = siblingInsertPoint(app);
      history.push(app, patchCommand('Insert Plasma Layer', [{ op: 'addLayer', parent, index, layer }]));
      viewState.update((s) => ({ ...s, activeLayer: layer.id }));
      // Generative sources are all about their parameters. Open Layer
      // Properties (its Source section live-edits them against the fresh
      // layer) immediately, so inserting IS editing rather than spawn-then-
      // go-find-the-dialog. Closing keeps the layer; Ctrl+Z removes it.
      openLayerProperties(app, layer.id);
    },
  },
  'source.insertGradient': {
    label: 'Insert Gradient Layer',
    run(app) {
      const doc = app.engine.getDocument();
      const layer = newGradientLayer(`Gradient ${doc.layers.length + 1}`);
      const { parent, index } = siblingInsertPoint(app);
      history.push(app, patchCommand('Insert Gradient Layer', [{ op: 'addLayer', parent, index, layer }]));
      viewState.update((s) => ({ ...s, activeLayer: layer.id }));
      // Generative sources are all about their parameters. Open Layer
      // Properties (its Source section live-edits them against the fresh
      // layer) immediately, so inserting IS editing rather than spawn-then-
      // go-find-the-dialog. Closing keeps the layer; Ctrl+Z removes it.
      openLayerProperties(app, layer.id);
    },
  },
  'source.insertNoise': {
    label: 'Insert Noise Layer',
    run(app) {
      const doc = app.engine.getDocument();
      const layer = newNoiseLayer(`Noise ${doc.layers.length + 1}`);
      const { parent, index } = siblingInsertPoint(app);
      history.push(app, patchCommand('Insert Noise Layer', [{ op: 'addLayer', parent, index, layer }]));
      viewState.update((s) => ({ ...s, activeLayer: layer.id }));
      // Generative sources are all about their parameters. Open Layer
      // Properties (its Source section live-edits them against the fresh
      // layer) immediately, so inserting IS editing rather than spawn-then-
      // go-find-the-dialog. Closing keeps the layer; Ctrl+Z removes it.
      openLayerProperties(app, layer.id);
    },
  },
  'source.insertFeedback': {
    label: 'Insert Feedback Layer',
    run(app) {
      const doc = app.engine.getDocument();
      const layer = newFeedbackLayer(`Feedback ${doc.layers.length + 1}`);
      const { parent, index } = siblingInsertPoint(app);
      history.push(app, patchCommand('Insert Feedback Layer', [{ op: 'addLayer', parent, index, layer }]));
      viewState.update((s) => ({ ...s, activeLayer: layer.id }));
      // Generative sources are all about their parameters. Open Layer
      // Properties (its Source section live-edits them against the fresh
      // layer) immediately, so inserting IS editing rather than spawn-then-
      // go-find-the-dialog. Closing keeps the layer; Ctrl+Z removes it.
      openLayerProperties(app, layer.id);
    },
  },
  'object.insertRect': {
    label: 'Insert Rectangle',
    run(app) {
      toolState.update((s) => ({ ...s, lastShape: 'rect' }));
      insertObject(app, () => createObject({
        id: objectId(crypto.randomUUID()),
        name: 'Rectangle',
        content: { type: 'shape', shape: { shape: 'rect', width: 200, height: 120 } },
        style: { fill: [0.6, 0.05, -0.05, 1] },
        transform: INSERT_TRANSFORM,
      }));
    },
  },
  'object.insertEllipse': {
    label: 'Insert Ellipse',
    run(app) {
      toolState.update((s) => ({ ...s, lastShape: 'ellipse' }));
      insertObject(app, () => createObject({
        id: objectId(crypto.randomUUID()),
        name: 'Ellipse',
        content: { type: 'shape', shape: { shape: 'ellipse', width: 160, height: 160 } },
        style: { fill: [0.6, -0.05, 0.05, 1] },
        transform: INSERT_TRANSFORM,
      }));
    },
  },
  // --- SHAPES block (richer scene shape primitives) -------------------------
  'object.insertPolygon': {
    label: 'Insert Polygon',
    run(app) {
      toolState.update((s) => ({ ...s, lastShape: 'polygon' }));
      insertObject(app, () => createObject({
        id: objectId(crypto.randomUUID()),
        name: 'Polygon',
        // Hexagon default.
        content: { type: 'shape', shape: { shape: 'polygon', width: 160, height: 160, sides: 6 } },
        style: { fill: SHAPE_FILL.polygon },
        transform: INSERT_TRANSFORM,
      }));
    },
  },
  'object.insertStar': {
    label: 'Insert Star',
    run(app) {
      toolState.update((s) => ({ ...s, lastShape: 'star' }));
      insertObject(app, () => createObject({
        id: objectId(crypto.randomUUID()),
        name: 'Star',
        // 5-point star default.
        content: { type: 'shape', shape: { shape: 'star', width: 160, height: 160, starPoints: 5, innerRatio: 0.5 } },
        style: { fill: SHAPE_FILL.star },
        transform: INSERT_TRANSFORM,
      }));
    },
  },
  'object.insertRoundedRect': {
    label: 'Insert Rounded Rectangle',
    run(app) {
      toolState.update((s) => ({ ...s, lastShape: 'rounded-rect' }));
      insertObject(app, () => createObject({
        id: objectId(crypto.randomUUID()),
        name: 'Rounded Rectangle',
        content: { type: 'shape', shape: { shape: 'rounded-rect', width: 200, height: 120, radius: 12 } },
        style: { fill: SHAPE_FILL['rounded-rect'] },
        transform: INSERT_TRANSFORM,
      }));
    },
  },
  // --- end SHAPES block ------------------------------------------------------
  'object.insertText': {
    label: 'Insert Text',
    run(app) {
      insertObject(app, () => createObject({
        id: objectId(crypto.randomUUID()),
        name: 'Text',
        content: { type: 'text', text: { text: 'Text', font: 'default', size: 48 } },
        style: { fill: [0.9, 0, 0, 1] },
        transform: INSERT_TRANSFORM,
      }));
    },
  },
  'edit.deselect': {
    label: 'Deselect',
    run() {
      selectionState.set({ objects: [], marquee: null });
    },
  },
  // --- Selection commands (Wave 5) ----------------------------------------
  'edit.selectAll': {
    label: 'Select All',
    run(app) {
      const doc = app.engine.getDocument();
      selectionState.set({ objects: allSceneObjectIds(doc), marquee: null });
    },
  },
  'edit.deleteSelected': {
    label: 'Delete Objects',
    /**
     * Delete/Backspace convention (see src/ui/CLAUDE.md): objects selected
     * -> remove them, one undo step. Marquee only (no objects) -> clear the
     * marquee. Nothing selected -> no-op. select-tool.ts's window keydown
     * listener routes bare Delete/Backspace here; Escape stays a pure
     * deselect and never reaches this command.
     */
    run(app) {
      const sel = selectionState.get();
      if (sel.objects.length > 0) {
        const doc = app.engine.getDocument();
        const hits = sel.objects
          .map((id) => findObjectAnywhere(doc, objectId(id)))
          .filter((h): h is NonNullable<ReturnType<typeof findObjectAnywhere>> => !!h);
        if (hits.length === 0) return;
        const edits: DocEdit[] = hits.map((hit) => ({ op: 'removeObject', layer: hit.layerId, id: hit.node.id }));
        history.push(app, patchCommand('Delete Objects', edits));
        selectionState.set({ objects: [], marquee: null });
        return;
      }
      if (sel.marquee) selectionState.set({ objects: [], marquee: null });
    },
  },
  'edit.nudge': {
    label: 'Nudge',
    run(app, args) {
      const { dx, dy } = args as { dx: number; dy: number };
      const selected = selectionState.get().objects;
      if (selected.length === 0) return;
      const doc = app.engine.getDocument();
      const edits: DocEdit[] = [];
      for (const id of selected) {
        const hit = findObjectAnywhere(doc, objectId(id));
        if (!hit) continue;
        const t = hit.node.transform;
        edits.push({ op: 'setTransform', id: objectId(id), transform: { ...t, x: t.x + dx, y: t.y + dy } });
      }
      if (edits.length === 0) return;
      history.push(app, nudgeCommand(edits));
    },
  },
  'edit.fillSelection': {
    label: 'Fill Selection',
    /**
     * Fills the current marquee rectangle (select-tool.ts keeps it in
     * selectionState.marquee after a rect/ellipse selection, precisely so
     * this command has a region to read) on a raster layer, via the
     * existing stroke API: there's no bucket-fill/rect-fill primitive, so
     * this stamps a dense grid of round-brush points across the rect. That
     * leaves the fill's corners slightly rounded at low brush sizes; an
     * exact rect fill would need a new raster op, out of scope here.
     */
    async run(app) {
      const marquee = selectionState.get().marquee;
      if (!marquee) {
        showStatusMessage('Fill Selection: marquee-select a region first');
        return;
      }
      const target = resolvePaintLayer(app);
      const { primary, brushSize } = toolState.get();
      const size = Math.max(brushSize, 16);
      const step = size * 0.5;
      app.engine.beginStroke({ layer: layerId(target), brush: 'round', size, color: primary, mode: 'paint' });
      for (let y = marquee.y; y < marquee.y + marquee.height + step; y += step) {
        const py = Math.min(y, marquee.y + marquee.height);
        for (let x = marquee.x; x < marquee.x + marquee.width + step; x += step) {
          app.engine.strokePoint({ x: Math.min(x, marquee.x + marquee.width), y: py });
        }
      }
      await commitStrokeEdits(app, 'Fill Selection');
    },
  },
  'edit.copy': {
    label: 'Copy',
    /** Object wins over layer when there's a scene selection: it's the
     * more specific thing the user is looking at. */
    run(app) {
      const selected = selectionState.get().objects;
      if (selected.length > 0) {
        const doc = app.engine.getDocument();
        const objects = selected
          .map((id) => findObjectAnywhere(doc, objectId(id))?.node)
          .filter((n): n is ObjectNode => !!n)
          .map((n) => structuredClone(n));
        if (objects.length > 0) {
          clipboard = { kind: 'object', objects };
          return;
        }
      }
      const active = viewState.get().activeLayer;
      if (!active) return;
      const doc = app.engine.getDocument();
      const source = findLayer(doc.layers, layerId(active));
      if (!source) return;
      clipboard = { kind: 'layer', node: structuredClone(source), assets: snapshotLayerAssets(app, source) };
    },
  },
  'edit.cut': {
    label: 'Cut',
    /** Copy + delete as ONE history entry (object removals, or a layer
     * removal), so a single undo restores exactly what was cut. */
    run(app) {
      const selected = selectionState.get().objects;
      if (selected.length > 0) {
        const doc = app.engine.getDocument();
        const hits = selected
          .map((id) => ({ id, hit: findObjectAnywhere(doc, objectId(id)) }))
          .filter((entry): entry is { id: string; hit: NonNullable<ReturnType<typeof findObjectAnywhere>> } => !!entry.hit);
        if (hits.length === 0) return;
        clipboard = { kind: 'object', objects: hits.map(({ hit }) => structuredClone(hit.node)) };
        const edits: DocEdit[] = hits.map(({ hit }) => ({ op: 'removeObject', layer: hit.layerId, id: hit.node.id }));
        history.push(app, patchCommand('Cut', edits));
        selectionState.set({ objects: [], marquee: null });
        return;
      }
      const active = viewState.get().activeLayer;
      if (!active) return;
      const doc = app.engine.getDocument();
      const source = findLayer(doc.layers, layerId(active));
      if (!source) return;
      clipboard = { kind: 'layer', node: structuredClone(source), assets: snapshotLayerAssets(app, source) };
      history.push(app, patchCommand('Cut', [{ op: 'removeLayer', id: layerId(active) }]));
      viewState.update((s) => ({ ...s, activeLayer: null }));
    },
  },
  'edit.paste': {
    label: 'Paste',
    /**
     * Precedence (see src/ui/CLAUDE.md): a same-gesture OS-image paste
     * (main.ts's window 'paste' listener, via paste-guard.ts) wins outright
     * (it already imported the file). Otherwise internal clipboard by kind
     * (object > layer > raster, most-specific-first), then the OS clipboard
     * as a last resort (Firefox denies navigator.clipboard.read, so this
     * path is mostly a Chromium fallback: the paste-event listener is what
     * covers Firefox).
     */
    async run(app) {
      if (wasPasteRecentlyHandled()) return;

      if (clipboard?.kind === 'object') {
        const target = resolveSceneLayer(app);
        const fresh = clipboard.objects.map((node) => {
          const clone = cloneObjectWithFreshIds(node);
          clone.transform = { ...clone.transform, x: clone.transform.x + 10, y: clone.transform.y + 10 };
          return clone;
        });
        const edits: DocEdit[] = fresh.map((object) => ({
          op: 'addObject', layer: target, parent: null, index: Number.MAX_SAFE_INTEGER, object,
        }));
        history.push(app, patchCommand('Paste', edits));
        selectionState.set({ objects: fresh.map((o) => o.id), marquee: null });
        return;
      }

      if (clipboard?.kind === 'layer') {
        const clone = cloneWithFreshIds(clipboard.node);
        clone.name = `${clipboard.node.name} copy`;
        const { parent, index } = siblingInsertPoint(app);
        const doc = app.engine.getDocument();
        const edits: DocEdit[] = [];
        // Re-add any snapshotted asset the paste target doc no longer has
        // (a fresh document, or the same doc after the source asset was
        // since removed). An asset already present (paste-back into the
        // same doc) is left untouched.
        for (const [id, asset] of Object.entries(clipboard.assets)) {
          if (!doc.assets[id]) edits.push({ op: 'addAsset', id, asset: structuredClone(asset) });
        }
        edits.push({ op: 'addLayer', parent, index, layer: clone });
        history.push(app, patchCommand('Paste', edits));
        viewState.update((s) => ({ ...s, activeLayer: clone.id }));
        return;
      }

      if (clipboard?.kind === 'raster') {
        const blob = await rasterClipboardToPng(clipboard);
        if (blob) {
          await importImageFile(app, blob, 'Pasted Image');
          return;
        }
      }

      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (!type) continue;
          const blob = await item.getType(type);
          await importImageFile(app, blob, 'Pasted Image');
          return;
        }
      } catch (err) {
        console.info('[gdesign] paste: clipboard image read denied or unavailable', err);
      }
    },
  },
  'edit.copyMerged': {
    label: 'Copy Merged',
    async run(app) {
      const result = await app.engine.readback({ via: 'quantised' });
      const raster: InternalClipboard = { kind: 'raster', width: result.width, height: result.height, data: result.data };
      clipboard = raster;
      try {
        const blob = await rasterClipboardToPng(raster);
        if (blob && 'clipboard' in navigator && 'write' in navigator.clipboard) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        }
      } catch (err) {
        console.info('[gdesign] copy merged: OS clipboard write denied or unavailable', err);
        showStatusMessage('Copy Merged: could not write to the system clipboard (internal copy still works)');
      }
    },
  },
  'edit.pasteAsLayer': {
    label: 'Paste as Layer (OS Clipboard)',
    /** OS-clipboard-explicit paste (Ctrl+Shift+V): unlike edit.paste it
     * never falls back to the internal clipboard, since choosing this
     * command over plain Paste IS the choice of "use what's on the system
     * clipboard, not gdesign's own". */
    async run(app) {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (!type) continue;
          const blob = await item.getType(type);
          await importImageFile(app, blob, 'Pasted Image');
          return;
        }
        showStatusMessage('Paste as Layer: no image found on the system clipboard');
      } catch (err) {
        console.info('[gdesign] paste as layer: clipboard image read denied or unavailable', err);
        showStatusMessage('Paste as Layer: system clipboard access denied');
      }
    },
  },
  'file.new': {
    label: 'New',
    run(app) {
      openNewDocumentDialog(app);
    },
  },
  'file.open': {
    label: 'Open',
    run(app) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,video/*,.gdesign.json,application/json';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.name.endsWith('.gdesign.json')) {
          void (async () => {
            try {
              const doc = deserializeDocument(await file.text());
              await loadFreshDocument(app, doc);
            } catch (err) {
              console.error('[gdesign] open document failed', err);
              showStatusMessage("Couldn't open document");
            }
          })();
          return;
        }
        const baseName = file.name.replace(/\.[^./\\]+$/, '');
        if (file.type.startsWith('video/')) {
          openImportVideoDialog(app, file, baseName || 'Video');
          return;
        }
        void importImageFile(app, file, baseName || 'Image');
      });
      input.click();
    },
  },
  'file.save': {
    label: 'Save',
    run(app) {
      const doc = app.engine.getDocument();
      // Baked video clips embed as base64 in the JSON: a large clip makes
      // this a genuinely heavy synchronous save. Surface that BEFORE the
      // main thread blocks (and yield one tick so the toast actually
      // paints) instead of looking like a hang.
      let assetBytes = 0;
      for (const asset of Object.values(doc.assets)) {
        if ('data' in asset && asset.data instanceof ArrayBuffer) assetBytes += asset.data.byteLength;
        if ('frames' in asset && Array.isArray(asset.frames)) {
          for (const f of asset.frames) if (f instanceof ArrayBuffer) assetBytes += f.byteLength;
        }
      }
      const save = () => {
        try {
          const blob = serializeDocument(doc);
          downloadExportResult({ mime: 'application/json', data: blob, fileName: 'document.gdesign.json' });
        } catch (err) {
          console.error('[gdesign] save document failed', err);
          showStatusMessage("Couldn't save document");
        }
      };
      if (assetBytes > 128 * 1024 * 1024) {
        showStatusMessage(`Saving ${Math.round(assetBytes / (1024 * 1024))} MB of baked assets. This can take a moment…`);
        setTimeout(save, 50);
      } else {
        save();
      }
    },
  },
  'file.export': {
    label: 'Export PNG',
    async run(app) {
      const result = await app.engine.export({ target: 'png' });
      downloadExportResult(result);
    },
  },
  'file.exportVideo': {
    label: 'Export Video…',
    run(app) {
      openExportVideoDialog(app);
    },
  },
  'effect.open': {
    label: 'Effect...',
    run(app, args) {
      openEffectDialog(app, args as string);
    },
  },
  'edit.repeatEffect': {
    label: 'Repeat Effect',
    run(app) {
      if (!lastEffect) {
        console.info('[gdesign] repeat effect: no effect to repeat');
        return;
      }
      openEffectDialog(app, lastEffect.id);
    },
  },
};

export function executeCommand(app: AppCtx, id: string, args?: unknown): void {
  try {
    if (shellExecute(app, id, args)) return;
    const def = table[id];
    if (!def) {
      console.warn(`[gdesign] unknown command: ${id}`);
      return;
    }
    def.run(app, args);
  } catch (err) {
    // Called from keymaps and menus: a throw here would escape into a
    // keydown/click handler with the app half-mutated and nothing shown.
    console.error(`[gdesign] command ${id} failed`, err);
    showStatusMessage(`Couldn't run ${table[id]?.label ?? id}. Nothing was changed.`);
  }
}

export { executeCommand as execute };

export function commandLabel(id: string): string {
  return table[id]?.label ?? id;
}

// uiCommand is re-exported here so callers building undoable UI-state
// actions (not document edits) don't need a separate import path.
export { uiCommand };
