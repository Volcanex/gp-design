/**
 * Boot. Creates the real WebGPU engine + starter doc, mounts the shell,
 * installs the keymap, and exposes the __gdesign debug/test handle.
 */

import { createLocalEngineHost } from '@engine';
import { emptyDocument, layerId, objectId, identityTransform } from '@engine';
import type { EngineHost, DocumentJSON } from '@engine';
import type { AppCtx } from './types';
import { clockState, defaultPanelPlacement, layoutState, selectionState, showStatusMessage, toolState, viewState } from './stores';
import { mountShell } from '../ui/shell/shell';
import { installViewport, setToolHandler } from '../ui/canvas/viewport';
import type { ToolHandler, ToolPoint } from '../ui/canvas/viewport';
import { createPaintToolHandler } from '../ui/canvas/paint-tool';
import { createBucketToolHandler } from '../ui/canvas/bucket-tool';
import { createSelectToolHandler, mountSelectionOverlay } from '../ui/canvas/select-tool';
import { createGradientToolHandler } from '../ui/canvas/gradient-tool';
import { createLineShapesToolHandler } from '../ui/canvas/line-shapes-tool';
import { mountTextEditor, createTextToolHandler } from '../ui/canvas/text-tool';
import { findSceneObject } from '../ui/canvas/object-bounds';
import { installKeymap } from './keymap/keymap';
import { installMaskEscapeGuard } from '../ui/canvas/mask-paint';
import { executeCommand } from './commands/registry';
import { fitZoom, centeredPan } from '../ui/shell/view-math';
import { importImageFile } from './commands/image-import';
import { markPasteHandled } from './commands/paste-guard';
import { loadRemoteScenes } from '../engine/sources/remote/render-scenes';

/** Move-tool double-click on a SHAPE object (text objects get the floating
 * editor instead, via textEditor.openForObject) opens/focuses the Effects
 * panel's Object section (panels/effects.ts), the only place shape
 * geometry/fill are editable. Forces `visible: true` rather than toggling,
 * since a double-click should always reveal the panel, never hide it. */
function focusEffectsPanel(): void {
  layoutState.update((s) => ({
    ...s,
    panels: { ...s.panels, effects: { ...(s.panels.effects ?? defaultPanelPlacement('effects')), visible: true } },
  }));
}

/** Routes to the select/move tool's handler for 'move', else the paint
 * tool's (which itself no-ops for non-paint tools). One ToolHandler is
 * ever installed via viewport.setToolHandler, so this fans it back out. */
function combineToolHandlers(...handlers: ToolHandler[]): ToolHandler {
  return {
    down(pt: ToolPoint, tool) { handlers.forEach((h) => h.down(pt, tool)); },
    move(pt: ToolPoint, tool) { handlers.forEach((h) => h.move(pt, tool)); },
    up(pt: ToolPoint, tool) { handlers.forEach((h) => h.up(pt, tool)); },
  };
}

declare global {
  interface Window {
    __gdesign?: {
      ready: boolean;
      engine: EngineHost;
      doc(): DocumentJSON;
      stores: {
        toolState: typeof toolState;
        viewState: typeof viewState;
        selectionState: typeof selectionState;
        layoutState: typeof layoutState;
      };
      exec(id: string, args?: unknown): void;
      /** Dev-only test hooks (crash-tests workstream), not part of the
       * shell tracks' contract above, so kept in a separate namespace. */
      debug: {
        /** Makes the next `n` render frames fail, exercising the
         * error-storm cutoff (error-storm.spec.ts). */
        failFrames(n: number): void;
      };
    };
  }
}

/** A fatal engine error (GPU device lost, out of memory, an error storm)
 * is unrecoverable in-session and statusMessage toasts expire, so pin a
 * persistent banner instead. One banner only: the first fatal message wins,
 * later ones are logged but not stacked. */
function showFatalBanner(message: string): void {
  if (document.getElementById('gd-fatal-banner')) return;
  const el = document.createElement('div');
  el.id = 'gd-fatal-banner';
  el.setAttribute('role', 'alert');
  el.setAttribute('data-testid', 'fatal-banner');
  el.textContent = message;
  document.body.appendChild(el);
}

/** Boot could not complete (no WebGPU, no adapter, a throw during init):
 * replace the empty shell with a plain explanation rather than leaving a
 * blank page. Kept as DOM, not lit-html, so it works even if the module
 * graph is what failed. */
function showBootFailure(err: unknown): void {
  console.error('[gdesign] boot failed', err);
  const root = document.getElementById('app');
  if (!root) return;
  const detail = err instanceof Error ? err.message : String(err);
  const noGpu = !('gpu' in navigator) || /WebGPU|adapter|navigator\.gpu/i.test(detail);
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'gd-boot-failure';
  box.setAttribute('data-testid', 'boot-failure');
  const h = document.createElement('h1');
  h.textContent = noGpu ? 'This editor needs WebGPU' : 'The editor could not start';
  const p = document.createElement('p');
  p.textContent = noGpu
    ? 'Open it in Chrome or Edge on a desktop, or Safari 18 or newer. Firefox needs WebGPU enabled in about:config.'
    : 'Reload the page to try again. If it keeps happening, the message below is what to report.';
  const pre = document.createElement('pre');
  pre.textContent = detail;
  box.append(h, p, pre);
  root.appendChild(box);
}

