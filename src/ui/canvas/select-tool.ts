/**
 * The 'move' tool: click-to-select (engine.hitTest) + drag-to-move
 * (setTransform, coalesced via patchCommand's identity merge, same pattern
 * paint-tool.ts/opacity use) on the canvas body, PLUS a DOM (not
 * engine-rendered) selection overlay showing the selected object's bounding
 * box, 8 resize handles, and a rotate handle (DOM stays crisp at any zoom).
 * mountSelectionOverlay gives the overlay div the exact same
 * width/height/transform as the canvas element every layout tick, so its
 * own local px == canvas-local px at the current zoom
 * (object-bounds.ts's docCornersToCanvasPx), no separate
 * getBoundingClientRect bookkeeping for the box/handles themselves.
 *
 * Also the 'select-rect'/'select-ellipse' tools: drag a marquee in
 * selectionState.marquee (shown as a dashed overlay box: ellipse uses
 * the same rect marquee/overlay as rect, a bbox simplification; an actual
 * ellipse hit-test is select-wand/lasso-tier work, not this pass). On
 * release the marquee resolves selectionState.objects to whichever scene
 * objects overlap its bounding box, but (unlike a transient drag preview)
 * the rect itself is KEPT (not nulled) as "the current rectangular
 * selection extent": registry.ts's edit.fillSelection reads it to fill that
 * region on a raster layer, so it needs to outlive the drag. Escape,
 * Delete/Backspace (window-level, suppressed while a text input has focus,
 * and guarded against modifiers so it doesn't shadow Ctrl+Shift+Delete/
 * layer.delete: this clears the SELECTION, it does not delete the
 * selected objects), or a release with ~zero drag distance (a plain click)
 * deselect and clear it instead.
 *
 * Both the marquee (objectsOverlapping) and the move-tool's click hit-test
 * (engine.hitTest) search EVERY enabled core.scene layer in the document,
 * never just viewState.activeLayer: painting a stroke reassigns
 * activeLayer to the raster layer (paint-layer.ts's resolvePaintLayer), so
 * scoping selection to "active layer only" silently broke marquee/click
 * selection the instant a user painted anything first (the probe that
 * caught this). Resolving a selection also makes the hit/first-matched
 * layer active, so a subsequent Insert/Fill targets where the user actually
 * clicked. See src/ui/CLAUDE.md's activeLayer section for the full
 * resolve-or-create contract this and registry.ts's insertObject share.
 *
 * Move-tool double-click on an object opens the floating text editor
 * (text-tool.ts) when it's a text object. Detected here, in the same
 * pointerdown/up handler that already resolves the hit, rather than a
 * second dblclick listener on the canvas (viewport.ts owns canvas events
 * and is off-limits this pass). Double-click is detected at UP time, two
 * consecutive completed CLICKS (down+up with ~no drag) on the same object
 * within the window, not "a second down soon after a first down": that
 * earlier version fired on an ordinary click-then-immediately-drag
 * sequence (the drag's down() landed close enough in time to the prior
 * click's down() to look like a double-click, silently swallowing the
 * drag instead of moving the object, a real regression this fixes).
 *
 * Resize convention: dragging a handle scales about the OBJECT'S OWN anchor
 * (transform.anchorX/Y), not the opposite handle. Simpler, and consistent
 * with the anchor already being the single pivot Transform2D defines for
 * scale+rotation. "Resize from the opposite corner" would need to move
 * x/y too; flagged as a nicety, not required for this phase.
 */

import type { AppCtx, ToolId } from '../../app/types';
import type { ContentBox, DocumentJSON, ObjectNode, Transform2D } from '@engine';
import { objectId, layerId, contentBoxOf, sceneObjects, walkObjects } from '@engine';
import { viewState, selectionState } from '../../app/stores';
import { history } from '../../app/commands/app-history';
import { patchCommand } from '../../app/commands/command';
import { isTextEditingTarget } from '../../app/keymap/keymap';
import { executeCommand } from '../../app/commands/registry';
import type { ToolHandler, ToolPoint } from './viewport';
import { findSceneObject, objectDocCorners, docCornersToCanvasPx } from './object-bounds';

