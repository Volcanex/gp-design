/**
 * Add-effect dialog: pick an effect (by id, from a menu: the menu itself is
 * shell track A/B's concern), edit its params, see it live on the target
 * layer, commit as ONE undo step on OK.
 *
 * Live preview writes directly via engine.applyEdits (NOT through history) so
 * scrubbing a slider doesn't spam the undo stack; OK reverts the live preview
 * and pushes a single patchCommand with the final chain.
 */

import { html, render } from 'lit-html';
import type { AppCtx } from '../../app/types';
import type { AssetJSON, Chain, DocumentJSON, NodePath, ParamValues, ParamSpec } from '@engine';
import { assetId, layerId as toLayerId, identityLutBytes } from '@engine';
import { paramsForm, type ParamsFormOpts } from '../forms/params-form';
import { openDialog, showToast, findLayerNode, type DialogHandle } from './dialog-shell';
import { patchCommand } from '../../app/commands/command';
import { history } from '../../app/commands/app-history';
import { setLastEffect } from '../../app/commands/registry';
import { viewState } from '../../app/stores';
import { chainForTarget } from '../panels/effects-logic';
import { importImageAsset } from '../../app/commands/image-import';
import { parseLutFile } from './lut-import';

/** Short, readable stand-in for a real asset name. AssetJSON carries no
 * user-facing label (doc/json.ts's FROZEN CONTRACT), so the id's own first
 * 8 chars is the best a picker can show today. */
function assetLabel(id: string): string {
  return id.slice(0, 8);
}

/** effect-dialog.ts's opts.assets.list: every doc.assets entry matching
 * assetType, most-recently-added last (insertion order, same as
 * Object.entries on a plain object). */
function listAssets(app: AppCtx, assetType: 'image' | 'lut' | 'font'): { id: string; label: string }[] {
  return Object.entries(app.engine.getDocument().assets)
    .filter(([, asset]) => asset.type === assetType)
    .map(([id]) => ({ id, label: assetLabel(id) }));
}

const LUT_IMPORT_SIZE = 17;

function addLutAsset(app: AppCtx, bytes: Uint8Array, size: number): { asset: string } {
  const id = assetId(crypto.randomUUID());
  const asset: AssetJSON = { type: 'lut', data: bytes.buffer.slice(0) as ArrayBuffer, size };
  history.push(app, patchCommand('Import LUT', [{ op: 'addAsset', id, asset }]));
  return { asset: id };
}

/** LUT's "Import…" flow needs one extra choice a plain file dialog can't
 * offer: a built-in Identity LUT, materialised as a real doc.assets entry
 * the moment it's picked (there's no way to reference a look-up table that
 * doesn't exist in the document, see core/frame.ts's asset resolution).
 *
 * Unlike colorRow's openColorPopover and the asset picker's
 * openAssetPopover (params-form.ts), this popover has no natural anchor
 * element to position against: it's one level removed from the click that
 * opens it (the asset picker's own "Import…" row, itself inside a popover
 * that's about to close). Centered in the viewport instead (fixed
 * `.menu`, `popover="manual"`, positioned with an explicit left/top rather
 * than params-form.ts's anchor-relative flip math). Appended inside the
 * open effect dialog, not document.body. See openMenuPopover's doc comment
 * (params-form.ts) for why a popover sibling of an open modal dialog paints
 * above it but isn't hit-testable there. */
function importLutAsset(app: AppCtx): Promise<{ asset: string } | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'menu';
    host.setAttribute('popover', 'manual');
    host.setAttribute('data-testid', 'lut-import-popover');
    const openDialogEl = document.querySelector('dialog.dlg[open]');
    (openDialogEl ?? document.body).appendChild(host);

    const close = (result: { asset: string } | null) => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      host.hidePopover?.();
      host.remove();
      resolve(result);
    };
    const onOutside = (e: PointerEvent) => { if (!host.contains(e.target as Node)) close(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(null); };

    const x = Math.round(window.innerWidth / 2 - 100);
    const y = Math.round(window.innerHeight / 2 - 60);
    render(html`
      <button type="button" class="menu-item" data-testid="lut-import-identity"
        @click=${() => close(addLutAsset(app, identityLutBytes(LUT_IMPORT_SIZE), LUT_IMPORT_SIZE))}
      >Use LUT</button>
      <button type="button" class="menu-item" data-testid="lut-import-file"
        @click=${() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.cube,image/png';
          input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) { close(null); return; }
            void (async () => {
              try {
                const parsed = await parseLutFile(file);
                close(addLutAsset(app, parsed.bytes, parsed.size));
              } catch (err) {
                console.error('[gdesign] LUT import failed', err);
                showToast("Couldn't import LUT");
                close(null);
              }
            })();
          });
          input.click();
        }}
      >Choose file… (.cube / Hald PNG)</button>
      <hr class="separator">
      <button type="button" class="menu-item" data-testid="lut-import-cancel" @click=${() => close(null)}>Cancel</button>
    `, host);
    host.style.left = `${x}px`;
    host.style.top = `${y}px`;
    host.showPopover?.();

    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  });
}

