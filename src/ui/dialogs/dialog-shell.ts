/**
 * Shared card-modal chrome for effect/layer dialogs: a native `<dialog
 * class="dlg">` opened with showModal() (a bare `open` attribute when
 * showModal is missing, so happy-dom unit tests still run), Escape cancels,
 * Enter OKs, OK/Cancel footer buttons. Content is schema/domain specific
 * (paramsForm, layer property fields) and lives in the caller.
 *
 * Escape is handled twice, deliberately: a real modal dialog's own
 * close-request handling fires the dialog's `cancel` event independently of
 * any keydown listener (preventing a keydown's preventDefault from stopping
 * it), so that's the primary path (preventDefault it and route to
 * doCancel). A document-level keydown listener is kept alongside it (Enter
 * needs one anyway, since a native dialog doesn't submit on Enter without a
 * submit button) because happy-dom doesn't synthesize `cancel` from a
 * synthetic Escape keydown, and unit tests dispatch exactly that. `doCancel`
 * is idempotent-guarded so the two paths firing together in a real browser
 * only run onCancel once.
 */

import { render, html } from 'lit-html';
import { setDialogOpen } from '../../app/keymap/keymap';
import type { LayerNode } from '@engine';

export interface DialogHandle {
  host: HTMLElement;
  close(): void;
  rerender(): void;
}

export interface DialogOptions {
  dialogTestId: string;
  okTestId: string;
  cancelTestId: string;
  title: string;
  body(): unknown;
  /** Verb-first, e.g. "Apply", "Export video". Defaults to "OK". */
  okLabel?: string;
  /** Returning a Promise defers the auto-close until it resolves (see doOk
   * below) instead of closing immediately. Lets a dialog stay open and
   * keep rerendering (e.g. export progress) for the duration of onOk. */
  onOk(): void | Promise<void>;
  onCancel(): void;
  /** Re-evaluated on every rerender(); OK is inert (no onOk, no close) while
   * this returns true. For dialogs with a hard refusal condition (e.g. an
   * over-budget video import) or an in-flight async onOk (e.g. a running
   * export) rather than every dialog needing its own disabled wiring. */
  okDisabled?(): boolean;
}

/** First focusable descendant, so focus lands inside the dialog on open
 * (falls back to the dialog card itself if the body has no controls). */
function focusInto(host: HTMLElement): void {
  const card = host.querySelector<HTMLElement>('.dlg');
  if (!card) return;
  const focusable = card.querySelector<HTMLElement>(
    'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable) focusable.focus();
  else { card.tabIndex = -1; card.focus(); }
}

export function openDialog(opts: DialogOptions): DialogHandle {
  const host = document.createElement('div');
  document.body.appendChild(host);
  setDialogOpen(true);

  const dialogEl = document.createElement('dialog');
  dialogEl.className = 'dlg';
  dialogEl.setAttribute('data-testid', opts.dialogTestId);
  host.appendChild(dialogEl);

  let cancelling = false;

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    dialogEl.removeEventListener('cancel', onNativeCancel);
    setDialogOpen(false);
    host.remove();
  };
  const doOk = () => {
    if (opts.okDisabled?.()) return;
    const result = opts.onOk();
    if (result instanceof Promise) result.then(close);
    else close();
  };
  const doCancel = () => {
    if (cancelling) return;
    cancelling = true;
    opts.onCancel();
    close();
  };
  const onNativeCancel = (e: Event) => {
    e.preventDefault();
    doCancel();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
    else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); doOk(); }
  };

  const rerender = () => {
    const disabled = opts.okDisabled?.() ?? false;
    render(html`
      <div class="dlg-body">
        <span class="dlg-title">${opts.title}</span>
        ${opts.body()}
      </div>
      <div class="dlg-foot">
        <button class="btn btn-secondary" data-testid=${opts.cancelTestId} @click=${doCancel}>Cancel</button>
        <button class="btn btn-primary" data-testid=${opts.okTestId} ?disabled=${disabled} @click=${doOk}>${opts.okLabel ?? 'OK'}</button>
      </div>
    `, dialogEl);
    // .g-slider (params-form's number/color rows) needs g-ui.js's initSlider
    // to wire its fill bar. Dialogs are created outside the boot-time root
    // window.g.init(root) already scanned once in shell.ts, and this call is
    // guarded/idempotent (each() in inputs2.js), so it's safe on every render.
    window.g?.init(dialogEl);
  };

  dialogEl.addEventListener('cancel', onNativeCancel);
  document.addEventListener('keydown', onKey, true);
  rerender();
  if (typeof dialogEl.showModal === 'function') dialogEl.showModal();
  else dialogEl.setAttribute('open', '');
  focusInto(host);
  return { host, close, rerender };
}

export function showToast(message: string): void {
  if (window.g?.toast) {
    window.g.toast({ title: message });
    // Keep data-testid="toast" queryable for existing e2e specs: g.toast's
    // own element is the last child of the toaster it lazily creates.
    document.querySelector('.toaster')?.lastElementChild?.setAttribute('data-testid', 'toast');
    return;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(html`<div class="toast" data-testid="toast">${message}</div>`, host);
  setTimeout(() => host.remove(), 2200);
}

export function findLayerNode(nodes: readonly LayerNode[], id: string): LayerNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === 'group') {
      const hit = findLayerNode(node.children, id);
      if (hit) return hit;
    }
  }
  return null;
}
