// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { flushLayoutSave, layoutState } from '../../src/app/stores';

const KEY = 'gdesign.layout.v2';

describe('layout save flush', () => {
  afterEach(() => {
    localStorage.removeItem(KEY);
  });

  it('a beforeunload/pagehide flush persists a still-debounced change immediately', () => {
    const before = layoutState.get();
    layoutState.set({ ...before, panels: { ...before.panels, colors: { visible: true, x: 0, y: 0, collapsed: true } }, rightWidth: 333 });

    // Debounce window (250ms) hasn't elapsed: nothing in storage yet.
    expect(localStorage.getItem(KEY)).toBeNull();

    window.dispatchEvent(new Event('pagehide'));

    const saved = JSON.parse(localStorage.getItem(KEY)!);
    expect(saved.panels.colors.collapsed).toBe(true);
    expect(saved.rightWidth).toBe(333);
  });

  it('flushLayoutSave is a no-op when there is nothing pending', () => {
    flushLayoutSave(); // drains anything left by a prior test/subscription
    localStorage.removeItem(KEY);
    flushLayoutSave();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
