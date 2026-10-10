/**
 * Import Video dialog: probes the source file (duration/fps/resolution),
 * then lets the user pick a range (max 8s), a target fps, and a half-res
 * downscale before baking it into a clip layer. The memory estimate label
 * and the OK-disabled refusal are both driven by the same pure math in
 * video-import-budget.ts that the importer itself uses: the dialog can
 * never promise a size the importer then blows past.
 */

import { html } from 'lit-html';
import type { AppCtx } from '../../app/types';
import { openDialog, showToast } from './dialog-shell';
import { probeVideo, importVideoAsLayer, VideoDecodeError } from '../../app/commands/video-import';
import { showStatusMessage } from '../../app/stores';
import {
  VIDEO_IMPORT_DEFAULT_RANGE_SECONDS, VIDEO_IMPORT_MAX_RANGE_SECONDS, VIDEO_IMPORT_HARD_MAX_BYTES,
  defaultHalfRes, pickTargetFps, estimateFrameCount, estimateBytes, exceedsHardBudget,
} from '../../app/commands/video-import-budget';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function openImportVideoDialog(app: AppCtx, blob: Blob, name: string): void {
  let probing = true;
  let probeError = false;
  let sourceDuration = 0;
  let sourceFps = 30;
  let sourceWidth = 0;
  let sourceHeight = 0;

  let from = 0;
  let to = VIDEO_IMPORT_DEFAULT_RANGE_SECONDS;
  let targetFps = 30;
  let halfRes = false;

  const handle = openDialog({
    dialogTestId: 'import-video-dialog',
    okTestId: 'import-video-ok',
    cancelTestId: 'import-video-cancel',
    title: 'Import video',
    okLabel: 'Import video',
    body: () => {
      if (probing) {
        return html`<div class="gd-form-row"><span class="label">Probing…</span></div>`;
      }
      if (probeError) {
        return html`<div class="gd-form-row"><span class="label">Couldn't read this file as video.</span></div>`;
      }
      const outWidth = halfRes ? Math.max(1, Math.round(sourceWidth / 2)) : sourceWidth;
      const outHeight = halfRes ? Math.max(1, Math.round(sourceHeight / 2)) : sourceHeight;
      const effectiveFps = pickTargetFps(sourceFps, targetFps);
      const frameCount = estimateFrameCount(from, to, effectiveFps);
      const bytes = estimateBytes(frameCount, outWidth, outHeight);
      const overBudget = exceedsHardBudget(bytes);
      return html`
        <div class="gd-form-row" data-testid="iv-row-source">
          <span class="label">Source</span>
          <div class="gd-form-control">${sourceWidth}x${sourceHeight}, ${sourceFps.toFixed(2)} fps, ${sourceDuration.toFixed(2)}s</div>
        </div>
        <div class="gd-form-row" data-testid="iv-row-from">
          <span class="label">From (s)</span>
          <div class="gd-form-control">
            <input class="input num" type="number" min="0" step="0.1" data-testid="iv-from" .value=${String(from)}
              @change=${(e: Event) => {
                from = Math.max(0, Number((e.target as HTMLInputElement).value) || 0);
                handle.rerender();
              }} />
          </div>
        </div>
        <div class="gd-form-row" data-testid="iv-row-to">
          <span class="label">To (s)</span>
          <div class="gd-form-control">
            <input class="input num" type="number" min="0" step="0.1" data-testid="iv-to" .value=${String(to)}
              @change=${(e: Event) => {
                const requested = Number((e.target as HTMLInputElement).value) || to;
                to = Math.min(from + VIDEO_IMPORT_MAX_RANGE_SECONDS, requested);
                handle.rerender();
              }} />
          </div>
        </div>
        <div class="gd-form-row" data-testid="iv-row-fps">
          <span class="label">Target FPS</span>
          <div class="gd-form-control">
            <input class="input num" type="number" min="1" step="1" data-testid="iv-fps" .value=${String(targetFps)}
              @change=${(e: Event) => {
                targetFps = Math.max(1, Number((e.target as HTMLInputElement).value) || targetFps);
                handle.rerender();
              }} />
          </div>
        </div>
        <div class="gd-form-row" data-testid="iv-row-halfres">
          <span class="label">Half resolution</span>
          <div class="gd-form-control">
            <input class="checkbox" type="checkbox" data-testid="iv-halfres" .checked=${halfRes}
              @change=${(e: Event) => {
                halfRes = (e.target as HTMLInputElement).checked;
                handle.rerender();
              }} />
          </div>
        </div>
        <div class="gd-form-row" data-testid="iv-row-estimate">
          <span class="label">Estimate</span>
          <div class="gd-form-control">
            ${outWidth}x${outHeight}, ${frameCount} frames, ${formatBytes(bytes)}
            ${overBudget ? html`, over the ${formatBytes(VIDEO_IMPORT_HARD_MAX_BYTES)} limit, lower range/fps or enable half-res` : ''}
          </div>
        </div>
      `;
    },
    okDisabled: () => {
      if (probing || probeError) return true;
      if (to <= from) return true;
      const outWidth = halfRes ? Math.max(1, Math.round(sourceWidth / 2)) : sourceWidth;
      const outHeight = halfRes ? Math.max(1, Math.round(sourceHeight / 2)) : sourceHeight;
      const effectiveFps = pickTargetFps(sourceFps, targetFps);
      const frameCount = estimateFrameCount(from, to, effectiveFps);
      return exceedsHardBudget(estimateBytes(frameCount, outWidth, outHeight));
    },
    onOk: () => {
      showToast('importing video…');
      void importVideoAsLayer(app, blob, name, { from, to, targetFps, halfRes }).catch((err) => {
        console.error('[gdesign] import video failed', err);
        showStatusMessage(err instanceof VideoDecodeError ? "Couldn't decode video" : "Couldn't import video");
      });
    },
    onCancel: () => {},
  });

  void probeVideo(blob)
    .then((probe) => {
      sourceDuration = probe.duration;
      sourceFps = probe.fps > 0 ? probe.fps : 30;
      sourceWidth = probe.width;
      sourceHeight = probe.height;
      to = Math.min(sourceDuration || VIDEO_IMPORT_DEFAULT_RANGE_SECONDS, VIDEO_IMPORT_DEFAULT_RANGE_SECONDS);
      targetFps = Math.min(30, Math.round(sourceFps) || 30);
      halfRes = defaultHalfRes(sourceWidth);
      probing = false;
    })
    .catch((err) => {
      console.error('[gdesign] probe video failed', err);
      probing = false;
      probeError = true;
    })
    .finally(() => handle.rerender());
}
