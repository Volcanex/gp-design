import { describe, it, expect } from 'vitest';
import { createClock } from '../../src/engine/core/clock';

describe('createClock', () => {
  it('does not advance while paused', () => {
    const clock = createClock(30);
    const tick = clock.tick(1000);
    expect(tick.time).toBe(0);
    expect(tick.frame).toBe(0);
  });

  it('advances time and frame while playing', () => {
    const clock = createClock(30);
    clock.play();
    const tick = clock.tick(500);
    expect(tick.time).toBeCloseTo(0.5, 5);
    expect(tick.frame).toBe(15);
    expect(clock.playing).toBe(true);
  });

  it('seek jumps to an exact time', () => {
    const clock = createClock(30);
    clock.seek(2);
    expect(clock.time).toBe(2);
    expect(clock.frame).toBe(60);
  });

  it('setFps changes frame derivation immediately', () => {
    const clock = createClock(30);
    clock.seek(1);
    expect(clock.frame).toBe(30);
    clock.setFps(60);
    expect(clock.frame).toBe(60);
  });

  it('loops at duration when playing past it', () => {
    const clock = createClock(10, 1); // 1 second loop
    clock.play();
    clock.tick(1500); // 1.5s -> wraps to 0.5s
    expect(clock.time).toBeCloseTo(0.5, 5);
  });

  it('seek wraps into the loop range too', () => {
    const clock = createClock(10, 1);
    clock.seek(1.25);
    expect(clock.time).toBeCloseTo(0.25, 5);
  });

  it('pause freezes the current time', () => {
    const clock = createClock(30);
    clock.play();
    clock.tick(500);
    clock.pause();
    const before = clock.time;
    clock.tick(500);
    expect(clock.time).toBe(before);
  });
});
