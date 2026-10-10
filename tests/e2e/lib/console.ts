/**
 * Attaches to a page before navigation and collects every `console.error`
 * (not warn/info: panels/tools log plenty of those in normal operation)
 * and every `pageerror` (an uncaught throw/rejection that escaped every
 * guard). `assertClean()` is the single assertion a resilience/sweep spec
 * makes at its end: zero of either means every crash guard this workstream
 * added actually did its job silently, not just "the app didn't visibly
 * break".
 */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export interface ConsoleWatcher {
  errors: string[];
  pageErrors: string[];
  assertClean(): void;
}

export function watchConsole(page: Page): ConsoleWatcher {
  const watcher: ConsoleWatcher = {
    errors: [],
    pageErrors: [],
    assertClean() {
      expect(watcher.errors, `console.error: ${JSON.stringify(watcher.errors)}`).toEqual([]);
      expect(watcher.pageErrors, `pageerror: ${JSON.stringify(watcher.pageErrors)}`).toEqual([]);
    },
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error') watcher.errors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    watcher.pageErrors.push(err.message);
  });
  return watcher;
}
