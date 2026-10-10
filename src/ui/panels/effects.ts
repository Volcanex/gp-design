/**
 * Effects panel (F9): the ONLY place an applied effect chain is visible or
 * editable outside undo. Shows the active layer's chain (top = last-applied)
 * plus a pinned Document section for doc.postChain, and, when exactly one
 * object is selected, an Object section (transform + per-content-type
 * fields; see objectSection's doc comment for what's editable per type).
 *
 * All mutations are whole-chain setChain writes (toggle/remove/reorder read
 * the current chain fresh off the doc and write the whole array back):
 * document.ts's resolveChainContainer is the only thing that knows how to
 * address a layer/object/document target, so nothing here duplicates that.
 *
 * Drag-reorder follows the layers-panel idiom (module-local drag state +
 * rowIndexAtPointerY, imported not copied, see src/ui/CLAUDE.md's layers
 * section for the full-containment boundary contract) but only the grip
 * handle starts a drag, not the whole row (double-click on the row opens
 * edit-in-place instead of reordering).
 *
 * The Document "add" picker is a `.menu` popover in MANUAL mode: it's
 * rendered once, unconditionally, so g-ui.js's one-time boot scan wires its
 * item-hover/click-to-hide behaviour (initMenu, keyed off `.menu[popover]`),
 * but manual popovers get none of the browser's own light-dismiss, so
 * show/hide, positioning under the trigger, outside-pointerdown and Escape
 * are this file's job (mirroring what a popover="auto" menu would give for
 * free, per the g-design skill's instruction for this control).
 */

import { html } from 'lit-html';
import { classMap } from 'lit-html/directives/class-map.js';
import { repeat } from 'lit-html/directives/repeat.js';
import type { AppCtx, PanelHost } from '../../app/types';
import type { Chain, DocumentJSON, EffectMeta, LayerId, NodePath, ObjectNode, TextSpec, Transform2D } from '@engine';
import { layerId as toLayerId, objectId as toObjectId, contentBoxOf } from '@engine';
import { viewState, selectionState } from '../../app/stores';
import { history } from '../../app/commands/app-history';
import { patchCommand } from '../../app/commands/command';
import { openEffectDialog } from '../dialogs/effect-dialog';
import { icon } from '../icons';
import { rowIndexAtPointerY } from './layers';
import { chainForTarget, displayChain, toggledChain, removedChain, reorderedChain, findSelectedObject } from './effects-logic';
import { oklabToCss, type Oklab } from '../forms/form-color';
import { openColorPopover } from '../forms/params-form';

function sameTarget(a: NodePath, b: NodePath): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface DragState {
  target: NodePath;
  dragId: string;
  dragOverRow: number | null;
}

let drag: DragState | null = null;

function beginDrag(target: NodePath, id: string): void {
  drag = { target, dragId: id, dragOverRow: null };
}

/** dragOverRow is read only at render time (same nudge idiom layers.ts uses). */
function updateDragOverRow(row: number): void {
  if (!drag || drag.dragOverRow === row) return;
  drag = { ...drag, dragOverRow: row };
  viewState.update((s) => ({ ...s }));
}

function endDrag(app: AppCtx): void {
  if (!drag || drag.dragOverRow === null) {
    drag = null;
    return;
  }
  const { target, dragId, dragOverRow } = drag;
  drag = null;
  const chain = chainForTarget(app.engine.getDocument(), target);
  if (!chain) return;
  const fromRow = displayChain(chain).findIndex((fx) => fx.id === dragId);
  if (fromRow === -1) return;
  history.push(app, patchCommand('Reorder Effect', [{ op: 'setChain', target, chain: reorderedChain(chain, fromRow, dragOverRow) }]));
}

let docPickerOpen = false;

function docPickerMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="effects-doc-picker"]');
}

