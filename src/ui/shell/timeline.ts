/**
 * Timeline + keyframe authoring strip (F10 / View > Timeline). A 4th shell
 * region (shell.ts), not a dockable panel card. Visibility reuses the panel
 * machinery (layoutState.panels['timeline'].visible) but geometry is a
 * full-width strip, not a positioned card.
 *
 * Structural content (ruler ticks, lanes, keys, duration field, loop brace)
 * re-renders via lit-html on document/selection/timeline-state changes. The
 * playhead is deliberately NOT part of that lit template: clockState ticks at
 * 30-60Hz during playback, and re-rendering the whole strip on every tick
 * would re-diff every lane/key for nothing. Instead the playhead element is
 * looked up once per structural render and its transform is written directly
 * from a clockState subscription (updatePlayhead), the one thing that
 * changes at clock-tick rate.
 *
 * Every row (the ruler and every lane) shares one CSS grid (a fixed
 * LANE_LABEL_W label column + a 1fr track column), so `root.clientWidth -
 * LANE_LABEL_W` is the one true track width for every timeToX/xToTime call
 * in a render pass. Measuring it once up front (rather than querying each
 * row's live DOM element mid-template) avoids reading stale width from the
 * PREVIOUS render's DOM while building the next one.
 *
 * Retiming a key (drag) follows the effect-dialog.ts live-preview idiom:
 * engine.applyEdits directly on every pointermove (never through history, so
 * a drag doesn't spam the undo stack), reverted and replaced by ONE
 * patchCommand on release. Adding/removing a key or changing its easing is a
 * single immediate patchCommand (nothing to preview, no drag involved).
 * Playhead scrub and the loop brace are transport, not document edits:
 * engine.setClock directly, never through history.
 */

import { html, render as litRender } from 'lit-html';
import type { AppCtx } from '../../app/types';
import type { DocEdit, Keyframe, LayerId, LayerNode, ParamValue, Seconds } from '@engine';
import { layerId, findLayer } from '@engine';
import { clockState, layoutState, timelineState, viewState } from '../../app/stores';
import { history } from '../../app/commands/app-history';
import { patchCommand } from '../../app/commands/command';
import {
  type Lane, lanesFor, quantiseToFrame, resolveTrackAt, timeToX, trackWithKeyAt, trackWithKeyMoved,
  trackWithKeyRemoved, visibleEnd, xToTime,
} from './timeline-logic';
import { icon } from '../icons';

const LANE_LABEL_W = 96;

function isTrack(v: ParamValue | undefined): v is { track: Keyframe[] } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'track' in v;
}

function opacityTrack(node: LayerNode): Keyframe[] | null {
  return isTrack(node.opacity) ? node.opacity.track : null;
}

function opacityValue(node: LayerNode): number {
  const track = opacityTrack(node);
  if (track) return typeof track[0]?.v === 'number' ? (track[0]!.v as number) : 1;
  return typeof node.opacity === 'number' ? node.opacity : 1;
}

/** A value produced by trackWithKeyRemoved is either a still-live track
 * (Keyframe[], array of OBJECTS) or a collapsed static value (a bare number,
 * or an array of NUMBERS for vec/color params), distinguished by checking
 * what the first element actually is, since both cases can be arrays. */
function wrapCollapsed(collapsed: Keyframe[] | number | readonly number[]): ParamValue {
  if (Array.isArray(collapsed) && collapsed.length > 0 && typeof collapsed[0] === 'object') {
    return { track: collapsed as Keyframe[] };
  }
  return collapsed as ParamValue;
}

interface KeyDragState {
  laneKey: string;
  isOpacity: boolean;
  layerId: LayerId;
  index: number;
  /** Full pre-drag ParamValue (track or static), restored before the final commit. */
  snapshot: ParamValue;
}