const DOUBLE_CLICK_MS = 400;
/** Below this doc-px drag distance, treat a marquee/move release as a
 * plain click rather than an intentional drag. */
const CLICK_EPSILON_PX = 2;

type Rect = { x: number; y: number; width: number; height: number };

function isSelectShapeTool(tool: ToolId): tool is 'select-rect' | 'select-ellipse' {
  return tool === 'select-rect' || tool === 'select-ellipse';
}

function normalizeRect(a: ToolPoint, b: ToolPoint): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Bounding-box hit test (rotation ignored: a marquee-vs-rotated-object
 * exact test isn't needed for a rect/ellipse bbox selection). */
function objectBboxInDoc(doc: DocumentJSON, node: ObjectNode): Rect {
  const box = contentBoxOf(node.content, { getAsset: (assetId) => doc.assets[assetId] });
  const t = node.transform;
  return { x: t.x - t.anchorX * box.width, y: t.y - t.anchorY * box.height, width: box.width, height: box.height };
}

/**
 * Scene objects (any depth) whose bbox overlaps `rect`, across EVERY
 * enabled core.scene layer in the document, not just the active layer.
 * A marquee drawn over an object on a non-active scene layer (e.g. right
 * after painting reassigned activeLayer to the raster layer) must still
 * find it; scoping this to activeLayer was the bug the probe caught (see
 * src/ui/CLAUDE.md's activeLayer section).
 */
function objectsOverlapping(app: AppCtx, rect: Rect): { layer: string; id: string }[] {
  const doc = app.engine.getDocument();
  const hits: { layer: string; id: string }[] = [];
  // Descends enabled groups (groups carry no transform, so doc-space coords
  // pass through unchanged). Mirrors localHost.ts's hitTest, which already
  // searches every enabled layer at any depth; this used to stop at the
  // top-level doc.layers array, silently missing a scene layer nested inside
  // a group.
  const walk = (nodes: DocumentJSON['layers']) => {
    for (const layerNode of nodes) {
      if (!layerNode.enabled) continue;
      if (layerNode.kind === 'group') { walk(layerNode.children); continue; }
      if (layerNode.source.type !== 'core.scene') continue;
      const objects = sceneObjects(layerNode);
      if (!objects) continue;
      walkObjects(objects, (node) => {
        if (rectsOverlap(rect, objectBboxInDoc(doc, node))) hits.push({ layer: layerNode.id, id: node.id });
      });
    }
  };
  walk(doc.layers);
  return hits;
}

/** Which layer (any depth, through groups) a scene object with `id` lives
 * on. Used by the overlay to resolve every selected object, not just a
 * single one, and by the move-tool's shift-click toggle. Mirrors
 * registry.ts's own (module-private) findObjectAnywhere. */
function findObjectLayer(doc: DocumentJSON, id: string): string | null {
  let found: string | null = null;
  const walk = (nodes: DocumentJSON['layers']) => {
    for (const node of nodes) {
      if (found) return;
      if (node.kind === 'group') { walk(node.children); continue; }
      if (findSceneObject(doc, layerId(node.id), objectId(id))) found = node.id;
    }
  };
  walk(doc.layers);
  return found;
}

export interface SelectToolOptions {
  /** Move-tool double-click on an object: text-tool.ts wires this to open
   * the floating editor when the object is text. */
  onObjectDoubleClick?(layer: string, id: string): void;
}

export function createSelectToolHandler(app: AppCtx, opts: SelectToolOptions = {}): ToolHandler {
  let dragging: { objId: string; layer: string; startX: number; startY: number; start: Transform2D } | null = null;
  let marqueeStart: ToolPoint | null = null;
  /** Set only when a completed interaction was a genuine click (no drag),
   * used solely to detect a SECOND such click for double-click, at up() time. */
  let lastClick: { objId: string; time: number } | null = null;

  window.addEventListener('keydown', (e) => {
    if (isTextEditingTarget(e.target)) return;
    // Escape is a pure deselect: never deletes anything.
    if (e.key === 'Escape') {
      if (selectionState.get().objects.length === 0 && !selectionState.get().marquee) return;
      selectionState.set({ objects: [], marquee: null });
      return;
    }
    // Bare Delete/Backspace DELETES the selected objects (universal editor
    // convention), guarded against modifiers so it doesn't shadow
    // Ctrl+Shift+Delete (layer.delete). edit.deleteSelected (registry.ts)
    // itself handles the no-objects-but-marquee (clear the rect) and
    // nothing-selected (no-op) cases, so this listener just routes there.
    const isDeleteKey = (e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (!isDeleteKey) return;
    executeCommand(app, 'edit.deleteSelected');
  });

  return {
    down(pt: ToolPoint, tool: ToolId) {
      if (isSelectShapeTool(tool)) {
        marqueeStart = pt;
        return;
      }
      if (tool !== 'move') return;
      void (async () => {
        const hit = await app.engine.hitTest(pt.x, pt.y);
        if (hit.object && hit.layer) {
          // hitTest already searches every enabled scene layer, not just
          // active. Make the hit layer active too, so a subsequent
          // Insert/Fill targets where the user is actually pointing.
          viewState.update((s) => ({ ...s, activeLayer: hit.layer }));
          if (pt.shiftKey) {
            // Shift+click TOGGLES the hit object in/out of the current
            // multi-selection instead of replacing it. A toggle-OFF never
            // starts a drag (the user just removed it from the selection,
            // not asked to move it); only a toggle-ON does, and only for
            // itself. Dragging every selected object together isn't part
            // of this pass (see src/ui/CLAUDE.md).
            const cur = selectionState.get().objects;
            const already = cur.includes(hit.object);
            const next = already ? cur.filter((o) => o !== hit.object) : [...cur, hit.object];
            selectionState.set({ objects: next, marquee: null });
            lastClick = null;
            if (already) { dragging = null; return; }
          } else {
            selectionState.set({ objects: [hit.object], marquee: null });
          }
          const doc = app.engine.getDocument();
          const node = findSceneObject(doc, layerId(hit.layer), objectId(hit.object));
          if (node) {
            dragging = { objId: hit.object, layer: hit.layer, startX: pt.x, startY: pt.y, start: node.transform };
          }
        } else if (pt.shiftKey) {
          // Shift+click on empty space is a no-op (additive-only): must
          // not clear an existing multi-selection.
          dragging = null;
        } else {
          lastClick = null;
          selectionState.set({ objects: [], marquee: null });
          dragging = null;
        }
      })();
    },
    move(pt: ToolPoint, tool: ToolId) {
      if (isSelectShapeTool(tool) && marqueeStart) {
        selectionState.update((s) => ({ ...s, marquee: normalizeRect(marqueeStart!, pt) }));
        return;
      }
      if (tool !== 'move' || !dragging) return;
      const dx = pt.x - dragging.startX;
      const dy = pt.y - dragging.startY;
      const next: Transform2D = { ...dragging.start, x: dragging.start.x + dx, y: dragging.start.y + dy };
      history.push(app, patchCommand('Move Object', [{ op: 'setTransform', id: objectId(dragging.objId), transform: next }]));
    },
    up(pt: ToolPoint, tool: ToolId) {
      if (isSelectShapeTool(tool) && marqueeStart) {
        const additive = !!marqueeStart.shiftKey;
        const rect = normalizeRect(marqueeStart, pt);
        marqueeStart = null;
        if (rect.width < CLICK_EPSILON_PX && rect.height < CLICK_EPSILON_PX) {
          // A shift+click (no real drag) is additive-only: must not clear
          // an existing multi-selection, same convention as the move tool's
          // shift+click-on-empty-space no-op.
          if (!additive) selectionState.set({ objects: [], marquee: null });
          return;
        }
        const hits = objectsOverlapping(app, rect);
        // Keep the rect (not null). See header comment: edit.fillSelection
        // needs it to outlive the drag. Make the first hit's layer active
        // (never refuse a marquee just because it landed on a non-active
        // scene layer), same reasoning as the move-tool hit-test above.
        if (hits.length > 0) viewState.update((s) => ({ ...s, activeLayer: hits[0]!.layer }));
        const hitIds = hits.map((h) => h.id);
        // Shift+marquee ADDS to the existing selection instead of replacing
        // it (a plain marquee still replaces, including clearing to []
        // when it lands on empty space, unchanged).
        const nextObjects = additive
          ? Array.from(new Set([...selectionState.get().objects, ...hitIds]))
          : hitIds;
        selectionState.set({ objects: nextObjects, marquee: rect });
        return;
      }
      if (tool === 'move' && dragging) {
        const { objId, layer, startX, startY } = dragging;
        dragging = null;
        const dist = Math.hypot(pt.x - startX, pt.y - startY);
        if (dist >= CLICK_EPSILON_PX) {
          // A real drag breaks any pending double-click chain.
          lastClick = null;
          return;
        }
        const now = performance.now();
        if (opts.onObjectDoubleClick && lastClick && lastClick.objId === objId && now - lastClick.time < DOUBLE_CLICK_MS) {
          lastClick = null;
          opts.onObjectDoubleClick(layer, objId);
        } else {
          lastClick = { objId, time: now };
        }
        return;
      }
      dragging = null;
    },
  };
}

type CornerHandle = 'tl' | 'tm' | 'tr' | 'ml' | 'mr' | 'bl' | 'bm' | 'br';

/** Local content-box point for each handle, as a function of the box size. */
const HANDLE_LOCAL: Record<CornerHandle, (w: number, h: number) => [number, number]> = {
  tl: (w, h) => [0, 0],
  tm: (w, h) => [w / 2, 0],
  tr: (w, h) => [w, 0],
  ml: (w, h) => [0, h / 2],
  mr: (w, h) => [w, h / 2],
  bl: (w, h) => [0, h],
  bm: (w, h) => [w / 2, h],
  br: (w, h) => [w, h],
};

/** Which scale axes a handle drag is allowed to touch (edge handles: one axis). */
const HANDLE_AXES: Record<CornerHandle, { x: boolean; y: boolean }> = {
  tl: { x: true, y: true },
  tm: { x: false, y: true },
  tr: { x: true, y: true },
  ml: { x: true, y: false },
  mr: { x: true, y: false },
  bl: { x: true, y: true },
  bm: { x: false, y: true },
  br: { x: true, y: true },
};

/** Fraction along the (possibly rotated) box edges, TL/TR/BR/BL basis. */
const HANDLE_FRACTIONS: Record<CornerHandle, [number, number]> = {
  tl: [0, 0], tm: [0.5, 0], tr: [1, 0],
  ml: [0, 0.5], mr: [1, 0.5],
  bl: [0, 1], bm: [0.5, 1], br: [1, 1],
};

const ROTATE_OFFSET_PX = 28;

function boxOf(app: AppCtx, layer: ReturnType<typeof layerId>, id: ReturnType<typeof objectId>): ContentBox | null {
  const doc = app.engine.getDocument();
  const node = findSceneObject(doc, layer, id);
  if (!node) return null;
  return contentBoxOf(node.content, { getAsset: (assetId) => doc.assets[assetId] });
}

/** Mounts a self-contained overlay: subscribes to the stores/document events
 * it needs and re-renders itself; caller just needs it to exist once. */
export function mountSelectionOverlay(app: AppCtx, canvasRegion: HTMLElement, canvas: HTMLCanvasElement): void {
  const overlay = document.createElement('div');
  overlay.className = 'gd-selection-overlay';
  overlay.dataset.testid = 'selection-overlay';
  canvasRegion.appendChild(overlay);

  function syncOverlayTransform(): void {
    overlay.style.width = canvas.style.width;
    overlay.style.height = canvas.style.height;
    overlay.style.transform = canvas.style.transform;
  }

  function docToCanvasClient(clientX: number, clientY: number): [number, number] {
    const rect = canvas.getBoundingClientRect();
    const { zoom } = viewState.get();
    return [(clientX - rect.left) / zoom, (clientY - rect.top) / zoom];
  }

  /**
   * The PRIMARY selected object: the one interactive handles/rotate get
   * drawn for. With a single selection it's that object (unchanged
   * behaviour); with a multi-selection it's the last one in
   * selectionState.objects (the most recently added, since shift-click/
   * shift-marquee both append). Everything else in the selection gets a
   * plain outline box only (see render()'s header comment).
   */
  function currentSelection(): { layer: string; id: string } | null {
    const sel = selectionState.get();
    if (sel.objects.length === 0) return null;
    const doc = app.engine.getDocument();
    const primary = sel.objects[sel.objects.length - 1]!;
    const layer = findObjectLayer(doc, primary);
    if (!layer) return null;
    return { layer, id: primary };
  }

  function startHandleDrag(
    e: PointerEvent,
    objId: string,
    apply: (start: Transform2D, docX: number, docY: number, shiftKey: boolean) => Transform2D,
  ): void {
    e.stopPropagation();
    e.preventDefault();
    const sel = currentSelection();
    if (!sel) return;
    const doc = app.engine.getDocument();
    const node = findSceneObject(doc, layerId(sel.layer), objectId(objId));
    if (!node) return;
    const start = node.transform;
    const pointerId = e.pointerId;

    // Listen on window, NOT the handle element: every setTransform below
    // fires document-changed → render() → overlay.innerHTML = '', which
    // destroys the handle mid-drag. Element-attached listeners (and pointer
    // capture) die with it: the drag applied exactly one move event and
    // went dead ("resize/rotate only moves a tiny bit", the live bug this
    // fixes). Window listeners survive the re-render; pointerId keys the
    // events to this drag.
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const [docX, docY] = docToCanvasClient(ev.clientX, ev.clientY);
      const next = apply(start, docX, docY, ev.shiftKey);
      history.push(app, patchCommand('Transform Object', [{ op: 'setTransform', id: objectId(objId), transform: next }]));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function renderMarquee(): boolean {
    const { marquee } = selectionState.get();
    if (!marquee) return false;
    const { zoom } = viewState.get();
    const box = document.createElement('div');
    box.className = 'gd-marquee-box';
    box.dataset.testid = 'marquee-box';
    box.style.left = `${marquee.x * zoom}px`;
    box.style.top = `${marquee.y * zoom}px`;
    box.style.width = `${marquee.width * zoom}px`;
    box.style.height = `${marquee.height * zoom}px`;
    overlay.appendChild(box);
    return true;
  }

  /** Plain outline box (no handles) for a non-primary member of a
   * multi-selection. See render()'s header comment. */
  function renderSecondaryBox(doc: DocumentJSON, objId: string, zoom: number): void {
    const layerIdStr = findObjectLayer(doc, objId);
    if (!layerIdStr) return;
    const corners = objectDocCorners(doc, layerId(layerIdStr), objectId(objId));
    if (!corners) return;
    const [tl, tr, , bl] = docCornersToCanvasPx(corners, zoom) as [
      [number, number], [number, number], [number, number], [number, number],
    ];
    const box = document.createElement('div');
    box.className = 'gd-selection-box gd-selection-box--secondary';
    box.style.left = `${tl[0]}px`;
    box.style.top = `${tl[1]}px`;
    box.style.width = `${Math.hypot(tr[0] - tl[0], tr[1] - tl[1])}px`;
    box.style.height = `${Math.hypot(bl[0] - tl[0], bl[1] - tl[1])}px`;
    box.style.transform = `rotate(${Math.atan2(tr[1] - tl[1], tr[0] - tl[0])}rad)`;
    box.style.transformOrigin = '0 0';
    overlay.appendChild(box);
  }

  function render(): void {
    syncOverlayTransform();
    overlay.innerHTML = '';
    renderMarquee();
    const sel = currentSelection();
    if (!sel) return;
    const doc = app.engine.getDocument();
    const { zoom } = viewState.get();
    // Every OTHER selected object gets a plain outline (no interactive
    // handles): resizing/rotating a whole multi-selection as one group
    // isn't part of this pass, but every selected object still needs
    // visible feedback, not just the primary (see src/ui/CLAUDE.md).
    for (const objId of selectionState.get().objects) {
      if (objId !== sel.id) renderSecondaryBox(doc, objId, zoom);
    }
    const layer = layerId(sel.layer);
    const id = objectId(sel.id);
    const corners = objectDocCorners(doc, layer, id);
    if (!corners) return;
    const [tl, tr, , bl] = docCornersToCanvasPx(corners, zoom) as [
      [number, number], [number, number], [number, number], [number, number],
    ];

    const box = document.createElement('div');
    box.className = 'gd-selection-box';
    const width = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
    const height = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
    const angle = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]);
    box.style.left = `${tl[0]}px`;
    box.style.top = `${tl[1]}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.style.transform = `rotate(${angle}rad)`;
    box.style.transformOrigin = '0 0';
    overlay.appendChild(box);

    for (const key of Object.keys(HANDLE_LOCAL) as CornerHandle[]) {
      const handle = document.createElement('div');
      handle.className = `gd-selection-handle gd-selection-handle--${key}`;
      handle.dataset.testid = `handle-${key}`;
      const [fx, fy] = HANDLE_FRACTIONS[key];
      const x = tl[0] + (tr[0] - tl[0]) * fx + (bl[0] - tl[0]) * fy;
      const y = tl[1] + (tr[1] - tl[1]) * fx + (bl[1] - tl[1]) * fy;
      handle.style.left = `${x}px`;
      handle.style.top = `${y}px`;
      handle.addEventListener('pointerdown', (e) => {
        startHandleDrag(e, sel.id, (start, docX, docY, shiftKey) => {
          const boxNow = boxOf(app, layer, id);
          if (!boxNow) return start;
          const anchorPx: [number, number] = [start.anchorX * boxNow.width, start.anchorY * boxNow.height];
          const local = HANDLE_LOCAL[key](boxNow.width, boxNow.height);
          const rel: [number, number] = [local[0] - anchorPx[0], local[1] - anchorPx[1]];
          const relDoc: [number, number] = [docX - start.x, docY - start.y];
          const c = Math.cos(-start.rotation);
          const s = Math.sin(-start.rotation);
          const unrot: [number, number] = [relDoc[0] * c - relDoc[1] * s, relDoc[0] * s + relDoc[1] * c];
          const axes = HANDLE_AXES[key];
          let scaleX = axes.x && Math.abs(rel[0]) > 1e-6 ? unrot[0] / rel[0] : start.scaleX;
          let scaleY = axes.y && Math.abs(rel[1]) > 1e-6 ? unrot[1] / rel[1] : start.scaleY;
          if (shiftKey) {
            // Shift locks the aspect ratio: one uniform factor relative to
            // the START scale, applied to both axes. Corners follow the
            // dominant axis of the drag, edge handles apply their single
            // axis's factor to both.
            const fx = start.scaleX !== 0 ? scaleX / start.scaleX : 1;
            const fy = start.scaleY !== 0 ? scaleY / start.scaleY : 1;
            const f = axes.x && axes.y
              ? (Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy)
              : axes.x ? fx : fy;
            scaleX = start.scaleX * f;
            scaleY = start.scaleY * f;
          }
          return { ...start, scaleX, scaleY };
        });
      });
      overlay.appendChild(handle);
    }

    const rotateHandle = document.createElement('div');
    rotateHandle.className = 'gd-selection-handle gd-selection-handle--rotate';
    rotateHandle.dataset.testid = 'handle-rotate';
    const topMidX = (tl[0] + tr[0]) / 2;
    const topMidY = (tl[1] + tr[1]) / 2;
    const dirX = -Math.sin(angle);
    const dirY = -Math.cos(angle);
    rotateHandle.style.left = `${topMidX + dirX * ROTATE_OFFSET_PX}px`;
    rotateHandle.style.top = `${topMidY + dirY * ROTATE_OFFSET_PX}px`;
    rotateHandle.addEventListener('pointerdown', (e) => {
      startHandleDrag(e, sel.id, (start, docX, docY) => {
        const rotation = Math.atan2(docY - start.y, docX - start.x) + Math.PI / 2;
        return { ...start, rotation };
      });
    });
    overlay.appendChild(rotateHandle);
  }

  app.engine.on('document-changed', render);
  viewState.subscribe(render);
  selectionState.subscribe(render);
  render();
}
