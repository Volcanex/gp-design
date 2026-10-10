import { describe, it, expect, vi } from 'vitest';
import { createHistory } from '../../src/app/commands/history';
import { patchCommand, uiCommand } from '../../src/app/commands/command';
import type { AppCtx, Command } from '../../src/app/types';
import type { DocEdit, EngineHost } from '@engine';

/** A fake engine whose applyEdits marks the edit as its own inverse
 * (edit -> {..., value: -value}) so run/undo can be asserted against a
 * simple counter without a real document. */
function fakeEngine(): { engine: EngineHost; counter: { value: number } } {
  const counter = { value: 0 };
  const engine = {
    applyEdits(edits: DocEdit[]): DocEdit[] {
      const inverses: DocEdit[] = [];
      for (const edit of edits) {
        if (edit.op === 'setOpacity') {
          const prev = counter.value;
          counter.value = edit.value as number;
          inverses.unshift({ op: 'setOpacity', id: edit.id, value: prev });
        }
      }
      return inverses;
    },
  } as unknown as EngineHost;
  return { engine, counter };
}

function ctx(engine: EngineHost): AppCtx {
  return { engine };
}

describe('history', () => {
  it('push runs the command and records an entry', () => {
    const { engine, counter } = fakeEngine();
    const app = ctx(engine);
    const history = createHistory();
    history.push(app, patchCommand('Set 1', [{ op: 'setOpacity', id: 'l1' as never, value: 1 }]));
    expect(counter.value).toBe(1);
    expect(history.entries()).toEqual([{ label: 'Set 1', current: true }]);
  });

  it('undo/redo restore and reapply state', () => {
    const { engine, counter } = fakeEngine();
    const app = ctx(engine);
    const history = createHistory();
    history.push(app, patchCommand('Set 1', [{ op: 'setOpacity', id: 'l1' as never, value: 1 }]));
    history.push(app, patchCommand('Set 2', [{ op: 'setOpacity', id: 'l2' as never, value: 2 }]));
    expect(counter.value).toBe(2);

    history.undo(app);
    expect(counter.value).toBe(1);
    history.undo(app);
    expect(counter.value).toBe(0);
    expect(history.canUndo()).toBe(false);

    history.redo(app);
    expect(counter.value).toBe(1);
    history.redo(app);
    expect(counter.value).toBe(2);
    expect(history.canRedo()).toBe(false);
  });

  it('push truncates the redo stack', () => {
    const { engine, counter } = fakeEngine();
    const app = ctx(engine);
    const history = createHistory();
    history.push(app, patchCommand('A', [{ op: 'setOpacity', id: 'l1' as never, value: 1 }]));
    history.push(app, patchCommand('B', [{ op: 'setOpacity', id: 'l2' as never, value: 2 }]));
    history.undo(app);
    expect(history.canRedo()).toBe(true);

    history.push(app, patchCommand('C', [{ op: 'setOpacity', id: 'l3' as never, value: 3 }]));
    expect(history.canRedo()).toBe(false);
    expect(history.entries().map((e) => e.label)).toEqual(['A', 'C']);
    expect(counter.value).toBe(3);
  });

  it('coalesces consecutive edits to the same target via mergeWith', () => {
    const { engine, counter } = fakeEngine();
    const app = ctx(engine);
    const history = createHistory();
    history.push(app, patchCommand('Opacity', [{ op: 'setOpacity', id: 'l1' as never, value: 0.2 }]));
    history.push(app, patchCommand('Opacity', [{ op: 'setOpacity', id: 'l1' as never, value: 0.5 }]));
    history.push(app, patchCommand('Opacity', [{ op: 'setOpacity', id: 'l1' as never, value: 0.9 }]));

    expect(history.entries()).toHaveLength(1);
    expect(counter.value).toBeCloseTo(0.9);

    // Undo must restore the PRE-DRAG value (0), not the mid-drag value.
    history.undo(app);
    expect(counter.value).toBe(0);

    // Redo replays the LATEST merged edit, landing on the final value.
    history.redo(app);
    expect(counter.value).toBeCloseTo(0.9);
  });

  it('does not merge edits targeting different layers', () => {
    const { engine } = fakeEngine();
    const app = ctx(engine);
    const history = createHistory();
    history.push(app, patchCommand('Opacity', [{ op: 'setOpacity', id: 'l1' as never, value: 0.2 }]));
    history.push(app, patchCommand('Opacity', [{ op: 'setOpacity', id: 'l2' as never, value: 0.5 }]));
    expect(history.entries()).toHaveLength(2);
  });

  it('caps the stack at 200 entries', () => {
    const { engine } = fakeEngine();
    const app = ctx(engine);
    const history = createHistory();
    for (let i = 0; i < 205; i++) {
      history.push(app, patchCommand(`Edit ${i}`, [{ op: 'setOpacity', id: `l${i}` as never, value: i }]));
    }
    expect(history.entries()).toHaveLength(200);
    expect(history.entries()[0]!.label).toBe('Edit 5');
    expect(history.entries()[199]!.label).toBe('Edit 204');
  });

  it('jumpTo walks undo/redo to land on an arbitrary index', () => {
    const { engine, counter } = fakeEngine();
    const app = ctx(engine);
    const history = createHistory();
    history.push(app, patchCommand('A', [{ op: 'setOpacity', id: 'l1' as never, value: 1 }]));
    history.push(app, patchCommand('B', [{ op: 'setOpacity', id: 'l2' as never, value: 2 }]));
    history.push(app, patchCommand('C', [{ op: 'setOpacity', id: 'l3' as never, value: 3 }]));

    history.jumpTo(app, 0);
    expect(counter.value).toBe(1);
    expect(history.entries().map((e) => e.current)).toEqual([true, false, false]);

    history.jumpTo(app, 2);
    expect(counter.value).toBe(3);
  });

  it('notifies subscribers on change', () => {
    const { engine } = fakeEngine();
    const app = ctx(engine);
    const history = createHistory();
    const cb = vi.fn();
    const unsub = history.onChange(cb);
    history.push(app, patchCommand('A', [{ op: 'setOpacity', id: 'l1' as never, value: 1 }]));
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    history.push(app, patchCommand('B', [{ op: 'setOpacity', id: 'l2' as never, value: 2 }]));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('uiCommand participates in undo/redo without touching the engine', () => {
    const { engine } = fakeEngine();
    const app = ctx(engine);
    const history = createHistory();
    let flag = false;
    const cmd: Command = uiCommand(
      'Toggle Flag',
      () => { flag = true; },
      () => { flag = false; },
    );
    history.push(app, cmd);
    expect(flag).toBe(true);
    history.undo(app);
    expect(flag).toBe(false);
    history.redo(app);
    expect(flag).toBe(true);
  });
});
