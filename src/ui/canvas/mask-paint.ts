/**
 * MASKS block. CPU-side mask painting: brush/pencil/eraser strokes at MASK
 * EDIT MODE (viewState.maskEditing, routed here by paint-layer.ts's
 * resolveStrokeTarget) land on a mask raster asset instead of a layer's own
 * GPU-backed raster source. A mask isn't a real Layer, so it can't go
 * through the frozen StrokeConfig/beginStroke/EngineHost path (which
 * requires an actual core.raster LAYER, see localHost.ts's beginStroke
 * guard) without an unauthorized third diff to those FROZEN CONTRACT files;
 * this instead mirrors that pipeline's shape (round-brush capsule stamps,
 * one commit per stroke, one undo entry) directly on the asset's CPU bytes.
 *
 * Live preview works without any GPU stroke instance: this mutates
 * doc.assets[id].data in place during the drag (same "commitRaster mutates
 * asset bytes in place" idiom document.ts already relies on), and
 * core/engine.ts's mask texture cache re-uploads when told to via
 * engine.invalidateAsset(id) (a byte-sampling signature was tried and could
 * never see a localized stamp), so invalidateAsset + requestFrame after
 * each stamp shows the edit. The eventual history entry is a plain uiCommand (not a DocEdit
 * batch) whose run()/undo() just re-write the captured post-/pre-stroke
 * bytes: run() at push time is a no-op (the bytes are already there from
 * the live mutation) but redo() needs it to be idempotent-safe, exactly the
 * way it's written.
 */

import type { AppCtx } from '../../app/types';
import type { AssetJSON } from '@engine';
import { viewState } from '../../app/stores';
import { history } from '../../app/commands/app-history';
import { uiCommand } from '../../app/commands/command';

type RasterAsset = Extract<AssetJSON, { type: 'raster' }>;

/** IEEE 754 single -> half precision. Paired with core/engine's f16ToF32-style
 * decode below. Both are small, self-contained (not imported from
 * gpu/readback.ts, which only decodes) rather than reused across the
 * engine/UI boundary for a handful of lines. */
function f32ToF16(val: number): number {
  const f32 = new Float32Array(1);
  const i32 = new Int32Array(f32.buffer);
  f32[0] = val;
  const x = i32[0]!;
  const sign = (x >> 16) & 0x8000;
  const exp = ((x >> 23) & 0xff) - 127 + 15;
  const mantissa = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    const m = mantissa | 0x800000;
    const shift = 14 - exp;
    return sign | (m >> shift);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mantissa >> 13);
}

