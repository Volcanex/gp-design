# src/engine: the GPU core

DOM-free. UI imports ONLY `index.ts` (via the `@engine` alias); nothing in
here may import from `src/ui` or `src/app`. This boundary is the future
Worker/Comlink split (M7): everything crossing `host/protocol.ts` must
survive structuredClone (enforced by tests/unit/doc-clone.test.ts).

## Non-obvious constraints

- **Buffers hold OKLab** (L, a, b, straight alpha) in rgba16float. Sources
  convert to OKLab as their last step; `gpu/present.ts` converts to display
  space once (and quantises/dithers, the ONLY 8-bit step). An effect that
  needs RGB declares `metadata.colorSpace: 'rgb'` and run-chain wraps it in
  core.to-rgb/from-rgb passes.
- **Files headed `FROZEN CONTRACT` change only with architect sign-off.**
- `applyEdits(edits) → inverse edits` is the only mutation channel. Async
  engine ops that produce document changes (endStroke, burn) return
  UNAPPLIED forward batches; the UI applies them exactly once via
  patchCommand. Never applyEdits inside those methods.
- Shader entry points: `fs_main` (fragment) / `cs_main` (compute), set by
  `gpu/pipelines.ts`, which also auto-emits all `@group/@binding`
  declarations from the PassDescriptor (engine/params uniforms,
  `input0/samp0…` pairs: declared inputs first, then asset-kind params in
  sorted key order, then `out_tex` for compute).
- Uniforms: Engine struct at a 256-aligned ring offset, Params at the NEXT
  256-byte slot (WebGPU minUniformBufferOffsetAlignment). Convention shared
  between `core/frame.ts` and `gpu/bindings.ts`, keep in sync.
- **WGSL gotcha:** a shader compile error does not throw: passes silently
  render black. `target` is a reserved WGSL word (also `type`, `override`,
  `enable`, `from`, `to`, and more; this has bitten core.gradient's params
  twice). Check the console for CreateShaderModule warnings first, but also
  rely on `tests/unit/registries.test.ts`'s guard test, which walks every
  registered effect/source ParamsSchema and fails if any key collides with
  its `WGSL_RESERVED_WORDS` list: the only backstop, since the failure mode
  itself throws nothing.
