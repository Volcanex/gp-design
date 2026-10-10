import { describe, it, expect } from 'vitest';
import {
  contentBoxOf, applyTransform, inverseTransform, transformedCorners, hitTestBox,
} from '../../src/engine/core/transform2d';
import { identityTransform } from '../../src/engine/core/types';
import type { Transform2D } from '../../src/engine/core/types';
import type { ObjectContent } from '../../src/engine/doc/json';
import { assetId } from '../../src/engine/core/types';

describe('contentBoxOf', () => {
  it('shape: uses the ShapeSpec width/height directly', () => {
    const content: ObjectContent = { type: 'shape', shape: { shape: 'rect', width: 120, height: 40 } };
    expect(contentBoxOf(content)).toEqual({ width: 120, height: 40 });
  });

  it('image: looks up the asset dimensions via getAsset', () => {
    const id = assetId('img1');
    const content: ObjectContent = { type: 'image', asset: id };
    const box = contentBoxOf(content, {
      getAsset: () => ({ type: 'image', mime: 'image/png', data: new ArrayBuffer(0), width: 300, height: 200 }),
    });
    expect(box).toEqual({ width: 300, height: 200 });
  });

  it('image: falls back to a fixed box when the asset is missing', () => {
    const content: ObjectContent = { type: 'image', asset: assetId('missing') };
    expect(contentBoxOf(content)).toEqual({ width: 100, height: 100 });
  });

  it('document/live: fixed placeholder box', () => {
    expect(contentBoxOf({ type: 'live', component: 'x' })).toEqual({ width: 200, height: 150 });
  });
});

describe('applyTransform / inverseTransform', () => {
  const box = { width: 100, height: 50 };

  it('identity transform (anchor at 0,0 offset by x/y) maps local -> doc by simple translation', () => {
    const t: Transform2D = { ...identityTransform(), anchorX: 0, anchorY: 0, x: 10, y: 20 };
    expect(applyTransform([0, 0], t, box)).toEqual([10, 20]);
    expect(applyTransform([100, 50], t, box)).toEqual([110, 70]);
  });

  it('inverseTransform undoes applyTransform for an arbitrary transform', () => {
    const t: Transform2D = { x: 50, y: -30, rotation: 0.7, scaleX: 1.5, scaleY: 0.8, anchorX: 0.5, anchorY: 0.5 };
    const local: [number, number] = [37, 12];
    const doc = applyTransform(local, t, box);
    const back = inverseTransform(doc, t, box);
    expect(back[0]).toBeCloseTo(local[0]);
    expect(back[1]).toBeCloseTo(local[1]);
  });

  it('the anchor point always maps to (x, y) in doc space regardless of scale/rotation', () => {
    const t: Transform2D = { x: 5, y: 5, rotation: 1.2, scaleX: 3, scaleY: 0.4, anchorX: 0.5, anchorY: 0.5 };
    const anchorLocal: [number, number] = [box.width * t.anchorX, box.height * t.anchorY];
    const doc = applyTransform(anchorLocal, t, box);
    expect(doc[0]).toBeCloseTo(5);
    expect(doc[1]).toBeCloseTo(5);
  });
});

describe('transformedCorners', () => {
  it('identity-ish transform yields the box corners offset by x/y', () => {
    const t: Transform2D = { ...identityTransform(), anchorX: 0, anchorY: 0, x: 0, y: 0 };
    const box = { width: 20, height: 10 };
    expect(transformedCorners(t, box)).toEqual([[0, 0], [20, 0], [20, 10], [0, 10]]);
  });
});

describe('hitTestBox', () => {
  const box = { width: 100, height: 50 };
  const t: Transform2D = { x: 100, y: 100, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 };

  it('point inside the (translated) box hits', () => {
    expect(hitTestBox([90, 90], t, box)).toBe(true);
  });

  it('point outside the box misses', () => {
    expect(hitTestBox([0, 0], t, box)).toBe(false);
  });

  it('rotation is respected: a corner point rotates out of the box', () => {
    const rotated: Transform2D = { ...t, rotation: Math.PI / 4 };
    // The un-rotated box's top-left corner in doc space would be (50,75);
    // after 45deg rotation about the centre that point moves elsewhere.
    expect(hitTestBox([50, 75], rotated, box)).toBe(false);
    expect(hitTestBox([100, 100], rotated, box)).toBe(true); // centre still hits
  });
});
