/**
 * Adapter/device acquisition, canvas context configuration, and capability
 * detection. `canvas === null` is the headless path (tests, export-only
 * workers): DeviceBundle.context is null and present.ts's toQuantised()
 * path is used instead of present().
 */

import type { EngineCaps } from '../core/types';
import type { DeviceBundle, InitDevice } from './interfaces';

const NO_ADAPTER = 'gpu/device: navigator.gpu.requestAdapter() returned null (no WebGPU adapter available)';

async function detectFloat16Renderable(device: GPUDevice): Promise<boolean> {
  // rgba16float render-attachment support is guaranteed by the WebGPU core
  // spec (no optional feature gates it), but probe defensively: create a
  // 1x1 render target and confirm the pipeline validates without error.
  try {
    device.pushErrorScope('validation');
    const tex = device.createTexture({
      size: [1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const view = tex.createView();
    const enc = device.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'discard' }],
    });
    rp.end();
    device.queue.submit([enc.finish()]);
    tex.destroy();
    const error = await device.popErrorScope();
    return error === null;
  } catch {
    return false;
  }
}

function detectDisplayP3(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(color-gamut: p3)').matches;
}

export const initDevice: InitDevice = async (canvas, outputColorSpace) => {
  const gpu = navigator.gpu;
  if (!gpu) throw new Error('gpu/device: navigator.gpu is unavailable (no WebGPU support)');

  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error(NO_ADAPTER);

  const device = await adapter.requestDevice();
  const presentFormat = gpu.getPreferredCanvasFormat();

  let context: GPUCanvasContext | null = null;
  // Environment bug (confirmed with a raw-WebGPU repro on this host's
  // headless SwiftShader build): configuring a canvas swapchain permanently
  // breaks GPUBuffer.mapAsync on the device ("A valid external Instance
  // reference no longer exists"), which kills readback, and readback is the
  // only way tests can assert pixels. Skip presentation there; readback
  // still exercises the identical present math via Presenter.toQuantised.
  const isSwiftShader = (adapter.info?.architecture ?? '') === 'swiftshader';
  // Test hook: forces swapchain config even on SwiftShader so the REAL
  // presentation path (the only one users see) runs under e2e. Readback
  // breaks after presenting there (the mapAsync bug above), so the present
  // smoke test asserts on validation warnings instead of pixels.
  const forcePresent = (globalThis as { __GDESIGN_FORCE_PRESENT?: boolean }).__GDESIGN_FORCE_PRESENT === true;
  if (canvas && (!isSwiftShader || forcePresent)) {
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) throw new Error('gpu/device: canvas.getContext("webgpu") returned null');
    ctx.configure({
      device,
      format: presentFormat,
      colorSpace: outputColorSpace,
      alphaMode: 'opaque',
    });
    context = ctx;
  }

  const [float16Renderable, displayP3] = await Promise.all([
    detectFloat16Renderable(device),
    Promise.resolve(detectDisplayP3()),
  ]);

  const caps: EngineCaps = {
    adapterInfo: {
      vendor: adapter.info?.vendor ?? 'unknown',
      architecture: adapter.info?.architecture ?? 'unknown',
    },
    float16Renderable,
    float32Filterable: adapter.features.has('float32-filterable'),
    timestampQueries: adapter.features.has('timestamp-query'),
    preferredCanvasFormat: presentFormat,
    displayP3,
  };

  const bundle: DeviceBundle = { device, context, caps, presentFormat };
  return bundle;
};

/** Registers the device-lost callback for a bundle created by initDevice. */
export function onDeviceLost(device: GPUDevice, cb: (info: GPUDeviceLostInfo) => void): void {
  device.lost.then(cb);
}

export interface UncapturedGpuError {
  kind: 'oom' | 'validation' | 'internal';
  message: string;
}

/**
 * Routes WebGPU errors that no error scope caught. Each distinct message
 * reaches the callback once: a validation error inside the per-frame render
 * would otherwise fire at frame rate for the rest of the session.
 */
export function onUncapturedError(device: GPUDevice, cb: (err: UncapturedGpuError) => void): void {
  const seen = new Set<string>();
  device.addEventListener('uncapturederror', (ev) => {
    const error = (ev as GPUUncapturedErrorEvent).error;
    const kind: UncapturedGpuError['kind'] =
      error instanceof GPUOutOfMemoryError ? 'oom'
      : error instanceof GPUValidationError ? 'validation'
      : 'internal';
    const message = error.message || kind;
    if (kind !== 'oom') {
      if (seen.has(message)) return;
      seen.add(message);
    }
    cb({ kind, message });
  });
}
