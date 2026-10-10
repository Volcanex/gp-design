/**
 * Bridges 3D scenes published by render.gabrielpenman.com in as live gdesign
 * Sources. render ships an ES module (`scenes.mjs`) exposing plain WebGL
 * scenes keyed by id; each one gets wrapped as `render.<sceneId>` here: a
 * canvas-backed SourceInstance that drives the remote scene's own render
 * loop and uploads its pixels into the OKLab pipeline via the same
 * srgb-decode blit pass core.image uses for uploaded stills.
 *
 * render is a separate, independently-deployed service: it can be slow,
 * down, or serving a stale/broken module. Nothing here may throw past
 * loadRemoteScenes: a dead render must never block gdesign boot or break
 * an otherwise-working document.
 */

import type { SourceDescriptor, SourceInstance, SourceCreateContext, FrameContext } from '../source';
import type { ParamsSchema, ResolvedParams } from '../../params/schema';
import type { PooledBuffer } from '../../gpu/pool';
import { sources } from '../../registry/sources';
import { createPlaceholderTexture, type DecodedTexture } from '../../core/image-decode';

/** render's own scene-side param vocabulary: a float/bool subset of
 * gdesign's ParamSpec, shared verbatim as `RemoteScene.params`. */
export type RemoteParamValue = number | boolean | string;

export interface RemoteSceneInstance {
  /** Synchronous, deterministic in (t, params). Renders into the canvas
   * handed to `create()`, sized to width x height, with
   * preserveDrawingBuffer so this module can read it back via
   * copyExternalImageToTexture. sRGB pixels. */
  renderFrame(t: number, params: Record<string, RemoteParamValue>, width: number, height: number): void;
  dispose(): void;
}

export interface RemoteScene {
  id: string;
  label: string;
  params: ParamsSchema;
  create(opts: { canvas: HTMLCanvasElement }): RemoteSceneInstance;
}

export interface RemoteScenesModule {
  contractVersion: number;
  scenes: RemoteScene[];
}

/**
 * Wraps a raw uploaded GPUTexture as a PooledBuffer so it can be passed to
 * FrameContext.runPass, which only accepts pool-shaped inputs (source.ts,
 * frozen contract). Copied from image.ts's `wrapAsPooledBuffer` rather than
 * imported: that helper is intentionally not exported, and this module's
 * texture lifetime (owned by the SourceInstance, torn down in dispose()) is
 * identical in shape, not identity, to image.ts's.
 */
function wrapAsPooledBuffer(texture: GPUTexture, view: GPUTextureView): PooledBuffer {
  return {
    texture,
    view,
    key: { width: texture.width, height: texture.height, format: texture.format, usage: texture.usage },
    generation: 0,
  };
}

/**
 * `render(ctx, params, target) => ctx.runPass('core.image.blit', ...)`
 * relies on that pass id being registered, a side effect of importing
 * registry/builtins (which imports sources/builtin/image.ts). Every real
 * boot path goes through host/localHost.ts, which imports registry/builtins
 * before any source ever renders, so this module deliberately does NOT
 * import image.ts itself (that would double-register the pass id if both
 * modules' import graphs ever merged). It just relies on builtins having
 * run first, same as any other source.
 */
