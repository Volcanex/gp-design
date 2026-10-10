/**
 * Pure CPU transport clock: play/pause/seek/tick. Owns time+frame only:
 * the engine host is what turns ticks into actual renders.
 */

import type { Seconds } from './types';

export interface ClockTick {
  time: Seconds;
  frame: number;
}

export interface Clock {
  play(): void;
  pause(): void;
  seek(time: Seconds): void;
  setFps(fps: number): void;
  /** Set/clear looping at a duration (undefined = no loop, play indefinitely). */
  setLoop(duration: Seconds | undefined): void;
  /** Advance by `dtMs` if playing; no-op (but still returns current state) if paused. */
  tick(dtMs: number): ClockTick;
  readonly playing: boolean;
  readonly time: Seconds;
  readonly frame: number;
  readonly fps: number;
}

export function createClock(fps: number, loopDuration?: Seconds): Clock {
  let playing = false;
  let time: Seconds = 0;
  let currentFps = fps;
  let loop = loopDuration;

  const frameOf = (t: Seconds) => Math.floor(t * currentFps);

  return {
    play() { playing = true; },
    pause() { playing = false; },
    seek(t: Seconds) {
      time = loop && loop > 0 ? ((t % loop) + loop) % loop : Math.max(0, t);
    },
    setFps(next: number) { currentFps = next; },
    setLoop(duration: Seconds | undefined) { loop = duration; },
    tick(dtMs: number): ClockTick {
      if (playing) {
        time += dtMs / 1000;
        if (loop && loop > 0 && time >= loop) time %= loop;
      }
      return { time, frame: frameOf(time) };
    },
    get playing() { return playing; },
    get time() { return time; },
    get frame() { return frameOf(time); },
    get fps() { return currentFps; },
  };
}
