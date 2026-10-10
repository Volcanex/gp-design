/** Contract: see tests/e2e/boot.spec.ts header. Exercises the crash guards
 * added in localHost.ts's emit / store.ts's set / main.ts's global error
 * handlers directly, from inside the running app. */

import { test, expect } from '@playwright/test';
import { bootAndPause } from './lib/boot';
import { watchConsole } from './lib/console';

test('a throwing frame listener and a throwing store subscriber do not stop others or freeze the engine', async ({ page }) => {
  const consoleWatcher = watchConsole(page);
  await bootAndPause(page);

  const result = await page.evaluate(async () => {
    const gd = (window as any).__gdesign;

    let healthyFrames = 0;
    gd.engine.on('frame', () => {
      throw new Error('resilience.spec: synthetic frame-listener throw');
    });
    gd.engine.on('frame', () => {
      healthyFrames += 1;
    });

    let healthyViewUpdates = 0;
    gd.stores.viewState.subscribe(() => {
      throw new Error('resilience.spec: synthetic store-subscriber throw');
    });
    gd.stores.viewState.subscribe(() => {
      healthyViewUpdates += 1;
    });
    // Fires both viewState subscribers exactly once. Read the healthy one's
    // count right away: layer.new below also touches viewState
    // (activeLayer), which would otherwise inflate this.
    gd.stores.viewState.update((s: any) => ({ ...s, zoom: s.zoom + 0.0001 }));
    const healthyViewUpdatesAfterTrigger = healthyViewUpdates;

    const before = gd.doc().layers.length;

    gd.engine.setClock({ cmd: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 800)); // ~20+ frames at 30fps
    gd.engine.setClock({ cmd: 'pause' });

    gd.exec('layer.new');
    const afterAdd = gd.doc().layers.length;
    gd.exec('edit.undo');
    const afterUndo = gd.doc().layers.length;

    return { healthyFrames, healthyViewUpdatesAfterTrigger, before, afterAdd, afterUndo };
  });

  expect(result.healthyViewUpdatesAfterTrigger).toBe(1);
  expect(result.healthyFrames).toBeGreaterThanOrEqual(15); // clock kept ticking through the throw
  expect(result.afterAdd).toBe(result.before + 1); // commands still work post-throw
  expect(result.afterUndo).toBe(result.before); // undo still works post-throw

  // Exactly one console.error per broken listener (each is logged once,
  // then suppressed). See events.ts / store.ts.
  expect(consoleWatcher.errors).toHaveLength(2);
  expect(consoleWatcher.pageErrors).toEqual([]);
});

test('a synthetic uncaught error and unhandled rejection surface as a status message, not a fatal banner', async ({ page }) => {
  await bootAndPause(page);

  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'resilience.spec: synthetic uncaught error',
      error: new Error('resilience.spec: synthetic uncaught error'),
    }));
  });
  await expect(page.locator('[data-testid="status-message"]')).toBeVisible();
  await expect(page.locator('[data-testid="fatal-banner"]')).toHaveCount(0);

  await page.evaluate(() => {
    Promise.reject(new Error('resilience.spec: synthetic unhandled rejection'));
  });
  await expect(page.locator('[data-testid="status-message"]')).toBeVisible();
  await expect(page.locator('[data-testid="fatal-banner"]')).toHaveCount(0);

  const ready = await page.evaluate(() => (window as any).__gdesign?.ready === true);
  expect(ready).toBe(true);
});