export function mountTimeline(app: AppCtx, root: HTMLElement): void {
  root.classList.add('gd-timeline');
  root.dataset.testid = 'timeline-region';

  let drag: KeyDragState | null = null;

  function currentDoc() {
    return app.engine.getDocument();
  }

  function activeNode(): LayerNode | null {
    const id = viewState.get().activeLayer;
    if (!id) return null;
    return findLayer(currentDoc(), layerId(id))?.node ?? null;
  }

  function laneSourceSchema(node: LayerNode) {
    if (node.kind !== 'layer') return {};
    return app.engine.listSources().find((s) => s.id === node.source.type)?.params ?? {};
  }

  function buildLanes(node: LayerNode | null): Lane[] {
    if (!node) return [];
    const opTrack = opacityTrack(node);
    const opacityLane: Lane = { key: 'opacity', label: 'Opacity', kind: 'float', track: opTrack ?? [] };
    const sourceLanes = node.kind === 'layer' ? lanesFor(node.source.params, laneSourceSchema(node)) : [];
    return [opacityLane, ...sourceLanes];
  }

  function laneValue(node: LayerNode, lane: Lane): ParamValue | undefined {
    return lane.key === 'opacity' ? node.opacity : (node.kind === 'layer' ? node.source.params[lane.key] : undefined);
  }

  function applyLaneValue(id: LayerId, isOpacity: boolean, key: string, value: ParamValue): void {
    const edit: DocEdit = isOpacity
      ? { op: 'setOpacity', id, value }
      : { op: 'setParam', target: { kind: 'layer', id }, key, value };
    app.engine.applyEdits([edit]);
  }

  function commitLaneValue(label: string, id: LayerId, isOpacity: boolean, key: string, value: ParamValue): void {
    const edit: DocEdit = isOpacity
      ? { op: 'setOpacity', id, value }
      : { op: 'setParam', target: { kind: 'layer', id }, key, value };
    history.push(app, patchCommand(label, [edit]));
  }

  function commitAddOrEditKey(node: LayerNode, lane: Lane, t: Seconds, v: Keyframe['v']): void {
    const nextTrack = trackWithKeyAt(lane.track, t, v);
    commitLaneValue(`Key ${lane.label}`, node.id, lane.key === 'opacity', lane.key, { track: nextTrack });
    timelineState.update((s) => ({ ...s, selectedKey: { lane: lane.key, index: nextTrack.findIndex((k) => k.t === t) } }));
  }

  function commitRemoveKey(node: LayerNode, lane: Lane, index: number): void {
    const collapsed = trackWithKeyRemoved(lane.track, index);
    commitLaneValue(`Remove ${lane.label} Key`, node.id, lane.key === 'opacity', lane.key, wrapCollapsed(collapsed));
    timelineState.update((s) => ({ ...s, selectedKey: undefined }));
  }

  function commitEase(node: LayerNode, lane: Lane, index: number, ease: Keyframe['ease']): void {
    const key = lane.track[index];
    if (!key) return;
    const nextTrack = [...lane.track];
    nextTrack[index] = { ...key, ease };
    commitLaneValue(`${lane.label} Easing`, node.id, lane.key === 'opacity', lane.key, { track: nextTrack });
  }

  function beginKeyDrag(node: LayerNode, lane: Lane, index: number): void {
    drag = {
      laneKey: lane.key,
      isOpacity: lane.key === 'opacity',
      layerId: node.id,
      index,
      snapshot: laneValue(node, lane) ?? { track: lane.track },
    };
  }

  function moveKeyDrag(lane: Lane, clientX: number, trackEl: HTMLElement, fps: number, end: Seconds): void {
    if (!drag || drag.laneKey !== lane.key) return;
    const rect = trackEl.getBoundingClientRect();
    const t = quantiseToFrame(xToTime(clientX - rect.left, rect.width, end), fps);
    const { track: nextTrack, index } = trackWithKeyMoved(lane.track, drag.index, t);
    drag = { ...drag, index };
    applyLaneValue(drag.layerId, drag.isOpacity, lane.key, { track: nextTrack });
  }

  function endKeyDrag(node: LayerNode, lane: Lane): void {
    if (!drag || drag.laneKey !== lane.key) return;
    const { layerId: id, isOpacity, snapshot } = drag;
    drag = null;
    // Revert the live preview, then push ONE real commit with the final
    // track (same revert-then-commit shape as effect-dialog.ts's onOk).
    applyLaneValue(id, isOpacity, lane.key, snapshot);
    const finalNode = findLayer(currentDoc(), id)?.node;
    const finalValue = finalNode ? laneValue(finalNode, lane) : undefined;
    if (finalValue === undefined) return;
    commitLaneValue(`Move ${lane.label} Key`, id, isOpacity, lane.key, finalValue);
    void node;
  }

  function onDurationChange(e: Event, doc: ReturnType<typeof currentDoc>): void {
    const raw = (e.target as HTMLInputElement).value;
    const duration = raw === '' ? undefined : Number(raw);
    if (duration === doc.clock.duration) return;
    history.push(app, patchCommand('Set Duration', [{ op: 'setDocClock', clock: { fps: doc.clock.fps, duration } }]));
  }

  function toggleLoop(end: Seconds): void {
    const current = timelineState.get().loop;
    const next = current ? undefined : { from: 0, to: Math.min(1, end) };
    timelineState.update((s) => ({ ...s, loop: next }));
    app.engine.setClock({ cmd: 'setLoop', range: next });
  }

  /** Both handles share one drag: which end moves, and each clamps against
   * the other so `from` can never cross `to`. trackEl is looked up lazily
   * (not passed in) so this never reads a stale pre-render element. */
  function dragLoopHandle(which: 'from' | 'to', end: Seconds, fps: number) {
    return (down: PointerEvent) => {
      down.preventDefault();
      down.stopPropagation();
      const handle = down.currentTarget as HTMLElement;
      const trackEl = root.querySelector<HTMLElement>('[data-testid="timeline-track"]');
      if (!trackEl) return;
      handle.setPointerCapture(down.pointerId);
      let pending: { from: Seconds; to: Seconds } | null = null;
      const onMove = (ev: PointerEvent) => {
        const loop = timelineState.get().loop;
        if (!loop) return;
        const rect = trackEl.getBoundingClientRect();
        const t = quantiseToFrame(xToTime(ev.clientX - rect.left, rect.width, end), fps);
        pending = which === 'from' ? { from: Math.min(t, loop.to), to: loop.to } : { from: loop.from, to: Math.max(t, loop.from) };
        const braceEl = root.querySelector<HTMLElement>('.gd-timeline__loop-brace');
        if (braceEl) {
          const fromX = timeToX(pending.from, rect.width, end);
          const toX = timeToX(pending.to, rect.width, end);
          braceEl.style.left = `${fromX}px`;
          braceEl.style.width = `${Math.max(0, toX - fromX)}px`;
        }
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        if (pending) {
          timelineState.update((s) => ({ ...s, loop: pending ?? s.loop }));
          app.engine.setClock({ cmd: 'setLoop', range: pending });
        }
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    };
  }

  function seekAt(clientX: number, trackEl: HTMLElement, end: Seconds): void {
    const rect = trackEl.getBoundingClientRect();
    const t = xToTime(clientX - rect.left, rect.width, end);
    app.engine.setClock({ cmd: 'seek', time: Math.min(t, end) });
  }

  function onRulerPointerDown(e: PointerEvent, end: Seconds): void {
    if ((e.target as HTMLElement).closest('.gd-timeline__loop-handle')) return;
    const el = e.currentTarget as HTMLElement;
    seekAt(e.clientX, el, end);
    el.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => seekAt(ev.clientX, el, end);
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }

  function renderLaneRow(node: LayerNode, lane: Lane, end: Seconds, fps: number, trackWidth: number) {
    const selected = timelineState.get().selectedKey;
    return html`
      <div class="gd-timeline__row gd-timeline__row--lane" data-testid="timeline-lane-${lane.key}">
        <span class="gd-timeline__lane-label">${lane.label}</span>
        <div
          class="gd-timeline__lane-track"
          data-testid="timeline-lane-track-${lane.key}"
          @pointerdown=${(e: PointerEvent) => {
            if ((e.target as HTMLElement).closest('.gd-timeline__key')) return;
            const el = e.currentTarget as HTMLElement;
            const rect = el.getBoundingClientRect();
            const t = quantiseToFrame(xToTime(e.clientX - rect.left, rect.width, end), fps);
            // Preserves the curve's current shape at the click point rather
            // than always reusing the last key's value.
            const current = lane.track.length > 0 ? resolveTrackAt(lane.track, t) : opacityValue(node);
            commitAddOrEditKey(node, lane, t, current);
          }}
        >
          ${lane.track.map((k, index) => html`
            <div
              class="gd-timeline__key ${selected?.lane === lane.key && selected.index === index ? 'selected' : ''}"
              data-testid="timeline-key-${lane.key}-${index}"
              style="left:${timeToX(k.t, trackWidth, end)}px"
              @pointerdown=${(e: PointerEvent) => {
                e.stopPropagation();
                timelineState.update((s) => ({ ...s, selectedKey: { lane: lane.key, index } }));
                const trackEl = (e.currentTarget as HTMLElement).closest('.gd-timeline__lane-track') as HTMLElement;
                beginKeyDrag(node, lane, index);
                const onMove = (ev: PointerEvent) => moveKeyDrag(lane, ev.clientX, trackEl, fps, end);
                const onUp = () => {
                  window.removeEventListener('pointermove', onMove);
                  window.removeEventListener('pointerup', onUp);
                  endKeyDrag(node, lane);
                };
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
              }}
            >${icon('diamond')}</div>
          `)}
        </div>
        ${selected?.lane === lane.key && lane.track[selected.index]
          ? html`
            <div class="gd-timeline__key-tools">
              <span class="select-wrap">
                <select
                  class="select"
                  data-testid="timeline-ease-${lane.key}"
                  @change=${(e: Event) => commitEase(node, lane, selected.index, (e.target as HTMLSelectElement).value as Keyframe['ease'])}
                >
                  ${(['linear', 'hold', 'cubic'] as const).map((opt) => html`
                    <option value=${opt} ?selected=${(lane.track[selected.index]!.ease ?? 'linear') === opt}>${opt}</option>
                  `)}
                </select>
              </span>
              <button
                type="button"
                class="btn btn-icon btn-tertiary btn-sm"
                data-testid="timeline-delete-key-${lane.key}"
                aria-label="Delete key"
                data-tip="Delete key"
                @click=${() => commitRemoveKey(node, lane, selected.index)}
              >${icon('trash')}</button>
            </div>
          `
          : ''}
      </div>
    `;
  }

  function renderStrip(): void {
    const doc = currentDoc();
    const loop = timelineState.get().loop;
    const end = visibleEnd(doc.clock.duration, loop?.to);
    const node = activeNode();
    const lanes = buildLanes(node);
    const fps = doc.clock.fps;
    const trackWidth = Math.max(0, root.clientWidth - LANE_LABEL_W);

    litRender(
      html`
        <div class="gd-timeline__header">
          <span class="gd-timeline__label">Timeline</span>
          <label class="gd-timeline__duration">
            <span>Duration</span>
            <input
              class="input num"
              type="number" min="0" step="0.1" placeholder="&infin;"
              data-testid="timeline-duration"
              .value=${doc.clock.duration != null ? String(doc.clock.duration) : ''}
              @change=${(e: Event) => onDurationChange(e, doc)}
            />
            <span class="gd-form-unit">s</span>
          </label>
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            data-testid="timeline-loop-toggle"
            @click=${() => toggleLoop(end)}
          >Loop: ${loop ? 'on' : 'off'}</button>
        </div>
        <div class="gd-timeline__row gd-timeline__row--ruler">
          <span class="gd-timeline__lane-label"></span>
          <div
            class="gd-timeline__track"
            data-testid="timeline-track"
            @pointerdown=${(e: PointerEvent) => onRulerPointerDown(e, end)}
          >
            <div class="gd-timeline__playhead" data-testid="timeline-playhead"></div>
            ${loop
              ? html`
                <div
                  class="gd-timeline__loop-brace"
                  style="left:${timeToX(loop.from, trackWidth, end)}px; width:${timeToX(loop.to, trackWidth, end) - timeToX(loop.from, trackWidth, end)}px"
                >
                  <div class="gd-timeline__loop-handle gd-timeline__loop-handle--from" data-testid="timeline-loop-from"
                    @pointerdown=${dragLoopHandle('from', end, fps)}></div>
                  <div class="gd-timeline__loop-handle gd-timeline__loop-handle--to" data-testid="timeline-loop-to"
                    @pointerdown=${dragLoopHandle('to', end, fps)}></div>
                </div>
              `
              : ''}
          </div>
        </div>
        <div class="gd-timeline__lanes" data-testid="timeline-lanes">
          ${!node
            ? html`<div class="gd-timeline__empty">Select a layer to see its keyframes</div>`
            : lanes.map((lane) => renderLaneRow(node, lane, end, fps, trackWidth))}
        </div>
      `,
      root,
    );
    updatePlayhead();
  }

  function updatePlayhead(): void {
    const playheadEl = root.querySelector<HTMLElement>('[data-testid="timeline-playhead"]');
    if (!playheadEl) return;
    const doc = currentDoc();
    const loop = timelineState.get().loop;
    const end = visibleEnd(doc.clock.duration, loop?.to);
    const trackWidth = Math.max(0, root.clientWidth - LANE_LABEL_W);
    const x = timeToX(clockState.get().time, trackWidth, end);
    playheadEl.style.transform = `translateX(${x}px)`;
  }

  function renderVisibility(): void {
    const visible = layoutState.get().panels['timeline']?.visible ?? false;
    root.style.display = visible ? '' : 'none';
    if (visible) renderStrip();
  }

  clockState.subscribe(updatePlayhead);
  app.engine.on('document-changed', renderStrip);
  history.onChange(renderStrip);
  viewState.subscribe(renderStrip);
  timelineState.subscribe(renderStrip);
  layoutState.subscribe(renderVisibility);
  renderVisibility();
}
