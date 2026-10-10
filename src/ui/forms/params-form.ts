/**
 * The schema-driven params form. Every effect/source ships a ParamsSchema
 * (FROZEN CONTRACT, engine/params/schema.ts) and gets this UI for free. NO
 * per-effect UI code is ever written against a specific param set.
 *
 * Keyframed values ({track: Keyframe[]}) render bound to the value at t=0
 * with a diamond indicator; editing replaces the track with a static value.
 * Full keyframe editing (adding/removing keys, curve editor) is a later
 * milestone. This is the Phase 1 read/collapse-to-static behaviour.
 */

import { html, render, type TemplateResult } from 'lit-html';
import type { AssetRef, ParamSpec, ParamsSchema, ParamValue, ParamValues, Keyframe, Lfo, Seconds } from '@engine';
import { assetId } from '@engine';
import { icon } from '../icons';
import { trackWithKeyAt, resolveTrackAt } from '../shell/timeline-logic';
import { oklabToCss, oklabToOklch, oklchToOklab, srgbToHex, hexToSrgb, oklabToSrgb, srgbToOklab, type Oklab } from './form-color';

export type ParamsChangeHandler = (key: string, value: ParamValue) => void;

/** Mirrors the 'asset' ParamSpec variant's assetType union (params/schema.ts
 * is a frozen contract, kept in sync by hand, not derived, since extracting
 * a union member's field type via a non-generic conditional doesn't
 * distribute the way `infer` implies). */
type AssetParamType = Extract<ParamSpec, { kind: 'asset' }>['assetType'];

/**
 * Single additive opts bag. `assets` enables the asset-picker popover on
 * asset-kind rows. `time`/`onSetKey` enable keyframe authoring on animatable
 * rows. Omitted entirely -> exact pre-existing behaviour (diamond is a
 * static badge, editing a keyframed row collapses it to a static value).
 */
export interface ParamsFormOpts {
  assets?: {
    /** Existing document assets of this type, for the picker popover. */
    list(assetType: AssetParamType): { id: string; label: string }[];
    /** "Import…" row: caller owns the file dialog/decoding/history push;
     * returns the new asset's ref, or null if the user cancelled. */
    importNew(assetType: AssetParamType): Promise<{ asset: string } | null>;
  };
  /** Current playhead time, frame-quantised by the caller. */
  time?: Seconds;
  /** Called after a diamond click adds/replaces a key at `time` (not on
   * alt+click collapse, which has no surviving key). Lets a host that also
   * shows the timeline strip select the just-authored key. */
  onSetKey?: (key: string, track: Keyframe[]) => void;
}

function isKeyframed(v: ParamValue | undefined): v is { track: Keyframe[] } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'track' in v;
}

function isLfo(v: ParamValue | undefined): v is { lfo: Lfo } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'lfo' in v;
}

/** Non-interactive keyframe indicator. No opts.time, so there's nothing to
 * click into: a plain glyph, not a .btn (it has no click handler). */
function keyframeBadge(label: string): TemplateResult {
  return html`<span class="gd-form-keyframe-badge" data-testid="pf-keyframe" title=${label}>${icon('diamond')}</span>`;
}

/**
 * Interactive keyframe diamond, only rendered when opts.time is available.
 * Click: not keyframed -> starts a track with a single key at `time`
 * holding `current`; keyframed -> inserts/replaces the key at `time` with
 * `current` (the value already on screen, resolved-at-time when keyframed).
 * Alt+click: collapses back to the static `current` value (only meaningful
 * when already keyframed).
 */
