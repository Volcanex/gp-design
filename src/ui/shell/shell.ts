/**
 * The docked app shell (2026-09): menubar / main / timeline / statusbar,
 * where main is [tools rail | canvas region | splitter | right column].
 * The canvas region hosts the engine canvas (absolutely positioned, sized
 * by doc dims * zoom, placed via translate(panX, panY), see
 * src/ui/CLAUDE.md's viewport section for the single-coordinate-system
 * rule). Panes never float and never overlap the canvas: the right column
 * is a g-system `.g-pane-stack` whose panes fold and unfold in place, and
 * a `.g-splitter` sets its width. F5-F10 still toggle each pane's
 * visibility (`layoutState.panels[id].visible`).
 */

import { render as litRender } from 'lit-html';
import type { AppCtx, PanelHost } from '../../app/types';
import {
  PANE_ORDER, clampRightWidth, defaultPanelPlacement, layoutState, viewState, toolState, selectionState,
} from '../../app/stores';
import { history } from '../../app/commands/app-history';
import { importImageFile } from '../../app/commands/image-import';
import { openImportVideoDialog } from '../dialogs';
import { allPanels } from '../panels';
import { mountMenubar } from './menubar';
import { mountStatusbar } from './statusbar';
import { mountTimeline } from './timeline';
import { clampPan } from './view-math';
import { CANVAS_HINT_TEXT, isStarterDoc } from './hints';

declare global {
  interface Window {
    g?: { init(root?: ParentNode): void; theme(mode: string): void; toast(opts: unknown): unknown; plain(s: string): string };
  }
}

let regionSize = { width: 0, height: 0 };
export function getCanvasRegionSize(): { width: number; height: number } {
  return regionSize;
}

function placementOf(id: string) {
  return layoutState.get().panels[id] ?? defaultPanelPlacement(id);
}

/** One `.g-pane` in the right column. The title button folds the body
 * (persisted as `collapsed`); F-keys and the Window menu hide the whole
 * pane (`visible`). The body re-renders from the host's template. */
function mountPane(app: AppCtx, host: PanelHost, stack: HTMLElement): () => void {
  const pane = document.createElement('section');
  pane.className = 'g-pane';
  pane.dataset.testid = `panel-${host.id}`;
  if (host.id === 'layers') pane.dataset.fill = '';

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'g-pane-title';
  title.dataset.testid = `pane-title-${host.id}`;
  const label = document.createElement('span');
  label.textContent = host.title;
  title.append(label);
  if (host.toggleKey) {
    const kbd = document.createElement('span');
    kbd.className = 'kbd';
    kbd.textContent = host.toggleKey;
    title.append(kbd);
  }

  const body = document.createElement('div');
  body.className = 'g-pane-body';
  body.id = `gd-pane-${host.id}`;
  if (host.id === 'layers' || host.id === 'history' || host.id === 'effects') body.dataset.flush = '';
  title.setAttribute('aria-controls', body.id);

  pane.append(title, body);
  stack.appendChild(pane);

  // The fragment's own click handler flips aria-expanded/hidden and fires
  // g-pane:toggle; we persist from that event rather than owning the click,
  // so keyboard activation works the same way.
  pane.addEventListener('g-pane:toggle', (e) => {
    const expanded = (e as CustomEvent<{ expanded: boolean }>).detail.expanded;
    layoutState.update((s) => ({
      ...s,
      panels: { ...s.panels, [host.id]: { ...placementOf(host.id), collapsed: !expanded } },
    }));
  });

  const renderPane = () => {
    const placement = placementOf(host.id);
    pane.hidden = !placement.visible;
    if (!placement.visible) return;
    const expanded = !placement.collapsed;
    title.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    body.hidden = !expanded;
    if (expanded) litRender(host.render(app), body);
  };

  layoutState.subscribe(renderPane);
  renderPane();
  return renderPane;
}

/** The tools rail: the tools host's template rendered straight into the
 * left column, no title. */
function mountRail(app: AppCtx, host: PanelHost, rail: HTMLElement): () => void {
  rail.dataset.testid = `panel-${host.id}`;
  const renderRail = () => {
    const placement = placementOf(host.id);
    rail.hidden = !placement.visible;
    if (placement.visible) litRender(host.render(app), rail);
  };
  layoutState.subscribe(renderRail);
  renderRail();
  return renderRail;
}