/** Anything that escapes every other guard lands here. Errors from the
 * engine's own fatal path already produced a banner; everything else is
 * reported as a transient status message so the app keeps working. */
function installGlobalErrorHandlers(): void {
  const seen = new Set<string>();
  const report = (label: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const key = `${label}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    console.error(`[gdesign] ${label}`, err);
    showStatusMessage(`Something went wrong: ${message}. The last action may not have applied.`);
  };
  window.addEventListener('error', (e) => report('uncaught error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => report('unhandled rejection', e.reason));
}

async function boot() {
  // Kicked off before engine init so the network fetch overlaps GPU init;
  // awaited below, right before mountShell (menus enumerate listSources()
  // at mount time). loadRemoteScenes never throws: render being down must
  // not affect gdesign boot.
  const remoteScenes = loadRemoteScenes();

  const root = document.getElementById('app')!;

  const canvas = document.createElement('canvas');
  canvas.id = 'gd-canvas';
  canvas.width = 1280;
  canvas.height = 720;

  const engine = createLocalEngineHost();
  engine.on('clock', (e) => {
    if (e.type === 'clock') clockState.set({ playing: e.playing, time: e.time });
  });
  engine.on('error', (e) => {
    if (e.type !== 'error') return;
    if (e.fatal) showFatalBanner(e.message);
    else showStatusMessage(e.message);
  });
  await engine.init(canvas);

  const doc = emptyDocument();
  doc.layers.push({
    id: layerId('layer-1'),
    kind: 'layer',
    name: 'Background',
    enabled: true,
    source: { type: 'core.solid', params: { color: [0.65, 0.05, -0.1, 1] } },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'baked',
  });
  // Paintable from the first pointer-down, paint.net style: a raster layer
  // on top, active by default (brush strokes only land on core.raster).
  doc.layers.push({
    id: layerId('paint-1'),
    kind: 'layer',
    name: 'Paint',
    enabled: true,
    source: { type: 'core.raster', params: {} },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'baked',
  });
  await engine.loadDocument(doc);
  viewState.update((s) => ({ ...s, activeLayer: 'paint-1' }));
  // This is a time-aware/live-generative editor: motion is the product, so
  // the transport clock plays from boot rather than sitting paused until a
  // user finds the play button. New/Open (loadFreshDocument) don't touch
  // playing state, so they inherit whatever this leaves it at.
  engine.setClock({ cmd: 'play' });

  const app: AppCtx = { engine };

  // Handles an OS image pasted directly onto the page (works even where
  // navigator.clipboard.read() is denied, e.g. Firefox). Takes priority
  // over registry.ts's edit.paste, which no-ops for ~150ms after this fires
  // (paste-guard.ts) so the two don't both import the same paste gesture.
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      markPasteHandled();
      void importImageFile(app, file, 'Pasted Image');
      return;
    }
  });

  const remoteSceneCount = await remoteScenes;
  if (remoteSceneCount > 0) console.info(`[gdesign] loaded ${remoteSceneCount} remote scene(s) from render`);

  mountShell(app, root, canvas);
  installViewport(app, canvas);

  const canvasRegion = root.querySelector<HTMLElement>('.gd-canvas-region');
  const textEditor = canvasRegion ? mountTextEditor(app, canvasRegion, canvas) : null;

  setToolHandler(combineToolHandlers(
    createSelectToolHandler(app, {
      onObjectDoubleClick: (layer, id) => {
        const node = findSceneObject(app.engine.getDocument(), layerId(layer), objectId(id));
        if (node?.content.type === 'text') textEditor?.openForObject(layer, id);
        else if (node) focusEffectsPanel();
      },
    }),
    createPaintToolHandler(app),
    createBucketToolHandler(app),
    createGradientToolHandler(app),
    createLineShapesToolHandler(app),
    ...(textEditor ? [createTextToolHandler(textEditor)] : []),
  ));
  installKeymap(app);
  installMaskEscapeGuard();

  if (canvasRegion) mountSelectionOverlay(app, canvasRegion, canvas);

  // Fit-and-centre on boot; capped at 1 so small docs aren't blown up. Measured
  // directly off the DOM (ResizeObserver's first callback hasn't fired yet).
  if (canvasRegion) {
    const region = canvasRegion.getBoundingClientRect();
    if (region.width && region.height) {
      const zoom = Math.min(fitZoom(region, doc.canvas), 1);
      const pan = centeredPan(region, doc.canvas, zoom);
      viewState.update((s) => ({ ...s, zoom, panX: pan.x, panY: pan.y }));
    }
  }

  window.__gdesign = {
    ready: true,
    engine,
    doc: () => engine.getDocument(),
    stores: { toolState, viewState, selectionState, layoutState },
    exec: (id, args) => executeCommand(app, id, args),
    debug: {
      failFrames: (n) => engine.debugFailFrames?.(n),
    },
  };
}

installGlobalErrorHandlers();
boot().catch(showBootFailure);
