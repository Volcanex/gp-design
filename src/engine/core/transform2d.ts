/**
 * Pure 2D affine math for ObjectNode.transform + its content box. DOM-free,
 * GPU-free, shared verbatim between the scene source's render()/hitTest()
 * (own-pipeline WGSL mirrors the same formula, see scene-transform-uniform.ts)
 * and the UI's selection overlay (object-bounds.ts), so "where is this
 * object on screen" only has one implementation.
 *
 * Convention: `transform.x/y` is the DOC-SPACE position of the anchor point
 * (anchorX/anchorY as a 0..1 fraction of the content box), not a pre-anchor
 * offset, i.e. with scale=1/rotation=0, the anchor point of the content box
 * sits exactly at (x, y). Order: translate content so anchor is at the
 * origin, scale, rotate, then move the anchor to (x, y).
 */

import type { AssetJSON, ObjectContent } from '../doc/json';
import type { AssetId, Transform2D } from './types';

export interface ContentBox {
  width: number;
  height: number;
}

export interface ContentBoxOptions {
  getAsset?: (id: AssetId) => AssetJSON | undefined;
}

/** Fallback for text objects: no font metrics available outside the loaded
 * MSDF atlas, so this is a deliberate approximation (avg glyph advance ~0.55
 * em, single-line height ~1.2 em), good enough for hit-test boxes and the
 * selection overlay, not for pixel-exact glyph bounds. */
function approxTextBox(text: string, size: number): ContentBox {
  return { width: Math.max(1, text.length * size * 0.55), height: size * 1.2 };
}

const PLACEHOLDER_BOX: ContentBox = { width: 200, height: 150 };
const FALLBACK_IMAGE_BOX: ContentBox = { width: 100, height: 100 };

export function contentBoxOf(content: ObjectContent, opts: ContentBoxOptions = {}): ContentBox {
  switch (content.type) {
    case 'shape':
      return { width: content.shape.width, height: content.shape.height };
    case 'text':
      return approxTextBox(content.text.text, content.text.size);
    case 'image': {
      const asset = opts.getAsset?.(content.asset);
      if (asset && asset.type === 'image') return { width: asset.width, height: asset.height };
      return FALLBACK_IMAGE_BOX;
    }
    case 'document':
    case 'live':
      return PLACEHOLDER_BOX;
    default: {
      const _exhaustive: never = content;
      return _exhaustive;
    }
  }
}

function anchorPx(transform: Transform2D, box: ContentBox): [number, number] {
  return [transform.anchorX * box.width, transform.anchorY * box.height];
}

/** Local content-space point -> doc-space point. */
export function applyTransform(p: readonly [number, number], transform: Transform2D, box: ContentBox): [number, number] {
  const [ax, ay] = anchorPx(transform, box);
  const relX = (p[0] - ax) * transform.scaleX;
  const relY = (p[1] - ay) * transform.scaleY;
  const c = Math.cos(transform.rotation);
  const s = Math.sin(transform.rotation);
  const rotX = relX * c - relY * s;
  const rotY = relX * s + relY * c;
  return [rotX + transform.x, rotY + transform.y];
}

/** Doc-space point -> local content-space point (inverse of applyTransform). */
export function inverseTransform(p: readonly [number, number], transform: Transform2D, box: ContentBox): [number, number] {
  const [ax, ay] = anchorPx(transform, box);
  const relX = p[0] - transform.x;
  const relY = p[1] - transform.y;
  const c = Math.cos(-transform.rotation);
  const s = Math.sin(-transform.rotation);
  const rotX = relX * c - relY * s;
  const rotY = relX * s + relY * c;
  const sx = transform.scaleX === 0 ? 1e-6 : transform.scaleX;
  const sy = transform.scaleY === 0 ? 1e-6 : transform.scaleY;
  return [rotX / sx + ax, rotY / sy + ay];
}

/** The four content-box corners in doc space, in order TL, TR, BR, BL. */
export function transformedCorners(transform: Transform2D, box: ContentBox): [number, number][] {
  const local: [number, number][] = [[0, 0], [box.width, 0], [box.width, box.height], [0, box.height]];
  return local.map((p) => applyTransform(p, transform, box));
}

/** True if doc-space point `p` lands inside the object's content box. */
export function hitTestBox(p: readonly [number, number], transform: Transform2D, box: ContentBox): boolean {
  const [lx, ly] = inverseTransform(p, transform, box);
  return lx >= 0 && lx <= box.width && ly >= 0 && ly <= box.height;
}
