import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStore } from '../../src/app/store';

describe('createStore subscriber resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a throwing subscriber does not stop later subscribers, and logs once', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createStore(0);

    const seenByLater: number[] = [];
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe((v) => seenByLater.push(v));

    store.set(1);
    expect(seenByLater).toEqual([1]);
    expect(spy).toHaveBeenCalledTimes(1);

    // Second and third throws from the SAME subscriber are suppressed:
    // only the later subscriber keeps running, and the console stays quiet.
    store.set(2);
    store.set(3);
    expect(seenByLater).toEqual([1, 2, 3]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a distinct throwing subscriber logs its own error once, independently', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createStore(0);

    store.subscribe(() => {
      throw new Error('first');
    });
    store.subscribe(() => {
      throw new Error('second');
    });

    store.set(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
