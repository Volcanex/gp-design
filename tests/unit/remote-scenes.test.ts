import { describe, expect, it, vi, afterEach } from 'vitest';
import { loadRemoteScenes, makeRemoteSceneSource, type RemoteScene } from '../../src/engine/sources/remote/render-scenes';
import { sources } from '../../src/engine/registry/sources';

function fakeScene(id: string): RemoteScene {
  return {
    id,
    label: `Scene ${id}`,
    params: { speed: { kind: 'float', default: 1, min: 0, max: 10 } },
    create: () => ({
      renderFrame: vi.fn(),
      dispose: vi.fn(),
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadRemoteScenes', () => {
  it('registers a source per scene from a valid module and returns the count', async () => {
    const importFn = vi.fn().mockResolvedValue({
      contractVersion: 1,
      scenes: [fakeScene('test-scene-a'), fakeScene('test-scene-b')],
    });

    const count = await loadRemoteScenes({ url: 'https://example.test/scenes.mjs', importFn });

    expect(count).toBe(2);
    expect(importFn).toHaveBeenCalledWith('https://example.test/scenes.mjs');
    expect(sources.get('render.test-scene-a')).toBeTruthy();
    expect(sources.get('render.test-scene-b')).toBeTruthy();
  });

  it('registers nothing and returns 0 for the wrong contractVersion', async () => {
    const importFn = vi.fn().mockResolvedValue({
      contractVersion: 2,
      scenes: [fakeScene('test-scene-wrong-version')],
    });

    const count = await loadRemoteScenes({ url: 'https://example.test/scenes.mjs', importFn });

    expect(count).toBe(0);
    expect(sources.get('render.test-scene-wrong-version')).toBeUndefined();
  });

  it('returns 0 when the import rejects', async () => {
    const importFn = vi.fn().mockRejectedValue(new Error('network down'));

    const count = await loadRemoteScenes({ url: 'https://example.test/scenes.mjs', importFn });

    expect(count).toBe(0);
  });

  it('returns 0 when the import never resolves before the timeout', async () => {
    const importFn = vi.fn().mockReturnValue(new Promise(() => {}));

    const count = await loadRemoteScenes({ url: 'https://example.test/scenes.mjs', importFn, timeoutMs: 10 });

    expect(count).toBe(0);
  });

  it('does not throw and returns 0 when scenes is not an array', async () => {
    const importFn = vi.fn().mockResolvedValue({ contractVersion: 1, scenes: 'nope' });

    const count = await loadRemoteScenes({ url: 'https://example.test/scenes.mjs', importFn });

    expect(count).toBe(0);
  });
});

describe('makeRemoteSceneSource', () => {
  it('maps id/label/params/liveByDefault from the remote scene', () => {
    const scene = fakeScene('test-scene-mapping');
    const descriptor = makeRemoteSceneSource(scene);

    expect(descriptor.id).toBe('render.test-scene-mapping');
    expect(descriptor.label).toBe('Render: Scene test-scene-mapping');
    expect(descriptor.params).toBe(scene.params);
    expect(descriptor.liveByDefault).toBe(true);
  });
});
