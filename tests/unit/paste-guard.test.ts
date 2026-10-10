import { describe, it, expect } from 'vitest';
import { markPasteHandled, wasPasteRecentlyHandled } from '../../src/app/commands/paste-guard';

describe('paste-guard', () => {
  it('reports unhandled before markPasteHandled is ever called', () => {
    expect(wasPasteRecentlyHandled()).toBe(false);
  });

  it('reports handled immediately after markPasteHandled', () => {
    markPasteHandled();
    expect(wasPasteRecentlyHandled()).toBe(true);
  });

  it('expires after the window elapses', async () => {
    markPasteHandled();
    expect(wasPasteRecentlyHandled(20)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wasPasteRecentlyHandled(20)).toBe(false);
  });
});
