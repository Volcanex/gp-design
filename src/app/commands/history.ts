/**
 * Undo/redo stack. push() runs the command immediately; undo/redo replay
 * inverse/forward through the SAME command instances. entries() is a cheap
 * snapshot for the History panel: {label, current} per stack slot.
 *
 * Retained bytes are budgeted too (history-budget block, 2026-09), not just
 * entry count: a full-canvas brush stroke's commitRaster + inverse retained
 * ~15MB at 720p, so 200 entries alone was a ~3GB worst case. Eviction is
 * always from the BOTTOM of the stack (oldest-applied first): every
 * remaining entry has index <= pointer at push time (truncateRedo already
 * cut anything past it), so shifting off the bottom and decrementing
 * pointer is exactly the HISTORY_CAP eviction this generalizes.
 */

import type { AppCtx, Command } from '../types';

const HISTORY_CAP = 200;
/** Secondary/hard bound is HISTORY_CAP entries; this is the primary bound. */
const HISTORY_BYTE_BUDGET = 256 * 1024 * 1024;

export interface HistoryEntry {
  label: string;
  current: boolean;
}

export interface HistoryStats {
  entries: number;
  bytes: number;
  budget: number;
}

export interface History {
  push(app: AppCtx, command: Command): void;
  undo(app: AppCtx): void;
  redo(app: AppCtx): void;
  /** Undo/redo-walk to land exactly on stack index `index` (from an entries() row). */
  jumpTo(app: AppCtx, index: number): void;
  canUndo(): boolean;
  canRedo(): boolean;
  entries(): HistoryEntry[];
  /** Current retained-byte total + the budget it's evicted against, for the History panel. */
  stats(): HistoryStats;
  onChange(cb: () => void): () => void;
  clear(): void;
}

function totalBytes(entries: readonly Command[]): number {
  let total = 0;
  for (const c of entries) total += c.bytes?.() ?? 0;
  return total;
}

export function createHistory(): History {
  let stack: Command[] = [];
  /** Index of the last-applied command; -1 = nothing applied. */
  let pointer = -1;
  const subs = new Set<() => void>();
  const notify = () => subs.forEach((cb) => cb());

  function truncateRedo() {
    if (pointer < stack.length - 1) stack = stack.slice(0, pointer + 1);
  }

  return {
    push(app, command) {
      command.run(app);
      truncateRedo();
      const top = pointer >= 0 ? stack[pointer] : undefined;
      if (top?.mergeWith?.(command)) {
        notify();
        return;
      }
      stack.push(command);
      pointer++;
      while (stack.length > 1 && (stack.length > HISTORY_CAP || totalBytes(stack) > HISTORY_BYTE_BUDGET)) {
        stack.shift();
        pointer--;
      }
      notify();
    },
    undo(app) {
      if (pointer < 0) return;
      stack[pointer]!.undo(app);
      pointer--;
      notify();
    },
    redo(app) {
      if (pointer + 1 >= stack.length) return;
      pointer++;
      stack[pointer]!.run(app);
      notify();
    },
    jumpTo(app, index) {
      if (index < -1 || index >= stack.length) return;
      while (pointer > index) {
        stack[pointer]!.undo(app);
        pointer--;
      }
      while (pointer < index) {
        pointer++;
        stack[pointer]!.run(app);
      }
      notify();
    },
    canUndo: () => pointer >= 0,
    canRedo: () => pointer + 1 < stack.length,
    entries: () => stack.map((c, i) => ({ label: c.label, current: i === pointer })),
    stats: () => ({ entries: stack.length, bytes: totalBytes(stack), budget: HISTORY_BYTE_BUDGET }),
    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    clear() {
      stack = [];
      pointer = -1;
      notify();
    },
  };
}
