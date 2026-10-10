import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppCtx } from '../../src/app/types';
import type { AssetJSON, DocEdit, DocumentJSON, EngineHost, LayerNode } from '@engine';

/**
 * Fakes Mediabunny entirely (demux/decode is a browser-only, GPU-adjacent
 * concern with no place in a node vitest run) so this exercises only
 * video-import.ts's own logic: fps/dimension resolution, frame-drop
 * decimation, and the addAsset+addLayer+setDocClock edit-batch it builds,
 * the same contract image-import.ts's importImageAsLayer follows for
 * stills. A real decode path is covered by tests/e2e/video-import.spec.ts.
 */
let mockSourceFps = 10;
let mockWidth = 64;
let mockHeight = 32;
let mockDuration = 1;
/** [timestamp, color] pairs: color lets a test assert distinct frames
 * actually produced distinct bytes, without needing real pixel decoding. */
let mockFrames: { timestamp: number; color: [number, number, number, number] }[] = [];

class MockInput {
  disposed = false;
  async getPrimaryVideoTrack() {
    return {
      async computePacketStats(_n: number) {
        return { packetCount: mockFrames.length, averagePacketRate: mockSourceFps, averageBitrate: 0 };
      },
      async getDisplayWidth() {
        return mockWidth;
      },
      async getDisplayHeight() {
        return mockHeight;
      },
    };
  }
  async getDurationFromMetadata() {
    return mockDuration;
  }
  async computeDuration() {
    return mockDuration;
  }
  dispose() {
    this.disposed = true;
  }
}

class MockVideoSampleSink {
  constructor(_track: unknown) {}
  samples(from: number, to: number) {
    const frames = mockFrames;
    return (async function* () {
      for (const f of frames) {
        if (f.timestamp < from || f.timestamp >= to) continue;
        yield {
          timestamp: f.timestamp,
          draw(ctx: FakeCtx) {
            ctx.lastColor = f.color;
          },
          close() {},
        };
      }
    })();
  }
}

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {
    constructor(_blob: Blob) {}
  },
  Input: MockInput,
  VideoSampleSink: MockVideoSampleSink,
}));

class FakeCtx {
  lastColor: [number, number, number, number] = [0, 0, 0, 0];
  getImageData(_x: number, _y: number, w: number, h: number) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set(this.lastColor, i * 4);
    return { data, width: w, height: h } as ImageData;
  }
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  private ctx = new FakeCtx();
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(kind: string) {
    return kind === '2d' ? this.ctx : null;
  }
}

beforeEach(() => {
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  mockSourceFps = 10;
  mockWidth = 64;
  mockHeight = 32;
  mockDuration = 1;
  // Each source frame gets a unique red-channel value so any two KEPT frames
  // are distinguishable regardless of which stride the decimator picks.
  mockFrames = Array.from({ length: 10 }, (_, i) => ({
    timestamp: i / 10,
    color: [i * 20, 0, 0, 255] as [number, number, number, number],
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeApp(): { app: AppCtx; edits: DocEdit[] } {
  const doc: DocumentJSON = {
    version: 1,
    canvas: { width: 640, height: 480, workingFormat: 'rgba16float', outputColorSpace: 'srgb' },
    clock: { fps: 30, duration: undefined },
    layers: [],
    assets: {},
  } as unknown as DocumentJSON;
  const edits: DocEdit[] = [];
  const engine = {
    getDocument: () => doc,
    applyEdits: (batch: DocEdit[]) => {
      edits.push(...batch);
      for (const edit of batch) {
        if (edit.op === 'setDocClock') doc.clock = edit.clock;
      }
      return [];
    },
  } as unknown as EngineHost;
  return { app: { engine }, edits };
}

describe('importVideoAsLayer', () => {
  it('bakes a decimated clip asset + baked layer + extended doc clock', async () => {
    const { importVideoAsLayer } = await import('../../src/app/commands/video-import');
    const { app, edits } = fakeApp();

    await importVideoAsLayer(app, new Blob(), 'My Video', { from: 0, to: 1, targetFps: 5, halfRes: false });

    expect(edits).toHaveLength(3);

    const addAsset = edits[0]!;
    expect(addAsset.op).toBe('addAsset');
    if (addAsset.op !== 'addAsset') throw new Error('unreachable');
    const asset = addAsset.asset as Extract<AssetJSON, { type: 'clip' }>;
    expect(asset.type).toBe('clip');
    expect(asset.format).toBe('rgba8unorm');
    expect(asset.width).toBe(64);
    expect(asset.height).toBe(32);
    expect(asset.fps).toBe(5);
    // Decimated from 10 source frames (0..0.9 @ 10fps) down to 5 @ target fps.
    expect(asset.frames).toHaveLength(5);

    const addLayer = edits[1]!;
    expect(addLayer.op).toBe('addLayer');
    if (addLayer.op !== 'addLayer') throw new Error('unreachable');
    const layer = addLayer.layer as LayerNode;
    expect(layer.kind).toBe('layer');
    if (layer.kind !== 'layer') throw new Error('unreachable');
    expect(layer.liveness).toBe('baked');
    expect(layer.source).toEqual({ type: 'core.solid', params: {} });
    expect(layer.baked).toEqual({ clip: addAsset.id, frames: 5, fps: 5 });

    const setDocClock = edits[2]!;
    expect(setDocClock).toEqual({ op: 'setDocClock', clock: { fps: 30, duration: 1 } });
  });

  it('drops alternating source frames whose colors differ, producing distinct frame bytes', async () => {
    const { importVideoAsLayer } = await import('../../src/app/commands/video-import');
    const { app, edits } = fakeApp();

    await importVideoAsLayer(app, new Blob(), 'My Video', { from: 0, to: 1, targetFps: 5, halfRes: false });

    const addAsset = edits.find((e) => e.op === 'addAsset');
    if (!addAsset || addAsset.op !== 'addAsset') throw new Error('no addAsset edit');
    const asset = addAsset.asset as Extract<AssetJSON, { type: 'clip' }>;
    const frame0 = new Uint8ClampedArray(asset.frames[0]!);
    const frame1 = new Uint8ClampedArray(asset.frames[1]!);
    expect(frame0[0]).not.toBe(frame1[0]); // red channel differs (kept frames alternate red/green source colors)
  });

  it('never targets a higher fps than the source', async () => {
    const { importVideoAsLayer } = await import('../../src/app/commands/video-import');
    const { app, edits } = fakeApp();
    mockSourceFps = 10;

    await importVideoAsLayer(app, new Blob(), 'My Video', { from: 0, to: 1, targetFps: 60, halfRes: false });

    const addAsset = edits.find((e) => e.op === 'addAsset');
    if (!addAsset || addAsset.op !== 'addAsset') throw new Error('no addAsset edit');
    expect((addAsset.asset as Extract<AssetJSON, { type: 'clip' }>).fps).toBe(10);
  });

  it('halves output dimensions when halfRes is set', async () => {
    const { importVideoAsLayer } = await import('../../src/app/commands/video-import');
    const { app, edits } = fakeApp();

    await importVideoAsLayer(app, new Blob(), 'My Video', { from: 0, to: 1, targetFps: 5, halfRes: true });

    const addAsset = edits.find((e) => e.op === 'addAsset');
    if (!addAsset || addAsset.op !== 'addAsset') throw new Error('no addAsset edit');
    const asset = addAsset.asset as Extract<AssetJSON, { type: 'clip' }>;
    expect(asset.width).toBe(32);
    expect(asset.height).toBe(16);
  });
});
