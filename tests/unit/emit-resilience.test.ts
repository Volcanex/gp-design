import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEmitter } from '../../src/engine/host/events';

type TestEvent = { type: 'a'; n: number } | { type: 'b' };

describe('createEmitter listener resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a throwing listener does not stop other listeners for the same event, and logs once', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const emitter = createEmitter<TestEvent>();

    const seen: number[] = [];
    emitter.on('a', () => {
      throw new Error('boom');
    });
    emitter.on('a', (e) => {
      if (e.type === 'a') seen.push(e.n);
    });

    emitter.emit({ type: 'a', n: 1 });
    expect(seen).toEqual([1]);
    expect(spy).toHaveBeenCalledTimes(1);

    // Repeated throws from the same listener are suppressed: the healthy
    // listener keeps receiving events and the console stays quiet.
    emitter.emit({ type: 'a', n: 2 });
    emitter.emit({ type: 'a', n: 3 });
    expect(seen).toEqual([1, 2, 3]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emitting an event with no listeners is a no-op', () => {
    const emitter = createEmitter<TestEvent>();
    expect(() => emitter.emit({ type: 'b' })).not.toThrow();
  });

  it('the unsubscribe function returned by on() removes only that listener', () => {
    const emitter = createEmitter<TestEvent>();
    const calls: number[] = [];
    const off = emitter.on('a', (e) => {
      if (e.type === 'a') calls.push(e.n);
    });
    emitter.on('a', () => {}); // second listener stays subscribed

    emitter.emit({ type: 'a', n: 1 });
    off();
    emitter.emit({ type: 'a', n: 2 });

    expect(calls).toEqual([1]);
  });
});