export function mountShell(app: AppCtx, root: HTMLElement, canvas: HTMLCanvasElement): void {
  root.innerHTML = '';
  root.classList.add('gd-shell');

  const menubarEl = document.createElement('nav');
  menubarEl.className = 'g-menubar gd-menubar';
  menubarEl.setAttribute('aria-label', 'Application');

  const main = document.createElement('div');
  main.className = 'gd-main';

  const rail = document.createElement('div');
  rail.className = 'gd-rail';

  const canvasRegion = document.createElement('div');
  canvasRegion.className = 'gd-canvas-region';
  canvasRegion.dataset.testid = 'canvas-region';

  const splitter = document.createElement('div');
  splitter.className = 'g-splitter';
  splitter.dataset.side = 'after';
  splitter.dataset.target = '#gd-right';
  splitter.dataset.min = '200';
  splitter.dataset.max = '520';
  splitter.setAttribute('aria-hidden', 'true');

  const right = document.createElement('aside');
  right.className = 'g-pane-stack gd-right';
  right.id = 'gd-right';
  right.setAttribute('aria-label', 'Panels');

  main.append(rail, canvasRegion, splitter, right);

  const timelineEl = document.createElement('div');
  timelineEl.className = 'gd-timeline-region';

  const statusbarEl = document.createElement('div');
  statusbarEl.className = 'gd-statusbar';

  root.append(menubarEl, main, timelineEl, statusbarEl);
  canvasRegion.appendChild(canvas);

  const applyRightWidth = () => {
    const w = clampRightWidth(layoutState.get().rightWidth ?? 280);
    right.style.width = `${w}px`;
    right.style.flexBasis = `${w}px`;
  };
  applyRightWidth();
  layoutState.subscribe(applyRightWidth);
  splitter.addEventListener('g-splitter:resize', (e) => {
    const size = (e as CustomEvent<{ size: number }>).detail.size;
    layoutState.update((s) => ({ ...s, rightWidth: clampRightWidth(size) }));
  });

  // Non-interactive discoverability overlay for the untouched starter doc.
  // pointer-events: none (styles/app.css) so it never intercepts drag/drop
  // or canvas pointer handling. Disappears permanently the moment history
  // gains its first entry (renderCanvasHint is wired into the same
  // history.onChange re-render every panel already listens to below).
  const canvasHintEl = document.createElement('div');
  canvasHintEl.className = 'gd-canvas-hint';
  canvasHintEl.dataset.testid = 'canvas-hint';
  canvasHintEl.textContent = CANVAS_HINT_TEXT;
  canvasRegion.appendChild(canvasHintEl);
  function renderCanvasHint(): void {
    canvasHintEl.hidden = !isStarterDoc();
  }
  renderCanvasHint();

  canvasRegion.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  canvasRegion.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    e.preventDefault();
    const baseName = file.name.replace(/\.[^./\\]+$/, '');
    if (file.type.startsWith('video/')) {
      openImportVideoDialog(app, file, baseName || 'Video');
      return;
    }
    if (!file.type.startsWith('image/')) return;
    void importImageFile(app, file, baseName || 'Image');
  });

  const ro = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const oldSize = regionSize;
    const newSize = { width: entry.contentRect.width, height: entry.contentRect.height };
    regionSize = newSize;
    if (!oldSize.width || !oldSize.height) return; // first observation: no prior centre to preserve
    // Keep the doc point under the (old) region centre fixed as the region resizes.
    const doc = app.engine.getDocument().canvas;
    const { zoom, panX, panY } = viewState.get();
    const pan = clampPan(
      { x: panX + (newSize.width - oldSize.width) / 2, y: panY + (newSize.height - oldSize.height) / 2 },
      newSize,
      doc,
      zoom,
    );
    viewState.update((s) => ({ ...s, panX: pan.x, panY: pan.y }));
  });
  ro.observe(canvasRegion);

  function layoutCanvas(): void {
    const doc = app.engine.getDocument();
    const { zoom, panX, panY } = viewState.get();
    canvas.style.width = `${doc.canvas.width * zoom}px`;
    canvas.style.height = `${doc.canvas.height * zoom}px`;
    canvas.style.transform = `translate(${panX}px, ${panY}px)`;
  }
  viewState.subscribe(layoutCanvas);
  layoutCanvas();

  mountMenubar(app, menubarEl);
  mountStatusbar(app, statusbarEl);
  mountTimeline(app, timelineEl);

  const hosts = allPanels(app);
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const renderers: Array<() => void> = [];
  const tools = byId.get('tools');
  if (tools) renderers.push(mountRail(app, tools, rail));
  for (const id of PANE_ORDER) {
    const host = byId.get(id);
    if (host) renderers.push(mountPane(app, host, right));
  }

  // g-ui.js is deferred: by the time boot() runs it has initialised, and
  // the fragments guard against a second init, so this wires the menubar,
  // panes and splitter we just created.
  window.g?.init(root);

  // Panels are pure functions of the document + UI stores, so they must
  // re-render on engine-side document changes (undo/redo, menu commands),
  // history-stack changes, and tool/view/selection state, not just layout.
  // Coalesced through one microtask: a single pointer move can touch
  // history, the document and the selection at once, and each used to be a
  // full re-render of every panel on its own. A microtask (not an animation
  // frame) so the DOM is current before the event loop turns: a deferred
  // frame lags behind state under load, which tests and quick users see.
  let scheduled = false;
  const renderAllPanels = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      renderers.forEach((render) => render());
    });
  };
  app.engine.on('document-changed', renderAllPanels);
  history.onChange(renderAllPanels);
  history.onChange(renderCanvasHint);
  toolState.subscribe(renderAllPanels);
  viewState.subscribe(renderAllPanels);
  selectionState.subscribe(renderAllPanels);
}
