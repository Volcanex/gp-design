/**
 * Command constructors. patchCommand is the 90% case for document edits;
 * uiCommand covers actions that mutate app/UI state instead of the document
 * (still undoable, just not through engine.applyEdits).
 */

import type { AppCtx, Command, PatchCommandFactory } from '../types';
import type { DocEdit } from '@engine';

const PATCH = Symbol('patchCommand');

interface PatchCommand extends Command {
  [PATCH]: { identity: string | null; edits: DocEdit[] };
}

/**
 * Sums every ArrayBuffer/typed-array's byteLength found anywhere inside
 * `value`: a generic walk rather than switching on DocEdit['op'], so it
 * stays correct for any current or future edit/asset shape (commitRaster's
 * data, addAsset's image/lut/font/raster/clip bytes, ...) without needing a
 * matching case added here every time one of those grows a new payload
 * field. `seen` guards against (structurally unexpected, but cheap to rule
 * out) reference cycles.
 */
function bytesOf(value: unknown, seen: Set<unknown> = new Set()): number {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) {
    let total = 0;
    for (const v of value) total += bytesOf(v, seen);
    return total;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return 0;
    seen.add(value);
    let total = 0;
    for (const v of Object.values(value)) total += bytesOf(v, seen);
    return total;
  }
  return 0;
}

/** Identity used to coalesce single-edit batches (e.g. an opacity drag) into
 * one history entry. Edits without a stable identity never merge. */
function editIdentity(edit: DocEdit): string | null {
  switch (edit.op) {
    case 'setOpacity': return `setOpacity:${edit.id}`;
    case 'setBlend': return `setBlend:${edit.id}`;
    case 'setEnabled': return `setEnabled:${edit.id}`;
    case 'renameNode': return `renameNode:${edit.id}`;
    case 'setTransform': return `setTransform:${edit.id}`;
    case 'setParam': return `setParam:${JSON.stringify(edit.target)}:${edit.key}`;
    default: return null;
  }
}

export const patchCommand: PatchCommandFactory = (label, edits) => {
  let liveLabel = label;
  let liveEdits = edits;
  let inverse: DocEdit[] | null = null;
  const identity = edits.length === 1 ? editIdentity(edits[0]!) : null;

  const cmd: PatchCommand = {
    get label() { return liveLabel; },
    run(app: AppCtx) {
      const inv = app.engine.applyEdits(liveEdits);
      // Keep the FIRST inverse only: later merges must still undo back to
      // the state before the whole coalesced sequence started.
      if (inverse === null) inverse = inv;
    },
    undo(app: AppCtx) {
      app.engine.applyEdits(inverse ?? []);
    },
    mergeWith(next: Command) {
      if (!identity) return false;
      const patched = (next as Partial<PatchCommand>)[PATCH];
      if (!patched || patched.identity !== identity) return false;
      liveLabel = next.label;
      liveEdits = patched.edits;
      return true;
    },
    bytes() {
      return bytesOf(liveEdits) + bytesOf(inverse ?? []);
    },
    [PATCH]: { identity, edits },
  };
  return cmd;
};

export function uiCommand(label: string, run: (app: AppCtx) => void, undo: (app: AppCtx) => void): Command {
  return { label, run, undo };
}
