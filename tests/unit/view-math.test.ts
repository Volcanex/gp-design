import { describe, it, expect } from 'vitest';
import { fitZoom, centeredPan, clampPan } from '../../src/ui/shell/view-math';

describe('fitZoom', () => {
  it('picks the tighter axis and respects the margin', () => {
    // 1280x720 doc in a 1000x1000 region: width-bound (1000-48)/1280 < height-bound
    const zoom = fitZoom({ width: 1000, height: 1000 }, { width: 1280, height: 720 }, 24);
    expect(zoom).toBeCloseTo((1000 - 48) / 1280, 5);
  });

  it('clamps to ZOOM_MIN/ZOOM_MAX', () => {
    expect(fitZoom({ width: 10, height: 10 }, { width: 100000, height: 100000 })).toBeGreaterThan(0);
    expect(fitZoom({ width: 100000, height: 100000 }, { width: 1, height: 1 })).toBeLessThanOrEqual(32);
  });
});

describe('centeredPan', () => {
  it('centres the zoomed doc in the region', () => {
    const pan = centeredPan({ width: 1000, height: 800 }, { width: 400, height: 200 }, 2);
    expect(pan).toEqual({ x: (1000 - 800) / 2, y: (800 - 400) / 2 });
  });
});

describe('clampPan', () => {
  const region = { width: 1000, height: 800 };
  const doc = { width: 400, height: 300 };
  const zoom = 1;

  it('leaves an in-bounds pan untouched', () => {
    const pan = { x: 300, y: 250 };
    expect(clampPan(pan, region, doc, zoom)).toEqual(pan);
  });

  it('keeps at least 48px of canvas visible when panned far right/down', () => {
    const pan = clampPan({ x: 100000, y: 100000 }, region, doc, zoom);
    expect(pan.x).toBeCloseTo(region.width - 48, 5);
    expect(pan.y).toBeCloseTo(region.height - 48, 5);
  });

  it('keeps at least 48px of canvas visible when panned far left/up', () => {
    const pan = clampPan({ x: -100000, y: -100000 }, region, doc, zoom);
    expect(pan.x).toBeCloseTo(48 - doc.width * zoom, 5);
    expect(pan.y).toBeCloseTo(48 - doc.height * zoom, 5);
  });
});
