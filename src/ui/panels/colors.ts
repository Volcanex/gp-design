/**
 * Colours panel (F8). Overlapping primary/secondary swatches (X swaps them,
 * C toggles which one is being edited, wired by whatever owns global
 * keybindings; this panel only reflects toolState.editing/primary/secondary
 * and writes back to them). OKLCH picker: H slider + 2D L/C canvas area +
 * numeric inputs + sRGB hex field, all via color-math.ts. 16 most-recent
 * colours tracked as module state (resets on reload, Phase 1 scope).
 */

import { html } from 'lit-html';
import { ref } from 'lit-html/directives/ref.js';
import type { AppCtx, PanelHost } from '../../app/types';
import { toolState } from '../../app/stores';
import { icon } from '../icons';
import { oklabToOklch, oklchToOklab, oklchToSrgb, srgbToHex, hexToSrgb, srgbToOklab } from './color-math';

type Oklab4 = readonly [number, number, number, number];

const LC_CANVAS_HEIGHT = 110;
const MAX_C = 0.4;
const MAX_RECENT = 16;
const recent: Oklab4[] = [];

function pushRecent(color: Oklab4): void {
  const key = color.join(',');
  const dupe = recent.findIndex((c) => c.join(',') === key);
  if (dupe !== -1) recent.splice(dupe, 1);
  recent.unshift(color);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
}

function setEditingColor(color: Oklab4): void {
  const { editing } = toolState.get();
  toolState.update((s) => ({ ...s, [editing]: color }));
  pushRecent(color);
}

function swapColors(): void {
  toolState.update((s) => ({ ...s, primary: s.secondary, secondary: s.primary }));
}

/** A g-swatch's colour is content, passed as the --swatch custom property:
 * a plain CSS oklch() carries the alpha channel straight through with no
 * lossy sRGB round trip (that round trip stays for the hex field only,
 * where sRGB is the actual destination format). */
function swatchCss(c: Oklab4): string {
  const [l, ch, h] = oklabToOklch([c[0], c[1], c[2]]);
  return `oklch(${l} ${ch} ${h} / ${c[3]})`;
}

function paintLcCanvas(canvas: HTMLCanvasElement, hue: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const l = 1 - y / (h - 1);
    for (let x = 0; x < w; x++) {
      const c = (x / (w - 1)) * MAX_C;
      const [r, g, b] = oklchToSrgb([l, c, hue]);
      const i = (y * w + x) * 4;
      img.data[i] = Math.round(r * 255);
      img.data[i + 1] = Math.round(g * 255);
      img.data[i + 2] = Math.round(b * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export const colorsPanel: PanelHost = {
  id: 'colors',
  title: 'Colours',
  toggleKey: 'F8',
  defaultPosition: { corner: 'br', x: 8, y: 260 },
  render(_app: AppCtx) {
    const state = toolState.get();
    const active = state[state.editing];
    const [L, C, H] = oklabToOklch([active[0], active[1], active[2]]);
    const [r, g, b] = oklchToSrgb([L, C, H]);
    const hex = srgbToHex([r, g, b]);

    const setLch = (nl: number, nc: number, nh: number) => {
      const [a, bb] = oklchToOklab([nl, nc, nh]).slice(1) as [number, number];
      setEditingColor([nl, a, bb, active[3]]);
    };

    return html`
      <div class="gd-panel-body gd-colors">
        <div class="gd-colors-head">
          <div class="g-swatch-pair">
            <button type="button" class="g-swatch" style="--swatch: ${swatchCss(state.primary)}" aria-label="Primary colour"></button>
            <button type="button" class="g-swatch" style="--swatch: ${swatchCss(state.secondary)}" aria-label="Secondary colour"></button>
            <button type="button" class="g-swatch-swap" data-tip="Swap (X)" aria-label="Swap colours" @click=${swapColors}>${icon('arrows-left-right')}</button>
          </div>
          <div class="g-segmented" role="radiogroup" aria-label="Editing">
            <label>
              <input
                type="radio"
                name="gd-color-edit"
                value="primary"
                .checked=${state.editing === 'primary'}
                @change=${() => toolState.update((s) => ({ ...s, editing: 'primary' }))}
              /><span>Primary</span>
            </label>
            <label>
              <input
                type="radio"
                name="gd-color-edit"
                value="secondary"
                .checked=${state.editing === 'secondary'}
                @change=${() => toolState.update((s) => ({ ...s, editing: 'secondary' }))}
              /><span>Secondary</span>
            </label>
          </div>
        </div>

        <canvas
          class="gd-lc-canvas"
          height=${LC_CANVAS_HEIGHT}
          ${ref((el) => {
            if (!(el instanceof HTMLCanvasElement)) return;
            const width = Math.max(1, Math.round(el.getBoundingClientRect().width) || 240);
            if (el.width !== width) el.width = width;
            if (el.height !== LC_CANVAS_HEIGHT) el.height = LC_CANVAS_HEIGHT;
            paintLcCanvas(el, H);
          })}
          @pointerdown=${(e: PointerEvent) => pickLc(e, setLch, H)}
          @pointermove=${(e: PointerEvent) => {
            if (e.buttons === 1) pickLc(e, setLch, H);
          }}
        ></canvas>

        <span class="g-slider gd-hue-slider">
          <input
            type="range"
            min="0"
            max="360"
            step="1"
            aria-label="Hue"
            .value=${String(Math.round(H))}
            @input=${(e: Event) => setLch(L, C, Number((e.target as HTMLInputElement).value))}
          />
        </span>

        <div class="gd-lch-row">
          <label class="field">
            <span class="label">L</span>
            <input
              class="input num"
              type="number"
              min="0"
              max="1"
              step="0.01"
              .value=${L.toFixed(3)}
              @change=${(e: Event) => setLch(Number((e.target as HTMLInputElement).value), C, H)}
            />
          </label>
          <label class="field">
            <span class="label">C</span>
            <input
              class="input num"
              type="number"
              min="0"
              max=${MAX_C}
              step="0.005"
              .value=${C.toFixed(3)}
              @change=${(e: Event) => setLch(L, Number((e.target as HTMLInputElement).value), H)}
            />
          </label>
          <label class="field">
            <span class="label">H</span>
            <input
              class="input num"
              type="number"
              min="0"
              max="360"
              step="1"
              .value=${H.toFixed(1)}
              @change=${(e: Event) => setLch(L, C, Number((e.target as HTMLInputElement).value))}
            />
          </label>
        </div>

        <label class="field">
          <span class="label">Hex</span>
          <input
            class="input mono"
            type="text"
            .value=${hex}
            @change=${(e: Event) => {
              const srgb = hexToSrgb((e.target as HTMLInputElement).value);
              if (!srgb) return;
              const [nL, na, nb] = srgbToOklab(srgb);
              setEditingColor([nL, na, nb, active[3]]);
            }}
          />
        </label>

        <details class="gd-recent-disclosure">
          <summary class="gd-disclosure">Recent</summary>
          <div class="g-swatch-grid">
            ${recent.map(
              (c) => html`<button
                type="button"
                class="g-swatch"
                style="--swatch: ${swatchCss(c)}"
                aria-label="Recent colour"
                @click=${() => setEditingColor(c)}
              ></button>`,
            )}
          </div>
        </details>
      </div>
    `;
  },
};

function pickLc(e: PointerEvent, setLch: (l: number, c: number, h: number) => void, hue: number): void {
  const canvas = e.currentTarget as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  const c = x * MAX_C;
  const l = 1 - y;
  setLch(l, c, hue);
}
