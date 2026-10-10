import { test, expect } from '@playwright/test';

/**
 * Gold tests for the FX-DISTORT block (wave, twirl, kaleidoscope,
 * tile-mirror, chromatic-aberration, sharpen, glow).
 *
 * Source fixture: a solid black background layer + a core.scene layer
 * holding one or more white rect objects (see scene.spec.ts's
 * `sceneDocument` for the same pattern), NOT core.gradient. core.gradient
 * was tried first but its PassDescriptor uses `from`/`to` as WGSL param
 * names, both reserved WGSL keywords (see repo CLAUDE.md's `type`/`target`
 * gotcha, which this same bug class hits). The shader silently fails to
 * compile and renders solid black, which is a shared, cross-cutting bug in
 * src/engine/sources/builtin/gradient.ts (also breaks blur.spec.ts and
 * fx-stylize.spec.ts), out of this block's ownership/scope to fix here.
 * The effect under test is always run via document postChain (not a
 * per-layer chain) since the composited two-layer source is what needs
 * distorting, not either layer alone.
 */

const SIZE = 64;

function toPixel(uv: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.round(uv * size - 0.5)));
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: readonly [number, number, number, number];
}

function sceneDoc(rects: Rect[], postChain: Array<{ id: string; pass: string; params: Record<string, unknown>; enabled: boolean }>) {
  return {
    version: 1,
    canvas: { width: SIZE, height: SIZE, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [
      {
        id: 'bg',
        kind: 'layer',
        name: 'Background',
        enabled: true,
        source: { type: 'core.solid', params: { color: [0, 0, 0, 1] } },
        chain: [],
        blendMode: 'normal',
        opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'live',
      },
      {
        id: 'scene1',
        kind: 'layer',
        name: 'Scene',
        enabled: true,
        source: {
          type: 'core.scene',
          params: {
            scene: rects.map((r, i) => ({
              id: `rect${i}`,
              name: `Rect${i}`,
              enabled: true,
              transform: { x: r.x, y: r.y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 },
              content: { type: 'shape', shape: { shape: 'rect', width: r.width, height: r.height } },
              style: { fill: r.fill ?? [1, 0, 0, 1] },
              liveness: 'live',
            })),
          },
        },
        chain: [],
        blendMode: 'normal',
        opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'live',
      },
    ],
    postChain,
    assets: {},
  };
}

/** White right half (uv.x >= 0.5), black left half: the step edge most tests key off. */
const RIGHT_HALF: Rect[] = [{ x: SIZE / 2, y: 0, width: SIZE / 2, height: SIZE }];

async function readFull(page: import('@playwright/test').Page) {
  const r = await page.evaluate(async () => {
    const res = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: res.width, height: res.height, data: Array.from(new Float32Array(res.data)) };
  });
  return {
    width: r.width,
    height: r.height,
    at(px: number, py: number) {
      const idx = (py * r.width + px) * 4;
      return r.data.slice(idx, idx + 4);
    },
  };
}

async function load(page: import('@playwright/test').Page, d: unknown) {
  await page.evaluate(async (doc) => {
    await window.__engineTest!.host.loadDocument(doc as never);
  }, d);
}

