import { test, expect } from '@playwright/test';

/**
 * SHAPES block: the richer scene shape kinds (polygon, star, rounded-rect)
 * plus the generic stroke ring, all rendered through core.scene's EXISTING
 * fill/stroke pipeline (scene.ts draws node.style.fill then node.style.stroke
 * as two separately-triangulated shape geometries, unchanged by this block;
 * only shapePath()'s new cases are new).
 *
 * Each test builds on loadScene()'s canvas (64x64, background [0.15,0,0,1];
 * see test-harness.ts's sceneDocument()) via one extra addObject, placed away
 * from loadScene()'s own rect (doc (10,10)-(30,25)) so the two never overlap.
 * Sample points below are hand-derived from the SAME formulas as
 * scene-geometry.ts's shapePath() (regular n-gon / alternating star radius /
 * quarter-circle corner fans). If that geometry ever changes, these
 * coordinates need updating too (same duplication tradeoff as
 * timeline-logic.ts's resolveTrackAt).
 */

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
  });
}

async function readFloat(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const r = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
  });
}

function pixelAt(float: { width: number; data: number[] }, x: number, y: number): number[] {
  const idx = (y * float.width + x) * 4;
  return float.data.slice(idx, idx + 4);
}

test.describe('SHAPES block: polygon / star / rounded-rect / stroke ring', () => {
  test('polygon: regular hexagon, centre reads fill, a bounding-box corner (outside the hexagon) reads background', async ({ page }) => {
    await ready(page);
    const ids = await page.evaluate(async () => window.__engineTest!.loadScene());

    await page.evaluate(({ layer }) => {
      window.__engineTest!.host.applyEdits([
        {
          op: 'addObject',
          layer: layer as unknown as never,
          parent: null,
          index: 1,
          object: {
            id: 'hex1' as unknown as never,
            name: 'Hexagon',
            enabled: true,
            content: { type: 'shape', shape: { shape: 'polygon', width: 16, height: 16, sides: 6 } },
            style: { fill: [0.5, 0.2, 0, 1] },
            liveness: 'live',
            transform: { x: 4, y: 36, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 },
          } as unknown as never,
        },
      ]);
    }, { layer: ids.layer });

    const float = await readFloat(page);

    // Box (4,36)-(20,52), centre (12,44), circumradius 8: well inside the hexagon.
    const inside = pixelAt(float, 12, 44);
    expect(inside[0]).toBeCloseTo(0.5, 1);

    // Bounding-box corner (5,37): distance from the hexagon's own centre
    // (8,8 local) is > 8 (the circumradius). Outside the hexagon, background.
    const outside = pixelAt(float, 5, 37);
    expect(outside[0]).toBeCloseTo(0.15, 1);
  });

  test('star: outer tip reads fill; the concave notch direction (beyond the inner radius) reads background (THE fan-triangulation check)', async ({ page }) => {
    await ready(page);
    const ids = await page.evaluate(async () => window.__engineTest!.loadScene());

    await page.evaluate(({ layer }) => {
      window.__engineTest!.host.applyEdits([
        {
          op: 'addObject',
          layer: layer as unknown as never,
          parent: null,
          index: 1,
          object: {
            id: 'star1' as unknown as never,
            name: 'Star',
            enabled: true,
            content: { type: 'shape', shape: { shape: 'star', width: 24, height: 24, starPoints: 5, innerRatio: 0.5 } },
            style: { fill: [0.4, 0, 0.2, 1] },
            liveness: 'live',
            transform: { x: 36, y: 36, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 },
          } as unknown as never,
        },
      ]);
    }, { layer: ids.layer });

    const float = await readFloat(page);

    // Box (36,36)-(60,60), local centre (12,12), outer radius 12, inner 6.
    // Outer tip points straight up (-90deg): a point 80% of the way out
    // along that SAME ray (local (12, 2.4)) sits on the shared edge between
    // the tip's two triangles, inside the fill.
    const tip = pixelAt(float, 48, 38);
    expect(tip[0]).toBeCloseTo(0.4, 1);

    // The first notch sits at -54deg, r=6 (inner radius). A point further
    // OUT along that exact ray (r=9, still < outer radius 12) is beyond
    // where either adjacent triangle reaches along that ray (both terminate
    // at the notch, r=6). This is the concave cut; must read background,
    // not fill. A vertex-0 boundary fan (the bug this test guards against)
    // would instead treat this point as inside one of the mis-triangulated
    // fan wedges.
    const notch = pixelAt(float, 53, 41);
    expect(notch[0]).toBeCloseTo(0.15, 1);
  });

  test('rounded-rect: interior reads fill, a box corner beyond the radius arc reads background', async ({ page }) => {
    await ready(page);
    const ids = await page.evaluate(async () => window.__engineTest!.loadScene());

    await page.evaluate(({ layer }) => {
      window.__engineTest!.host.applyEdits([
        {
          op: 'addObject',
          layer: layer as unknown as never,
          parent: null,
          index: 1,
          object: {
            id: 'rr1' as unknown as never,
            name: 'Rounded Rect',
            enabled: true,
            content: { type: 'shape', shape: { shape: 'rounded-rect', width: 20, height: 12, radius: 4 } },
            style: { fill: [0.3, 0.1, 0.1, 1] },
            liveness: 'live',
            transform: { x: 4, y: 4, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 },
          } as unknown as never,
        },
      ]);
    }, { layer: ids.layer });

    const float = await readFloat(page);

    // Box (4,4)-(24,16): well inside, away from any corner arc.
    const inside = pixelAt(float, 14, 10);
    expect(inside[0]).toBeCloseTo(0.3, 1);

    // The literal box corner: rasterisation samples at PIXEL CENTRES, so
    // pixel (5,5)'s centre is local (1.5,1.5). Distance to the top-left
    // arc centre (4,4) is ~3.54 < radius 4, i.e. correctly INSIDE the
    // rounded corner (the first draft asserted background there and was
    // wrong). Pixel (4,4)'s centre is local (0.5,0.5), distance ~4.95 > 4:
    // genuinely outside the arc, reads background.
    const corner = pixelAt(float, 4, 4);
    expect(corner[0]).toBeCloseTo(0.15, 1);
  });

  test('stroke ring: a point on the ring reads stroke colour, the centre reads fill (fill != stroke)', async ({ page }) => {
    await ready(page);
    const ids = await page.evaluate(async () => window.__engineTest!.loadScene());

    await page.evaluate(({ layer }) => {
      window.__engineTest!.host.applyEdits([
        {
          op: 'addObject',
          layer: layer as unknown as never,
          parent: null,
          index: 1,
          object: {
            id: 'ring1' as unknown as never,
            name: 'Ring Rect',
            enabled: true,
            content: { type: 'shape', shape: { shape: 'rect', width: 20, height: 20 } },
            style: { fill: [0.5, 0, 0, 1], stroke: [0.9, 0, 0, 1], strokeWidth: 6 },
            liveness: 'live',
            transform: { x: 4, y: 40, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 },
          } as unknown as never,
        },
      ]);
    }, { layer: ids.layer });

    const float = await readFloat(page);

    // Box (4,40)-(24,60). Stroke (width 6, centred on the edge) spans
    // doc x in [1,7] along the left edge: (4,50) sits in the middle of
    // that band.
    const ring = pixelAt(float, 4, 50);
    expect(ring[0]).toBeCloseTo(0.9, 1);

    // Centre (14,50) is 10px from the nearest edge, well past the 3px
    // stroke half-width, reads the fill instead.
    const centre = pixelAt(float, 14, 50);
    expect(centre[0]).toBeCloseTo(0.5, 1);
  });
});