function toggleDocPicker(anchor: HTMLElement): void {
  if (docPickerOpen) {
    closeDocPicker();
    return;
  }
  const menu = docPickerMenu();
  if (!menu) return;
  // Show first, then measure: an unshown popover lays out at zero size.
  // Same order, and same fitsBelow/fitsAbove flip-and-clamp math, as
  // g-ui.js's own initMenu positions a popovertarget-triggered menu. That
  // one keys its trigger lookup off a popovertarget attribute we don't set
  // (this button opens the menu imperatively, not declaratively), so it
  // never touches this popover and this file place it instead.
  menu.style.maxHeight = '';
  menu.showPopover();
  const r = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const fitsBelow = r.bottom + 4 + menu.offsetHeight < innerHeight;
  const fitsAbove = r.top - 4 - menu.offsetHeight > 0;
  const below = fitsBelow || !fitsAbove;
  menu.style.setProperty('--_origin', below ? 'top' : 'bottom');
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`;
  menu.style.top = `${below ? Math.round(r.bottom + 4) : Math.round(r.top - menu.offsetHeight - 4)}px`;
  if (below && !fitsBelow) menu.style.maxHeight = `${innerHeight - r.bottom - 12}px`;
  docPickerOpen = true;
  viewState.update((s) => ({ ...s }));
}

function closeDocPicker(): void {
  if (!docPickerOpen) return;
  docPickerOpen = false;
  docPickerMenu()?.hidePopover();
  viewState.update((s) => ({ ...s }));
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    if (!docPickerOpen) return;
    const t = e.target as HTMLElement;
    if (t.closest('[data-testid="effects-doc-picker"]') || t.closest('[data-testid="effects-doc-add"]')) return;
    closeDocPicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && docPickerOpen) closeDocPicker();
  });
}

function effectLabel(effects: EffectMeta[], passId: string): string {
  return effects.find((m) => m.id === passId)?.label ?? passId;
}

function chainSection(app: AppCtx, target: NodePath, chain: Chain, effects: EffectMeta[]) {
  const rows = displayChain(chain);
  return html`
    <div
      class="g-tree gd-effects-list"
      @pointermove=${(e: PointerEvent) => {
        if (!drag || !sameTarget(drag.target, target)) return;
        const rowEls = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.g-tree-row'));
        if (rowEls.length === 0) return;
        updateDragOverRow(rowIndexAtPointerY(rowEls.map((el) => el.getBoundingClientRect()), e.clientY));
      }}
    >
      ${repeat(
        rows,
        (fx) => fx.id,
        (fx, i) => html`
          <div
            class=${classMap({
              'g-tree-row': true,
              'drag-over': drag !== null && sameTarget(drag.target, target) && drag.dragOverRow === i,
            })}
            style="--depth: 0"
            data-testid="effect-row"
            ?data-muted=${!fx.enabled}
            @dblclick=${() => openEffectDialog(app, fx.pass, { target, instanceId: fx.id })}
            @pointerenter=${() => {
              if (drag && sameTarget(drag.target, target)) updateDragOverRow(i);
            }}
            @pointerup=${() => endDrag(app)}
          >
            <span
              class="g-tree-grip"
              data-testid="effect-drag-handle"
              @pointerdown=${(e: PointerEvent) => {
                e.stopPropagation();
                beginDrag(target, fx.id);
              }}
              >${icon('dots-six-vertical')}</span
            >
            <input
              type="checkbox"
              class="checkbox"
              data-testid="effect-toggle"
              aria-label=${fx.enabled ? 'Disable effect' : 'Enable effect'}
              .checked=${fx.enabled}
              @click=${(e: Event) => {
                e.stopPropagation();
                history.push(app, patchCommand('Toggle Effect', [{ op: 'setChain', target, chain: toggledChain(chain, fx.id) }]));
              }}
            />
            <span class="g-tree-label">${effectLabel(effects, fx.pass)}</span>
            <span class="g-tree-actions">
              <button
                type="button"
                class="btn btn-icon btn-tertiary"
                data-testid="effect-remove"
                data-tip="Remove"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  history.push(app, patchCommand('Remove Effect', [{ op: 'setChain', target, chain: removedChain(chain, fx.id) }]));
                }}
              >
                ${icon('trash')}
              </button>
            </span>
          </div>
        `,
      )}
    </div>
  `;
}

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/** Move/Resize/Rotate a single object via one setTransform edit. Merges
 * with an immediately-preceding edit of the SAME field family the way any
 * other patchCommand does (command.ts's identity is keyed by object id
 * only), which is the existing coalescing behaviour every other transform
 * writer (select-tool.ts's drag, opacity) already relies on. */
function commitTransform(app: AppCtx, id: string, next: Transform2D, label: string): void {
  history.push(app, patchCommand(label, [{ op: 'setTransform', id: toObjectId(id), transform: next }]));
}

/**
 * x/y/width/height/rotation, live-updating from the doc (this panel already
 * re-renders on document-changed, so a canvas drag reflects here for free).
 * Width/height are NOT ObjectContent's own dimensions (a shape's
 * content.shape.width/height, a text object's approximated glyph box):
 * they're that intrinsic box scaled by transform.scaleX/scaleY, mirroring
 * exactly what select-tool.ts's resize handles already do (scale about the
 * object's own anchor), so panel-typed and handle-dragged resizes agree.
 */
function transformFields(app: AppCtx, objId: string, transform: Transform2D, box: { width: number; height: number }) {
  // Reads the CURRENT transform fresh off the doc as the patch base, rather
  // than closing over the `transform` this row was rendered with: a panel
  // re-render (document-changed) is what normally keeps that in sync, but
  // two commits from this row firing back-to-back before a re-render lands
  // (e.g. tabbing between fields) must not silently revert whichever field
  // was just committed to its pre-edit value.
  const commit = (label: string, patch: Partial<Transform2D>) => {
    const current = findSelectedObject(app.engine.getDocument(), [objId])?.node.transform ?? transform;
    commitTransform(app, objId, { ...current, ...patch }, label);
  };
  const width = box.width * transform.scaleX;
  const height = box.height * transform.scaleY;
  const rotationDeg = Math.round(transform.rotation * RAD_TO_DEG * 10) / 10;

  return html`
    <div class="gd-effects-object-row">
      <label class="field">
        <span class="label">X</span>
        <input class="input num" type="number" data-testid="object-x" .value=${String(Math.round(transform.x))}
          @change=${(e: Event) => commit('Move', { x: Number((e.target as HTMLInputElement).value) })} />
      </label>
      <label class="field">
        <span class="label">Y</span>
        <input class="input num" type="number" data-testid="object-y" .value=${String(Math.round(transform.y))}
          @change=${(e: Event) => commit('Move', { y: Number((e.target as HTMLInputElement).value) })} />
      </label>
    </div>
    <div class="gd-effects-object-row">
      <label class="field">
        <span class="label">W</span>
        <input class="input num" type="number" min="0" data-testid="object-width" .value=${String(Math.round(width))}
          @change=${(e: Event) => {
            const next = Number((e.target as HTMLInputElement).value);
            if (box.width === 0) return;
            commit('Resize', { scaleX: next / box.width });
          }} />
      </label>
      <label class="field">
        <span class="label">H</span>
        <input class="input num" type="number" min="0" data-testid="object-height" .value=${String(Math.round(height))}
          @change=${(e: Event) => {
            const next = Number((e.target as HTMLInputElement).value);
            if (box.height === 0) return;
            commit('Resize', { scaleY: next / box.height });
          }} />
      </label>
    </div>
    <div class="gd-effects-object-row">
      <label class="field">
        <span class="label">Rotation</span>
        <input class="input num" type="number" data-testid="object-rotation" .value=${String(rotationDeg)}
          @change=${(e: Event) => commit('Rotate', { rotation: Number((e.target as HTMLInputElement).value) * DEG_TO_RAD })} />
      </label>
    </div>
  `;
}

/** Fill-colour swatch, shared by shape fill and text colour: both live in
 * ObjectStyle.fill (document.ts's 'content.fill' setParam special case),
 * not per-content-type, so one row covers both callers. */
function fillRow(app: AppCtx, layer: string, id: string, fill: readonly [number, number, number, number] | undefined) {
  const lab: Oklab = fill ? [fill[0], fill[1], fill[2]] : [0, 0, 0];
  const alpha = fill?.[3] ?? 1;
  const target: NodePath = { kind: 'object', layer: toLayerId(layer), id: toObjectId(id) };
  const commit = (nextLab: Oklab, nextAlpha: number) => {
    history.push(app, patchCommand('Change Fill', [{
      op: 'setParam', target, key: 'content.fill',
      value: [nextLab[0], nextLab[1], nextLab[2], nextAlpha],
    }]));
  };
  return html`
    <div class="gd-effects-object-row">
      <span class="label">Fill</span>
      <button type="button" class="g-swatch" data-testid="object-fill" style="--swatch: ${oklabToCss(lab)}" aria-label="Fill colour"
        @click=${(e: MouseEvent) => openColorPopover((e.currentTarget as HTMLElement).getBoundingClientRect(), lab, alpha, commit)}
      ></button>
    </div>
  `;
}

/** Text content + size: extends 'content.text' (the text tool's existing
 * channel) with 'content.size', both document.ts's ObjectNode special cases. */
function textFields(app: AppCtx, layer: string, id: string, text: TextSpec) {
  const target: NodePath = { kind: 'object', layer: toLayerId(layer), id: toObjectId(id) };
  return html`
    <label class="field">
      <span class="label">Text</span>
      <textarea class="textarea" data-testid="object-text" .value=${text.text}
        @change=${(e: Event) => history.push(app, patchCommand('Edit Text', [{
          op: 'setParam', target, key: 'content.text', value: (e.target as HTMLTextAreaElement).value,
        }]))}
      ></textarea>
    </label>
    <div class="gd-effects-object-row">
      <label class="field">
        <span class="label">Size</span>
        <input class="input num" type="number" min="1" data-testid="object-text-size" .value=${String(text.size)}
          @change=${(e: Event) => history.push(app, patchCommand('Resize Text', [{
            op: 'setParam', target, key: 'content.size', value: Number((e.target as HTMLInputElement).value),
          }]))} />
      </label>
    </div>
  `;
}

/**
 * Shown when exactly one object is selected (findSelectedObject). Transform
 * fields (x/y/width/height/rotation) work for every content type: setTransform
 * already has a generic object-target channel (document.ts's
 * findObjectAnywhere). Per-content-type fields use the narrow content.*
 * setParam special cases: shape gets a fill swatch, text gets editable
 * text/size/fill, image gets no content fields (transform only) since an
 * image object's pixels come from its asset, not editable style/content,
 * just a label naming which asset it points at.
 */
function objectSection(app: AppCtx, doc: DocumentJSON, selected: { node: ObjectNode; layer: LayerId }) {
  const { node, layer } = selected;
  const box = contentBoxOf(node.content, { getAsset: (id) => doc.assets[id] });
  return html`
    <div class="gd-effects-section" data-testid="effects-object-section">
      <div class="gd-section-title"><span class="label">Object</span></div>
      ${transformFields(app, node.id, node.transform, box)}
      ${node.content.type === 'shape' ? fillRow(app, layer, node.id, node.style.fill) : ''}
      ${node.content.type === 'text' ? html`
        ${textFields(app, layer, node.id, node.content.text)}
        ${fillRow(app, layer, node.id, node.style.fill)}
      ` : ''}
      ${node.content.type === 'image' ? html`
        <div class="gd-effects-object-row">
          <span class="label">Asset</span>
          <span class="label" data-testid="object-image-asset">${node.content.asset.slice(0, 8)}</span>
        </div>
      ` : ''}
    </div>
  `;
}

export const effectsPanel: PanelHost = {
  id: 'effects',
  title: 'Effects',
  toggleKey: 'F9',
  defaultPosition: { corner: 'br', x: 8, y: 8 },
  render(app: AppCtx) {
    const doc = app.engine.getDocument();
    const effects = app.engine.listEffects();
    const active = viewState.get().activeLayer;
    const layerTarget: NodePath | null = active ? { kind: 'layer', id: toLayerId(active) } : null;
    const layerChain = layerTarget ? chainForTarget(doc, layerTarget) : null;
    const docTarget: NodePath = { kind: 'document' };
    const docChain = doc.postChain;
    const selectedObject = findSelectedObject(doc, selectionState.get().objects);

    return html`
      <div class="gd-panel-body gd-effects">
        <div class="gd-effects-section">
          <div class="gd-section-title"><span class="label">Layer</span></div>
          ${!layerTarget || !layerChain
            ? html`<div class="gd-effects-empty label">No layer selected</div>`
            : layerChain.length === 0
              ? html`<div class="gd-effects-empty label">No effects</div>`
              : chainSection(app, layerTarget, layerChain, effects)}
        </div>

        ${selectedObject ? objectSection(app, doc, selectedObject) : ''}

        <div class="gd-effects-divider"></div>

        <div class="gd-effects-section">
          <div class="gd-section-title">
            <span class="label">Document</span>
            <button
              type="button"
              class="btn btn-icon btn-tertiary btn-sm"
              data-testid="effects-doc-add"
              aria-label="Add effect"
              aria-expanded=${docPickerOpen ? 'true' : 'false'}
              data-tip="Add effect"
              @click=${(e: Event) => {
                e.stopPropagation();
                toggleDocPicker(e.currentTarget as HTMLElement);
              }}
            >
              ${icon('plus')}
            </button>
          </div>
          <div class="menu" popover="manual" role="menu" data-testid="effects-doc-picker">
            ${effects.length === 0
              ? html`<button type="button" class="menu-item" role="menuitem" disabled>No effects available</button>`
              : effects.map(
                  (meta) => html`
                    <button
                      type="button"
                      class="menu-item"
                      role="menuitem"
                      data-testid="effects-picker-item"
                      @click=${() => {
                        closeDocPicker();
                        openEffectDialog(app, meta.id, { target: docTarget });
                      }}
                    >
                      ${meta.label}
                    </button>
                  `,
                )}
          </div>
          ${docChain.length === 0
            ? html`<div class="gd-effects-empty label">No effects</div>`
            : chainSection(app, docTarget, docChain, effects)}
        </div>
      </div>
    `;
  },
};
