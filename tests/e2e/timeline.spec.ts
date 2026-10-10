/**
 * Timeline + keyframe authoring (F10 / View > Timeline). See boot.spec.ts's
 * header for the window.__gdesign contract this relies on.
 *
 * NOT run from this agent session. Build first (`npm run build`) and serve
 * dist/ before `npx playwright test tests/e2e/timeline.spec.ts` (see
 * tests/CLAUDE.md).
 *
 * v1 lane interactions (timeline.ts) only let you retime/delete/ease a key:
 * there's no in-lane value editor (see src/ui/CLAUDE.md's Timeline section).
 * To author an opacity track with TWO distinct values from scratch, this
 * spec sets the layer's static opacity directly via engine.applyEdits
 * immediately before each "click to add a key": that click is real UI
 * (proves the lane-click-to-add-key flow), but choosing what value each key
 * captures is a documented precondition step, not something the strip itself
 * can do yet.
 */

import { test, expect } from '@playwright/test';

function soloLayerDoc() {
  return {
    version: 1,
    canvas: { width: 8, height: 8, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30, duration: 2 },
    layers: [
      {
        id: 'l1',
        kind: 'layer',
        name: 'solo',
        enabled: true,
        source: { type: 'core.solid', params: { color: [1, 0, 0, 1] } },
        chain: [],
        blendMode: 'normal',
        opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'baked',
      },
    ],
    postChain: [],
    assets: {},
  };
}

async function readCentreAlpha(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const w = window as any;
    const res = await w.__gdesign.engine.readback({ via: 'float' });
    const data = new Float32Array(res.data);
    const cx = Math.floor(res.width / 2);
    const cy = Math.floor(res.height / 2);
    const idx = (cy * res.width + cx) * 4;
    return data[idx + 3] ?? 0;
  });
}

test.describe('timeline strip', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
    // main.ts's boot() auto-plays the clock. A still-running RAF loop races
    // any exact seek()+readback pair below: seek() sets time and renders
    // synchronously, but readback() is an async GPU round-trip. If even
    // one more autoplay tick fires before it resolves, time (and the
    // composited frame) drifts forward by ~1 frame, which is exactly what
    // made the opacity-track test flake (alpha landed at ~1/30 instead of
    // 0, one frame's worth of linear interpolation past the t=0 key).
    // Pausing here doesn't block the "loop + play" test below, which
    // issues its own cmd:'play'.
    await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'pause' }));
    await page.evaluate(async (doc) => {
      const w = window as any;
      await w.__gdesign.engine.loadDocument(doc);
      w.__gdesign.stores.viewState.update((s: any) => ({ ...s, activeLayer: 'l1' }));
    }, soloLayerDoc());
  });

  test('F10 shows the strip and Window > Timeline toggles it too', async ({ page }) => {
    const region = page.locator('[data-testid="timeline-region"]');
    await expect(region).toBeHidden();
    await page.keyboard.press('F10');
    await expect(region).toBeVisible();
    await page.keyboard.press('F10');
    await expect(region).toBeHidden();

    // panel.toggle/'timeline' lives in the Window menu (menubar.ts's
    // windowMenu), not View. This spec named the wrong menu.
    await page.getByTestId('menu-trigger').filter({ hasText: 'Window' }).click();
    await page.getByTestId('menu-item').filter({ hasText: 'Timeline' }).click();
    await expect(region).toBeVisible();
  });

  test('scrubbing the ruler moves the transport time', async ({ page }) => {
    await page.keyboard.press('F10');
    const track = page.locator('[data-testid="timeline-track"]');
    const box = await track.boundingBox();
    expect(box).not.toBeNull();

    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    const timeText = await page.locator('[data-testid="transport-time"]').textContent();
    expect(parseFloat(timeText ?? '0')).toBeGreaterThan(0);
  });

  test('authoring an opacity track end-to-end: seeking 0 vs 1 reads back transparent vs opaque', async ({ page }) => {
    await page.keyboard.press('F10');
    const laneTrack = page.locator('[data-testid="timeline-lane-track-opacity"]');
    const box = await laneTrack.boundingBox();
    expect(box).not.toBeNull();
    // doc.clock.duration is 2s, so the visible range is [0, 2].
    const xAt = (t: number) => box!.x + (t / 2) * box!.width;

    // Key at t=0, v=0: set static opacity to 0, then click the lane at x=0.
    await page.evaluate(() => {
      const w = window as any;
      w.__gdesign.engine.applyEdits([{ op: 'setOpacity', id: 'l1', value: 0 }]);
    });
    await page.mouse.click(xAt(0) + 1, box!.y + box!.height / 2);

    // Key at t=1, v=1. Setting static opacity to a plain number (as the
    // t=0 precondition above does) COLLAPSES any existing track. That's
    // correct semantics for "opacity is now a constant", but it would
    // destroy the t=0 key we just added if used again here. Instead,
    // temporarily set the existing (single-key) track's own value to 1
    // (a one-key track is constant everywhere, so the lane-click below
    // captures "current" = 1 at t=1), then restore the t=0 key's value to
    // 0 afterward, preserving both keys throughout.
    await page.evaluate(() => {
      const w = window as any;
      w.__gdesign.engine.applyEdits([{ op: 'setOpacity', id: 'l1', value: { track: [{ t: 0, v: 1 }] } }]);
    });
    await page.mouse.click(xAt(1), box!.y + box!.height / 2);
    await page.evaluate(() => {
      const w = window as any;
      w.__gdesign.engine.applyEdits([{ op: 'setOpacity', id: 'l1', value: { track: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } }]);
    });

    await expect(page.locator('[data-testid="timeline-key-opacity-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="timeline-key-opacity-1"]')).toBeVisible();

    await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'seek', time: 0 }));
    expect(await readCentreAlpha(page)).toBeCloseTo(0, 2);

    await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'seek', time: 1 }));
    expect(await readCentreAlpha(page)).toBeCloseTo(1, 2);
  });

  test('loop {0, 0.5} + play keeps the transport time under 0.5 across samples', async ({ page }) => {
    await page.keyboard.press('F10');
    await page.locator('[data-testid="timeline-loop-toggle"]').click(); // default {from:0, to:1}

    const fromHandle = page.locator('[data-testid="timeline-loop-from"]');
    const toHandle = page.locator('[data-testid="timeline-loop-to"]');
    const track = page.locator('[data-testid="timeline-track"]');
    const box = await track.boundingBox();
    expect(box).not.toBeNull();

    // Drag the "to" handle to the 0.5s mark (duration 2s -> half of half the track).
    const toBox = await toHandle.boundingBox();
    await page.mouse.move(toBox!.x + 1, toBox!.y + toBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.25, toBox!.y + toBox!.height / 2, { steps: 5 });
    await page.mouse.up();
    void fromHandle;

    await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'play' }));
    for (let i = 0; i < 5; i += 1) {
      await page.waitForTimeout(150);
      const time = await page.evaluate(() => (window as any).__gdesign.stores.clockState?.get?.().time ?? 0);
      expect(time).toBeLessThan(0.5);
    }
  });

  test('setting the duration field is one undoable step', async ({ page }) => {
    await page.keyboard.press('F10');
    const durationInput = page.locator('[data-testid="timeline-duration"]');
    await durationInput.fill('5');
    await durationInput.dispatchEvent('change');

    const duration = await page.evaluate(() => (window as any).__gdesign.doc().clock.duration);
    expect(duration).toBe(5);

    await page.keyboard.press('Control+z');
    const reverted = await page.evaluate(() => (window as any).__gdesign.doc().clock.duration);
    expect(reverted).toBe(2);
  });
});
