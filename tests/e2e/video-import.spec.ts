import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { srgb8ToOklab } from '../../src/engine/color/oklab';

/**
 * NOT run from this agent session (Mediabunny/WebCodecs decode needs a real
 * browser, see tests/CLAUDE.md for the build+serve steps). Written against
 * a real decoder against tests/fixtures/video-import-16f-64x64.webm: a
 * 16-frame, 64x64, 8fps VP8 clip, four frames each of red/green/blue/yellow
 * in that order (generated via `ffmpeg -f lavfi -i color=...` per-colour
 * stills muxed to VP8/WebM, see tests/fixtures/CLAUDE.md), so seeking into
 * two different quarters must read back two different, specific colours.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/video-import-16f-64x64.webm', import.meta.url));

// [seconds, expected sRGB8 colour]: frame 0 (red) and frame 4 (green), each
// comfortably inside their quarter so decode/seek jitter can't cross a
// colour boundary.
const RED_TIME = 0.1;
const GREEN_TIME = 0.6;
const EXPECTED_RED_OKLAB = srgb8ToOklab([252, 0, 0]);
const EXPECTED_GREEN_OKLAB = srgb8ToOklab([0, 252, 0]);
const OKLAB_TOLERANCE = 0.08; // VP8 lossy chroma subsampling + SwiftShader float roundtrip

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
});

test('dropping a video onto the canvas opens Import Video, and OK bakes a clip layer with per-frame colour intact', async ({ page }) => {
  const supportsDecode = await page.evaluate(() => 'VideoDecoder' in window);
  test.skip(!supportsDecode, 'no WebCodecs VideoDecoder in this environment');

  const bytes = readFileSync(FIXTURE_PATH);
  const before = await page.evaluate(() => (window as any).__gdesign.doc().layers.length);

  await page.evaluate((b64) => {
    const raw = atob(b64);
    const arr = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const file = new File([arr], 'fixture.webm', { type: 'video/webm' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const region = document.querySelector('.gd-canvas-region')!;
    region.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, bytes.toString('base64'));

  await expect(page.locator('[data-testid="import-video-dialog"]')).toBeVisible();
  // Probing is async; the dialog starts with a "Probing…" placeholder body
  // and rerenders once probeVideo() resolves. Wait for the real form.
  await expect(page.locator('[data-testid="iv-row-source"]')).toBeVisible({ timeout: 15_000 });

  await expect(page.locator('[data-testid="import-video-ok"]')).toBeEnabled();
  await page.locator('[data-testid="import-video-ok"]').click();
  await expect(page.locator('[data-testid="import-video-dialog"]')).toHaveCount(0);

  await expect.poll(() => page.evaluate(() => (window as any).__gdesign.doc().layers.length)).toBe(before + 1);

  const bakedInfo = await page.evaluate(() => {
    const doc = (window as any).__gdesign.doc();
    const layer = doc.layers.find((l: any) => l.baked);
    const asset = layer ? doc.assets[layer.baked.clip] : null;
    return layer && asset
      ? { fps: layer.baked.fps, frames: layer.baked.frames, width: asset.width, height: asset.height, format: asset.format }
      : null;
  });
  expect(bakedInfo).not.toBeNull();
  expect(bakedInfo!.format).toBe('rgba8unorm');
  expect(bakedInfo!.width).toBe(64);
  expect(bakedInfo!.height).toBe(64);
  expect(bakedInfo!.frames).toBe(16);
  expect(bakedInfo!.fps).toBe(8);

  // Pause first: the app's clock autoplays from boot (see app/main.ts), and
  // an in-flight play would race the seek before this frame's readback lands.
  await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'pause' }));

  async function readCenterOklab(time: number): Promise<[number, number, number, number]> {
    return page.evaluate(async (t) => {
      const engine = (window as any).__gdesign.engine;
      engine.setClock({ cmd: 'seek', time: t });
      const result = await engine.readback({ via: 'float' });
      const arr = new Float32Array(result.data);
      const cx = Math.floor(result.width / 2);
      const cy = Math.floor(result.height / 2);
      const i = (cy * result.width + cx) * 4;
      return [arr[i] ?? 0, arr[i + 1] ?? 0, arr[i + 2] ?? 0, arr[i + 3] ?? 0] as [number, number, number, number];
    }, time);
  }

  const red = await readCenterOklab(RED_TIME);
  const green = await readCenterOklab(GREEN_TIME);

  // Sanity: two frames from different colour quarters must read back
  // differently (the whole point of decoding per-frame, not just the first).
  expect(Math.abs(red[0] - green[0]) + Math.abs(red[1] - green[1]) + Math.abs(red[2] - green[2])).toBeGreaterThan(0.1);

  for (let i = 0; i < 3; i++) {
    expect(Math.abs(red[i]! - EXPECTED_RED_OKLAB[i]!)).toBeLessThanOrEqual(OKLAB_TOLERANCE);
    expect(Math.abs(green[i]! - EXPECTED_GREEN_OKLAB[i]!)).toBeLessThanOrEqual(OKLAB_TOLERANCE);
  }
});
