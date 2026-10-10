/**
 * Pure loop-wrap arithmetic shared by localHost.ts's and MockEngineHost's
 * own inline clocks; host/localHost.ts's module doc explains why they
 * don't use core/clock.ts's createClock. Ticks advance by one frame at a
 * time, so a single wrap (not a modulo) is enough to land back in range.
 */

import type { Seconds } from './types';

export function wrapLoopTime(
  time: Seconds,
  range: { from: Seconds; to: Seconds } | undefined,
): Seconds {
  if (!range || time < range.to) return time;
  return range.from + (time - range.to);
}
