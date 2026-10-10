/**
 * Shared "open the app and get it into a stable, testable state" helper.
 * Existing specs are NOT refactored onto this. It exists for the new
 * crash-tests specs only (tests/CLAUDE.md).
 */

import type { Page } from '@playwright/test';

/** Navigates to `/`, waits for `__gdesign.ready`, and pauses the
 * auto-playing clock, required in every app-page spec (tests/CLAUDE.md):
 * the boot clock's continuous render loop compounds across sequential
 * contexts under SwiftShader until readbacks hang outright. */
export async function bootAndPause(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
  await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'pause' }));
}
