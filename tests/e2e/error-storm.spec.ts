/** Contract: see tests/e2e/boot.spec.ts header, plus the __gdesign.debug
 * hook documented in tests/CLAUDE.md. Exercises localHost.ts's
 * MAX_CONSECUTIVE_FAILURES cutoff without needing a real GPU fault. */

import { test, expect } from '@playwright/test';
import { bootAndPause } from './lib/boot';

test('an error storm halts the transport within 40 frames, shows one fatal banner, refuses further play, and does not leak GPU memory', async ({ page }) => {
  await bootAndPause(page);

  const result = await page.evaluate(async () => {
    const gd = (window as any).__gdesign;

    let clockEvents = 0;
    let frameEvents = 0;
    let fatalErrors = 0;
    gd.engine.on('clock', () => { clockEvents += 1; });
    gd.engine.on('frame', () => { frameEvents += 1; });
    gd.engine.on('error', (e: any) => { if (e.fatal) fatalErrors += 1; });

    const bytesBefore = gd.engine.memoryStats()?.bytes ?? 0;

    gd.debug.failFrames(1000); // far more than MAX_CONSECUTIVE_FAILURES
    gd.engine.setClock({ cmd: 'play' });

    // MAX_CONSECUTIVE_FAILURES=30 at 30fps is ~1s; give it generous margin.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const clockEventsAtStop = clockEvents;
    const frameEventsAtStop = frameEvents;

    gd.engine.setClock({ cmd: 'play' }); // must be refused: fatal was set
    await new Promise((resolve) => setTimeout(resolve, 500));

    const bytesAfter = gd.engine.memoryStats()?.bytes ?? 0;

    return {
      fatalErrors,
      clockEventsAtStop,
      frameEventsAtStop,
      clockGrewAfterRefusedPlay: clockEvents > clockEventsAtStop,
      frameGrewAfterRefusedPlay: frameEvents > frameEventsAtStop,
      bytesBefore,
      bytesAfter,
    };
  });

  expect(result.fatalErrors).toBe(1);
  expect(result.frameEventsAtStop).toBe(0); // every attempted frame failed
  expect(result.clockEventsAtStop).toBeLessThanOrEqual(40);
  expect(result.clockGrewAfterRefusedPlay).toBe(false);
  expect(result.frameGrewAfterRefusedPlay).toBe(false);
  expect(result.bytesAfter).toBeLessThanOrEqual(result.bytesBefore);

  await expect(page.locator('[data-testid="fatal-banner"]')).toHaveCount(1);
});
