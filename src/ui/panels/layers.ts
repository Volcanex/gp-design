/**
 * Layers panel (F7). Rows are TOP-first (reverse of doc.layers, which
 * composites bottom-up) via layers-logic.displayOrder. render(app) is pure:
 * it reads app.engine.getDocument() + viewState fresh every call, so it
 * relies on the shell's global re-render loop firing on BOTH store changes
 * and the engine's 'document-changed' event (the shell already needs the
 * latter to redraw the canvas, so this panel adds no extra subscription).
 *
 * Drag-reorder uses pointer events (not native HTML5 DnD), deterministic
 * under Playwright/SwiftShader and touch-friendly. Any row (any depth) is
 * draggable via its `.g-tree-grip` handle; layers-logic.dropTarget resolves
 * the {parent, index} a drop should produce, including dropping INTO a
 * hovered group row.
 *
 * Groups collapse via viewState.collapsedGroups (session-scoped, not
 * persisted): displayOrder(doc, collapsed) simply omits a collapsed
 * group's children rows, so drag/rename/select all keep working over
 * whatever's currently visible without knowing about collapse at all.
 * The caret itself is g-system's g-tree (tree.js): a click dispatches a
 * bubbling, cancelable "g-tree:toggle" we catch on the list container and
 * translate into a toggleCollapsed call, keyed off each row's
 * data-layer-id. collapsedGroups (not the row's own aria-expanded) stays
 * the single source of truth, so the next re-render always wins.
 */

import { html, nothing } from 'lit-html';
import { classMap } from 'lit-html/directives/class-map.js';
import { repeat } from 'lit-html/directives/repeat.js';
import type { AppCtx, PanelHost } from '../../app/types';
import type { LayerId, LayerNode, Layer } from '@engine';
import { layerId, findLayer } from '@engine';
import { viewState } from '../../app/stores';
import { history } from '../../app/commands/app-history';
import { patchCommand } from '../../app/commands/command';
import { execute } from '../../app/commands/registry';
import { icon, type IconName } from '../icons';
import { displayOrder, dropTarget } from './layers-logic';

let dragId: LayerId | null = null;
let dragOverRow: number | null = null;

/** A layer name is user-authored content, not UI copy. Flatten markdown
 * syntax it might carry (see g-design skill's boundary-flattening rule)
 * rather than trusting it verbatim. */
function plain(s: string): string {
  return window.g?.plain ? window.g.plain(s) : s;
}

/** g-tree-icon slot: folder(-open) for a group, circle-half for an
 * adjustment layer, image for a scene layer, paint-brush as the general
 * raster/paint fallback. */
function iconForNode(node: LayerNode, expanded: boolean): IconName {
  if (node.kind === 'group') return expanded ? 'folder-open' : 'folder';
  if (node.source.type === 'core.adjustment') return 'circle-half';
  if (node.source.type === 'core.scene') return 'image';
  return 'paint-brush';
}

/** MASKS block: only a Layer (never a LayerGroup) can carry a mask. See
 * doc/json.ts. Centralised so every row template does the same narrowing
 * instead of re-checking `node.kind === 'layer'` inline (TS narrowing
 * doesn't survive into the nested lit-html event-handler closures below). */
function maskOf(node: LayerNode): Layer['mask'] {
  return node.kind === 'layer' ? node.mask : undefined;
}

function setActive(id: LayerId): void {
  viewState.update((s) => ({
    ...s,
    activeLayer: id,
    // Clicking a DIFFERENT layer row exits MASK EDIT MODE (re-clicking the
    // row currently being mask-edited is a no-op, not an exit).
    maskEditing: s.maskEditing && s.maskEditing !== id ? null : s.maskEditing,
  }));
}

/** Mask chip click: enter MASK EDIT MODE for this layer, or exit it if
 * already editing this layer's mask. */
function toggleMaskEditing(id: LayerId): void {
  viewState.update((s) => ({ ...s, maskEditing: s.maskEditing === id ? null : id }));
}

/** Mask chip alt-click: toggle enabled without entering/exiting edit mode. */
function toggleMaskEnabled(app: AppCtx, id: LayerId, mask: NonNullable<Layer['mask']>): void {
  history.push(app, patchCommand('Toggle Mask', [{ op: 'setMask', id, mask: { ...mask, enabled: !mask.enabled } }]));
}