function importImageAssetForDialog(app: AppCtx): Promise<{ asset: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      void importImageAsset(app, file).then(resolve);
    });
    input.click();
  });
}

function assetPickerOpts(app: AppCtx): ParamsFormOpts {
  return {
    assets: {
      list: (assetType) => listAssets(app, assetType),
      importNew: (assetType) => {
        if (assetType === 'lut') return importLutAsset(app);
        if (assetType === 'image') return importImageAssetForDialog(app);
        return Promise.resolve(null);
      },
    },
  };
}

function genInstanceId(): string {
  return `effect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultParams(schema: Record<string, ParamSpec>): ParamValues {
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([, spec]) => spec.kind !== 'asset')
      .map(([key, spec]) => [key, spec.kind === 'asset' ? undefined : spec.default]),
  ) as ParamValues;
}

export interface EffectDialogOpts {
  /** Defaults to the active layer when omitted (the original, only, behaviour). */
  target?: NodePath;
  /** When set, edits that chain entry in place (seeded from its current
   * params) instead of appending a new one: the Effects panel's
   * double-click-to-edit flow. */
  instanceId?: string;
}

export function openEffectDialog(app: AppCtx, effectId: string, opts?: EffectDialogOpts): void {
  const meta = app.engine.listEffects().find((m) => m.id === effectId);
  if (!meta) {
    showToast(`${effectId}: not available yet`);
    return;
  }

  const doc: DocumentJSON = app.engine.getDocument();

  let target: NodePath;
  let currentChain: Chain;
  if (opts?.target) {
    const chain = chainForTarget(doc, opts.target);
    if (chain === null) {
      showToast('select a layer first');
      return;
    }
    target = opts.target;
    currentChain = chain;
  } else {
    const activeLayerId = viewState.get().activeLayer;
    if (!activeLayerId) {
      showToast('select a layer first');
      return;
    }
    const node = findLayerNode(doc.layers, activeLayerId);
    if (!node) {
      showToast('select a layer first');
      return;
    }
    target = { kind: 'layer', id: toLayerId(activeLayerId) };
    currentChain = node.chain;
  }

  const snapshotChain: Chain = currentChain.map((fx) => ({ ...fx, params: { ...fx.params } }));
  const existingInstance = opts?.instanceId ? snapshotChain.find((fx) => fx.id === opts.instanceId) : undefined;
  if (opts?.instanceId && !existingInstance) {
    showToast('effect no longer exists');
    return;
  }

  const instanceId = existingInstance ? existingInstance.id : genInstanceId();
  let params: ParamValues = existingInstance ? { ...existingInstance.params } : defaultParams(meta.params);
  let debounceHandle = 0;
  // A label-scrub drag (params-form.ts's startScrub) attaches its own
  // window-level mousemove/mouseup listeners that outlive the dialog if
  // closed mid-drag (no mouseup yet). Those leaked listeners can still call
  // preview() after revertToSnapshot(). This flag makes preview() a no-op
  // once the dialog is closed, so a stale drag can't resurrect the effect.
  let closed = false;

  // Add: appends a new instance. Edit-in-place: replaces the matching entry
  // by id, in position, instead of appending a duplicate.
  const buildChain = (): Chain =>
    existingInstance
      ? snapshotChain.map((fx) => (fx.id === instanceId ? { ...fx, params } : fx))
      : [...snapshotChain, { id: instanceId, pass: effectId, params, enabled: true }];

  const preview = () => {
    if (closed) return;
    window.clearTimeout(debounceHandle);
    debounceHandle = window.setTimeout(() => {
      if (closed) return;
      app.engine.applyEdits([{ op: 'setChain', target, chain: buildChain() }]);
    }, 30);
  };

  const revertToSnapshot = () => {
    window.clearTimeout(debounceHandle);
    app.engine.applyEdits([{ op: 'setChain', target, chain: snapshotChain }]);
  };

  let handle: DialogHandle;
  handle = openDialog({
    dialogTestId: 'effect-dialog',
    okTestId: 'effect-ok',
    cancelTestId: 'effect-cancel',
    title: existingInstance ? `Edit ${meta.label}` : meta.label,
    okLabel: existingInstance ? 'Apply changes' : 'Apply',
    body: () => paramsForm(meta.params, params, (key, value) => {
      params = { ...params, [key]: value };
      preview();
      handle.rerender();
    }, assetPickerOpts(app)),
    onOk: () => {
      closed = true;
      revertToSnapshot();
      history.push(app, patchCommand(meta.label, [{ op: 'setChain', target, chain: buildChain() }]));
      setLastEffect(effectId, params);
    },
    onCancel: () => { closed = true; revertToSnapshot(); },
  });
}
