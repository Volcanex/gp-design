import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { scene } from '../../src/engine/sources/builtin/scene';
import type { SourceCreateContext, FrameContext } from '../../src/engine/sources/source';
import type { AssetJSON, ObjectNode } from '../../src/engine/doc/json';
import type { PooledBuffer } from '../../src/engine/gpu/pool';

/**
 * Regression test for the "paste image flashes" bug: cachePlaceholder()
 * hands every still-decoding image object the SAME shared placeholder
 * GPUTexture. beginImageDecode's success handler used to destroy
 * `prev.texture` unconditionally, which (the first time ANY pending
 * object's decode landed) destroyed that shared texture out from under
 * every OTHER object still showing it (any other image still decoding),
 * which then sampled a destroyed texture next frame (garbage/black flash).
 *
 * Mock GPUDevice: plain objects standing in for GPU resources, same pattern
 * as gpu-pool.test.ts / image-decode.test.ts. Numeric usage flags via
 * stubbed globals (GPUTextureUsage/GPUBufferUsage aren't defined in
 * vitest's node environment).
 */
function mockDevice() {
  const destroyedTextures: object[] = [];
  const device = {
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createSampler: () => ({}),
    createBuffer: (desc: { size: number; mappedAtCreation?: boolean }) => ({
      getMappedRange: () => new ArrayBuffer(desc.size),
      unmap: () => {},
      destroy: () => {},
    }),
    createBindGroup: () => ({}),
    createTexture: () => {
      const texture = {
        createView: () => ({}),
        destroy: vi.fn(() => destroyedTextures.push(texture)),
      };
      return texture;
    },
    queue: {
      writeBuffer: () => {},
      writeTexture: () => {},
      copyExternalImageToTexture: () => {},
    },
  };
  return { device: device as unknown as GPUDevice, destroyedTextures };
}

function mockFrameContext(): FrameContext {
  const rp = { setPipeline: () => {}, setBindGroup: () => {}, setVertexBuffer: () => {}, draw: () => {}, end: () => {} };
  return {
    device: {} as GPUDevice,
    encoder: { beginRenderPass: () => rp } as unknown as GPUCommandEncoder,
    pool: {} as never,
    time: 0,
    frame: 0,
    runPass: () => {},
    borrowScratch: (like) => like,
  };
}

function mockTarget(): PooledBuffer {
  return {
    texture: {} as GPUTexture,
    view: {} as GPUTextureView,
    key: { width: 64, height: 64, format: 'rgba16float', usage: 0 },
    generation: 0,
  };
}

function imageObject(id: string, assetRef: string): ObjectNode {
  return {
    id: id as never,
    name: id,
    enabled: true,
    content: { type: 'image', asset: assetRef as never },
    style: {},
    liveness: 'live',
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 },
  };
}

beforeEach(() => {
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 0x04, COPY_DST: 0x02, RENDER_ATTACHMENT: 0x10 });
  vi.stubGlobal('GPUBufferUsage', { VERTEX: 0x20, UNIFORM: 0x40, COPY_DST: 0x08 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('core.scene image objects: shared placeholder lifetime', () => {
  it('does not destroy the shared placeholder texture while another object is still pending on it', async () => {
    // Two image objects, two distinct assets, each createImageBitmap call
    // controllable independently so we can land object A's decode while B
    // is still pending on the shared placeholder.
    const bitmapResolvers: Array<(bitmap: { width: number; height: number; close: () => void }) => void> = [];
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => new Promise((resolve) => bitmapResolvers.push(resolve))),
    );

    const { device, destroyedTextures } = mockDevice();
    const assets: Record<string, AssetJSON> = {
      assetA: { type: 'image', mime: 'image/png', data: new ArrayBuffer(4), width: 10, height: 10 },
      assetB: { type: 'image', mime: 'image/png', data: new ArrayBuffer(4), width: 10, height: 10 },
    };
    const ctx: SourceCreateContext = {
      device,
      pool: {} as never,
      getAsset: (id: string) => assets[id],
    };

    const instance = scene.create(ctx);
    const nodeA = imageObject('nodeA', 'assetA');
    const nodeB = imageObject('nodeB', 'assetB');
    const frameCtx = mockFrameContext();
    const target = mockTarget();

    // First render: both objects miss their (empty) image cache, both fall
    // back to the shared placeholder, both kick off a decode.
    instance.render(frameCtx, { scene: [nodeA, nodeB] } as never, target);
    expect(bitmapResolvers).toHaveLength(2);

    // Land A's decode only. B is still supposed to be showing the shared
    // placeholder texture.
    bitmapResolvers[0]!({ width: 10, height: 10, close: () => {} });
    await Promise.resolve();
    await Promise.resolve();

    // The bug: this used to be truthy (the shared placeholder destroyed).
    expect(destroyedTextures).toHaveLength(0);

    // A second render (B still pending) must not throw or sample a
    // destroyed texture.
    expect(() => instance.render(frameCtx, { scene: [nodeA, nodeB] } as never, target)).not.toThrow();

    // Land B's decode too, then dispose: now the placeholder (unused by any
    // live node) is destroyed exactly once, plus each node's own decoded
    // texture.
    bitmapResolvers[1]!({ width: 10, height: 10, close: () => {} });
    await Promise.resolve();
    await Promise.resolve();
    instance.dispose?.();
    // 1 placeholder + 2 decoded textures (A and B), each destroyed once.
    expect(destroyedTextures).toHaveLength(3);
    expect(new Set(destroyedTextures).size).toBe(3); // no double-destroy
  });
});

