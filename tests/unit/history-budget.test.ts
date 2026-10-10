import { describe, expect, it } from 'vitest';
import { createHistory } from '../../src/app/commands/history';
import type { AppCtx, Command } from '../../src/app/types';

const fakeApp = {} as AppCtx;

function fakeCommand(label: string, bytes: number): Command {
  return {
    label,
    run() {},
    undo() {},
    bytes: () => bytes,
  };
}

const MB = 1024 * 1024;

describe('history byte budget', () => {
  it('stats() reports 0 bytes against the 256MB budget with an empty history', () => {
    const history = createHistory();
    const stats = history.stats();
    expect(stats.entries).toBe(0);
    expect(stats.bytes).toBe(0);
    expect(stats.budget).toBe(256 * MB);
  });

  it('sums bytes() across every retained entry', () => {
    const history = createHistory();
    history.push(fakeApp, fakeCommand('a', 10 * MB));
    history.push(fakeApp, fakeCommand('b', 20 * MB));
    expect(history.stats()).toEqual({ entries: 2, bytes: 30 * MB, budget: 256 * MB });
  });

  it('a command with no bytes() contributes 0', () => {
    const history = createHistory();
    history.push(fakeApp, { label: 'ui-only', run() {}, undo() {} });
    expect(history.stats().bytes).toBe(0);
  });

  it('evicts from the bottom of the stack once retained bytes exceed the budget', () => {
    const history = createHistory();
    history.push(fakeApp, fakeCommand('one', 100 * MB));
    history.push(fakeApp, fakeCommand('two', 100 * MB));
    expect(history.stats()).toEqual({ entries: 2, bytes: 200 * MB, budget: 256 * MB });

    // 300MB total > 256MB budget: evicts 'one' (oldest) until back under budget.
    history.push(fakeApp, fakeCommand('three', 100 * MB));
    const labels = history.entries().map((e) => e.label);
    expect(labels).toEqual(['two', 'three']);
    expect(history.stats().bytes).toBe(200 * MB);

    history.push(fakeApp, fakeCommand('four', 100 * MB));
    expect(history.entries().map((e) => e.label)).toEqual(['three', 'four']);
    expect(history.stats().bytes).toBe(200 * MB);
  });

  it('never evicts the sole remaining (just-pushed) entry, even if it alone exceeds the budget', () => {
    const history = createHistory();
    history.push(fakeApp, fakeCommand('huge', 500 * MB));
    expect(history.entries().map((e) => e.label)).toEqual(['huge']);
    expect(history.stats().bytes).toBe(500 * MB);
  });

  it('keeps the pointer correct (current entry, canUndo) across byte-budget eviction', () => {
    const history = createHistory();
    history.push(fakeApp, fakeCommand('one', 150 * MB));
    history.push(fakeApp, fakeCommand('two', 150 * MB)); // evicts 'one'
    expect(history.entries()).toEqual([{ label: 'two', current: true }]);
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
  });

  it('the 200-entry cap still applies as a secondary bound for zero-byte commands', () => {
    const history = createHistory();
    for (let i = 0; i < 205; i++) history.push(fakeApp, fakeCommand(`c${i}`, 0));
    expect(history.entries().length).toBe(200);
    expect(history.stats().bytes).toBe(0);
  });
});
