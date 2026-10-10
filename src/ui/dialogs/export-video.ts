/**
 * Export dialog: range from/to (defaults 0..doc.clock.duration, falling
 * back to 2s for docs with no stated duration) + editable fps, live
 * estimated frame count, and a format select (Video / PNG Sequence). OK
 * stays open for the duration of the export (dialog-shell's onOk may
 * return a Promise, which defers auto-close until it resolves), showing
 * "frame N / M" progress from the engine's 'export-progress' events and
 * disabling OK (via okDisabled) while running. The progress subscription is
 * torn down on every close path: onOk's own finally (OK, once export
 * settles) and onCancel (Cancel button or Escape, which dialog-shell routes
 * through onCancel too). Mirrors effect-dialog.ts's `closed` flag idiom
 * (src/ui/CLAUDE.md) so a late progress event after close is a no-op.
 */

import { html } from 'lit-html';
import type { AppCtx } from '../../app/types';
import { openDialog, showToast } from './dialog-shell';
import { downloadExportResult } from '../../app/commands/registry';
import type { EngineEvent, ExportRequest } from '@engine';

type ExportFormat = 'video' | 'png-sequence';

export function openExportVideoDialog(app: AppCtx): void {
  const doc = app.engine.getDocument();
  let from = 0;
  let to = doc.clock.duration ?? 2;
  let fps = doc.clock.fps;
  let format: ExportFormat = 'video';
  let running = false;
  let progress: { done: number; total: number } | null = null;
  let closed = false;
  let unsubscribe: (() => void) | null = null;

  const frameCount = () => Math.max(0, Math.round((to - from) * fps));

  const stopListening = () => {
    unsubscribe?.();
    unsubscribe = null;
  };

  const handle = openDialog({
    dialogTestId: 'export-video-dialog',
    okTestId: 'export-video-ok',
    cancelTestId: 'export-video-cancel',
    title: 'Export video',
    okLabel: 'Export video',
    okDisabled: () => running,
    body: () => html`
      <div class="gd-form-row" data-testid="ev-row-format">
        <span class="label">Format</span>
        <div class="gd-form-control">
          <span class="select-wrap">
            <select class="select" data-testid="ev-format" ?disabled=${running}
              @change=${(e: Event) => { format = (e.target as HTMLSelectElement).value as ExportFormat; }}>
              <option value="video" ?selected=${format === 'video'}>Video</option>
              <option value="png-sequence" ?selected=${format === 'png-sequence'}>PNG sequence (.tar)</option>
            </select>
          </span>
        </div>
      </div>
      <div class="gd-form-row" data-testid="ev-row-from">
        <span class="label">From (s)</span>
        <div class="gd-form-control">
          <input class="input num" type="number" min="0" step="0.1" data-testid="ev-from" .value=${String(from)}
            ?disabled=${running}
            @change=${(e: Event) => { from = Number((e.target as HTMLInputElement).value); }} />
        </div>
      </div>
      <div class="gd-form-row" data-testid="ev-row-to">
        <span class="label">To (s)</span>
        <div class="gd-form-control">
          <input class="input num" type="number" min="0" step="0.1" data-testid="ev-to" .value=${String(to)}
            ?disabled=${running}
            @change=${(e: Event) => { to = Number((e.target as HTMLInputElement).value); }} />
        </div>
      </div>
      <div class="gd-form-row" data-testid="ev-row-fps">
        <span class="label">FPS</span>
        <div class="gd-form-control">
          <input class="input num" type="number" min="1" step="1" data-testid="ev-fps" .value=${String(fps)}
            ?disabled=${running}
            @change=${(e: Event) => { fps = Number((e.target as HTMLInputElement).value); }} />
        </div>
      </div>
      <div class="gd-form-row" data-testid="ev-row-frames">
        <span class="label">Frames</span>
        <div class="gd-form-control">${frameCount()}</div>
      </div>
      ${running ? html`
        <div class="gd-form-row" data-testid="ev-row-progress">
          <span class="label">Progress</span>
          <div class="gd-form-control">${progress ? `frame ${progress.done} / ${progress.total}` : 'starting…'}</div>
        </div>
      ` : ''}
    `,
    onOk: async () => {
      if (running) return;
      if (to <= from) {
        showToast('export: "to" must be after "from"');
        return;
      }
      if (!Number.isFinite(fps) || fps <= 0) {
        showToast('export: fps must be greater than 0');
        return;
      }

      running = true;
      progress = null;
      unsubscribe = app.engine.on('export-progress', (e: EngineEvent) => {
        if (closed || e.type !== 'export-progress') return;
        progress = { done: e.done, total: e.total };
        handle.rerender();
      });
      handle.rerender();

      try {
        showToast(format === 'video' ? 'exporting video…' : 'exporting PNG sequence…');
        const req: ExportRequest = { target: format, range: { from, to }, options: { fps } };
        const result = await app.engine.export(req);
        if (format === 'video' && result.mime !== 'video/mp4' && result.mime !== 'video/webm') {
          showToast('export video: no supported codec in this environment');
          return;
        }
        downloadExportResult(result);
      } finally {
        stopListening();
        running = false;
        if (!closed) handle.rerender();
      }
    },
    onCancel: () => {
      closed = true;
      stopListening();
    },
  });
}