describe('core.scene image objects: vertex buffer sizing', () => {
  it('draws exactly as many vertices as the image quad buffer holds at its 4-float (x,y,u,v) stride', async () => {
    // Regression test for the actual "pasting images flashes" root cause:
    // ensureVertexBuffer's vertexCount used to be hardcoded to
    // flat.length / 2 (correct for shape geometry's x,y pairs), so the
    // image quad's x,y,u,v vertices (4 floats each) got vertexCount
    // DOUBLED. WebGPU's draw-call validation then rejects the draw (buffer
    // too small for the requested vertex range), which invalidates the
    // whole command buffer for that submission, so the frame silently
    // falls back to stale/recycled target content instead of the decoded
    // image. This never throws in JS (WebGPU validation errors surface as
    // console warnings, not exceptions), which is why it went unnoticed by
    // exception-based checks.
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 10, height: 10, close: () => {} }));

    let vertexBufferBytes = 0;
    const bufferSizes: number[] = [];
    const draws: Array<{ count: number; boundVertexBufferBytes: number }> = [];
    const rp = {
      setPipeline: () => {},
      setBindGroup: () => {},
      setVertexBuffer: (_slot: number, buffer: { __size: number }) => {
        vertexBufferBytes = buffer.__size;
      },
      draw: (count: number) => draws.push({ count, boundVertexBufferBytes: vertexBufferBytes }),
      end: () => {},
    };
    const device = {
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createSampler: () => ({}),
      createBuffer: (desc: { size: number; mappedAtCreation?: boolean }) => {
        bufferSizes.push(desc.size);
        return {
          __size: desc.size,
          getMappedRange: () => new ArrayBuffer(desc.size),
          unmap: () => {},
          destroy: () => {},
        };
      },
      createBindGroup: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
      queue: { writeBuffer: () => {}, writeTexture: () => {}, copyExternalImageToTexture: () => {} },
    } as unknown as GPUDevice;

    const assets: Record<string, AssetJSON> = {
      assetA: { type: 'image', mime: 'image/png', data: new ArrayBuffer(4), width: 10, height: 10 },
    };
    const ctx: SourceCreateContext = { device, pool: {} as never, getAsset: (id) => assets[id] };
    const instance = scene.create(ctx);
    const node = imageObject('nodeA', 'assetA');
    const frameCtx: FrameContext = {
      device,
      encoder: { beginRenderPass: () => rp } as unknown as GPUCommandEncoder,
      pool: {} as never,
      time: 0,
      frame: 0,
      runPass: () => {},
      borrowScratch: (like) => like,
    };
    const target = mockTarget();

    instance.render(frameCtx, { scene: [node] } as never, target); // kicks decode, draws placeholder
    await Promise.resolve();
    await Promise.resolve();
    instance.render(frameCtx, { scene: [node] } as never, target); // decode landed, draws the real image

    expect(draws.length).toBeGreaterThan(0);
    for (const d of draws) {
      // 16 bytes/vertex (x,y,u,v as f32): the actual imageShaderWgsl stride.
      expect(d.count * 16).toBeLessThanOrEqual(d.boundVertexBufferBytes);
    }
  });
});