- **Bool params pack as u32, not WGSL `bool`** (`gpu/params-ubo.ts`'s
  `layoutOf`): a bare `if (params.flag)`, `!params.flag`, or
  `select(a, b, params.flag)` is a WGSL type error: same silent-black
  failure mode as reserved words, and has shipped broken more than once
  (posterize's `chromaToo`, edge-detect's `invert`, dither-ordered's
  `monoOnly`, grain's `animated`). Always compare explicitly:
  `params.flag != 0u` (or `== 0u` for a negation). `registries.test.ts` has
  a companion (imperfect, regex-based) static guard for the common bare
  forms.
- Two source styles: stateless = a PassDescriptor via
  `sources/from-pass.ts`; stateful (text, scene, 3d, raster, image) = a
  SourceInstance owning its own pipelines/textures directly on ctx.device
  (depth buffers, glyph quads etc. never leave the instance).
- Free-string params (e.g. core.text's `text`) are legal ParamValues with no
  schema entry; `params/resolve.ts` passes schema-less non-track values
  through verbatim. A first-class 'string' ParamSpec kind is a flagged
  follow-up.
- An `{kind:'object'}` setParam target has no generic ParamValues bag
  (ObjectNode is a frozen shape, doc/json.ts). `document.ts`'s `applyEdit`
  special-cases a small, NAMED set of keys instead of adding one. Sanctioned
  keys today: `'content.text'` (TextSpec.text, the text tool's original
  channel), `'content.size'` (TextSpec.size, text objects only), `'content.fill'`
  (ObjectStyle.fill: shape fill OR text colour; both live on `style.fill`,
  not per-content-type, so this one key covers both; absent old fill inverts
  to deleting the key, mirroring the generic bag's undefined-means-delete
  convention). The key names are semantic labels (`'content.fill'` maps to
  `node.style.fill`, not a literal path), matching `content.text`'s existing
  precedent. src/ui/CLAUDE.md's Object-panel section is the UI-facing mirror
  of this list. Keep both in sync when adding another key.
- Scene objects live in `layer.source.params['scene']` as ObjectNode[]
  (see doc/document.ts's `sceneObjects`). Transform/hit-test math is shared
  in `core/transform2d.ts`: render, hitTest and the UI overlay all use it
  so they cannot disagree.
- `commitRaster` mutates asset bytes in place; localHost invalidates all
  raster instances after every applyEdits so undo re-uploads from doc bytes.
- **Stroke commits are region-scoped, not full-canvas** (history-budget
  block, 2026-09). `localHost.ts`'s `endStroke` no longer reads back or
  commits the whole canvas: `raster.ts`'s `RasterStrokeInstance` tracks every
  point pushed since `beginStroke` (independent of `StrokeBatcher`'s
  render-draining queue, which can't answer "what did this whole stroke
  touch?" by endStroke time) and exposes `strokeBounds()`:
  `stroke-batch.ts`'s pure `strokeBounds(points, brushSize, canvasWidth,
  canvasHeight)` expanded by brush radius + 1px (the stamp shader's
  antialiasing band) and clamped to canvas. `readBack(region?)` and
  `readRawRgba16f`'s new optional `origin` then pull back only that rect.
  `commitRaster.region` is that bbox instead of `{0,0,width,height}`; a
  stroke whose bounds come back null (touched nothing, or landed entirely
  off-canvas) commits no edits at all. `applyCommitRaster` (doc/document.ts)
  already cropped correctly to whatever `region` it was given, so nothing
  there needed to change. This took a full-canvas stroke from ~15MB retained
  (commitRaster data + its full-canvas inverse) at 720p down to a few KB–MB
  depending on brush size. See `tests/e2e/memory-soak.spec.ts` and
  `src/ui/CLAUDE.md`'s history-budget note for the app-level byte-budget
  half of this fix.
- Asset-kind params on chain effects resolve through
  `core/asset-textures.ts` (cache keyed by id + byte-signature).
- Burn: removeLayer+addLayer clone pair swaps a layer's source/liveness
  (no setLayerSource op yet; proposed, needs protocol sign-off). Baked
  clips are sampled by the scheduler, skipping source+chain.
- **Baked-clip upload has two paths, keyed on `AssetJSON`'s clip `format`.**
  `core/engine.ts`'s `sampleBakedClip` uploads `rgba16float` frames straight
  into the per-layer WORKING_FORMAT cache texture (unchanged since Wave 0).
  `rgba8unorm` frames (video import's format: smaller footprint, but sRGB-
  encoded straight-alpha bytes, not OKLab) upload into a separate persistent
  `rgba8unorm` staging texture instead, then run `core.image.blit`
  (registered as a side effect of importing `sources/builtin/image.ts`;
  the same srgb_decode+linear_srgb_to_oklab shader `core.image` uses for
  uploaded stills) to convert into the WORKING_FORMAT cache texture. A raw
  `core.blit` (passthrough copy) would silently reinterpret sRGB bytes as
  OKLab and render wrong colours. This is why the rgba8 path reuses
  core.image's conversion pass rather than adding a new one.

## Multi-pass macro effects (FX-MULTIPASS block)

Five hidden sub-passes (no `menuPath`, unreachable from menus, only ever run
via a macro's `expand`): `core.blur-dir` (separable 1D blur along `dir`,
fixed 33-tap kernel, `radius` scales tap spacing not tap count, `boxWeights`
switches gaussian falloff to flat weights, shared by both blur macros),
`core.bright-pass` (L-threshold extract, keeps chroma above threshold, zeros
below), `core.screen-add` (2-input: screens bloom's L onto orig's L, mixes
chroma toward bloom's weighted by contribution), `core.shadow-tint`
(alpha-silhouette recolored to a shadow color, scaled by opacity), and
`core.shadow-composite` (2-input: shadow sampled offset by `offset`px,
composited under `orig` via `porter_duff_over`).

Four user-facing macros compose these: `core.blur-gaussian` and
`core.blur-box` (Effects/Blur/Gaussian, /Box: 2-step blur-dir x then y),
`core.bloom` (Effects/Blur/Bloom: bright-pass, blur x, blur y, screen-add),
`core.drop-shadow` (Effects/Stylize/Drop Shadow: shadow-tint, blur x, blur
y, shadow-composite). Each ships `wgsl: ''` and an `expand()` instead. See
the Contract changelog entry below for the mechanism itself.

`core.displacement` (Effects/Distort/Displacement Map) is a single ordinary
pass, not a macro: its `asset`-kind param is `input1` per `lut.ts`'s
precedent. Leaving the map unset now falls back to a neutral 1x1 mid-grey
texture (added to `core/asset-textures.ts`'s `neutral()` and wired into
`core/frame.ts`'s `resolveAssetInputs`) rather than throwing: mid-grey's
xy recentres to (0,0), so an unset map is identity. This changed
`resolveAssetInputs`'s prior behaviour (it used to throw on *any* missing
asset param); a *set* param pointing at a nonexistent asset id still
throws: only "left unset" is now non-fatal. Not a frozen-contract file,
but shared by every `asset`-kind param (`core.lut` included), so double-
check before relying on "unset asset throws" elsewhere.

**Adding another macro effect:** write hidden sub-passes with no
`menuPath` (register them in `builtins.ts`'s FX-MULTIPASS block); write the
macro descriptor with `wgsl: ''`, a `menuPath`, and an `expand(params)`
returning the sub-pass sequence (`inputs: ['prev','orig']` only needed for
non-default 2-input steps: 1-input steps default to `['prev']`, chaining
off the previous step's output).

**Gotcha (test fixtures, not the engine): an `EffectInstance`/`Chain` item
with `enabled` omitted is silently skipped, identically to `enabled:
false`**. `run-chain.ts`'s `if (!inst.enabled) continue` doesn't
distinguish "explicitly off" from "never set". `tests/e2e/blur.spec.ts`
originally built chain items from a locally-typed array that didn't
require `enabled`, so every call site silently omitted it; the resulting
"blur/bloom read back pixel-identical to the raw input" looked exactly
like the macro `expand()` mechanism not running (it was never reached:
the step never got past the enabled check), and cost real investigation
time before the fixture, not `run-chain.ts` or the registry, turned out
to be the actual cause (confirmed via `tests/unit/run-chain.test.ts`'s
"skips a step with enabled omitted" case, and by checking that
`effects.require('core.blur-gaussian').expand` survives registration
intact: it does; nothing clones descriptors between `builtins.ts` and
`run-chain.ts`). Local chain-item types in tests should require `enabled`
(not make it optional) so a forgotten one is a compile error.

## Known TODOs (flagged in code, not silently absent)

Object chains unrendered; nested-doc/live objects render placeholder rects;
hitTest doesn't descend layer groups; concave `polygon` (explicit `points`)
fill wrong (fan-triangulated); `star` is NOT affected, see the Wave 6 entry
below; mergeDown burns the
single layer (no composite-with-below); timestamp-query profiling not wired
(SwiftShader lacks it; add when chains get slow on real hardware). `localHost.ts`'s clock now plays by default (see
`src/app/main.ts`). A deliberately deferred optimisation: skip the rAF loop
entirely when the loaded document has no live time-dependent sources, instead
of ticking (and re-rendering) a static doc forever.

## Contract changelog

- **2026-07-12 (leak-fix pass):** additive diff to `EngineHost`: optional
  `memoryStats()` (buffer-pool bytes/peak; the statusbar's MB readout).
  GPU-memory lifecycle fixes, motivated by session-long growth freezing
  unified-memory machines: engine gained `dispose()` (destroys clip/mask/
  asset textures, source instances, uniform ring; `localHost` calls it
  before every rebuild and on host dispose), the buffer pool's free-lists
  are aged via `pool.trim(120)` after each rendered frame (trim(0) on host
  dispose), `text-gpu.ts`'s per-string geometry cache is LRU-capped at 256
  (evicted buffers destroyed after `onSubmittedWorkDone`), and `scene.ts`
  evicts per-object caches when objects are deleted. Device loss now stops
  the rAF loop and emits `{type:'error', fatal:true}`. `main.ts` pins a
  persistent reload banner for it.

- **2026-07-07 (Wave 6 shapes, architect-approved):** additive diff to
  `ShapeSpec` (`doc/json.ts`, FROZEN CONTRACT): `shape` union gained
  `'star'` and `'rounded-rect'`; new optional fields `sides` (regular-polygon
  side count, `'polygon'` only, ignored when `points` is set: existing
  arbitrary-point polygons unchanged), `starPoints`/`innerRatio` (`'star'`
  only, named `starPoints` rather than reusing `points` since that field
  already means "explicit vertex list" on this flat interface), `radius`
  (`'rounded-rect'` only). `ObjectStyle` already had `stroke`/`strokeWidth`
  (flat OKLab+alpha tuple + number, not a nested object) from an earlier
  wave, and `scene.ts` already drew fill-then-stroke generically for any
  shape kind. Neither needed a contract change for this block.
  `scene-geometry.ts`'s `ShapePath` (not a frozen file) gained an optional
  `fanOrigin`: `fillTriangles()` fans a full closed loop from it instead of
  from `points[0]` when set. The one new shape (`star`) that's concave but
  star-shaped about its own centre uses this to fill correctly without
  touching the existing points[0]-fan path any other shape relies on. See
  `scene-geometry.ts`'s header comment and `tests/e2e/shapes2.spec.ts` for
  the worked concave-notch proof. `contentBoxOf`/hit-testing were left
  untouched (still the shape's plain width x height box, ignoring stroke
  width), deliberately consistent with rect/ellipse's existing behaviour,
  not a new gap.
- **2026-07-06 (Wave 0, architect-approved):** six additive diffs to frozen
  contracts, all backward-compatible with existing saved documents.
  `ClockCommand` gained `setLoop` (implemented in localHost.ts's own inline
  clock; see `core/loop.ts`'s `wrapLoopTime`, shared with `MockEngineHost`).
  `DocEdit` gained `setDocClock` (replaces `doc.clock` wholesale, inverse
  carries the old clock). `EngineEvent` gained `export-progress` (type only:
  emission is a later export-milestone agent's job). `AssetJSON`'s clip
  variant gained optional `format?: 'rgba16float' | 'rgba8unorm'` (absent =
  rgba16float; engine sampling/upload path is a later agent's job).
  `PassDescriptor` gained optional `expand` for macro effects that compose
  already-registered sub-passes instead of shipping their own `wgsl`;
  `run-chain.ts` runs the macro branch, mapping each sub-step's declared
  `inputs` (`'prev'`/`'orig'`, default `['prev']`) to buffers while preserving
  the ping-pong invariant. `ParamValue` gained `{ lfo: Lfo }` (procedural
  oscillator: sine/triangle/square/noise). `params/resolve.ts`'s `evalLfo`
  resolves it to a live value for `float` specs only (v1 scope); non-float
  specs holding an lfo value fall back to their schema default, and
  `params-form.ts` reads an lfo's `offset` as a static readout so forms don't
  crash on it.
- **2026-07-06 (export upgrade):** `'export-progress'` is now emitted, not
  just typed: `host/localHost.ts`'s `export()` wraps `ExportTargetDef.run`'s
  new optional third arg (`onProgress(done, total, label)`) and re-emits it
  as the engine event; `export/video.ts` calls it once per encoded frame,
  `export/png.ts` calls it 0/1 then 1/1 (single-frame targets still get a
  progress event, just a trivial one). `localHost.ts`'s `export()` also no
  longer clobbers a caller-supplied `options.fps` with `doc.clock.fps`: it
  now does `(req.options?.fps as number|undefined) ?? doc.clock.fps`, so
  UI callers (the export dialog) control frame rate independently of the
  document's playback fps. New export target **`'png-sequence'`**
  (`export/png-sequence.ts`, registered in `registry/builtins.ts`) loops the
  requested range like `video.ts` but encodes each frame as a PNG
  (`png-encoder.ts`, shared with the `'png'` target) and bundles them into a
  single hand-rolled `.tar` (`export/tar.ts`, no dependency, no zip) instead
  of triggering one download per frame. `ExportRequest.target` gained this
  fourth literal (additive, backward-compatible with the frozen contract).
  `ExportTargetDef.run` (registry.ts) gained the optional `onProgress` third
  parameter; existing two-arg call sites still type-check.

## Blend mode inventory (registry/blends.ts, content in registry/builtins.ts)

All 13 blends are pure data: a `fn blend(base: vec4f, src: vec4f) -> vec3f`
WGSL snippet operating directly on OKLab components (`.x`=L, `.y`/`.z`=a/b
chroma), spliced into `core.composite` at call time (see composite.ts's
header comment), never touching RGB. Original five: normal, darken,
lighten, add, multiply. FX-BLENDGEN block added: screen, overlay,
soft-light (all three operate on L, following their classic RGB formulas
verbatim but on the single L channel: one op instead of three per
channel), difference (L delta, chroma delta clamped to `AB_RANGE`), color/
luminosity (swap L vs chroma wholesale between base and src, trivial and
more perceptually correct than Photoshop's RGB->HSL round trip), hue/
saturation (rotate or rescale the a/b chroma vector via atan2/length,
keeping the other operand's L). The blend picker UI reads the registry:
adding a mode never touches UI code.

## Generative sources (FX-BLENDGEN block)

- **core.noise** (`sources/builtin/noise.ts`): stateless, `sourceFromPass`
  like plasma.ts. Modes simplex/fbm/curl share `wgsl/snippets/noise.wgsl`
  (2D simplex, fbm with configurable octaves/lacunarity/gain, and the curl
  of that fbm field). `seed` is a domain offset (`noise_seed_offset`, via
  `hash21` from the `common` include), not a permutation reseed: same
  seed+scale+time always reproduces the same field. `speed` drifts the
  sampled position diagonally over time (simplex2d has no time axis).
- **core.feedback** (`sources/builtin/feedback.ts`): the stateful
  generative one: composited trails of everything below it, decaying over
  time. Owns a ping/pong GPUTexture pair (persistent, `TEXTURE_BINDING |
  COPY_DST`, recreated on resize, both destroyed in `dispose()`): sample
  from one, `copyTextureToTexture` this frame's `target` into the other,
  then swap, so a pass never samples and writes the same texture in one
  draw. Its transform pass (`core.feedback`) is registered into the
  `effects` registry by hand with no `menuPath` (mirrors `core.image.blit`
  in image.ts) so it can't be reached from the Effects menu directly.

## The backdrop contract (`wantsBackdrop` / `setBackdrop`)

Additive diff to the frozen Source contract (sources/source.ts, 2026-07-07,
architect-approved, FX-BLENDGEN block): `SourceDescriptor` gained optional
`wantsBackdrop?: boolean`; `SourceInstance` gained optional
`setBackdrop?(backdrop: PooledBuffer): void`. Both optional: no existing
source changes. core/engine.ts's `renderNodes` calls
`getSource(node).setBackdrop?.(accumulator)` just before rendering any
enabled, non-baked layer whose descriptor has `wantsBackdrop`. `accumulator`
is everything below that layer, already composited, for THIS FRAME ONLY.
**The backdrop is pool-scoped scratch: an instance may sample it during that
same render() call, but must never retain the reference past it** (copy to
a persistent texture first if longer-lived content is needed; core.feedback's
own ping-pong pair is the reference pattern: it captures a copy of `setBackdrop`'s
buffer during render(), immediately clears its own field afterward, and falls
back to a 1x1 transparent placeholder if render() ever runs with no backdrop
set that frame).

core.feedback is the only current user: it composites this frame's backdrop
ON TOP of its own faded prior trail ("trails-under": fresh content stays
crisp, history decays behind it), then persists the composited result as
next frame's trail. `fade` decays the trail's alpha only, not its L/chroma
(see feedback.ts's module doc comment): straight-alpha `over` reproduces a
fully-opaque backdrop's exact color from frame one regardless of alpha, so
decaying L directly would darken future re-composites instead of letting
the trail dissolve away; what genuinely converges over frames is the
trail's PREMULTIPLIED brightness (`L * alpha`), not raw `L`. See
tests/e2e/blendgen.spec.ts's accumulation/decay proof for the worked math
(a fully-opaque base layer also leaves the trail no memory to accumulate at
all; that test's base layer opacity is deliberately < 1).

Renderer wiring is exercised only by e2e (tests/e2e/blendgen.spec.ts):
`createEngine()` eagerly calls real GPU device methods at construction
(`gpu/present.ts`'s `createPresenter`), and this repo's unit tests are
WebGPU-free by convention (tests/CLAUDE.md). There's no lightweight fake
device path for testing `renderNodes` itself in isolation. The
`wantsBackdrop` descriptor flag (a plain boolean) is covered by
tests/unit/registries.test.ts.

## GPU resource lifetime (the "pasting images flickers" postmortem)

Two related rules, both found the hard way while chasing a real flicker
report on image-object paste/import (core.scene's image objects,
`sources/builtin/scene.ts`):

- **Never `destroy()` a buffer/texture that the current or a previous
  (still in-flight/queued) frame may still reference.** A resource shared
  across multiple in-flight consumers (e.g. `core/image-decode.ts`'s
  placeholder texture, handed to every still-decoding image object) must
  only ever be destroyed once nothing can possibly reference it. In
  practice that means the owning `SourceInstance.dispose()`, not an
  opportunistic cleanup the moment ONE consumer stops needing it. If a
  resource's ownership is genuinely shared, either defer destruction (a
  small queue flushed N frames later) or simply don't destroy it until
  dispose. The second is what scene.ts's `ensureImage`/`beginImageDecode`
  does: it checks `prev.texture !== sharedPlaceholder?.texture` before
  destroying, so a per-node decode landing never destroys the placeholder
  other still-pending nodes are sampling.
- **A vertex buffer's `vertexCount` must match its ACTUAL floats-per-vertex,
  not an assumed constant.** This was the real root cause of the flicker,
  not the shared-texture rule above (which was a real bug too, just not
  the dominant one): `ensureVertexBuffer` hardcoded `vertexCount =
  flat.length / 2`, correct for shape geometry's x,y-only vertices, wrong
  for the image quad's x,y,u,v (4 floats/vertex), which silently doubled
  the requested vertex count. WebGPU's draw-call validation rejects a
  `draw()` whose vertex range exceeds the bound buffer, which invalidates
  the WHOLE command buffer for that submission, so the frame falls back
  to whatever the recycled target buffer already held (stale or cleared),
  alternating with correctly-rendered frames on adjacent submissions. **This
  never throws in JS**: WebGPU validation failures surface only as
  `console` warnings (`page.on('console')`, not `pageerror`), so an
  exception-based check (try/catch, `.catch()`, even `renderNow`'s own
  render-error recovery) cannot see it. Proving and fixing this needed
  `tests/e2e/paste-stability.spec.ts`'s pattern: collect console warnings
  under forced presentation (`__GDESIGN_FORCE_PRESENT`, see
  `gpu/device.ts` and `tests/e2e/present.spec.ts`) AND compare consecutive
  readbacks byte-for-byte once decode settles. A silent validation
  failure is invisible to pixel-diff assertions that don't check for
  alternation across repeated calls.

**Per-layer/per-asset cache eviction (MEMORY-EVICTION block, 2026-09-09):**
`core/engine.ts`'s `reconcile()` runs after every `applyEdits` batch:
forward, undo, AND redo, since `localHost.ts`'s `applyEdits` is the one
channel all three go through. It destroys `sourceCache`/`clipTextureCache`/
`maskTextureCache` entries whose layer id no longer exists anywhere in the
doc (`doc/document.ts`'s `evictedLayerIds`, walking groups), drops
`assetGenerations` entries for asset ids no longer in `doc.assets` at all,
and calls `core/asset-textures.ts`'s `evict()` with the set of asset ids
still reachable from any layer's source params, mask, or any chain's
asset-kind params (`doc/document.ts`'s `liveAssetIds`, deliberately a
superset of what the asset-textures cache actually keys on, so an id is
never dropped while anything still points at it). **Undo needs no special
"recreate" step**: all three per-layer caches are populated lazily
(`getSource`/`sampleBakedClip`/`resolveMaskTexture` each check-then-create),
so a layer undo brings back just looks like a layer rendering for the first
time to the very next frame: the boot-time path, not a separate one.
`localHost.ts`'s `memoryStats()` folds `engine.memoryBytes()` (the clip/mask
caches here plus `asset-textures.ts`'s own tracked bytes) in alongside
`pool.stats()`, so this eviction is actually visible in the statusbar/
memoryStats reader, not just an internal accounting change. See
`tests/e2e/memory-eviction.spec.ts`.

**The chain-scratch leak (fixed 2026-09-09).** `core/frame.ts`'s
`borrowScratch` used to call the raw `pool.borrow()` directly rather than
the `borrow` callback `BufferPool.scope()` hands its caller, so every
scratch buffer `run-chain.ts` allocated for a chain step never entered the
scope's tracking list and was never returned: one full-canvas texture per
chain step per frame, forever, invisible to `trim()`. Measured at 720p with
a two-effect layer: ~15 MB per rendered frame (494 MB after 30 frames,
1.38 GB after 90). This, not the free-list growth d07d5d1 fixed, was the
practical "the machine locks up once I add an effect" leak. Fix:
`FrameContextDeps.borrow` carries the scope's tracked borrow and
`borrowScratch` uses it; both `createFrameContext` call sites in
`core/engine.ts` pass `borrow`. Regression: `tests/e2e/chain-scratch.spec.ts`
(pool bytes flat between frame 30 and frame 90 with a chain applied).
Rule: render code must never reach `pool.borrow()` directly; if a new
context ever needs a buffer, it takes the scoped `borrow`.
`tests/e2e/memory-eviction.spec.ts`'s layers still carry masks and empty
chains, which is fine: that spec is about cache eviction, not scratch.

## Adjustment layers (ADJUST block, 2026-07-07, architect-approved)

No new doc schema: a `Layer` whose `source.type === 'core.adjustment'` IS an
adjustment layer (`sources/builtin/adjustment.ts`, a `sourceFromPass`-wrapped
sentinel: no params, no inputs, its own `render()` writes fully transparent).
`core/engine.ts`'s `renderNodes` intercepts every enabled, non-group layer of
that source type BEFORE the usual `renderNodeContent` call: instead of
rendering the layer's own content, it runs the layer's chain against the
CURRENT ACCUMULATOR (`runChain(node.chain, accumulator, ctx)`), and that
chained result becomes the "layer output" fed into the ordinary
`core.composite` step alongside the layer's own `blendMode`/`opacity`,
identical shape to every other layer, just with the chain's input swapped
from "this layer's own render" to "everything already composited below it".
This is why opacity 0.5 on an adjustment layer means half-strength (a linear
lerp between the pre-chain accumulator and the fully-chained result, same as
any other layer's opacity), and why an empty chain is a visual no-op
(compositing the accumulator over itself). A layer ABOVE an adjustment layer
is unaffected: it composites onto the accumulator as normal, adjustment
included; an adjustment layer moved below everything sees an empty (cleared)
accumulator and adjusts nothing.

**Baked/liveness paths don't apply.** Adjustment layers can't be baked: the
renderNodes branch above runs unconditionally by `source.type`, never
consulting `node.liveness` (new adjustment layers are created `liveness:
'live'` in `app/commands/registry.ts`'s `newAdjustmentLayer`, but nothing
currently reads it for this source type either way). **`renderSubtree`
(burn's frame-pull accessor) does NOT take the renderNodes branch**: it
calls `renderNodeContent` directly with no accumulator at all, so burning an
adjustment layer standalone gets the chain applied to the source's own
transparent fallback render (i.e. "nothing below", the honest answer, not
an attempt to reconstruct what was below it at burn time). This is the one
documented limitation: merge-down/flatten/burn of an adjustment layer alone
is not meaningful the way it is for an ordinary layer.

UI: `layer.newAdjustment` command (Layers menu "New Adjustment Layer" +
Adjustments menu's leading "New Adjustment Layer…" bridge item, both in
`app/commands/registry.ts` / `ui/shell/menubar.ts`) inserts one above the
active layer via the standard `siblingInsertPoint` pattern. The F9 Effects
panel needed ZERO changes: it already edits whatever layer is active, so an
adjustment layer's chain is immediately visible/editable there, and the
Adjustments/Effects menus' `effect.open` already targets the active layer
when no explicit target is given (`effect-dialog.ts`'s fallback path). The
layers panel row shows a `ph-circle-half` indicator icon
(`gd-layer-adjustment-icon`) for `source.type === 'core.adjustment'` rows.
## Layer masks (MASKS block, 2026-07-07, architect-approved)

Additive diffs to two frozen contracts: `Layer` (doc/json.ts) gained
optional `mask?: { asset: string; enabled: boolean; invert: boolean }`. The
mask is a raster asset (same format paint layers use); its **L channel is
the mask value**, 1 = opaque/keep, 0 = hidden. `DocEdit` (host/protocol.ts)
gained `setMask` (replaces a layer's `mask` wholesale, `null` removes it,
inverse carries the old value). Both absent-by-default, so every existing
document stays valid. Groups don't get masks (`Layer`-only field).

**Rendering:** `core/engine.ts`'s `renderNodeContent` runs a hidden pass,
`core.mask-apply` (`passes/builtin/mask-apply.ts`, no `menuPath`, 2 declared
inputs: content, mask), right after a layer's own source+chain content is
resolved, whenever `node.mask?.enabled`: `out.alpha = content.alpha *
(invert ? 1-mask.L : mask.L)`, `out.rgb` untouched. The mask texture itself
is resolved by a small per-layer-id cache (`maskTextureCache`, mirrors
`sampleBakedClip`'s `clipTextureCache` in the same file) that uploads
straight from the raster asset's raw rgba16float bytes (the same upload
`sources/builtin/raster.ts`'s `loadFromAsset` does for a layer's own backing
store) and re-uploads when the asset's invalidation generation changes
(`EngineHost.invalidateAsset(id)`, additive diff 2026-07-08: in-place byte
mutators (mask painting's live preview and its undo/redo) MUST call it,
because the byte-sampling signature shipped first was structurally blind:
its stride divided the row length exactly, so it only ever sampled column
0 and a brush stamp anywhere else never re-uploaded) or the asset's
ArrayBuffer identity changes (wholesale replacement). A missing or
wrong-type mask asset warns once per layer id and renders unmasked instead
of throwing (the crash-proofing doctrine). It does NOT fall back to a
neutral/identity texture like `asset-textures.ts`'s chain-param path, since
`resolveMaskTexture` returning null just means "skip the mask pass
entirely" here.

**Painting a mask (UI, `src/ui/canvas/mask-paint.ts`):** a mask is not a
real `Layer`, so brush/pencil/eraser strokes at it can't go through the
frozen `StrokeConfig`/`beginStroke`/`EngineHost` GPU path (which requires an
actual `core.raster` layer, see `localHost.ts`'s `beginStroke` guard):
adding a field to those frozen types wasn't part of this diff's sign-off.
Mask painting is instead a small CPU-side stroke rasterizer mirroring
`sources/builtin/raster.ts`'s `rasterStampPass` coverage math (round
capsule falloff), mutating `doc.assets[id].data` in place during the drag
(live preview: the mask texture cache above picks up the byte-signature
change on the next `requestFrame()`) and committing ONE `uiCommand` (not a
`DocEdit` batch) per stroke whose run()/undo() just re-write the captured
post-/pre-stroke bytes. See `src/ui/CLAUDE.md`'s mask-edit-mode section for
the UI-side routing (`resolveStrokeTarget`, MASK EDIT MODE).

## Readback via 'float' is OKLab, not sRGB

`host.readback({ via: 'float' })` returns the raw accumulator, which holds
OKLab (L, a, b, straight alpha) per the buffer non-negotiable, not sRGB.
Callers must not run it through `srgbToOklab` (that double-converts); use the
components directly. `src/ui/canvas/paint-tool.ts`'s colour picker is the
reference caller. Also note: the engine ignores `ReadbackRequest.region` and
always returns the full accumulator at the document's pixel size. Callers
that want a single pixel must sample it themselves out of the full buffer
(clamped/rounded), not assume a cropped 1x1 result.