export function makeRemoteSceneSource(scene: RemoteScene): SourceDescriptor {
  return {
    id: `render.${scene.id}`,
    label: `Render: ${scene.label}`,
    params: scene.params,
    liveByDefault: true,
    create(ctx: SourceCreateContext): SourceInstance {
      let canvas: HTMLCanvasElement | null = null;
      let instance: RemoteSceneInstance | null = null;
      let failed = false;
      let uploaded: DecodedTexture | null = null;
      let placeholder: DecodedTexture | null = null;
      let uploadedSize = { width: 0, height: 0 };

      function ensurePlaceholder(): DecodedTexture {
        if (!placeholder) placeholder = createPlaceholderTexture(ctx.device);
        return placeholder;
      }

      function ensureInstance(): RemoteSceneInstance | null {
        if (failed) return null;
        if (instance) return instance;
        try {
          canvas = document.createElement('canvas');
          instance = scene.create({ canvas });
          return instance;
        } catch (err) {
          failed = true;
          console.warn(`render.${scene.id}: scene.create() threw, falling back to placeholder`, err);
          return null;
        }
      }

      function ensureUploadTexture(width: number, height: number): GPUTexture {
        if (uploaded && uploadedSize.width === width && uploadedSize.height === height) {
          return uploaded.texture;
        }
        uploaded?.texture.destroy();
        const texture = ctx.device.createTexture({
          size: [width, height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        uploaded = { texture, view: texture.createView() };
        uploadedSize = { width, height };
        return texture;
      }

      return {
        render(frameCtx: FrameContext, params: ResolvedParams, target: PooledBuffer) {
          const width = target.key.width;
          const height = target.key.height;
          const inst = ensureInstance();

          if (!inst || !canvas) {
            const { texture, view } = ensurePlaceholder();
            frameCtx.runPass('core.image.blit', [wrapAsPooledBuffer(texture, view)], {}, target);
            return;
          }

          try {
            canvas.width = width;
            canvas.height = height;
            inst.renderFrame(frameCtx.time, params as Record<string, RemoteParamValue>, width, height);
          } catch (err) {
            failed = true;
            console.warn(`render.${scene.id}: renderFrame() threw, falling back to placeholder`, err);
            const { texture, view } = ensurePlaceholder();
            frameCtx.runPass('core.image.blit', [wrapAsPooledBuffer(texture, view)], {}, target);
            return;
          }

          const texture = ensureUploadTexture(width, height);
          frameCtx.device.queue.copyExternalImageToTexture({ source: canvas }, { texture }, [width, height]);
          frameCtx.runPass(
            'core.image.blit',
            [wrapAsPooledBuffer(texture, texture.createView())],
            {},
            target,
          );
        },
        dispose() {
          instance?.dispose();
          instance = null;
          canvas = null;
          uploaded?.texture.destroy();
          uploaded = null;
          placeholder?.texture.destroy();
          placeholder = null;
        },
      };
    },
  };
}

const DEFAULT_URL = 'https://render.gabrielpenman.com/scenes.mjs';
const DEFAULT_TIMEOUT_MS = 4000;

function resolveUrl(override: string | undefined): string {
  if (override) return override;
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('gdRenderScenesUrl') : null;
    if (stored) return stored;
  } catch {
    // localStorage unavailable (non-DOM test env, privacy mode, etc.): fall through to the default.
  }
  return DEFAULT_URL;
}

function isValidModule(mod: unknown): mod is RemoteScenesModule {
  if (!mod || typeof mod !== 'object') return false;
  const m = mod as Record<string, unknown>;
  return m.contractVersion === 1 && Array.isArray(m.scenes);
}

/**
 * Loads render's remote scene module and registers one Source per scene.
 * NEVER throws: render being slow, down, or serving a broken/mismatched
 * module must not affect gdesign boot. Returns the number of scenes
 * registered (0 on any failure, including partial/timeout).
 */
export async function loadRemoteScenes(opts?: {
  url?: string;
  timeoutMs?: number;
  importFn?: (url: string) => Promise<unknown>;
}): Promise<number> {
  const url = resolveUrl(opts?.url);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const importFn = opts?.importFn ?? ((u: string) => import(/* @vite-ignore */ u));

  try {
    const mod = await Promise.race([
      importFn(url),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);

    if (!isValidModule(mod)) {
      console.warn('[gdesign] render scenes unavailable', new Error('invalid or unsupported contractVersion'));
      return 0;
    }

    let registered = 0;
    for (const scene of mod.scenes) {
      const source = makeRemoteSceneSource(scene);
      if (!sources.get(source.id)) {
        sources.register(source);
        registered++;
      }
    }
    return registered;
  } catch (err) {
    console.warn('[gdesign] render scenes unavailable', err);
    return 0;
  }
}