function toggleCollapsed(id: LayerId): void {
  viewState.update((s) => {
    const collapsed = s.collapsedGroups.includes(id)
      ? s.collapsedGroups.filter((g) => g !== id)
      : [...s.collapsedGroups, id];
    return { ...s, collapsedGroups: collapsed };
  });
}

/** g-tree's own caret click flips the row's aria-expanded as a default
 * action unless this handler cancels it. It doesn't need to: the next
 * re-render sets aria-expanded from collapsedGroups regardless, so letting
 * the default through just avoids a one-frame flicker. */
function onTreeToggle(e: Event): void {
  const row = (e as CustomEvent<{ row: HTMLElement; expanded: boolean }>).detail.row;
  const id = row.dataset.layerId;
  if (id) toggleCollapsed(layerId(id));
}

function toggleVisibility(app: AppCtx, id: LayerId, enabled: boolean): void {
  history.push(app, patchCommand('Toggle Visibility', [{ op: 'setEnabled', id, enabled: !enabled }]));
}

function commitRename(app: AppCtx, id: LayerId, name: string): void {
  history.push(app, patchCommand('Rename Layer', [{ op: 'renameNode', id, name }]));
}

// Rename state lives in the template, not in hand-spliced DOM: lit-html
// re-renders (document-changed, store updates) would wipe a manually
// inserted input between the dblclick and the user typing.
let renamingId: LayerId | null = null;

function beginRename(_app: AppCtx, id: LayerId): void {
  renamingId = id;
  viewState.update((s) => ({ ...s })); // nudge subscribers → panel re-render
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>('.g-tree-edit');
    input?.focus();
    input?.select();
  });
}

function beginDrag(id: LayerId): void {
  dragId = id;
  dragOverRow = null;
}

/** dragOverRow is read only at render time (the drag-over class + the
 * insertion-line indicator), so changing it silently does nothing unless
 * something nudges a subscribed store (same idiom beginRename uses). */
function updateDragOverRow(row: number): void {
  if (dragOverRow === row) return;
  dragOverRow = row;
  viewState.update((s) => ({ ...s })); // nudge subscribers → panel re-render
}

/**
 * Geometric fallback for drop-row tracking: @pointerenter only fires on
 * rows the pointer actually crosses, so a fast drag that skips rows (easy
 * to do: rows are ~28px tall) leaves dragOverRow stale and the eventual
 * drop silently lands on whatever row enter last fired for, or doesn't
 * update at all. This instead derives the target row directly from the
 * pointer's Y against each row's own rect on every pointermove, so it
 * can't be outrun. Rows are assumed to be in top-first document order
 * already (repeat()'s render order matches displayOrder).
 *
 * Uses FULL row containment (top..top+height), not a top/bottom-half
 * midpoint split: "hovering anywhere over row i" means "drop at row i".
 * dropTarget's dropRow is a single target position, not an above/below
 * choice, so there's no reason to bias half a row toward the next one. A
 * midpoint-based version shipped first and had a real, easy-to-hit bug: a
 * strict `<` compare against exactly `top + height/2` meant a drop aimed at
 * a row's own visual centre (the single most natural place to release the
 * mouse) landed on the NEXT row instead, one further than intended. Full
 * containment removes that knife-edge entirely.
 *
 * Takes plain {top, height} rects rather than HTMLElements so the geometry
 * itself is unit-testable without real layout (happy-dom's
 * getBoundingClientRect is always zeroed). The DOM-touching part is just
 * `rowEls.map((el) => el.getBoundingClientRect())` at the call site.
 */
export function rowIndexAtPointerY(rowRects: { top: number; height: number }[], clientY: number): number {
  for (let i = 0; i < rowRects.length; i++) {
    if (clientY < rowRects[i]!.top + rowRects[i]!.height) return i;
  }
  return Math.max(0, rowRects.length - 1); // below the last row: clamp to it
}

function endDrag(app: AppCtx): void {
  if (dragId === null || dragOverRow === null) {
    dragId = null;
    dragOverRow = null;
    return;
  }
  const id = dragId;
  const row = dragOverRow;
  dragId = null;
  dragOverRow = null;
  const doc = app.engine.getDocument();
  const collapsed = new Set(viewState.get().collapsedGroups.map(layerId));
  const rows = displayOrder(doc, collapsed);
  const target = dropTarget(rows, row, id);
  if (!target) return; // drop onto self/own descendant: no-op
  history.push(app, patchCommand('Reorder Layer', [{ op: 'reorderLayer', id, parent: target.parent, index: target.index }]));
}

