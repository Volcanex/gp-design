/** Contract: see tests/e2e/boot.spec.ts header for the full window.__gdesign
 * shape. Dialog-opening commands are driven via __gdesign.exec() directly
 * (not by clicking through the dynamically-grouped Effects menu tree) per
 * tests/CLAUDE.md's menu-sweep brief. 'file.export' ("Export…") runs
 * immediately with no dialog, so 'file.exportVideo' ("Export Video…") is
 * the Export flow swept here. */

import { test, expect } from '@playwright/test';
import { bootAndPause } from './lib/boot';
import { watchConsole } from './lib/console';

test('every top-level menu opens and closes without a console error', async ({ page }) => {
  const consoleWatcher = watchConsole(page);
  await bootAndPause(page);

  const triggers = page.locator('[data-testid="menu-trigger"]');
  const count = await triggers.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i += 1) {
    const trigger = triggers.nth(i);
    const menu = page.locator(`#${await trigger.getAttribute('popovertarget')}`);
    await trigger.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape'); // popover light dismiss
    await expect(menu).toBeHidden();
  }

  consoleWatcher.assertClean();
});

test('every effect, File > New, Layer Properties and Export Video open a dialog that Cancel leaves the document untouched', async ({ page }) => {
  const consoleWatcher = watchConsole(page);
  await bootAndPause(page);

  await page.evaluate(() => {
    (window as any).__testDigest = () => {
      const doc = (window as any).__gdesign.doc();
      const walk = (nodes: any[]): unknown[] =>
        nodes.map((n) =>
          n.kind === 'group'
            ? { kind: 'group', id: n.id, children: walk(n.children) }
            : { kind: 'layer', id: n.id, chain: n.chain.length },
        );
      return JSON.stringify({ layers: walk(doc.layers), assets: Object.keys(doc.assets).sort() });
    };
  });

  const targets = await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    const list: { label: string; command: string; args?: string; dialogTestId: string; cancelTestId: string }[] = [
      { label: 'file.new', command: 'file.new', dialogTestId: 'new-document-dialog', cancelTestId: 'new-document-cancel' },
      { label: 'layer.properties', command: 'layer.properties', dialogTestId: 'layer-props-dialog', cancelTestId: 'layer-props-cancel' },
      { label: 'file.exportVideo', command: 'file.exportVideo', dialogTestId: 'export-video-dialog', cancelTestId: 'export-video-cancel' },
    ];
    for (const eff of gd.engine.listEffects()) {
      list.push({ label: `effect.open:${eff.id}`, command: 'effect.open', args: eff.id, dialogTestId: 'effect-dialog', cancelTestId: 'effect-cancel' });
    }
    return list;
  });
  expect(targets.length).toBeGreaterThan(3); // File/Layer/Export plus at least one effect

  for (const target of targets) {
    const before = await page.evaluate(() => (window as any).__testDigest());

    await page.evaluate(
      ({ command, args }) => (window as any).__gdesign.exec(command, args),
      { command: target.command, args: target.args },
    );
    await expect(page.locator(`[data-testid="${target.dialogTestId}"]`), target.label).toBeVisible();

    await page.locator(`[data-testid="${target.cancelTestId}"]`).click();
    await expect(page.locator(`[data-testid="${target.dialogTestId}"]`), target.label).toHaveCount(0);

    const after = await page.evaluate(() => (window as any).__testDigest());
    expect(after, `${target.label}: Cancel changed the document`).toBe(before);
  }

  consoleWatcher.assertClean();
});
