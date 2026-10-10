# src/engine/sources/remote: bridged scenes from render.gabrielpenman.com

`render-scenes.ts` loads `https://render.gabrielpenman.com/scenes.mjs`, an ES
module render publishes independently, and registers one `SourceDescriptor`
per exported scene (`render.<sceneId>`) so it shows up in the source picker
like any built-in.

## The contract (owned by render, mirrored here as types only)

`{ contractVersion: 1, scenes: RemoteScene[] }`. Each `RemoteScene` is
`{ id, label, params (gdesign's own float/bool ParamSpec subset),
create({ canvas }) => { renderFrame(t, params, width, height): void;
dispose(): void } }`. `renderFrame` is synchronous, deterministic in `(t,
params)`, and renders sRGB pixels into the given canvas with
`preserveDrawingBuffer`. This module owns the canvas (created lazily,
never DOM-attached) and uploads its pixels each frame via
`copyExternalImageToTexture` into a persistent `rgba8unorm` texture (resized
on target-size change, mirroring `core/image-decode.ts`'s upload pattern),
then runs it through `core.image.blit` (the same srgb-decode+OKLab pass
`core.image` uses, registered as a side effect of `registry/builtins`
importing `sources/builtin/image.ts`; this module deliberately does not
import `image.ts` itself to avoid double-registering that pass id).

## Fail-soft is the whole point

render is a separate, independently-deployed service: slow, down, or
serving a stale/broken module must never affect gdesign. Two layers:

- `loadRemoteScenes()` never throws. Timeout (default 4s), import
  rejection, wrong `contractVersion`, or a non-array `scenes` all just
  `console.warn` and resolve to `0` registered.
- Per-scene, `makeRemoteSceneSource()`'s instance catches once if
  `scene.create()` or `renderFrame()` throws, warns, and falls back to a 1x1
  transparent placeholder blit every frame after that (no retry), same
  crash-proofing doctrine as `core.image`'s missing/bad-asset path.

## localStorage override

`loadRemoteScenes()` checks `localStorage.getItem('gdRenderScenesUrl')`
before falling back to the default URL. Lets a dev point at a local render
build without a code change. Guarded in try/catch (non-DOM test envs, e.g.
vitest's node environment, don't have `localStorage`).

## Boot wiring

`src/app/main.ts`'s `boot()` calls `loadRemoteScenes()` before engine init
(so the network fetch overlaps GPU init) and `await`s it immediately before
`mountShell()` (menus enumerate `listSources()` at mount time).
