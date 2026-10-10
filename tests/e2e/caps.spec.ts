import { test, expect } from '@playwright/test';

/**
 * SwiftShader capability gate. Everything the GPU test strategy assumes is
 * verified here: adapter acquisition, rgba16float as a render target, and
 * float readback via copyTextureToBuffer. If float readback ever breaks,
 * pixel tests fall back to the quantised path (renders into rgba8unorm).
 */

test('webgpu adapter + rgba16float render + float readback', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return { error: 'no adapter' };
    out.adapter = {
      vendor: adapter.info?.vendor ?? 'unknown',
      architecture: adapter.info?.architecture ?? 'unknown',
    };
    const device = await adapter.requestDevice();

    // 63px wide on purpose: exercises the 256-byte bytesPerRow padding path.
    const W = 63, H = 4;
    const tex = device.createTexture({
      size: [W, H],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    const shader = device.createShaderModule({
      code: `
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
          var p = array<vec2f, 3>(vec2f(-1,-3), vec2f(-1,1), vec2f(3,1));
          return vec4f(p[i], 0, 1);
        }
        @fragment fn fs() -> @location(0) vec4f {
          return vec4f(1.5, 0.25, -0.125, 1.0); // >1 and negative: float-buffer proof
        }`,
    });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs' },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    });

    const bytesPerRow = Math.ceil((W * 8) / 256) * 256;
    const buf = device.createBuffer({
      size: bytesPerRow * H,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = device.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    rp.setPipeline(pipeline);
    rp.draw(3);
    rp.end();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow }, [W, H]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const halfs = new Uint16Array(buf.getMappedRange());

    const f16 = (h: number) => {
      const sign = (h & 0x8000) ? -1 : 1;
      const exp = (h >> 10) & 0x1f;
      const frac = h & 0x3ff;
      if (exp === 0) return sign * frac * 2 ** -24;
      if (exp === 31) return frac ? NaN : sign * Infinity;
      return sign * (1 + frac / 1024) * 2 ** (exp - 15);
    };
    // last pixel of last row, through the padded stride
    const rowWords = bytesPerRow / 2;
    const px = (x: number, y: number) => [0, 1, 2, 3].map((c) => f16(halfs[y * rowWords + x * 4 + c]!));
    out.firstPixel = px(0, 0);
    out.lastPixel = px(W - 1, H - 1);
    return out;
  });

  expect(result, JSON.stringify(result)).not.toHaveProperty('error');
  const r = result as { adapter: { architecture: string }; firstPixel: number[]; lastPixel: number[] };
  for (const p of [r.firstPixel, r.lastPixel]) {
    expect(p[0]).toBeCloseTo(1.5, 2);
    expect(p[1]).toBeCloseTo(0.25, 2);
    expect(p[2]).toBeCloseTo(-0.125, 2);
    expect(p[3]).toBeCloseTo(1.0, 2);
  }
  console.log('CAPS:', JSON.stringify(r));
});
