/**
 * FROZEN CONTRACT (shell FREEZE-1). UI-side types. Engine types are
 * re-exported from @engine. This file adds only what is UI-native:
 * commands/undo, panels, tools.
 */

import type { EngineHost, DocEdit } from '@engine';

export interface AppCtx {
  engine: EngineHost;
}

/** Every document mutation is a Command; History owns do/undo ordering. */
export interface Command {
  /** Shown in the History panel and Edit menu. */
  label: string;
  run(app: AppCtx): void;
  undo(app: AppCtx): void;
  /** Coalesce consecutive commands (e.g. opacity drag). True = merged into this. */
  mergeWith?(next: Command): boolean;
  /**
   * Additive (2026-09, history-budget block). Retained payload bytes (every
   * ArrayBuffer/typed-array in this command's forward edits and inverse):
   * history.ts sums these to evict by byte budget, not just entry count.
   * Omitted = 0 bytes (a uiCommand with no buffer payload).
   */
  bytes?(): number;
}

/**
 * The 90% case: wrap an edit batch; engine returns inverses on apply.
 * Implemented in src/app/commands/command.ts (shell track B).
 */
export type PatchCommandFactory = (label: string, edits: DocEdit[]) => Command;

/** Panel registration: every dockable window mounts through this. */
export interface PanelHost {
  id: 'tools' | 'history' | 'layers' | 'colors' | (string & {});
  title: string;
  /** e.g. 'F5'. Used by keymap AND rendered in the panel titlebar. */
  toggleKey?: string;
  /** lit-html template producer; called on store change. */
  render(app: AppCtx): unknown;
  /** Default dock position, px from the canvas-region corner. */
  defaultPosition: { corner: 'tl' | 'tr' | 'bl' | 'br'; x: number; y: number };
}

export type ToolId =
  | 'select-rect' | 'select-lasso' | 'select-ellipse' | 'select-wand'
  | 'move' | 'zoom' | 'pan'
  | 'brush' | 'pencil' | 'eraser' | 'bucket' | 'gradient'
  | 'picker' | 'recolor' | 'clone'
  | 'text' | 'line' | 'shapes';

export interface ToolState {
  active: ToolId;
  brushSize: number;
  /** OKLab + alpha. */
  primary: readonly [number, number, number, number];
  secondary: readonly [number, number, number, number];
  /** Which of primary/secondary the palette edits (C toggles, X swaps values). */
  editing: 'primary' | 'secondary';
  /** Shapes tool: which shape kind it inserts on drag, whichever kind was
   * last created via the Insert menu (registry.ts's SHAPES block), not a
   * separate cycle-through-shapes gesture. See src/ui/CLAUDE.md. Optional
   * (rather than required) so pre-existing ToolState literals elsewhere in
   * the codebase that predate this field don't all need updating; readers
   * fall back to 'rect'. */
  lastShape?: 'rect' | 'ellipse' | 'polygon' | 'star' | 'rounded-rect';
  /** Bucket tool match threshold (0..0.5), OKLab+alpha distance from the seed
   * pixel's colour. Optional/additive (same pattern as PanelPlacement's w/h)
   * so existing full-object `toolState.set({...})` call sites don't need to
   * change. DEFAULT_BUCKET_TOLERANCE (stores.ts) is the fallback wherever
   * it's read. */
  bucketTolerance?: number;
}

export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
  activeLayer: string | null;
  /** Group ids collapsed in the Layers panel. Session-scoped, not persisted
   * (layoutState is the only store that round-trips to localStorage). */
  collapsedGroups: string[];
  /**
   * MASKS block: the layer whose mask brush/pencil/eraser strokes currently
   * route to (via paint-layer.ts's resolveStrokeTarget), or null. Session-
   * scoped, never persisted: entering mask edit mode is a transient UI
   * state, not part of the document. Optional/additive (same pattern as
   * ToolState's lastShape/bucketTolerance) so pre-existing ViewState
   * literals don't all need updating; absent reads as null.
   */
  maskEditing?: string | null;
}

export interface SelectionState {
  objects: string[];
  marquee: { x: number; y: number; width: number; height: number } | null;
}

export interface PanelPlacement {
  visible: boolean;
  /** Unused since the docked shell (2026-09): panels no longer float. Kept
   * so the frozen shape stays valid; always written as 0. */
  x: number;
  y: number;
  /** Floating-era size; unused by the docked shell, never written now. */
  w?: number;
  h?: number;
  /** Docked shell: the pane's title is shown but its body is folded away.
   * Additive (2026-09 reskin); absent reads as expanded. */
  collapsed?: boolean;
}

export interface LayoutState {
  panels: Record<string, PanelPlacement>;
  /** Legacy. The theme is g-system's (`g.theme`, persisted under `g-theme`);
   * this field is no longer read or written by the shell. */
  theme: 'dark' | 'light';
  /** Docked shell: width of the right pane column in px. Additive (2026-09
   * reskin); absent reads as the default. */
  rightWidth?: number;
}