function setOpacity(app: AppCtx, id: LayerId, value: number): void {
  history.push(app, patchCommand('Opacity', [{ op: 'setOpacity', id, value }]));
}

function setBlend(app: AppCtx, id: LayerId, mode: string): void {
  history.push(app, patchCommand('Blend Mode', [{ op: 'setBlend', id, mode }]));
}

export const layersPanel: PanelHost = {
  id: 'layers',
  title: 'Layers',
  toggleKey: 'F7',
  defaultPosition: { corner: 'br', x: 8, y: 8 },
  render(app: AppCtx) {
    const doc = app.engine.getDocument();
    const active = viewState.get().activeLayer;
    const collapsed = new Set(viewState.get().collapsedGroups.map(layerId));
    const rows = displayOrder(doc, collapsed);
    // Resolved against the full tree (not `rows`) so the footer keeps
    // working when the active layer is hidden inside a collapsed group.
    const activeNode = active ? findLayer(doc, layerId(active))?.node : undefined;
    const opacity = activeNode && typeof activeNode.opacity === 'number' ? activeNode.opacity : 1;

    return html`
      <div class="gd-panel-body gd-layers">
        <div
          class="g-tree gd-layers-list"
          @g-tree:toggle=${onTreeToggle}
          @pointermove=${(e: PointerEvent) => {
            // Geometric fallback for fast drags that skip @pointerenter on
            // intermediate rows (see rowIndexAtPointerY's doc comment).
            if (dragId === null) return;
            const rowEls = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.g-tree-row'));
            if (rowEls.length === 0) return;
            updateDragOverRow(rowIndexAtPointerY(rowEls.map((el) => el.getBoundingClientRect()), e.clientY));
          }}
        >
          ${repeat(
            rows,
            (r) => r.node.id,
            (r, i) => {
              const isGroup = r.node.kind === 'group';
              const expanded = isGroup && !collapsed.has(r.node.id);
              const mask = maskOf(r.node);
              const editingMask = viewState.get().maskEditing === r.node.id;
              return html`
              <div
                class=${classMap({
                  'g-tree-row': true,
                  // Hovering a group row drops INTO it (dropTarget's
                  // group-row case): a distinct highlight from the
                  // insertion-line used for an ordinary sibling drop.
                  'drag-over': dragOverRow === i && dragId !== null && r.node.kind !== 'group',
                  'drag-into': dragOverRow === i && dragId !== null && r.node.kind === 'group',
                })}
                style="--depth: ${r.depth}"
                data-testid="layer-row"
                data-layer-id=${r.node.id}
                aria-selected=${r.node.id === active ? 'true' : nothing}
                aria-expanded=${isGroup ? (expanded ? 'true' : 'false') : nothing}
                ?data-muted=${!r.node.enabled}
                ?data-dragging=${dragId === r.node.id}
                data-drop=${dragOverRow === i && dragId !== null ? (r.node.kind === 'group' ? 'into' : 'before') : nothing}
                @click=${() => setActive(r.node.id)}
                @dblclick=${() => beginRename(app, r.node.id)}
                @pointerenter=${() => {
                  if (dragId !== null) updateDragOverRow(i);
                }}
                @pointerup=${() => endDrag(app)}
              >
                <span
                  class="g-tree-grip"
                  data-testid="layer-drag-handle"
                  @pointerdown=${(e: PointerEvent) => {
                    e.stopPropagation();
                    if (renamingId !== null) {
                      // Commit the pending rename (the input's own @blur
                      // handler does the work) instead of silently blocking
                      // drag while any row is mid-rename.
                      document.querySelector<HTMLInputElement>('.g-tree-edit')?.blur();
                    }
                    beginDrag(r.node.id);
                  }}
                  >${icon('dots-six-vertical')}</span
                >
                <button
                  type="button"
                  class="g-tree-caret"
                  aria-label="Toggle"
                  data-testid=${isGroup ? 'layer-group-collapse' : nothing}
                ></button>
                <span
                  class="g-tree-icon"
                  data-testid=${r.node.kind === 'layer' && r.node.source.type === 'core.adjustment' ? 'layer-adjustment-icon' : nothing}
                  title=${r.node.kind === 'layer' && r.node.source.type === 'core.adjustment' ? 'Adjustment layer' : nothing}
                  >${icon(iconForNode(r.node, expanded))}</span
                >
                ${r.node.id === renamingId
                  ? html`<input
                      class="g-tree-edit"
                      .value=${r.node.name}
                      @click=${(e: Event) => e.stopPropagation()}
                      @pointerdown=${(e: Event) => e.stopPropagation()}
                      @blur=${(e: Event) => {
                        const value = (e.currentTarget as HTMLInputElement).value;
                        if (renamingId !== null) {
                          renamingId = null;
                          commitRename(app, r.node.id, value);
                        }
                      }}
                      @keydown=${(e: KeyboardEvent) => {
                        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                        if (e.key === 'Escape') {
                          renamingId = null;
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                    />`
                  : html`<span class="g-tree-label">${plain(r.node.name)}</span>`}
                <span class="g-tree-actions">
                  <button
                    type="button"
                    class="btn btn-icon btn-tertiary"
                    data-testid="layer-visibility"
                    data-tip=${r.node.enabled ? 'Hide' : 'Show'}
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      toggleVisibility(app, r.node.id, r.node.enabled);
                    }}
                  >
                    ${icon(r.node.enabled ? 'eye' : 'eye-slash')}
                  </button>
                  ${mask
                    ? html`
                        <button
                          type="button"
                          class="btn btn-icon btn-tertiary"
                          data-testid="mask-chip"
                          aria-pressed=${editingMask ? 'true' : 'false'}
                          ?data-muted=${!mask.enabled}
                          data-tip=${editingMask ? 'Exit mask editing (Esc)' : `Edit mask${mask.enabled ? '' : ' (disabled)'}, alt-click to toggle enabled`}
                          @click=${(e: MouseEvent) => {
                            e.stopPropagation();
                            if (e.altKey) toggleMaskEnabled(app, r.node.id, mask);
                            else toggleMaskEditing(r.node.id);
                          }}
                        >
                          ${icon('mask-happy')}
                        </button>
                      `
                    : ''}
                </span>
              </div>
            `;
            },
          )}
          ${rows.length === 0 ? html`<div class="gd-layers-empty label">No layers</div>` : ''}
        </div>
        <div class="gd-layers-footer">
          <label class="gd-layers-row">
            <span class="label">Blend</span>
            <div class="select-wrap">
              <select
                class="select"
                aria-label="Blend mode"
                data-testid="layer-blend"
                ?disabled=${!activeNode}
                @change=${(e: Event) => {
                  if (!active) return;
                  setBlend(app, layerId(active), (e.target as HTMLSelectElement).value);
                }}
              >
                ${app.engine.listBlendModes().map(
                  (m) => html`<option value=${m.id} ?selected=${activeNode?.blendMode === m.id}>${m.label}</option>`,
                )}
              </select>
            </div>
          </label>
          <label class="gd-layers-row">
            <span class="label">Opacity</span>
            <span class="g-slider" data-output data-suffix="%">
            <input
              type="range"
              min="0"
              max="100"
              aria-label="Opacity"
              data-testid="layer-opacity"
              ?disabled=${!activeNode}
              .value=${String(Math.round(opacity * 100))}
              @input=${(e: Event) => {
                if (!active) return;
                setOpacity(app, layerId(active), Number((e.target as HTMLInputElement).value) / 100);
              }}
            />
            </span>
          </label>
          <div class="gd-layers-actions">
            <button type="button" class="btn btn-icon btn-tertiary btn-sm" data-testid="layer-new" data-tip="New layer" @click=${() => execute(app, 'layer.new')}>
              ${icon('plus')}
            </button>
            <button type="button" class="btn btn-icon btn-tertiary btn-sm" data-testid="layer-duplicate" data-tip="Duplicate layer" @click=${() => execute(app, 'layer.duplicate')}>
              ${icon('copy')}
            </button>
            <button type="button" class="btn btn-icon btn-tertiary btn-sm" data-testid="layer-delete" data-tip="Delete layer" @click=${() => execute(app, 'layer.delete')}>
              ${icon('trash')}
            </button>
            <button type="button" class="btn btn-icon btn-tertiary btn-sm" data-testid="layer-merge-down" data-tip="Merge down" @click=${() => execute(app, 'layer.mergeDown')}>
              ${icon('arrow-line-down')}
            </button>
          </div>
        </div>
      </div>
    `;
  },
};