function keyframeDiamond(
  label: string, key: string, kf: boolean, current: Keyframe['v'], track: Keyframe[] | null,
  opts: ParamsFormOpts, onChange: ParamsChangeHandler,
): TemplateResult {
  const time = opts.time as Seconds;
  return html`<button
    type="button"
    class="btn btn-icon btn-tertiary btn-sm"
    data-testid="pf-keyframe"
    aria-pressed=${kf}
    data-tip=${kf ? `${label}: click to key here, Alt+click to collapse to static` : `${label}: click to start keyframing`}
    @click=${(e: MouseEvent) => {
      if (e.altKey) {
        onChange(key, current);
        return;
      }
      const nextTrack = trackWithKeyAt(track ?? [], time, current);
      onChange(key, { track: nextTrack });
      opts.onSetKey?.(key, nextTrack);
    }}
  >${icon('diamond')}</button>`;
}

function numericAt0(raw: ParamValue | undefined, fallback: number): number {
  if (isKeyframed(raw)) {
    const v = raw.track[0]?.v;
    return typeof v === 'number' ? v : fallback;
  }
  // Forms don't animate yet: a static readout of the LFO's offset is v1-acceptable.
  if (isLfo(raw)) return raw.lfo.offset;
  return typeof raw === 'number' ? raw : fallback;
}

function arrayAt0(raw: ParamValue | undefined, fallback: readonly number[]): readonly number[] {
  if (isKeyframed(raw)) {
    const v = raw.track[0]?.v;
    return Array.isArray(v) ? v : fallback;
  }
  return Array.isArray(raw) ? (raw as readonly number[]) : fallback;
}