test.describe('FX-DISTORT gold', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
  });

  test('core.wave: wave mode at t=0 displaces uv.x by ampX*sin(uv.y*frequency)', async ({ page }) => {
    // Sample column x=28 (uv~0.445, left of the step edge at uv.x=0.5 -> black
    // baseline). frequency=pi and row y=32 (uv~0.508, sin(uv.y*pi)~1) so the
    // displacement is ~ampX=0.15, pushing the sample past the edge into the
    // white right half: a binary crossing, not a continuous-value match, so
    // it tolerates any edge antialiasing at the boundary itself.
    const px = 28;
    const py = 32;

    await load(page, sceneDoc(RIGHT_HALF, []));
    const base = await readFull(page);
    const baseline = base.at(px, py);

    await load(
      page,
      sceneDoc(RIGHT_HALF, [
        {
          id: 'fx1',
          pass: 'core.wave',
          params: { ampX: 0.15, ampY: 0, frequency: Math.PI, speed: 0, mode: 'wave', center: [0.5, 0.5] },
          enabled: true,
        },
      ]),
    );
    const waved = await readFull(page);
    const displaced = waved.at(px, py);

    expect(baseline[0]).toBeCloseTo(0, 1);
    expect(displaced[0]).toBeCloseTo(1, 1);
  });

  test('core.twirl: pixel inside radius crosses the step edge, corner outside radius matches baseline', async ({
    page,
  }) => {
    const baselineDoc = sceneDoc(RIGHT_HALF, []);
    const twirledDoc = sceneDoc(RIGHT_HALF, [
      { id: 'fx1', pass: 'core.twirl', params: { angle: 3.0, radius: 0.25, center: [0.5, 0.5] }, enabled: true },
    ]);

    await load(page, baselineDoc);
    const base = await readFull(page);
    const insideBase = base.at(33, 32);
    const cornerBase = base.at(2, 2);

    await load(page, twirledDoc);
    const twirled = await readFull(page);
    const insideTwirled = twirled.at(33, 32);
    const cornerTwirled = twirled.at(2, 2);

    // (33,32) is on the white side, close enough to center (dist ~0.02 uv,
    // well inside radius 0.25) that the near-max rotation there swings it
    // across the vertical edge back onto the black side (verified empirically:
    // nearby columns land right at the edge and pick up bilinear blending,
    // so this column was chosen for a clean, fully-crossed sample).
    expect(insideBase[0]).toBeCloseTo(1, 1);
    expect(insideTwirled[0]).toBeCloseTo(0, 1);
    // (2,2) is far outside radius 0.25 -> identity branch -> unchanged.
    expect(cornerTwirled[0]).toBeCloseTo(cornerBase[0]!, 2);
  });

  test('core.kaleidoscope: segments=4 mirror-symmetric points sample equal', async ({ page }) => {
    // wedge = 2*pi/4 = pi/2; a0 and (wedge - a0) fold to the same uv. Uses a
    // small dot at a0's own position (not a half-plane) so an unfolded
    // (broken) reading at a1's raw position would clearly miss the dot and
    // read black instead. A half-plane source can't discriminate here
    // because a0/a1 are mirror images about the wedge's own bisector.
    const a0 = Math.PI / 8;
    const wedge = Math.PI / 2;
    const a1 = wedge - a0;
    const r = 0.2;
    const cx = 0.5;
    const cy = 0.5;
    const dotX = cx + r * Math.cos(a0);
    const dotY = cy + r * Math.sin(a0);
    const dot: Rect[] = [{ x: dotX * SIZE - 4, y: dotY * SIZE - 4, width: 8, height: 8 }];

    await load(
      page,
      sceneDoc(dot, [
        { id: 'fx1', pass: 'core.kaleidoscope', params: { segments: 4, rotation: 0, center: [cx, cy] }, enabled: true },
      ]),
    );
    const res = await readFull(page);
    const pA = res.at(toPixel(dotX, res.width), toPixel(dotY, res.height));
    const pB = res.at(
      toPixel(cx + r * Math.cos(a1), res.width),
      toPixel(cy + r * Math.sin(a1), res.height),
    );

    expect(pA[0]).toBeGreaterThan(0.5); // sanity: a0 (no fold needed) hits the dot
    expect(pB[0]).toBeCloseTo(pA[0]!, 1);
  });

  test('core.tile-mirror: tile mode count=2 folds two points to the same source sample', async ({ page }) => {
    // p = uv*count; mirror_repeat gives an ascending ramp on p in [0,1) and a
    // descending mirror on p in [1,2). uv=0.2 (p=0.4) and uv=0.8 (p=1.6, folds
    // to 2-1.6=0.4) land on the SAME transformed x=0.4 < 0.5 -> both should
    // read the step edge's black side, even though uv=0.2 and uv=0.8 read
    // opposite sides (black vs white) with no tiling applied at all. That
    // pre-fold divergence is what makes the post-fold equality meaningful.
    await load(
      page,
      sceneDoc(RIGHT_HALF, [
        { id: 'fx1', pass: 'core.tile-mirror', params: { mode: 'tile', count: 2, offset: [0, 0] }, enabled: true },
      ]),
    );
    const res = await readFull(page);
    const p1 = res.at(toPixel(0.2, res.width), toPixel(0.5, res.height));
    const p2 = res.at(toPixel(0.8, res.width), toPixel(0.5, res.height));

    expect(p1[0]).toBeCloseTo(0, 1);
    expect(p2[0]).toBeCloseTo(0, 1);
  });

  test('core.chromatic-aberration: amount=0 matches baseline, amount>0 diverges channels at an edge', async ({
    page,
  }) => {
    const baselineDoc = sceneDoc(RIGHT_HALF, []);
    await load(page, baselineDoc);
    const base = await readFull(page);
    const baseEdge = base.at(32, 32);

    const zeroDoc = sceneDoc(RIGHT_HALF, [
      {
        id: 'fx1',
        pass: 'core.chromatic-aberration',
        params: { amount: 0, center: [0, 0.5], falloff: 1 },
        enabled: true,
      },
    ]);
    await load(page, zeroDoc);
    const zeroRes = await readFull(page);
    const zeroEdge = zeroRes.at(32, 32);
    expect(zeroEdge[0]).toBeCloseTo(baseEdge[0]!, 2);
    expect(zeroEdge[2]).toBeCloseTo(baseEdge[2]!, 2);

    // center is far to the left of the sample point (dist ~0.51 uv), so the
    // r/b radial offsets there are large enough (~0.08 uv, ~5px) to pull one
    // channel's sample across the step edge while the other stays put.
    const nonzeroDoc = sceneDoc(RIGHT_HALF, [
      {
        id: 'fx1',
        pass: 'core.chromatic-aberration',
        params: { amount: 10, center: [0, 0.5], falloff: 1 },
        enabled: true,
      },
    ]);
    await load(page, nonzeroDoc);
    const nzRes = await readFull(page);
    const nzEdge = nzRes.at(32, 32);
    expect(Math.abs(nzEdge[0]! - nzEdge[2]!)).toBeGreaterThan(0.5);
  });

  test('core.sharpen: overshoots beyond both plateaus on a step edge', async ({ page }) => {
    await load(
      page,
      sceneDoc(RIGHT_HALF, [
        { id: 'fx1', pass: 'core.sharpen', params: { amount: 2, radius: 1, lumaOnly: true }, enabled: true },
      ]),
    );
    const res = await readFull(page);
    // Pixel columns adjacent to the edge at x=32: 31 (black side) and
    // 32 (white side) each have the tent kernel straddling the edge, so
    // their local blur is pulled toward the opposite plateau and the
    // src-blur diff, scaled by amount, overshoots past 0/1.
    const justBeforeEdge = res.at(31, 32);
    const justAfterEdge = res.at(32, 32);

    expect(justBeforeEdge[0]).toBeLessThan(0);
    expect(justAfterEdge[0]).toBeGreaterThan(1);
  });

  test('core.glow: dark pixel adjacent to a bright thresholded region gains L vs baseline', async ({ page }) => {
    const baselineDoc = sceneDoc(RIGHT_HALF, []);
    await load(page, baselineDoc);
    const base = await readFull(page);
    const darkBase = base.at(25, 32);

    const glowedDoc = sceneDoc(RIGHT_HALF, [
      { id: 'fx1', pass: 'core.glow', params: { threshold: 0.7, radius: 12, intensity: 2 }, enabled: true },
    ]);
    await load(page, glowedDoc);
    const res = await readFull(page);
    const darkGlowed = res.at(25, 32);

    expect(darkGlowed[0]).toBeGreaterThan(darkBase[0]!);
  });
});
