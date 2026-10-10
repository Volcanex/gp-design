/**
 * Layer properties dialog: name, blend mode, opacity, visibility. Those four
 * commit as ONE patchCommand on OK: no live-preview channel needed here,
 * unlike effect-dialog (native input DOM state carries the live edit until
 * commit).
 *
 * For a `core.*` layer (has a source), a Source section renders the source's
 * own ParamsSchema via paramsForm. This is the only place a layer's OWN
 * params (as opposed to its effect chain, which the Effects panel owns) are
 * editable at all. Unlike the four fields above, Source edits commit
 * IMMEDIATELY per change (params-form's onChange -> setParam, one
 * patchCommand each) rather than batching into this dialog's OK, because the
 * `opts.time`-aware diamond keyframing needs edits to land while the dialog
 * is still open and the timeline strip is watching for them (opts.onSetKey
 * lets the timeline reselect the just-authored key).
 */

import { html } from 'lit-html';
import type { AppCtx } from '../../app/types';
import type { DocEdit, ParamValue } from '@engine';
import { openDialog, showToast, findLayerNode, type DialogHandle } from './dialog-shell';
import { patchCommand } from '../../app/commands/command';
import { history } from '../../app/commands/app-history';
import { paramsForm } from '../forms/params-form';
import { clockState, timelineState } from '../../app/stores';
import { quantiseToFrame } from '../shell/timeline-logic';

export function openLayerProperties(app: AppCtx, layerId: string): void {
  const doc = app.engine.getDocument();
  const found = findLayerNode(doc.layers, layerId);
  if (!found) {
    showToast('layer not found');
    return;
  }
  // Narrowed to a plain const so nested function declarations below (which
  // TS can't narrow a closed-over binding into) see the non-null type too.
  const node: NonNullable<typeof found> = found;

  const originalOpacity = typeof node.opacity === 'number' ? node.opacity : 1;
  let name = node.name;
  let blend = node.blendMode;
  let opacity = originalOpacity;
  let visible = node.enabled;

  const blends = app.engine.listBlendModes();
  const sourceSchema = node.kind === 'layer' ? app.engine.listSources().find((s) => s.id === node.source.type)?.params : undefined;

  let handle: DialogHandle;

  function commitSourceParam(key: string, value: ParamValue): void {
    if (node.kind !== 'layer') return;
    history.push(app, patchCommand(`Set ${key}`, [{ op: 'setParam', target: { kind: 'layer', id: node.id }, key, value }]));
    handle.rerender();
  }

  function sourceSection() {
    if (node.kind !== 'layer' || !sourceSchema || Object.keys(sourceSchema).length === 0) return '';
    const doc2 = app.engine.getDocument();
    const live = findLayerNode(doc2.layers, layerId);
    if (live?.kind !== 'layer') return '';
    const fps = doc2.clock.fps;
    const time = quantiseToFrame(clockState.get().time, fps);
    return html`
      <div class="gd-form-row" data-testid="lp-row-source-header">
        <span class="label">Source</span>
      </div>
      ${paramsForm(sourceSchema, live.source.params, commitSourceParam, {
        time,
        onSetKey: (key, track) => {
          timelineState.update((s) => ({ ...s, selectedKey: { lane: key, index: track.findIndex((k) => k.t === time) } }));
        },
      })}
    `;
  }

  handle = openDialog({
    dialogTestId: 'layer-props-dialog',
    okTestId: 'layer-props-ok',
    cancelTestId: 'layer-props-cancel',
    title: 'Layer properties',
    okLabel: 'Apply changes',
    body: () => html`
      <div class="gd-form-row" data-testid="lp-row-name">
        <span class="label">Name</span>
        <div class="gd-form-control">
          <input class="input" type="text" data-testid="lp-name" .value=${name}
            @change=${(e: Event) => { name = (e.target as HTMLInputElement).value; }} />
        </div>
      </div>
      <div class="gd-form-row" data-testid="lp-row-blend">
        <span class="label">Blend</span>
        <div class="gd-form-control">
          <span class="select-wrap">
            <select class="select" data-testid="lp-blend"
              @change=${(e: Event) => { blend = (e.target as HTMLSelectElement).value; }}>
              ${blends.map((b) => html`<option value=${b.id} ?selected=${b.id === blend}>${b.label}</option>`)}
            </select>
          </span>
        </div>
      </div>
      <div class="gd-form-row" data-testid="lp-row-opacity">
        <span class="label">Opacity</span>
        <div class="gd-form-control">
          <span class="g-slider">
            <input type="range" min="0" max="1" step="0.01" .value=${String(opacity)}
              data-testid="lp-opacity"
              @input=${(e: Event) => { opacity = Number((e.target as HTMLInputElement).value); }} />
          </span>
        </div>
      </div>
      <div class="gd-form-row" data-testid="lp-row-visible">
        <span class="label">Visible</span>
        <div class="gd-form-control">
          <input class="checkbox" type="checkbox" data-testid="lp-visible" .checked=${visible}
            @change=${(e: Event) => { visible = (e.target as HTMLInputElement).checked; }} />
        </div>
      </div>
      ${sourceSection()}
    `,
    onOk: () => {
      const edits: DocEdit[] = [];
      if (name !== node.name) edits.push({ op: 'renameNode', id: node.id, name });
      if (blend !== node.blendMode) edits.push({ op: 'setBlend', id: node.id, mode: blend });
      if (opacity !== originalOpacity) edits.push({ op: 'setOpacity', id: node.id, value: opacity });
      if (visible !== node.enabled) edits.push({ op: 'setEnabled', id: node.id, enabled: visible });
      if (edits.length > 0) history.push(app, patchCommand('Layer Properties', edits));
    },
    onCancel: () => {},
  });
}