function startScrub(e: MouseEvent, get: () => number, set: (v: number) => void, step: number): void {
  e.preventDefault();
  const startX = e.clientX;
  const startVal = get();
  const move = (ev: MouseEvent) => {
    const dx = ev.clientX - startX;
    set(startVal + dx * step);
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function clamp(v: number, min?: number, max?: number): number {
  let out = v;
  if (min !== undefined) out = Math.max(min, out);
  if (max !== undefined) out = Math.min(max, out);
  return out;
}

function numberRow(
  key: string, spec: Extract<ParamSpec, { kind: 'float' | 'int' }>, raw: ParamValue | undefined,
  onChange: ParamsChangeHandler, opts?: ParamsFormOpts,
): TemplateResult {
  const kf = isKeyframed(raw);
  const track = kf ? (raw as { track: Keyframe[] }).track : null;
  const value = kf && track && opts?.time !== undefined
    ? (resolveTrackAt(track, opts.time) as number)
    : numericAt0(raw, spec.default);
  const step = spec.kind === 'float' ? (spec.step ?? 0.01) : 1;
  const min = spec.min ?? (spec.kind === 'int' ? 0 : 0);
  const max = spec.max ?? (spec.kind === 'int' ? 100 : 1);
  const label = spec.label ?? key;
  const unit = spec.kind === 'float' ? spec.unit : undefined;

  const commit = (next: number) => {
    const coerced = spec.kind === 'int' ? Math.round(next) : next;
    const clamped = clamp(coerced, spec.min, spec.max);
    if (opts?.time !== undefined && kf && track) {
      const nextTrack = trackWithKeyAt(track, opts.time, clamped);
      onChange(key, { track: nextTrack });
      opts.onSetKey?.(key, nextTrack);
      return;
    }
    onChange(key, clamped);
  };

  return html`
    <div class="gd-form-row" data-testid="pf-row-${key}" data-kind=${spec.kind}>
      <span class="label" data-testid="pf-label-${key}"
        @mousedown=${(e: MouseEvent) => startScrub(e, () => value, commit, step)}
      >${label}</span>
      <div class="gd-form-control">
        <span class="g-slider">
          <input type="range" min=${min} max=${max} step=${step} .value=${String(value)}
            data-testid="pf-slider-${key}"
            @input=${(e: Event) => commit(Number((e.target as HTMLInputElement).value))} />
        </span>
        <input class="input num" type="number" min=${min} max=${max} step=${step} .value=${String(value)}
          data-testid="pf-number-${key}"
          @change=${(e: Event) => commit(Number((e.target as HTMLInputElement).value))} />
        ${unit ? html`<span class="gd-form-unit">${unit}</span>` : ''}
        ${opts?.time !== undefined && (kf || (spec.kind === 'float' && spec.animatable))
          ? keyframeDiamond(label, key, kf, value, track, opts, onChange)
          : kf ? keyframeBadge(`${label} is keyframed: editing sets a static value`) : ''}
      </div>
    </div>
  `;
}

function boolRow(
  key: string, spec: Extract<ParamSpec, { kind: 'bool' }>, raw: ParamValue | undefined,
  onChange: ParamsChangeHandler,
): TemplateResult {
  const value = typeof raw === 'boolean' ? raw : spec.default;
  const label = spec.label ?? key;
  return html`
    <div class="gd-form-row" data-testid="pf-row-${key}" data-kind="bool">
      <span class="label" data-testid="pf-label-${key}">${label}</span>
      <div class="gd-form-control">
        <input class="checkbox" type="checkbox" .checked=${value}
          data-testid="pf-checkbox-${key}"
          @change=${(e: Event) => onChange(key, (e.target as HTMLInputElement).checked)} />
      </div>
    </div>
  `;
}

function enumRow(
  key: string, spec: Extract<ParamSpec, { kind: 'enum' }>, raw: ParamValue | undefined,
  onChange: ParamsChangeHandler,
): TemplateResult {
  const value = typeof raw === 'string' ? raw : spec.default;
  const label = spec.label ?? key;
  return html`
    <div class="gd-form-row" data-testid="pf-row-${key}" data-kind="enum">
      <span class="label" data-testid="pf-label-${key}">${label}</span>
      <div class="gd-form-control">
        <span class="select-wrap">
          <select class="select" data-testid="pf-select-${key}"
            @change=${(e: Event) => onChange(key, (e.target as HTMLSelectElement).value)}>
            ${spec.options.map((opt) => html`<option value=${opt} ?selected=${opt === value}>${opt}</option>`)}
          </select>
        </span>
      </div>
    </div>
  `;
}

function vecRow(
  key: string, spec: Extract<ParamSpec, { kind: 'vec2' | 'vec3' | 'vec4' }>, raw: ParamValue | undefined,
  onChange: ParamsChangeHandler, opts?: ParamsFormOpts,
): TemplateResult {
  const kf = isKeyframed(raw);
  const track = kf ? (raw as { track: Keyframe[] }).track : null;
  const n = spec.kind === 'vec2' ? 2 : spec.kind === 'vec3' ? 3 : 4;
  const value = kf && track && opts?.time !== undefined
    ? (resolveTrackAt(track, opts.time) as readonly number[])
    : arrayAt0(raw, spec.default);
  const label = spec.label ?? key;

  const commit = (next: number[]) => {
    if (opts?.time !== undefined && kf && track) {
      const nextTrack = trackWithKeyAt(track, opts.time, next);
      onChange(key, { track: nextTrack });
      opts.onSetKey?.(key, nextTrack);
      return;
    }
    onChange(key, next);
  };
  const commitAt = (i: number, v: number) => {
    const next = value.slice(0, n);
    while (next.length < n) next.push(0);
    next[i] = clamp(v, spec.min, spec.max);
    commit(next);
  };

  return html`
    <div class="gd-form-row" data-testid="pf-row-${key}" data-kind=${spec.kind}>
      <span class="label" data-testid="pf-label-${key}">${label}</span>
      <div class="gd-form-control">
        <div class="gd-form-vec" data-testid="pf-vec-${key}">
          ${Array.from({ length: n }, (_, i) => html`
            <input class="input num" type="number" min=${spec.min ?? ''} max=${spec.max ?? ''} step="0.01"
              .value=${String(value[i] ?? 0)}
              data-testid="pf-vec-${key}-${i}"
              @change=${(e: Event) => commitAt(i, Number((e.target as HTMLInputElement).value))} />
          `)}
        </div>
        ${opts?.time !== undefined && (kf || spec.animatable)
          ? keyframeDiamond(label, key, kf, value, track, opts, onChange)
          : kf ? keyframeBadge(`${label} is keyframed: editing sets a static value`) : ''}
      </div>
    </div>
  `;
}

function isAssetRef(v: ParamValue | undefined): v is AssetRef {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'asset' in v && typeof (v as AssetRef).asset === 'string';
}

/** Opens a `.menu` popover (Popover API, `popover="manual"`) anchored under
 * `anchor`, flipping above when there isn't room below, the same geometry
 * g-ui.js's initMenu uses for `[popovertarget]` menus, reimplemented here
 * because these popovers have no persistent trigger element to key off of
 * (a swatch/asset button gets re-rendered by lit-html on every params-form
 * render). Closes on an outside pointerdown or Escape. `paint` renders (and,
 * via the passed `repaint`, re-renders) the popover's content into `host`;
 * `window.g?.init(host)` runs after every paint so a `.g-slider` inside
 * picks up its fill/readout behaviour (these popovers live outside the
 * boot-time root g-ui.js scans once at startup).
 *
 * Appended inside the currently-open modal `<dialog>` when there is one,
 * not `document.body`: a `popover="manual"` element promoted to the top
 * layer as a SIBLING of an already-open modal dialog paints above it (this
 * file's swatch/asset rows are only ever opened from a panel with no dialog
 * open, or from a paramsForm rendered inside one) but is not actually
 * hit-testable there. A real, reproducible Chromium top-layer quirk, not a
 * z-index issue this file's CSS could fix. A child of the open dialog hit-
 * tests correctly instead. */
function openMenuPopover(
  anchor: DOMRect, testId: string,
  paint: (host: HTMLElement, repaint: () => void, close: () => void) => void,
): { host: HTMLElement; close: () => void } {
  const host = document.createElement('div');
  host.className = 'menu';
  host.setAttribute('popover', 'manual');
  host.setAttribute('data-testid', testId);
  const openDialogEl = document.querySelector('dialog.dlg[open]');
  (openDialogEl ?? document.body).appendChild(host);

  const close = () => {
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    host.hidePopover?.();
    host.remove();
  };
  const onOutside = (e: PointerEvent) => { if (!host.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

  const repaint = () => {
    paint(host, repaint, close);
    window.g?.init(host);
  };
  repaint();
  host.showPopover?.();

  const fitsBelow = anchor.bottom + 6 + host.offsetHeight < window.innerHeight;
  const fitsAbove = anchor.top - 6 - host.offsetHeight > 0;
  const below = fitsBelow || !fitsAbove;
  host.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - host.offsetWidth - 8))}px`;
  host.style.top = `${below ? anchor.bottom + 6 : anchor.top - host.offsetHeight - 6}px`;

  // Defer listener attach so the opening click doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  return { host, close };
}

function openAssetPopover(
  anchor: DOMRect,
  assetType: AssetParamType,
  api: NonNullable<ParamsFormOpts['assets']>,
  onChoose: (assetId: string) => void,
): void {
  openMenuPopover(anchor, 'asset-popover', (host, _repaint, close) => {
    const items = api.list(assetType);
    render(html`
      ${items.length === 0 ? html`<div class="gd-menu-empty" data-testid="asset-empty">No ${assetType} assets yet</div>` : ''}
      ${items.map((it) => html`
        <button type="button" class="menu-item" data-testid="asset-option-${it.id}"
          @click=${() => { onChoose(it.id); close(); }}>${it.label}</button>
      `)}
      ${items.length > 0 ? html`<hr class="separator">` : ''}
      <button type="button" class="menu-item" data-testid="asset-option-import"
        @click=${async () => {
          const result = await api.importNew(assetType);
          if (result) { onChoose(result.asset); close(); }
        }}>Import…</button>
    `, host);
  });
}

function assetRow(
  key: string, spec: Extract<ParamSpec, { kind: 'asset' }>, raw: ParamValue | undefined,
  onChange: ParamsChangeHandler, opts: ParamsFormOpts | undefined,
): TemplateResult {
  const label = spec.label ?? key;
  const assetsApi = opts?.assets;

  if (!assetsApi) {
    // No picker wired for this form (Layer properties' Source section):
    // show what is set, read-only, rather than pretend a button works.
    const current = raw && typeof raw === 'object' && 'asset' in raw ? String((raw as { asset: string }).asset).slice(0, 8) : null;
    return html`
      <div class="gd-form-row" data-testid="pf-row-${key}" data-kind="asset">
        <span class="label" data-testid="pf-label-${key}">${label}</span>
        <div class="gd-form-control">
          <button class="btn btn-secondary btn-sm" data-testid="pf-asset-${key}" disabled title="Change it from the Effects pane">
            ${current ? html`<span class="mono">${current}</span>` : `No ${spec.assetType} set`}
          </button>
        </div>
      </div>
    `;
  }

  const currentId = isAssetRef(raw) ? raw.asset : undefined;
  const currentLabel = currentId
    ? assetsApi.list(spec.assetType).find((a) => a.id === currentId)?.label ?? currentId
    : undefined;

  const openPopover = (e: MouseEvent) => {
    const target = e.currentTarget as HTMLElement;
    openAssetPopover(target.getBoundingClientRect(), spec.assetType, assetsApi, (assetIdValue) => {
      onChange(key, { asset: assetId(assetIdValue) });
    });
  };

  return html`
    <div class="gd-form-row" data-testid="pf-row-${key}" data-kind="asset">
      <span class="label" data-testid="pf-label-${key}">${label}</span>
      <div class="gd-form-control">
        <button class="btn btn-secondary btn-sm" data-testid="pf-asset-${key}" @click=${openPopover}>
          ${currentLabel ? html`<span class="mono">${currentLabel}</span>` : 'Choose…'}
        </button>
      </div>
    </div>
  `;
}

function colorRow(
  key: string, spec: Extract<ParamSpec, { kind: 'color' }>, raw: ParamValue | undefined,
  onChange: ParamsChangeHandler, opts?: ParamsFormOpts,
): TemplateResult {
  const kf = isKeyframed(raw);
  const track = kf ? (raw as { track: Keyframe[] }).track : null;
  const flat = kf && track && opts?.time !== undefined
    ? (resolveTrackAt(track, opts.time) as readonly number[])
    : arrayAt0(raw, spec.default);
  const lab: Oklab = [flat[0] ?? 0, flat[1] ?? 0, flat[2] ?? 0];
  const alpha = flat[3] ?? 1;
  const label = spec.label ?? key;
  const bg = oklabToCss(lab);

  const commit = (next: readonly number[]) => {
    if (opts?.time !== undefined && kf && track) {
      const nextTrack = trackWithKeyAt(track, opts.time, next);
      onChange(key, { track: nextTrack });
      opts.onSetKey?.(key, nextTrack);
      return;
    }
    onChange(key, next);
  };

  const openPopover = (e: MouseEvent) => {
    const target = e.currentTarget as HTMLElement;
    openColorPopover(target.getBoundingClientRect(), lab, alpha, (nextLab, nextAlpha) => {
      commit([nextLab[0], nextLab[1], nextLab[2], nextAlpha]);
    });
  };

  return html`
    <div class="gd-form-row" data-testid="pf-row-${key}" data-kind="color">
      <span class="label" data-testid="pf-label-${key}">${label}</span>
      <div class="gd-form-control">
        <button class="g-swatch" data-testid="pf-swatch-${key}" style="--swatch:${bg}"
          @click=${openPopover}></button>
        ${opts?.time !== undefined && (kf || spec.animatable)
          ? keyframeDiamond(label, key, kf, flat, track, opts, onChange)
          : kf ? keyframeBadge(`${label} is keyframed: editing sets a static value`) : ''}
      </div>
    </div>
  `;
}

/** Self-contained color popover: OKLCH sliders + hex input. Closes on
 * Escape/outside click. Exported: colorRow (this file) and the Object
 * panel's fill/text-colour swatch (effects.ts) are both plain callers:
 * this is the one color-editing popover implementation, not duplicated. */
export function openColorPopover(
  anchor: DOMRect, initial: Oklab, initialAlpha: number,
  onChange: (lab: Oklab, alpha: number) => void,
): void {
  let lab = initial;
  let alpha = initialAlpha;

  openMenuPopover(anchor, 'color-popover', (host, repaint) => {
    const [l, c, h] = oklabToOklch(lab);
    const hex = srgbToHex(oklabToSrgb(lab));
    render(html`
      <div class="gd-form-row">
        <span class="label">L</span>
        <div class="gd-form-control">
          <span class="g-slider" data-output>
            <input type="range" min="0" max="1" step="0.001" .value=${String(l)}
              data-testid="pf-color-l"
              @input=${(e: Event) => { lab = oklchToOklab([Number((e.target as HTMLInputElement).value), c, h]); onChange(lab, alpha); repaint(); }} />
          </span>
        </div>
      </div>
      <div class="gd-form-row">
        <span class="label">C</span>
        <div class="gd-form-control">
          <span class="g-slider" data-output>
            <input type="range" min="0" max="0.4" step="0.001" .value=${String(c)}
              data-testid="pf-color-c"
              @input=${(e: Event) => { lab = oklchToOklab([l, Number((e.target as HTMLInputElement).value), h]); onChange(lab, alpha); repaint(); }} />
          </span>
        </div>
      </div>
      <div class="gd-form-row">
        <span class="label">H</span>
        <div class="gd-form-control">
          <span class="g-slider" data-output>
            <input type="range" min="0" max="360" step="0.1" .value=${String(h)}
              data-testid="pf-color-h"
              @input=${(e: Event) => { lab = oklchToOklab([l, c, Number((e.target as HTMLInputElement).value)]); onChange(lab, alpha); repaint(); }} />
          </span>
        </div>
      </div>
      <div class="gd-form-row">
        <span class="label">Alpha</span>
        <div class="gd-form-control">
          <span class="g-slider" data-output>
            <input type="range" min="0" max="1" step="0.01" .value=${String(alpha)}
              data-testid="pf-color-alpha"
              @input=${(e: Event) => { alpha = Number((e.target as HTMLInputElement).value); onChange(lab, alpha); repaint(); }} />
          </span>
        </div>
      </div>
      <input class="input" type="text" .value=${hex} data-testid="pf-color-hex"
        @change=${(e: Event) => {
          const parsed = hexToSrgb((e.target as HTMLInputElement).value);
          if (!parsed) { repaint(); return; }
          lab = srgbToOklab(parsed);
          onChange(lab, alpha);
          repaint();
        }} />
    `, host);
  });
}

export function paramsForm(
  schema: ParamsSchema, values: ParamValues, onChange: ParamsChangeHandler, opts?: ParamsFormOpts,
): TemplateResult {
  const rows = Object.entries(schema).map(([key, spec]) => {
    const raw = values[key];
    switch (spec.kind) {
      case 'float':
      case 'int':
        return numberRow(key, spec, raw, onChange, opts);
      case 'bool':
        return boolRow(key, spec, raw, onChange);
      case 'enum':
        return enumRow(key, spec, raw, onChange);
      case 'vec2':
      case 'vec3':
      case 'vec4':
        return vecRow(key, spec, raw, onChange, opts);
      case 'color':
        return colorRow(key, spec, raw, onChange, opts);
      case 'asset':
        return assetRow(key, spec, raw, onChange, opts);
      default:
        return html``;
    }
  });
  return html`<div class="gd-form" data-testid="params-form">${rows}</div>`;
}
