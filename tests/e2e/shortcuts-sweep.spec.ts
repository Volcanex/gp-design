/** Contract: see tests/e2e/boot.spec.ts header. Fires every KEY_BINDINGS
 * chord (imported directly, so a new binding is swept automatically) and
 * asserts the app survives it. This is a resilience sweep, not a
 * behavioural test of what each shortcut does (shortcuts.spec.ts already
 * covers specific ones). */

import { test, expect } from '@playwright/test';
import { KEY_BINDINGS } from '../../src/app/keymap/bindings';
import { bootAndPause } from './lib/boot';
import { watchConsole } from './lib/console';

// Commands that open a native OS picker/dialog a headless test can't drive
// (file.open's <input type="file">.click(), file.save's download prompt):
// none of KEY_BINDINGS currently binds these, but the allowlist stays
// explicit so a future binding to one of them fails loudly here instead of
// hanging the sweep.
const SKIP_COMMANDS = new Set(['file.open', 'file.save']);

function toPlaywrightChord(keys: string): string {
  return keys
    .split('+')
    .map((part) => (part === 'Ctrl' ? 'Control' : part))
    .join('+');
}

test('every keymap binding fires without a pageerror or console error, and undoes cleanly', async ({ page }) => {
  const consoleWatcher = watchConsole(page);
  await bootAndPause(page);

  const bindings = KEY_BINDINGS.filter((b) => !SKIP_COMMANDS.has(b.command));
  expect(bindings.length).toBeGreaterThan(0);

  const layersBefore = await page.evaluate(() => (window as any).__gdesign.doc().layers.length);

  for (const binding of bindings) {
    const errorsBefore = consoleWatcher.errors.length;
    const pageErrorsBefore = consoleWatcher.pageErrors.length;

    await page.keyboard.press(toPlaywrightChord(binding.keys));
    // Async command handlers (readback, burn) need a beat to settle before
    // their rejection/console output (if any) would show up.
    await page.waitForTimeout(150);

    // A shortcut that opens a dialog (e.g. F4, Ctrl+L) must not stack
    // dialogs across iterations. Cancel it via Escape (dialog-shell.ts)
    // before moving to the next binding.
    const dialogs = page.locator('[data-testid$="-dialog"]');
    if ((await dialogs.count()) > 0) {
      await page.keyboard.press('Escape');
      await expect(dialogs).toHaveCount(0);
    }

    const ready = await page.evaluate(() => (window as any).__gdesign?.ready === true);
    expect(ready, `${binding.keys} (${binding.command}) left __gdesign not ready`).toBe(true);
    expect(
      consoleWatcher.errors.slice(errorsBefore),
      `${binding.keys} (${binding.command}) logged a console error`,
    ).toEqual([]);
    expect(
      consoleWatcher.pageErrors.slice(pageErrorsBefore),
      `${binding.keys} (${binding.command}) threw a pageerror`,
    ).toEqual([]);
  }

  // Undo everything the sweep may have pushed onto history: idempotent
  // once the stack is empty, so a generous fixed count is safe.
  await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    for (let i = 0; i < 200; i += 1) gd.exec('edit.undo');
  });
  const layersAfter = await page.evaluate(() => (window as any).__gdesign.doc().layers.length);
  expect(layersAfter).toBe(layersBefore);
});
