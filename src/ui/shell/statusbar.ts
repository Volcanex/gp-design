/**
 * Transport, time, zoom, cursor doc coords, active tool, adapter, frame
 * time, GPU memory, and a contextual hint, all derived from stores +
 * engine events. The hint (hints.ts) yields to the statusMessage toast
 * whenever one is showing (errors trump "how do I use this tool").
 */

import { html, nothing, render } from 'lit-html';
import type { AppCtx } from '../../app/types';
import type { EngineCaps } from '@engine';
import { clockState, selectionState, statusMessage, toolState, viewState } from '../../app/stores';
import { pointerPosition } from '../canvas/viewport';
import { executeCommand } from '../../app/commands/registry';
import { history } from '../../app/commands/app-history';
import { isToolDisabled } from '../../app/tool-registry';
import { hintFor } from './hints';
import { icon } from '../icons';

const FRAME_WINDOW = 30;

const formatMb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Tool ids read like code ('select-rect'); the bar shows a name. */
const TOOL_NAMES: Record<string, string> = {
  'select-rect': 'Rectangle select',
  'select-lasso': 'Lasso select',
  'select-ellipse': 'Ellipse select',
  'select-wand': 'Magic wand',
  move: 'Move',
  zoom: 'Zoom',
  pan: 'Pan',
  brush: 'Brush',
  pencil: 'Pencil',
  eraser: 'Eraser',
  bucket: 'Bucket',
  gradient: 'Gradient',
  picker: 'Colour picker',
  recolor: 'Recolour',
  clone: 'Clone stamp',
  text: 'Text',
  line: 'Line',
  shapes: 'Shapes',
};

export function mountStatusbar(app: AppCtx, root: HTMLElement): void {
  let caps: EngineCaps | null = null;
  const frameDeltas: number[] = [];
  let lastFrameAt = performance.now();

  app.engine.on('caps', (e) => {
    if (e.type === 'caps') caps = e.caps;
    renderStatusbar();
  });
  app.engine.on('frame', () => {
    const now = performance.now();
    frameDeltas.push(now - lastFrameAt);
    lastFrameAt = now;
    if (frameDeltas.length > FRAME_WINDOW) frameDeltas.shift();
    renderStatusbar();
  });

  function avgFrameMs(): number {
    if (!frameDeltas.length) return 0;
    return frameDeltas.reduce((a, b) => a + b, 0) / frameDeltas.length;
  }

  function renderStatusbar(): void {
    const mem = app.engine.memoryStats?.() ?? null;
    const view = viewState.get();
    const { zoom } = view;
    const tool = toolState.get().active;
    const pos = pointerPosition.get();
    const message = statusMessage.get();
    const { playing, time } = clockState.get();
    const hint = message
      ? null
      : hintFor({ tool, disabled: isToolDisabled(tool), hasSelection: selectionState.get().objects.length > 0, maskEditing: !!viewState.get().maskEditing });
    render(
      html`
        <button
          type="button"
          class="btn btn-tertiary btn-icon btn-sm gd-status__transport"
          data-testid="transport-toggle"
          data-tip=${playing ? 'Pause (Ctrl+Space)' : 'Play (Ctrl+Space)'}
          aria-label=${playing ? 'Pause' : 'Play'}
          @click=${() => executeCommand(app, 'clock.toggle')}
        >
          ${icon(playing ? 'pause' : 'play')}
        </button>
        <span class="gd-status__item num" data-testid="transport-time">${time.toFixed(1)}s</span>
        <span class="gd-status__item num">${Math.round(zoom * 100)}%</span>
        <span class="gd-status__item num" data-tip="Cursor position in document pixels">${pos ? `${Math.round(pos.x)}, ${Math.round(pos.y)}` : ''}</span>
        <span class="gd-status__item">${TOOL_NAMES[tool] ?? tool}</span>
        ${caps ? html`<span class="gd-status__item gd-status__quiet" data-tip="GPU adapter">${caps.adapterInfo.vendor}/${caps.adapterInfo.architecture}</span>` : nothing}
        <span class="gd-status__item gd-status__quiet num" data-tip="Average frame time">${avgFrameMs().toFixed(1)} ms</span>
        ${mem ? html`<span class="gd-status__item gd-status__quiet num" data-testid="status-memory" data-tip=${`GPU buffer pool, peak ${formatMb(mem.peakBytes)}`}>${formatMb(mem.bytes)}</span>` : nothing}
        ${hint ? html`<span class="gd-status__item gd-status__hint" data-testid="status-hint">${hint}</span>` : nothing}
        ${message ? html`<span class="gd-status__item gd-status__message" data-testid="status-message" role="status">${message}</span>` : nothing}
      `,
      root,
    );
  }

  viewState.subscribe(renderStatusbar);
  toolState.subscribe(renderStatusbar);
  pointerPosition.subscribe(renderStatusbar);
  statusMessage.subscribe(renderStatusbar);
  clockState.subscribe(renderStatusbar);
  selectionState.subscribe(renderStatusbar);
  history.onChange(renderStatusbar);
  renderStatusbar();
}