function f16ToF32(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const F16_ONE = 0x3c00;

/** Builds a mask asset's initial bytes: OPAQUE WHITE everywhere (L=1, a=0,
 * b=0, alpha=1), an all-keep mask, so adding one never changes the layer's
 * current appearance until the user paints on it. */
export function whiteMaskBytes(width: number, height: number): ArrayBuffer {
  const buf = new ArrayBuffer(width * height * 8);
  const view = new Uint16Array(buf);
  for (let i = 0; i < width * height; i++) {
    view[i * 4] = F16_ONE;
    view[i * 4 + 1] = 0;
    view[i * 4 + 2] = 0;
    view[i * 4 + 3] = F16_ONE;
  }
  return buf;
}

interface MaskStroke {
  asset: string;
  before: ArrayBuffer;
  last: { x: number; y: number } | null;
}

let active: MaskStroke | null = null;

export function beginMaskStroke(app: AppCtx, assetId: string): void {
  const doc = app.engine.getDocument();
  const asset = doc.assets[assetId];
  active = asset && asset.type === 'raster' ? { asset: assetId, before: asset.data.slice(0), last: null } : null;
}

/** Stamps a capsule segment from the stroke's last point (or a single dot at
 * `pt`, for the first point) into the mask asset's live bytes. Coverage math
 * mirrors sources/builtin/raster.ts's rasterStampPass (round falloff via the
 * same smoothstep band) but evaluated on the CPU. See module header for
 * why there's no GPU raster instance to reuse for a mask. `color`'s L
 * component is the value painted in ('erase' scales the mask's alpha down
 * instead, matching the raster stamp pass's own paint/erase split): "paint
 * white to reveal, black to hide" is just which L the user's current brush
 * colour happens to carry. */
export function maskStrokePoint(
  app: AppCtx,
  pt: { x: number; y: number },
  size: number,
  color: readonly [number, number, number, number],
  erase: boolean,
): void {
  if (!active) return;
  const doc = app.engine.getDocument();
  const asset = doc.assets[active.asset];
  if (!asset || asset.type !== 'raster') return;
  const a = active.last ?? pt;
  active.last = pt;
  stampCapsule(asset, a, pt, size, color, erase);
  // In-place mutation is invisible to the engine. Tell it to re-upload the
  // mask texture before rendering (see EngineHost.invalidateAsset).
  app.engine.invalidateAsset(active.asset);
  app.engine.requestFrame();
}

function stampCapsule(
  asset: RasterAsset,
  a: { x: number; y: number },
  b: { x: number; y: number },
  size: number,
  color: readonly [number, number, number, number],
  erase: boolean,
): void {
  const { width, height, data } = asset;
  const view = new Uint16Array(data);
  const r = Math.max(size * 0.5, 0.5);
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - r - 1));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + r + 1));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - r - 1));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + r + 1));
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abLenSq = Math.max(abx * abx + aby * aby, 1e-6);
  const targetL = color[0];

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const pax = x + 0.5 - a.x;
      const pay = y + 0.5 - a.y;
      const t = Math.min(1, Math.max(0, (pax * abx + pay * aby) / abLenSq));
      const dx = pax - abx * t;
      const dy = pay - aby * t;
      const d = Math.hypot(dx, dy);
      const coverage = 1 - smoothstep(r - 1, r + 1, d);
      if (coverage <= 0) continue;
      const i = (y * width + x) * 4;
      if (erase) {
        const alpha = f16ToF32(view[i + 3]!);
        view[i + 3] = f32ToF16(alpha * (1 - coverage));
      } else {
        const oldL = f16ToF32(view[i]!);
        view[i] = f32ToF16(oldL + (targetL - oldL) * coverage);
        view[i + 1] = 0;
        view[i + 2] = 0;
        view[i + 3] = F16_ONE;
      }
    }
  }
}

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  return true;
}

/** Ends the in-progress mask stroke and pushes ONE history entry (a plain
 * uiCommand, not a DocEdit batch, see module header). No-ops (no history
 * entry) if nothing actually changed, e.g. a stray click whose stamp
 * rounded to zero coverage. */
export function commitMaskStroke(app: AppCtx, label: string): void {
  if (!active) return;
  const { asset: assetId, before } = active;
  active = null;
  const doc = app.engine.getDocument();
  const asset = doc.assets[assetId];
  if (!asset || asset.type !== 'raster') return;
  const after = asset.data.slice(0);
  if (bytesEqual(before, after)) return;

  history.push(app, uiCommand(
    label,
    (a) => {
      const target = a.engine.getDocument().assets[assetId];
      if (target && target.type === 'raster') new Uint8Array(target.data).set(new Uint8Array(after));
      a.engine.invalidateAsset(assetId);
      a.engine.requestFrame();
    },
    (a) => {
      const target = a.engine.getDocument().assets[assetId];
      if (target && target.type === 'raster') new Uint8Array(target.data).set(new Uint8Array(before));
      a.engine.invalidateAsset(assetId);
      a.engine.requestFrame();
    },
  ));
}

/**
 * Escape exits MASK EDIT MODE before anything else Escape currently does
 * (dialog-shell, layer rename, menubar close, marquee deselect, …). Each of
 * those installs its own independent 'keydown' listener, so the only way to
 * guarantee this one runs first (and stops there) is a capture-phase
 * listener that stops propagation once it has handled the exit. Installed
 * once at boot (see app/main.ts).
 */
export function installMaskEscapeGuard(): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (viewState.get().maskEditing === null) return;
    e.preventDefault();
    e.stopPropagation();
    viewState.update((s) => ({ ...s, maskEditing: null }));
  };
  window.addEventListener('keydown', handler, true);
  return () => window.removeEventListener('keydown', handler, true);
}
