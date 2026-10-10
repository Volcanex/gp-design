/**
 * The app-level stores everything reads from. Singletons (one app on the
 * page), not threaded through AppCtx: panels/commands/shell import them
 * directly. layoutState persists to localStorage.
 *
 * Layout (docked shell, 2026-09): a pane is visible or not (F5-F10), and a
 * visible pane is expanded or collapsed (click its title). The right column
 * has one width. Nothing floats, so nothing needs clamping. Theme is NOT
 * here: g-system owns it (`g.theme(mode)`, persisted under `g-theme` and
 * re-applied by g-ui.js at boot), and the View menu calls that directly.
 */

import { createStore } from './store';
import type { LayoutState, PanelPlacement, SelectionState, ToolState, ViewState } from './types';

const LAYOUT_STORAGE_KEY = 'gdesign.layout.v2';
/** Floating-era layouts: only their visible flags are worth carrying over. */
const LEGACY_LAYOUT_KEY = 'gdesign.layout.v1';
const SAVE_DEBOUNCE_MS = 250;

export const RIGHT_WIDTH_DEFAULT = 280;
export const RIGHT_WIDTH_MIN = 200;
export const RIGHT_WIDTH_MAX = 520;

/** Pane ids in their docked order. `tools` is the left rail, `timeline`
 * the strip under the canvas; the rest stack in the right column top to
 * bottom. */
export const PANE_ORDER = ['layers', 'effects', 'colors', 'history'] as const;

const PANE_DEFAULTS: Record<string, { visible: boolean; collapsed?: boolean }> = {
  tools: { visible: true },
  layers: { visible: true },
  effects: { visible: true },
  colors: { visible: true },
  history: { visible: true, collapsed: true },
  timeline: { visible: false },
};

/** Used by panel.toggle/reset and to seed layoutState on first run or for an unknown id. */
export function defaultPanelPlacement(id: string): PanelPlacement {
  const def = PANE_DEFAULTS[id] ?? { visible: true };
  return { visible: def.visible, collapsed: def.collapsed ?? false, x: 0, y: 0 };
}

export function defaultLayout(): LayoutState {
  const panels: Record<string, PanelPlacement> = {};
  for (const id of Object.keys(PANE_DEFAULTS)) panels[id] = defaultPanelPlacement(id);
  return { panels, theme: 'dark', rightWidth: RIGHT_WIDTH_DEFAULT };
}

export function clampRightWidth(w: number): number {
  return Math.round(Math.min(RIGHT_WIDTH_MAX, Math.max(RIGHT_WIDTH_MIN, w)));
}

function loadLayout(): LayoutState {
  const fallback = defaultLayout();
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LayoutState>;
      const panels: Record<string, PanelPlacement> = { ...fallback.panels };
      for (const [id, p] of Object.entries(parsed.panels ?? {})) {
        if (!p || typeof p !== 'object') continue;
        panels[id] = { ...defaultPanelPlacement(id), visible: !!p.visible, collapsed: !!p.collapsed };
      }
      return {
        ...fallback,
        panels,
        rightWidth: typeof parsed.rightWidth === 'number' ? clampRightWidth(parsed.rightWidth) : fallback.rightWidth,
      };
    }
    const legacy = localStorage.getItem(LEGACY_LAYOUT_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as { panels?: Record<string, { visible?: boolean }> };
      const panels: Record<string, PanelPlacement> = { ...fallback.panels };
      for (const [id, p] of Object.entries(parsed.panels ?? {})) {
        if (p && typeof p === 'object' && typeof p.visible === 'boolean') panels[id] = { ...defaultPanelPlacement(id), visible: p.visible };
      }
      return { ...fallback, panels };
    }
  } catch {
    /* corrupt storage reads as first run */
  }
  return fallback;
}

/** Bucket tool's default OKLab+alpha match tolerance (see ToolState.bucketTolerance). */
export const DEFAULT_BUCKET_TOLERANCE = 0.08;

export const toolState = createStore<ToolState>({
  active: 'brush',
  brushSize: 24,
  primary: [0.6, 0.1, -0.05, 1],
  secondary: [1, 0, 0, 1],
  editing: 'primary',
  lastShape: 'rect',
  bucketTolerance: DEFAULT_BUCKET_TOLERANCE,
});

export const viewState = createStore<ViewState>({
  zoom: 1,
  panX: 0,
  panY: 0,
  activeLayer: null,
  collapsedGroups: [],
  maskEditing: null,
});

export const selectionState = createStore<SelectionState>({
  objects: [],
  marquee: null,
});

/** Mirrors the engine's 'clock' events (localHost.ts) for the statusbar
 * transport control and clock.toggle command. Defaults to playing since the
 * clock plays by default from boot (main.ts sends the play command right
 * after load). This just avoids a one-frame flash of a paused-looking
 * button before the first 'clock' event lands. */
export const clockState = createStore<{ playing: boolean; time: number }>({
  playing: true,
  time: 0,
});

export const layoutState = createStore<LayoutState>(loadLayout());

export interface TimelineState {
  /** Transport loop range: session-only, mirrors the engine's own loopRange
   * (localHost.ts), never persisted or round-tripped through the document. */
  loop?: { from: number; to: number };
  selectedKey?: { lane: string; index: number };
}

export const timelineState = createStore<TimelineState>({});

const STATUS_MESSAGE_MS = 5000;

/** Transient statusbar message (import errors, etc.). Auto-clears itself. */
export const statusMessage = createStore<string | null>(null);
let statusMessageTimer: ReturnType<typeof setTimeout> | undefined;

export function showStatusMessage(text: string): void {
  clearTimeout(statusMessageTimer);
  statusMessage.set(text);
  statusMessageTimer = setTimeout(() => statusMessage.set(null), STATUS_MESSAGE_MS);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSave: LayoutState | null = null;

/** Writes a still-debounced save immediately. Called on unload so a pane
 * toggled right before a reload/close isn't lost to the 250ms window. */
export function flushLayoutSave(): void {
  if (pendingSave === null || typeof localStorage === 'undefined') return;
  clearTimeout(saveTimer);
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(pendingSave));
  pendingSave = null;
}

if (typeof document !== 'undefined') {
  layoutState.subscribe((state) => {
    if (typeof localStorage === 'undefined') return;
    pendingSave = state;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state));
      pendingSave = null;
    }, SAVE_DEBOUNCE_MS);
  });

  window.addEventListener('pagehide', flushLayoutSave);
  window.addEventListener('beforeunload', flushLayoutSave);
}
