import { test, expect } from '@playwright/test';
import type { LayerId, DocumentJSON } from '@engine';

const layer = 'plasma1' as LayerId;

/** Plasma layer + an exposure chain step, so burn must capture both the
 * source AND the chain's effect, not just the raw source output. */
function plasmaWithChainDocument(): DocumentJSON {
  return {
    version: 1,
    canvas: { width: 64, height: 64, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [
      {
        id: layer,
        kind: 'layer',
        name: 'Plasma',
        enabled: true,
        source: { type: 'core.plasma', params: { scale: 8, speed: 6 } },
        chain: [{ id: 'fx1', pass: 'core.exposure', params: { exposure: 1 }, enabled: true }],
        blendMode: 'normal',
        opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'live',
      },
    ],
    postChain: [],
    assets: {},
  };
}

async function loadDoc(page: import('@playwright/test').Page, doc: DocumentJSON) {
  await page.evaluate(async (d) => {
    await window.__engineTest!.ready;
    await window.__engineTest!.host.loadDocument(d as never);
  }, doc);
}

/**
 * Burn-to-still: render the target's source+chain, read it back, and swap
 * the layer to a baked core.raster source with an empty chain. Per the
 * ArrayBuffer-bridge gotcha (Phase 2), the burn + apply + readback flow runs
 * inside a single page.evaluate call: only plain numbers cross back to Node.
 */
test('burn still: bakes source+chain, pixels survive, layer no longer animates', async ({ page }) => {
  await page.goto('/engine-test.html');
  await loadDoc(page, plasmaWithChainDocument());

  const result = await page.evaluate(async ({ layer }) => {
    const host = window.__engineTest!.host;

    const before = await host.readback({ via: 'float' });
    const beforeData = Array.from(new Float32Array(before.data));

    const burnResult = await host.burn({ target: layer, mode: 'still' });
    const inverses = host.applyEdits(burnResult.edits);

    const afterBurn = await host.readback({ via: 'float' });
    const afterBurnData = Array.from(new Float32Array(afterBurn.data));

    // The baked layer no longer animates: seeking forward must not change it.
    host.setClock({ cmd: 'seek', time: 1 });
    const afterSeek = await host.readback({ via: 'float' });
    const afterSeekData = Array.from(new Float32Array(afterSeek.data));

    const doc = host.getDocument();
    const bakedLayer = doc.layers.find((l) => l.id === layer) as import('@engine').Layer;

    return {
      editCount: burnResult.edits.length,
      inverseCount: inverses.length,
      width: before.width,
      beforeData,
      afterBurnData,
      afterSeekData,
      sourceType: bakedLayer.source.type,
      chainLength: bakedLayer.chain.length,
      liveness: bakedLayer.liveness,
    };
  }, { layer });

  expect(result.editCount).toBeGreaterThan(0);
  expect(result.inverseCount).toBe(result.editCount);
  expect(result.sourceType).toBe('core.raster');
  expect(result.chainLength).toBe(0);
  expect(result.liveness).toBe('baked');

  const maxDelta = (a: number[], b: number[]) => {
    let max = 0;
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
    return max;
  };

  // Pixels survive the bake.
  expect(maxDelta(result.beforeData, result.afterBurnData)).toBeLessThan(0.03);
  // No longer animates: seeking forward doesn't change the baked layer.
  expect(maxDelta(result.afterBurnData, result.afterSeekData)).toBeLessThan(0.03);
});

/**
 * Burn-to-clip: bakes a time range into per-frame textures; the scheduler
 * samples the nearest captured frame instead of re-running source+chain.
 * Frame times are chosen to land exactly on sampled indices (0 and 0.5s
 * @4fps -> frame 0 and frame 2) so the comparison isn't sensitive to
 * in-between interpolation.
 */
test('burn clip: bakes a frame range, playback samples distinct frames matching pre-burn renders', async ({ page }) => {
  await page.goto('/engine-test.html');
  await loadDoc(page, plasmaWithChainDocument());

  const result = await page.evaluate(async ({ layer }) => {
    const host = window.__engineTest!.host;

    host.setClock({ cmd: 'seek', time: 0 });
    const preAt0 = await host.readback({ via: 'float' });
    const preAt0Data = Array.from(new Float32Array(preAt0.data));

    host.setClock({ cmd: 'seek', time: 0.5 });
    const preAt05 = await host.readback({ via: 'float' });
    const preAt05Data = Array.from(new Float32Array(preAt05.data));

    host.setClock({ cmd: 'seek', time: 0 });
    const burnResult = await host.burn({
      target: layer,
      mode: 'clip',
      range: { from: 0, to: 0.5, fps: 4 },
    });
    host.applyEdits(burnResult.edits);

    host.setClock({ cmd: 'seek', time: 0 });
    const postAt0 = await host.readback({ via: 'float' });
    const postAt0Data = Array.from(new Float32Array(postAt0.data));

    host.setClock({ cmd: 'seek', time: 0.5 });
    const postAt05 = await host.readback({ via: 'float' });
    const postAt05Data = Array.from(new Float32Array(postAt05.data));

    const doc = host.getDocument();
    const bakedLayer = doc.layers.find((l) => l.id === layer) as import('@engine').Layer;

    return {
      editCount: burnResult.edits.length,
      preAt0Data,
      preAt05Data,
      postAt0Data,
      postAt05Data,
      liveness: bakedLayer.liveness,
      chainLength: bakedLayer.chain.length,
      baked: bakedLayer.baked,
    };
  }, { layer });

  expect(result.editCount).toBeGreaterThan(0);
  expect(result.liveness).toBe('baked');
  expect(result.chainLength).toBe(0);
  expect(result.baked).toMatchObject({ frames: 3, fps: 4 });

  const maxDelta = (a: number[], b: number[]) => {
    let max = 0;
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
    return max;
  };

  // Sampled clip frames match the pre-burn live renders at the same times.
  expect(maxDelta(result.postAt0Data, result.preAt0Data)).toBeLessThan(0.03);
  expect(maxDelta(result.postAt05Data, result.preAt05Data)).toBeLessThan(0.03);
  // The two sampled frames are genuinely distinct (plasma moved between them).
  expect(maxDelta(result.postAt0Data, result.postAt05Data)).toBeGreaterThan(0.05);
});

test('burn undo: applying the inverse restores the live, animating layer', async ({ page }) => {
  await page.goto('/engine-test.html');
  await loadDoc(page, plasmaWithChainDocument());

  const result = await page.evaluate(async ({ layer }) => {
    const host = window.__engineTest!.host;

    const burnResult = await host.burn({ target: layer, mode: 'still' });
    const inverses = host.applyEdits(burnResult.edits);
    host.applyEdits(inverses);

    const doc = host.getDocument();
    const restoredLayer = doc.layers.find((l) => l.id === layer) as import('@engine').Layer;

    host.setClock({ cmd: 'seek', time: 0 });
    const at0 = await host.readback({ via: 'float' });
    const at0Data = Array.from(new Float32Array(at0.data));

    host.setClock({ cmd: 'seek', time: 1 });
    const at1 = await host.readback({ via: 'float' });
    const at1Data = Array.from(new Float32Array(at1.data));

    return {
      sourceType: restoredLayer.source.type,
      chainLength: restoredLayer.chain.length,
      liveness: restoredLayer.liveness,
      at0Data,
      at1Data,
    };
  }, { layer });

  expect(result.sourceType).toBe('core.plasma');
  expect(result.chainLength).toBe(1);
  expect(result.liveness).toBe('live');

  let totalDelta = 0;
  for (let i = 0; i < result.at0Data.length; i++) totalDelta += Math.abs(result.at0Data[i]! - result.at1Data[i]!);
  expect(totalDelta / result.at0Data.length).toBeGreaterThan(0.01);
});
