/**
 * File > New: width/height (+ a few sensible presets) -> a fresh document via
 * loadDocument, mirroring app/main.ts's boot layers (a solid background plus
 * an always-paintable raster layer on top) so a new doc behaves like boot.
 */

import { html } from 'lit-html';
import type { AppCtx } from '../../app/types';
import type { DocumentJSON } from '@engine';
import { emptyDocument, layerId, identityTransform } from '@engine';
import { openDialog } from './dialog-shell';
import { history } from '../../app/commands/app-history';
import { viewState, selectionState } from '../../app/stores';
import { getCanvasRegionSize } from '../shell/shell';
import { fitZoom, centeredPan } from '../shell/view-math';

const PRESETS: { label: string; width: number; height: number }[] = [
  { label: '1280x720', width: 1280, height: 720 },
  { label: '1920x1080', width: 1920, height: 1080 },
  { label: '800x800', width: 800, height: 800 },
];

function newDocumentContent(width: number, height: number): DocumentJSON {
  const doc = emptyDocument(width, height);
  doc.layers.push({
    id: layerId('layer-1'),
    kind: 'layer',
    name: 'Background',
    enabled: true,
    source: { type: 'core.solid', params: { color: [0.65, 0.05, -0.1, 1] } },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'baked',
  });
  doc.layers.push({
    id: layerId('paint-1'),
    kind: 'layer',
    name: 'Paint',
    enabled: true,
    source: { type: 'core.raster', params: {} },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'baked',
  });
  return doc;
}

/** Shared by New and Open (.gdesign.json): loads doc, clears undo history
 * (a loaded document has no prior edits to undo back through), and re-fits
 * the view. */
export async function loadFreshDocument(app: AppCtx, doc: DocumentJSON): Promise<void> {
  await app.engine.loadDocument(doc);
  history.clear();
  selectionState.set({ objects: [], marquee: null });
  const activeLayer = doc.layers[doc.layers.length - 1]?.id ?? null;
  const region = getCanvasRegionSize();
  if (region.width && region.height) {
    const zoom = Math.min(fitZoom(region, doc.canvas), 1);
    const pan = centeredPan(region, doc.canvas, zoom);
    viewState.update((s) => ({ ...s, activeLayer, zoom, panX: pan.x, panY: pan.y }));
  } else {
    viewState.update((s) => ({ ...s, activeLayer }));
  }
}

export function openNewDocumentDialog(app: AppCtx): void {
  let width = 1280;
  let height = 720;

  const handle = openDialog({
    dialogTestId: 'new-document-dialog',
    okTestId: 'new-document-ok',
    cancelTestId: 'new-document-cancel',
    title: 'New document',
    okLabel: 'Create document',
    body: () => html`
      <div class="gd-form-row" data-testid="nd-row-width">
        <span class="label">Width</span>
        <div class="gd-form-control">
          <input class="input num" type="number" min="1" max="8192" data-testid="nd-width" .value=${String(width)}
            @change=${(e: Event) => { width = Math.max(1, Number((e.target as HTMLInputElement).value) || width); }} />
        </div>
      </div>
      <div class="gd-form-row" data-testid="nd-row-height">
        <span class="label">Height</span>
        <div class="gd-form-control">
          <input class="input num" type="number" min="1" max="8192" data-testid="nd-height" .value=${String(height)}
            @change=${(e: Event) => { height = Math.max(1, Number((e.target as HTMLInputElement).value) || height); }} />
        </div>
      </div>
      <div class="gd-form-row" data-testid="nd-row-presets">
        <span class="label">Presets</span>
        <div class="gd-form-control">
          ${PRESETS.map((p) => html`
            <button class="btn btn-secondary btn-sm" type="button" data-testid="nd-preset-${p.label}"
              @click=${() => { width = p.width; height = p.height; handle.rerender(); }}
            >${p.label}</button>
          `)}
        </div>
      </div>
    `,
    onOk: () => { void loadFreshDocument(app, newDocumentContent(width, height)); },
    onCancel: () => {},
  });
}
