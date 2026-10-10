# src/ui + src/app: the paint.net face

lit-html templates + a ~40-line Store; no framework runtime. Engine access
is ONLY through the EngineHost facade and `@engine` types.

## Non-obvious constraints

- **No per-effect UI files, ever.** Menus build from `listEffects()`
  menuPaths; parameter panels generate from ParamsSchema
  (`forms/params-form.ts`). A new engine effect must get UI for free:
  breaking this invariant is review-blocking.
- All document mutations go `patchCommand(label, edits)` →
  `history.push(app, cmd)` (singleton in `app/commands/app-history.ts`).
  Never call `engine.applyEdits` directly from a panel, except live
  previews (effect dialog), which apply directly and MUST revert before
  pushing the single real command.
- Stores are module singletons in `app/stores.ts` (not threaded through
  AppCtx). layoutState persists to localStorage key `gdesign.layout.v1`,
  debounced 250ms; `flushLayoutSave()` writes any still-pending save
  immediately and is wired to `pagehide`/`beforeunload` so a panel moved
  right before a reload isn't lost to the debounce window.
  `stores.ts` also owns `statusMessage`/`showStatusMessage(text)`: a
  transient statusbar toast (auto-clears after 5s) for things like a failed
  image import; `statusbar.ts` renders it as `[data-testid="status-message"]`.
- File > New/Save/Open: `New` (`dialogs/new-document.ts`) builds a doc via
  `emptyDocument` + boot's two-layer pattern and loads it through
  `loadFreshDocument`, which also clears undo history and re-fits the view:
  reuse that helper for anything else that swaps the whole document. `Save`
  and `Open` (.gdesign.json) round-trip through
  `app/commands/doc-serialize.ts`, which base64-wraps `ArrayBuffer` asset
  bytes (image/lut/font/raster/clip data) since plain `JSON.stringify` drops
  them silently. Don't serialize a `DocumentJSON` any other way.
- Keymap SSOT is `app/keymap/bindings.ts`; `executeCommand` tries
  `shellExecute` (UI-only commands) first, then the registry table.
  Menu hints render via `formatKeys(commandId, args)`. It matches on command
  id AND args (deep-equal), not id alone, because every generated Effects/
  Adjustments item shares the one `effect.open` command id and differs only
  by args. `menubar.ts` must always pass `item.args` through.
- Dialog keyboard gating: `dialog-shell.ts`'s `openDialog` calls
  `setDialogOpen(true)`/`(false)` around its own lifetime (every close path (
  OK, Cancel, Escape) funnels through one `close()`), and focuses the first
  focusable control on open. `keymap.ts`'s `resolveBinding` uses that flag to
  suppress canvas-scoped (`when: 'canvas'`) bindings while any dialog is open.
  Any new modal must go through `openDialog`, not roll its own chrome, or it
  won't get this for free. `onOk` may return `void` (closes immediately, the
  original behaviour every other dialog still relies on) or a `Promise<void>`
  (closes only once it resolves: lets a dialog stay open and keep
  rerendering, e.g. live progress, for the duration of an async action).
  `okDisabled?(): boolean` is re-evaluated every `rerender()` to grey out the
  OK button. `dialogs/export-video.ts` is the reference caller for both.
- Effect dialog live preview (`dialogs/effect-dialog.ts`): a label-scrub drag
  (`forms/params-form.ts`'s `startScrub`) attaches its own window-level
  mousemove/mouseup listeners that only detach on an actual mouseup. Closing
  the dialog doesn't touch them. `effect-dialog.ts` tracks a `closed` flag set
  by both onOk and onCancel so a leaked in-flight scrub can't resurrect the
  effect via a debounced `preview()` firing after `revertToSnapshot()`.
- lit-html owns panel DOM: never splice elements by hand inside a panel
  (re-renders wipe them: rename input bug, Phase 1). Interactive state
  belongs in the template. Don't `setPointerCapture` on containers with
  clickable children: capture retargets derived click events.
- Panels re-render on document-changed + history + tool/view/selection
  stores (wired in `shell/shell.ts`); they are pure functions of
  doc + stores.
- Selection overlay (`canvas/select-tool.ts`) is DOM, sized to match the
  canvas element exactly; bounds math comes from `@engine`'s transform2d
  re-exports. Do not reimplement.
- **Tools-panel hints are DERIVED, never hand-written.** `panels/tools.ts`'s
  `toolKeyHint(id)` scans `bindings.ts` for the `tool.cycle` binding whose
  args include that tool id. A hardcoded per-tool `key` field drifted from
  the real keymap (7/15 wrong) and is gone for good. `app/tool-registry.ts`
  is the other half: `DISABLED_TOOLS` (select-lasso, select-wand, clone,
  recolor: no working implementation) is read by both the panel (dimmed
  button, "Not implemented yet" tooltip, click no-ops) and
  `shell-commands.ts`'s `cycleTool` (skipped when stepping through a
  `tool.cycle` group). No tool button may be a silent no-op: it either does
  something or visibly says it doesn't. Note DISABLED_TOOLS' 4 ids don't map
  to 4 buttons: `panels/tools.ts`'s `TOOLS` array has one button for the
  whole select-* family (`select-rect` stands in for all four), so
  select-lasso/select-wand have no button at all to disable: only
  clone/recolor render a disabled button (2, not 4).
- **Bucket fill is a pure CPU flood fill, not a GPU pass**: `canvas/flood-
  fill.ts` is engine-free (no `@engine` import) and operates on an already-
  decoded `Float32Array` of OKLab+alpha (or `null` for "no raster asset yet",
  which reads as an all-transparent canvas): a scanline flood fill (not a
  naive per-pixel BFS queue) from the seed point, matching every 4-connected
  pixel whose OKLab+alpha euclidean distance from the SEED's colour is within
  `tolerance`. Two fully-transparent pixels always match regardless of
  L/a/b (those channels are meaningless once alpha is ~0). A hard
  `MAX_VISITED_PIXELS` (4M) cap bails out of runaway fills with a
  `console.warn` and a partial (still internally consistent) result rather
  than hanging. `canvas/raster-codec.ts` owns the rgba16float
  `Float32Array` encode/decode (a deliberate small duplicate of
  `engine/gpu/readback.ts`'s private f16 conversion: the UI boundary only
  ever touches the engine through `@engine`, and neither direction is
  exported there); `canvas/bucket-tool.ts` wires the two together: resolves
  the target layer via `resolvePaintLayer` (never refuses), decodes its
  raster asset if one exists, floods from the click point at
  `toolState.bucketTolerance` (clipped to `selectionState.marquee` when one
  exists), and commits the result as ONE undo step: `commitRaster` alone if
  an asset already exists, or `addAsset` + `setParam` + `commitRaster` for a
  brand-new one, mirroring the exact edit shape `localHost.ts`'s
  `endStroke()` builds for a first brush stroke (so `applyEdits`'s
  `invalidateRasterInstances` resyncs the GPU texture the same way). Because
  `commitRaster` overwrites its ENTIRE region rect (not just individually
  matched pixels, see `document.ts`'s `applyCommitRaster`), `floodFill`'s
  result data covers the flood's tight bounding box with the fill colour
  where matched and the ORIGINAL pixel colour everywhere else in that
  bbox, needed because a non-convex filled region (e.g. filling inside a
  ring) still has a rectangular bbox that includes untouched pixels.
  `ToolState.bucketTolerance` is optional/additive (same pattern as
  `PanelPlacement`'s `w`/`h`) so existing full-object `toolState.set({...})`
  call sites don't need to change; `stores.ts`'s `DEFAULT_BUCKET_TOLERANCE`
  is the fallback wherever it's read. The Tools panel only renders the
  tolerance slider when the bucket tool is active.
- **Tool handlers are one ToolHandler chain**, combined in `app/main.ts` via
  `combineToolHandlers(...)` and installed once through
  `viewport.setToolHandler`. Each handler (select/paint/gradient/line-
  shapes/text) checks the active tool id itself and no-ops otherwise. New
  tool behaviour is a new handler added to that list, never a second
  dispatch path. `viewport.ts` owns canvas pointer/wheel events and pan; it
  does not know about individual tools beyond routing non-pan events to the
  installed handler.
- **Marquee selection** (`select-rect`/`select-ellipse`, in
  `canvas/select-tool.ts`): drag writes a live rect into
  `selectionState.marquee` (drawn as a dashed `.gd-marquee-box` in the same
  overlay div the move-tool's selection box uses); on release it resolves
  `selectionState.objects` to whichever scene objects' bounding boxes
  (rotation ignored: a bbox simplification, not an exact hit test) overlap
  the marquee, searching every ENABLED scene layer at any depth (through
  groups, mirroring `localHost.ts`'s `hitTest`), but **keeps the rect
  itself** (doesn't null it), because `registry.ts`'s `edit.fillSelection`
  needs it to outlive the drag. A release with ~zero drag distance (a plain
  click) deselects and clears the rect, UNLESS Shift is held (see below).
  `select-lasso`/`select-wand` are DISABLED_TOOLS: no polygon/flood-fill
  selection yet. `edit.fillSelection` (Edit menu) fills the kept rect on a
  raster layer by stamping a dense round-brush grid across it via the
  existing stroke API: no rect-fill primitive exists, so corners round off
  slightly at low brush sizes; a no-op with no marquee.
- **Selection keys and multi-select (Wave 5).** Escape is a pure deselect
  (`selectionState.set({objects:[],marquee:null})`), window-level in
  `select-tool.ts`, suppressed while a text input has focus
  (`isTextEditingTarget`). Bare Delete/Backspace (same listener, same
  text-input guard, still guarded against modifiers so it doesn't shadow
  Ctrl+Shift+Delete/`layer.delete`) instead routes to `registry.ts`'s
  `edit.deleteSelected`: objects selected → `removeObject` them all in ONE
  undo step, then clear the selection; only a marquee (no objects) → clear
  the marquee; nothing selected → no-op. (An earlier version made bare
  Delete a second deselect key. That was reverted; Delete now matches
  every other editor's convention.) Ctrl+A (`edit.selectAll`) selects every
  scene object across every enabled layer/group
  (`registry.ts`'s `allSceneObjectIds`, same enabled-layer/group descent as
  the marquee and `hitTest`). Shift+click (move tool) TOGGLES the hit
  object in/out of `selectionState.objects` (an array, so multi-select was
  already the state shape: this just adds the affordance) instead of
  replacing the selection; a toggle-OFF never arms a drag. Shift+marquee
  UNIONS its hits into the existing selection instead of replacing it;
  shift+click-with-no-hit (either tool) is a no-op, never a clear. Only a
  NON-shift click/marquee on empty space still deselects. This is why
  `viewport.ts`'s `isPanTrigger` carves out an exception: Shift is claimed
  for pan globally (see that file's own section below) EXCEPT on
  move/select-rect/select-ellipse, where Shift+click/drag needs to reach
  `select-tool.ts`'s handler instead. `ToolPoint` grew an optional
  `shiftKey` field (`viewport.ts`'s `toDocPoint`) for this; every other tool
  handler ignores it. The selection overlay (`mountSelectionOverlay`) draws
  a box for EVERY selected object, but interactive resize/rotate handles
  only on the PRIMARY one (the last id in `selectionState.objects`, since
  shift-click/shift-marquee both append). Group-transform resize isn't
  part of this pass, so a non-primary box is a plain (dimmer,
  `.gd-selection-box--secondary`) outline with no handles. Arrow keys nudge
  every selected object 1px (Shift+arrow = 10px) via `edit.nudge`; EACH
  KEYPRESS IS ITS OWN UNDO STEP, deliberately: reusing `patchCommand`'s
  generic `setTransform:${id}` merge identity would risk silently
  coalescing a nudge into an unrelated PRIOR command on the same object (a
  drag or handle-resize that just finished), since that identity only keys
  on object id, not on "why"; `registry.ts`'s `nudgeCommand` is a bare
  run/undo pair with no `mergeWith` at all, so bursts of held-arrow presses
  land as separate stack entries. Per-press steps were called out as an
  acceptable simplification for this pass rather than a real bug.
- **Move-tool double-click is detected at UP time**, on two consecutive
  completed CLICKS (down+up with ~no drag) on the same object within the
  window, NOT "a second down soon after a first down". The latter
  (an earlier version) fired on an ordinary click-then-immediately-drag: the
  drag's `down()` looked close enough in time to the prior click to be
  treated as a double-click, silently swallowing the drag instead of moving
  the object (a real regression once real usage (click to select, then
  immediately drag) hit it; `scene.spec.ts`'s move-tool test catches it).
- **Text editing is the only way to set object text.** `canvas/text-tool.ts`
  mounts one floating `<textarea>` (positioned like the selection overlay:
  a wrapper div kept at the canvas's exact width/height/transform, so
  `docCornersToCanvasPx`'s zoom-only math is correct without separate
  offset bookkeeping). The Text tool's click inserts an empty text object at
  that point (`registry.ts`'s `insertTextAt`) and opens the editor on it
  immediately; the Move tool's double-click (detected inside
  `select-tool.ts`'s existing hit-test `down()`/`up()`, not a second canvas
  listener) reopens it on an existing text object. Enter (no shift) or blur
  commits `content.text` via `patchCommand`. `document.ts`'s `setParam`
  special-cases `target.kind === 'object'` + `key === 'content.text'`
  precisely for this (ObjectNode has no generic ParamValues bag; see that
  file's comment). Escape cancels without writing. **The editor's
  `.focus()` call is deferred one `setTimeout(0)`** past opening: it opens
  from inside the canvas's own pointerdown handler, and the browser's
  default mousedown focus handling (which runs AFTER that handler returns)
  otherwise steals focus straight back to the canvas/body, instantly
  blurring the textarea and firing `commit()` before a single keystroke.
  Reproduced and fixed via e2e, not obvious from a unit test alone since
  fake-DOM focus timing differs from a real browser's.
- **Gradient and Shapes tools create content, not new architecture.**
  Gradient (`canvas/gradient-tool.ts`) drags a `core.gradient` layer's
  `from`/`to` (normalized to `[0,1]` doc-uv, same space as `in.uv`) with
  `colorA`/`colorB` defaulted from the current primary/secondary. See
  `engine/sources/builtin/gradient.ts` for the WGSL and why its enum param
  is named `gradType`, not `type` (a reserved WGSL word). Shapes
  (`canvas/line-shapes-tool.ts`) drags a sized rect object via
  `registry.ts`'s `insertDraggedShape`, the same `insertObject` plumbing the
  Insert menu's fixed-size commands use. Line (same file) commits one
  straight stroke on release only (no live preview) via the shared
  `resolvePaintLayer`/`commitStrokeEdits` helpers in `canvas/paint-layer.ts`,
  factored out of `paint-tool.ts` so brush/pencil/eraser/line don't
  duplicate the raster-layer-resolution logic.
- **`viewState.activeLayer` is a hint, never a filter that can make a tool
  refuse.** Every tool that needs "a layer of kind X" resolves one through a
  resolve-or-create chain, active layer (if already the right kind) →
  topmost layer of that kind in the doc (made active) → auto-create one
  (its own undo step, then made active), and NEVER just checks activeLayer
  and bails with a console-only message. `paint-layer.ts`'s
  `resolvePaintLayer` (raster) established the pattern; `registry.ts`'s
  `resolveSceneLayer` (core.scene, used by `insertObject`/
  `insertDraggedShape`/`insertTextAt`) mirrors it exactly. A verification
  probe caught the fallout of NOT doing this everywhere: painting one brush
  stroke reassigns activeLayer to the raster layer it just used
  (`resolvePaintLayer`'s own contract), and at that point `insertObject`
  used to return null with only a `console.info` (Shapes/Text insert
  silently did nothing) and `select-tool.ts`'s marquee resolution, scoped
  to `objectsOverlapping(app, activeLayer, rect)`, silently found nothing
  even when the marquee was drawn right over an existing object on a
  *different*, still-valid scene layer. Fixed: `objectsOverlapping` (and the
  move-tool's `engine.hitTest`, which already searched every layer) now
  search every ENABLED scene layer in the document regardless of
  activeLayer, and resolving a selection makes the hit/matched layer active
  (not the other way around). See `select-tool.ts`'s header comment.
  `tools2.spec.ts`'s "painting first…" test is the regression guard: paint
  a stroke, then Shapes insert / Text insert / marquee-select must all
  still work. If you add a new tool that needs "the current X layer", give
  it this same three-step fallback. A bare `if (!activeLayer...) return`
  (or `console.info`-only) is the anti-pattern this section exists to name.
- **Layers panel: top-first rows vs. bottom-first doc, and the off-by-one
  that cost.** `layers-logic.ts`'s `displayOrder(doc, collapsed?)` walks
  `doc.layers` in REVERSE (doc storage is bottom-up compositing order,
  index 0 = bottom; the panel shows top-first), recursing into a group's
  `children` the same way unless that group's id is in the optional
  `collapsed` set (viewState.collapsedGroups: session-scoped, never
  persisted). The original single-array `reorderTarget(doc, dropRow)` has
  been replaced by depth-aware `dropTarget(rows, dropRow, dragId)`, which
  takes the CURRENT display rows (already collapse-filtered) rather than
  the doc directly, and returns `{parent, index} | null`: hovering a GROUP
  row always means "drop INTO it" (as its new top child: append to
  `children`, since children arrays are bottom-first); hovering any other
  row inserts among ITS siblings (`parent = row.parentId`). Both cases
  share one index formula: for a destination array of length `L` *at the
  moment of insertion*, landing the dragged node at top-first position
  `local` within that array is doc-index `L - local`. `L` is
  `siblings.length - 1` when the destination is the SAME array the dragged
  node is already in (`document.ts`'s `reorderLayer` removes it from there
  FIRST, the standard `arr.splice(to, 0, arr.splice(from, 1)[0])` idiom,
  so the array is one shorter by the time the insert happens), or plain
  `siblings.length` when it's a different array (nothing removed from it
  first). Getting the same-array `-1` wrong doesn't throw: it just lands
  one slot off, self-correcting only at the very top row (the destination's
  own `Math.min` clamp absorbs the excess there) and flat-out no-opping the
  single most common gesture, an adjacent one-row nudge, which is why
  `layers-logic.test.ts` checks every `(from, to)` pair on a flat 4-layer
  fixture AND a battery of group cases (into/out-of a group, adjacent
  nudges inside a group, dropping a group among its own top-level
  siblings, collapsed rows simply absent from `rows`) through the REAL
  `applyEdits`, not just `dropTarget`'s return value. Keep that suite
  green, not just the hand-picked cases, if you touch this function.
  `dropTarget` also guards against nesting: it computes the intended
  destination parent id and returns `null` if the dragged node IS that id
  or a group containing it anywhere in its own subtree (dropping a group
  onto its own header row, or into one of its own descendants). Since a
  group row's hover is ALWAYS drop-into, there's no other legal
  interpretation of "hover a group over itself" to fall back to. A group
  CAN still be dropped among its own top-level siblings (a plain reorder,
  not a nest). Only self/descendant nesting is barred.
  Drop-row tracking itself is geometric, not enter-event-based:
  `layers.ts`'s `rowIndexAtPointerY` derives the target row from the
  pointer's Y against each row's own rect on every `pointermove`, because
  `@pointerenter` alone misses intermediate rows on a fast drag (rows are
  ~28px tall, trivial to skip). It uses FULL row containment
  (`top..top+height`), not a top/bottom-half midpoint split. A midpoint
  version shipped first and briefly regressed the very bug it was meant to
  fix: a strict `<` compare against exactly `top + height/2` meant a drop
  aimed at a row's own visual centre (the single most natural release
  point, and where an e2e drag test's `boundingBox()` midpoint landed
  exactly) rolled over to the NEXT row instead. `dropTarget`'s dropRow
  is one target position, not an above/below choice, so there's no reason
  to bias half a row toward its neighbour: "hovering anywhere over row i"
  should mean "drop at row i," full stop.
  `dragOverRow` (the drop target, drives both `dropTarget`'s input and the
  `.drag-over`/`.drag-into` highlight: a border-top insertion line for an
  ordinary sibling drop, a filled outline for dropping INTO a group, picked
  by checking `rows[dragOverRow].node.kind` at render time) is read only at
  render time, so changing it does nothing unless something nudges a
  subscribed store. `updateDragOverRow` reuses `beginRename`'s
  "`viewState.update(s => ({...s}))` just to trigger a re-render" idiom;
  forgetting that nudge is exactly how the drag-over affordance ends up
  silently absent even once the row math is otherwise correct. Every row
  (any depth) is draggable now. The old depth-0-only guard existed only
  because `reorderTarget` couldn't address nested arrays; `dropTarget` can.
  Renaming: a rename in progress must not block interaction with OTHER
  rows. `pointerdown`'s `renamingId !== null` branch blurs the active
  rename input (committing it via its own `@blur` handler) and then lets
  the click/drag on THIS row proceed, rather than returning early
  regardless of which row was pressed.
- **Groups: `layer.group`/`layer.ungroup` (Ctrl+G / Ctrl+Shift+G,
  registry.ts).** Group wraps the active layer in a fresh (empty)
  `LayerGroup`, one `patchCommand` with two edits: `addLayer` the new
  group as the active node's next-higher sibling (via `findLayer`'s
  `parentId`/`index`, so grouping something already inside a group nests
  correctly), then `reorderLayer` the active node INTO it at child index 0.
  Ungroup reverses it by moving every child out to the group's own
  parent/index in original (bottom-up) order (each `reorderLayer` lands
  one index higher than the last so the flattened order matches the
  group's internal order exactly), then `removeLayer`s the now-empty
  group; still one `patchCommand`, so undo restores the group and every
  child's position in a single step. `activeLayer` may be a group id (the
  footer's opacity/blend controls already work on any `LayerNode`, group or
  layer). The layers panel resolves the footer's `activeNode` via
  `findLayer` over the FULL doc, not the (possibly collapse-filtered)
  `rows` list, so the footer keeps working when the active layer is hidden
  inside a collapsed group. Collapse state lives in
  `viewState.collapsedGroups: string[]` (session-only), toggled by each
  group row's caret button (`layers.ts`); the row also shows a
  folder/folder-open icon before the eye toggle, purely derived from that
  same collapsed set. `registry.ts`'s `siblingInsertPoint` (formerly
  `topLevelIndexAboveActive`, doc.layers-only) and
  `image-import.ts`'s matching helper both resolve "insert above active"
  through `findLayer` now, so a new/duplicated/imported layer lands next to
  the active layer INSIDE its group rather than silently falling back to
  the document root the moment the active layer is nested.
  `localHost.ts`'s `hitTest` (Move-tool click-to-select) now descends
  enabled groups recursively instead of only scanning top-level `core.scene`
  layers: groups carry no transform, so doc-space coordinates pass through
  unchanged at every level.
- **Viewport: one coordinate system.** `.gd-canvas-region` does not flex-centre
  the canvas (see `styles/app.css`); `#gd-canvas` is `position: absolute` and
  `viewState.panX/panY` IS its top-left in region coordinates, not an offset
  on top of a centred canvas. `layoutCanvas` (`shell/shell.ts`) sets
  width/height from `zoom` and `transform: translate(panX, panY)`. Shared math
  (`fitZoom`, `centeredPan`, `clampPan`) lives in `shell/view-math.ts`;
  `clampPan` is applied on every pan/zoom write path so the canvas can never
  be flung fully off-screen (48px must stay visible per axis). Boot
  (`app/main.ts`) and `view.zoomToWindow` both fit-and-centre; `zoomIn`/
  `zoomOut`/`actualSize`, Ctrl+wheel, and the Zoom tool (`Z`) all anchor via
  the same `zoomAtClient`/`zoomAtRegionCentre` math so a doc point under the
  region-centre (or cursor) stays fixed. Zoom tool: plain click zooms in
  1.25x, Alt+click zooms out (cursor shows `zoom-out` while Alt is held).
  Region resize (`ResizeObserver` in `shell.ts`) re-centres on the old
  region-centre's doc point rather than silently cropping.
  Pan inputs (all funnel through one `panDrag` path in `canvas/viewport.ts`):
  Space+drag, middle-drag, the Pan tool (`H`) via plain left-drag, Shift+
  left-drag (works on every tool EXCEPT move/select-rect/select-ellipse,
  where Wave 5 claimed Shift+click/drag for additive selection instead:
  `isPanTrigger`'s `shiftClaimedBySelection` carve-out; revisit again if
  shift-constrain gestures are ever wanted on paint tools too), and
  plain wheel (Shift+wheel = horizontal). Ctrl+wheel zooms; it does not pan.
- **Transport control** (`shell/statusbar.ts`): a play/pause button
  (`[data-testid="transport-toggle"]`) + a 1-decimal time readout
  (`[data-testid="transport-time"]`), driven by `app/stores.ts`'s
  `clockState` (mirrors the engine's `'clock'` events, wired once in
  `app/main.ts`). The clock plays by default from boot (this is a
  time-aware/live-generative editor, motion is the product), so `main.ts`
  sends `engine.setClock({ cmd: 'play' })` right after `loadDocument`;
  `loadFreshDocument` (File > New/Open) doesn't touch playing state, so it
  inherits whatever the clock was already doing. Toggle command is
  `clock.toggle` (`shell-commands.ts`), bound to **Ctrl+Space** (not plain
  Space: that's claimed by pan, see `canvas/viewport.ts`).
- **Tools rail** (`panels/tools.ts`): a 2-column grid of
  `.btn.btn-icon.btn-tertiary.btn-sm` with `aria-pressed` for the active
  tool and `data-tip` for the name + key; brush size (and bucket tolerance
  when that tool is active) are stacked `.g-slider` fields under it
  (`app.css`'s `--gd-rail-w`, 76px). Hints stay derived from bindings.ts.
- **Menus are g-system popovers.** `menubar.ts` renders `.g-menubar-item`
  triggers with `popovertarget` and one `.menu[popover]` per menu, all in
  the DOM from mount (tests read a menu by its trigger's `popovertarget`,
  never by clicking first). Light dismiss, Escape, arrow keys and
  hover-to-switch come from g-ui.js; the menubar never re-creates a `.menu`
  element (initMenu binds once, unguarded), it only re-renders their
  contents on layout changes for the Window menu's check marks. Effects and
  Adjustments are generated from `menuPath` (`buildEffectMenus`, pure,
  unit-tested; skips effects with no menuPath; 3-segment paths nest under
  a `.menu-heading`). Labels are sentence-cased at render (`sentenceCase`,
  acronyms untouched). Theme is g-system's (`view.theme` → `g.theme`),
  not a store field.
- **The shell is docked (2026-09 reskin), on g-system.** `shell/shell.ts`
  builds menubar / main / timeline / statusbar, where main is
  [tools rail | canvas region | `.g-splitter` | right column]. The right
  column is g-system's `.g-pane-stack`: one `.g-pane` per host in
  `stores.ts`'s `PANE_ORDER` (layers takes the slack via `data-fill`), each
  a `.g-pane-title` button (aria-expanded = not collapsed) over a
  `.g-pane-body` that re-renders the host's template. `tools` renders
  straight into the rail with no title. Nothing floats, so the old
  drag/clamp/resize-grip code and `view-math.ts`'s panel clamps are gone.
  `layoutState` persists `panels[id].{visible, collapsed}` and
  `rightWidth` under `gdesign.layout.v2` (a v1 blob is read once for its
  `visible` flags); `PanelPlacement.x/y` are still written (frozen shape)
  but always 0. `panel.toggle` flips `visible` (F5-F10, Window menu);
  `panel.reset` (Ctrl+Shift+F5) restores `defaultLayout()` wholesale. The
  splitter and pane titles are driven by g-ui.js's fragments (events
  `g-splitter:resize`, `g-pane:toggle`), which is why `mountShell` calls
  `window.g.init(root)` once after building the DOM. Panel re-renders are
  coalesced through one `requestAnimationFrame` (`renderAllPanels`), so a
  pointer move that touches history, the document and the selection at
  once renders the panes once.
- **Insert menu can create source-only layers, not just scene objects.**
  `registry.ts`'s marked insert-source block (`newPlasmaLayer`/
  `newGradientLayer`, commands `source.insertPlasma`/`source.insertGradient`)
  mirrors `newSceneLayer`/`newSolidLayer`: `params: {}` deliberately, since
  `engine/params/resolve.ts`'s `resolveParams` fills any unset key from the
  source's own `ParamsSchema` default, so the UI doesn't need to duplicate
  `plasma.ts`/`gradient.ts`'s defaults. Plasma is `liveness: 'live'` (it's
  `engine.time`-driven, baking it would freeze one frame forever); Gradient
  is `liveness: 'baked'`, same reasoning as `core.solid`, since a static
  two-color fill has nothing to re-render per frame unless its params get
  keyframed later.
- **Effects panel (F9)** is the only place an applied chain is visible or
  editable outside undo. Before it existed, `effect-dialog.ts` only ever
  *appended* to the active layer's chain, so re-applying an effect stacked
  duplicates with no way to see, disable, reorder, or remove what had already
  been applied. `panels/effects.ts` shows the active layer's chain (top =
  last-applied) plus a pinned Document section for `doc.postChain`, and, when
  exactly one text object is selected, a read-only Text section. All
  mutations are whole-chain `setChain` writes (toggle/remove/reorder read the
  current chain fresh off the doc via `effects-logic.ts`'s `chainForTarget`,
  a UI-side read-only mirror of `document.ts`'s engine-internal
  `resolveChainContainer`, and write the whole array back). Nothing here
  re-implements per-target chain resolution. Reorder drag follows the layers
  panel's pointer-drag idiom (`rowIndexAtPointerY`, imported from `layers.ts`
  not copied) but only the row's grip handle starts a drag, not the whole
  row, since double-clicking a row opens edit-in-place instead. `reorderedChain`
  (effects-logic.ts) deliberately avoids re-deriving the
  display-row↔chain-index math directly (it moves the entry within the
  already-reversed (display-order) list using the same splice-out/splice-back
  idiom the layers-logic exhaustive test checks against, then reverses back)
  because this exact family of panel has shipped two off-by-one drag bugs
  from hand-rolling that conversion (see the Layers section above).
- **Edit-in-place** (`dialogs/effect-dialog.ts`'s `openEffectDialog(app, id,
  opts?)`): `opts.target` overrides the default (active layer) target;
  `opts.instanceId` seeds params from that chain entry (not schema defaults),
  titles the dialog "Edit …", and makes both `preview()` and `onOk` replace
  the matching entry in place (`chain.map(fx => fx.id===instanceId ? {...fx,
  params} : fx)`) instead of appending. Cancel still reverts to the
  pre-open snapshot. Existing call sites (menubar, keymap `effect.open`) are
  unaffected since `opts` is optional and they never pass an `instanceId`.
- **Object properties: the Effects panel's Object section** (shown when
  exactly one scene object is selected: `effects-logic.ts`'s
  `findSelectedObject`, any content type) is the one place object geometry
  and per-content fields are editable outside the canvas itself.
  Transform (x/y/width/height/rotation) works for every content type via
  the existing generic `setTransform` object channel (`document.ts`'s
  `findObjectAnywhere`). Width/height commit `scaleX`/`scaleY` derived from
  the content's intrinsic box (`contentBoxOf`), the same convention
  `select-tool.ts`'s resize handles already use, so panel-typed and
  handle-dragged resizes agree. `document.ts`'s `setParam` has no generic
  `ParamValues` bag for an `{kind:'object'}` target (`ObjectNode` is a frozen
  shape), so a small NAMED set of keys is special-cased instead. The
  sanctioned list, all in `document.ts`: `'content.text'` (text string, the
  text tool's original channel), `'content.size'` (text-only, `TextSpec.size`),
  `'content.fill'` (shape fill OR text colour: both actually live in
  `ObjectStyle.fill`, not per-content-type, so one key covers both; the key
  name is a semantic label like `content.text`'s, not a literal object path).
  Per content type: shape gets transform + a fill swatch
  (`content.fill`); text gets transform + editable text/size/fill
  (`content.text`/`content.size`/`content.fill`); image gets transform ONLY
  plus a read-only asset-id label (`content.asset`'s first 8 chars, same
  truncation `effect-dialog.ts`'s asset picker uses). An image's pixels come
  from its asset, not editable content/style. The fill swatch reuses
  `params-form.ts`'s `openColorPopover` (exported for this) rather than a
  second color-popover implementation. Move-tool double-click on a SHAPE
  object opens/focuses this panel (`main.ts`'s `focusEffectsPanel`, forcing
  `layoutState.panels.effects.visible = true`); double-click on a TEXT object
  still opens the floating text editor instead (`textEditor.openForObject`,
  unchanged). `main.ts` branches on the hit object's `content.type` to pick
  one or the other.
- **Video import is dialog-gated, unlike image import.** File > Open
  (`registry.ts`'s `file.open`) and the canvas drop handler (`shell.ts`)
  both route `video/*` to `dialogs/import-video.ts` instead of importing
  straight to a layer: range (max 8s), target fps, and half-res are the
  user's call because a baked clip is decoded frame-by-frame into memory up
  front (no streaming baked-clip source yet), so the size is exactly
  `frames × width × height × 4` bytes and worth showing before committing to
  it. The dialog's live estimate and its OK-disabled hard refusal
  (`app/commands/video-import-budget.ts`, 512MB) share the exact same pure
  math the importer (`app/commands/video-import.ts`) uses, so the dialog can
  never promise a size the importer then exceeds. `dialog-shell.ts` grew an
  optional `okDisabled?()` hook for this (re-evaluated every rerender; OK is
  inert, not just visually disabled, while it returns true).
- **Image imports are OBJECTS, not full-canvas layers: a full-canvas
  `core.image` layer used to be the import shape, and it's wrong on two
  counts at once.** Its shader samples uv across the WHOLE canvas, so any
  image whose aspect doesn't match the document stretches; and layers have
  no on-canvas manipulation at all (only scene objects get move/resize/
  rotate handles, via `select-tool.ts`): a user drops a photo and it's
  simultaneously distorted and untouchable. `app/commands/image-import.ts`'s
  `importImageAsLayer` (the ONE function behind File > Open, the canvas drop
  handler, `main.ts`'s window `paste` listener, and `edit.paste`'s internal-
  raster-clipboard path: fixing it fixes all four) now builds one addAsset
  + addLayer(`core.scene`, empty) + addObject edit batch instead: a single
  image object, `content.asset` pointing at the new asset, sized to the
  asset's NATIVE pixel dimensions via `contentBoxOf` (`@engine`'s
  `core/transform2d.ts`) with a uniform `transform.scaleX`/`scaleY` (equal,
  always: an object can never skew because a mistaken per-axis fit ratio
  would reintroduce the exact stretch bug one level down) applying
  `fitImageSize`'s contain-fit: native size unless the image overflows the
  canvas on either axis, in which case both axes shrink together by
  whichever axis is more overflowing. All three edits are one `patchCommand`,
  one undo step for the whole import, matching every other content
  command. After the push, `importImageAsLayer` selects the new object
  (`selectionState.set`) and switches `toolState.active` to `'move'`, the
  fix for "I can't manipulate it at all": the very next drag moves the
  image, no extra click-to-select or tool-switch needed. `video-import.ts`'s
  baked clip layers are the one deliberate exception to "imports are
  objects": full-canvas is the CORRECT shape for a decoded video clip (it's
  sampled by the scheduler as a baked source, not manipulated as scene
  content), so don't generalize this rule to that importer.
- **Clipboard is one tagged internal slot, precedence-ordered against the OS
  clipboard.** `registry.ts`'s module-level `clipboard` holds an
  `InternalClipboard` (`'object' | 'layer' | 'raster'`, most-specific-first).
  Ctrl+C (`edit.copy`): a non-empty `selectionState.objects` copies those
  ObjectNodes (object wins over layer: it's the more specific thing being
  looked at); otherwise the active layer's whole subtree is
  `structuredClone`d, PLUS every asset its sources (recursing into groups)
  or `baked.clip` reference is snapshotted alongside it (`snapshotLayerAssets`
  walks source params + `baked.clip` only, not chain params), so a
  layer-with-an-image/LUT survives a paste into a doc that no longer has
  that asset id. Fresh ids are assigned at PASTE time (`cloneWithFreshIds`/
  `cloneObjectWithFreshIds`), not copy time, so repeat-pasting the same
  clipboard entry never collides. Ctrl+X (`edit.cut`) is copy + delete as
  ONE `patchCommand` (object removals, or a layer removal) so a single undo
  restores exactly what was cut. Ctrl+V (`edit.paste`) precedence: (1)
  no-op if `paste-guard.ts`'s `wasPasteRecentlyHandled()` says main.ts's
  window `'paste'` listener already imported an OS image within the last
  150ms (Firefox denies `navigator.clipboard.read()`, so that listener is
  the only way to see an OS image there, and both paths must not double-
  import the same gesture); (2) internal `'object'` → insert into
  `resolveSceneLayer`'s target, fresh ids, +10px offset; (3) internal
  `'layer'` → `addLayer` above active, re-adding any snapshotted asset the
  target doc doesn't already have; (4) internal `'raster'` (Copy Merged's
  quantised RGBA8 readback) → PNG-encode via `OffscreenCanvas`
  `putImageData`/`convertToBlob` and route through `importImageFile`: the
  quantised readback IS display-referred, exactly what a PNG is, so this is
  the same encode `edit.copyMerged` uses to also write the OS clipboard; (5)
  fall through to `navigator.clipboard.read()`. Ctrl+Shift+V
  (`edit.pasteAsLayer`) is OS-clipboard-EXPLICIT: it never touches the
  internal clipboard at all, since choosing it over plain Paste IS the
  choice of "use the system clipboard, not gdesign's own". Ctrl+Shift+C
  (`edit.copyMerged`) sets the internal raster clipboard AND best-effort
  writes a PNG to the OS clipboard (denial just toasts: the internal copy
  already succeeded). All three new bindings (Ctrl+C/X/V) are
  `when: 'canvas'` in `bindings.ts`, unlike most Edit-menu bindings, so
  they don't hijack native copy/paste while typing in the text tool's
  floating textarea or any other form field.
- **The asset picker is one `opts` object threaded through `paramsForm`,
  additive-only.** `params-form.ts`'s `paramsForm(schema, values, onChange,
  opts?)` takes an optional `ParamsFormOpts` whose `assets` key
  (`{list(assetType), importNew(assetType)}`) turns `assetRow`'s disabled
  "assets land Phase 2" button into a working picker: a popover (same
  host/outside-click/Escape shell as `colorRow`'s `openColorPopover`)
  listing `list(spec.assetType)` plus an "Import…" row that calls
  `importNew` and, on a non-null result, `onChange(key, {asset: id})`.
  Omitting `opts` (or `opts.assets`) keeps the original disabled-button
  behaviour byte-for-byte. Existing callers of `paramsForm` don't need to
  change. **This is deliberately the SAME opts object a sibling keyframe-
  editing workstream adds `{time, onSetKey}` keys to**: both land as
  additive keys on one bag, not two trailing parameters, so the merge stays
  clean. `effect-dialog.ts`'s `assetPickerOpts(app)` is the one caller today:
  `list` filters `doc.assets` by type (label = the asset id's first 8 chars:
  `AssetJSON` carries no user-facing name, `doc/json.ts` being a FROZEN
  CONTRACT); `importNew('image')` opens a file input and decodes+`addAsset`s
  via `image-import.ts`'s exported `importImageAsset` (one undo step, no
  layer); `importNew('lut')` opens a small popover offering a built-in
  "Identity" LUT (materialised as a real `doc.assets` entry the moment it's
  picked: a lut asset ref has to resolve to something) or "Choose File…"
  (`.cube` text or a Hald-tiled PNG, parsed by `ui/dialogs/lut-import.ts`
  and re-packed into `core.lut`'s own byte layout via `@engine`'s
  `packLutBytes`, so an imported LUT and a procedurally-built one share one
  GPU upload path). An `asset`-kind chain param with no ref set yet, or a
  ref pointing at a missing/removed asset, no longer kills the render:
  `core/frame.ts`'s `resolveAssetInputs` falls back to
  `asset-textures.ts`'s `resolveMissing()` (a cached 1x1 mid-grey texture)
  instead of throwing. This is what makes "add core.lut, haven't picked a
  LUT yet" survivable, not just the picker itself.
- **Timeline strip (F10 / View > Timeline, `shell/timeline.ts` + `shell/timeline-logic.ts`)** is a 4th shell region (`shell.ts` mounts it between canvas-region and statusbar), NOT a dockable `PanelHost` card. It reuses only the visible-flag half of the panel machinery: `layoutState.panels['timeline'].visible` + `panel.toggle`/`'timeline'`, with a `PANEL_DEFAULTS` entry carrying `visible: false` (stores.ts's `defaultPanelPlacement` gained an optional `def.visible` override for this: every other panel still defaults to visible: true). `timeline.ts` owns its own show/hide (a `layoutState.subscribe` that toggles `root.style.display`), not shell.ts.
  Every row (the ruler and each keyframe lane) shares one CSS grid (a fixed 96px label column + a `1fr` track column), specifically so `root.clientWidth - 96` is the ONE track width used by every `timeToX`/`xToTime` call in a render pass; querying each row's own (previous-render) DOM element mid-template would read stale widths.
  The playhead is deliberately NOT part of the lit-html template that re-renders on document/selection/timeline-state changes: clockState ticks at 30-60Hz during playback, and re-diffing every lane/key on every tick would be wasted work. Its position is written directly (`translateX`) from a separate `clockState.subscribe`, looked up once per structural render: the same "don't re-render on the hot path" idiom the statusbar's frame-time readout doesn't need but the strip does, since it hosts actual editable content.
  v1 lanes: an always-present Opacity lane (reads `node.opacity`, which is a `ParamValue` like any source param, already track-aware end to end via `engine/core/engine.ts`'s `resolveOpacity`) plus one lane per source param currently holding a `{track}` value (`timeline-logic.ts`'s `lanesFor`, schema-driven the same way `params-form.ts` is). Retiming a key (drag) follows the `effect-dialog.ts` live-preview idiom exactly: `engine.applyEdits` directly on every pointermove (never through history: a drag must not spam undo), reverted and replaced by ONE `patchCommand` on release. Add/remove/ease-change are each a single immediate `patchCommand` (nothing to preview, no drag). Playhead scrub and the loop brace are transport, not document edits, so they only ever call `engine.setClock`, never history. `resolveTrackAt` in `timeline-logic.ts` is a deliberate DISPLAY-ONLY duplicate of `engine/params/resolve.ts`'s private `evalTrack` (linear/hold/cubic), kept here because `engine/` is off-limits to the UI-only timeline workstream; if the engine's easing math ever changes, this copy needs updating too.
  **Known v1 gap:** lanes can retime/delete/ease a key but have no in-lane VALUE editor. Authoring a track with two different values today means changing the underlying static value (Layer Properties' opacity slider, or a source param's own control) between clicks, not dragging a key vertically. A value-drag (vertical) or an inline numeric edit on the selected key is the natural Wave 3+ follow-up.
  **Source-param keyframing host:** `dialogs/layer-props.ts` gained a "Source" section, the only place a layer's OWN params (as opposed to its effect chain, which stays the Effects panel's job) are editable at all, using `forms/params-form.ts`'s new 4th `opts` argument (`{time, onSetKey}`). Unlike the dialog's four base fields (batched into one `patchCommand` on OK), Source edits commit immediately per change so the timeline strip (open alongside) sees them right away; the dialog calls `handle.rerender()` after each one (the `effect-dialog.ts` `let handle: DialogHandle; handle = openDialog(...)` pattern, needed here because the body callback captures `handle` before it exists yet). `params-form.ts` without `opts` is byte-for-byte the pre-existing behaviour (badge is a plain non-interactive `<span>`, editing a keyframed row collapses it to static). `opts.time` is what turns the diamond into a live button (click = key here with the row's current/resolved-at-time value, Alt+click = collapse to static, editing while keyframed = update the key at `opts.time` instead of collapsing).
- **Discoverability layer is one SSOT: `shell/hints.ts`.** `TOOL_HINTS` is a
  `Record<ToolId, ToolHint>` (omitting a tool is a `tsc` error, not a silent
  blank hint) read by `statusbar.ts`'s `hintFor()` (tool + selection +
  `isStarterDoc()`, disabled tools always read "Not implemented yet"
  regardless of selection) and rendered as `[data-testid="status-hint"]`,
  which yields to the `statusMessage` toast whenever one is showing (errors
  outrank "how do I use this"). Key names quoted inside a hint sentence
  (brush-size `[`/`]`, colour-swap `X`) are derived from `bindings.ts` via
  `keymap.ts`'s `formatKeys` (through a small display-only `prettyKey`
  prettifier for the physical-key codes `formatKeys` returns), the same
  anti-drift reasoning as `panels/tools.ts`'s `toolKeyHint`. Never hardcode
  a key label a hint quotes. `isStarterDoc()` (`history.entries().length ===
  0`) is also the single heuristic behind `shell.ts`'s `[data-testid=
  "canvas-hint"]` overlay (centred, `pointer-events: none`, disappears the
  moment history gains its first entry) and the move-tool's own
  empty-canvas hint variant: one function, three call sites, so "empty" is
  never redefined slightly differently in each place.
- **Shapes tool inserts whichever shape kind the Insert menu last created,
  not a separate cycle gesture.** `toolState.lastShape` (`'rect' | 'ellipse'
  | 'polygon' | 'star' | 'rounded-rect'`) is set by each of registry.ts's
  `object.insertRect/insertEllipse/insertPolygon/insertStar/insertRoundedRect`
  commands (SHAPES block) and read by `canvas/line-shapes-tool.ts`'s drag
  handler when `tool === 'shapes'`; `insertDraggedShape(app, kind, rect)`
  takes that kind directly. This was picked over a `tool.cycle`-style
  key-repeat cycle (also considered) because it's discoverable without a
  hidden keybinding: pick a shape from Insert once, then every subsequent
  drag reuses it. `panels/tools.ts`'s Shapes tool tooltip surfaces the
  current kind (`"Shapes (S), inserts a star"`); the statusbar hint line
  (`shell/hints.ts`, below) is the other discoverability surface.
- **No style-editing UI for the new shape/stroke fields yet: candidates for
  the sibling wave5-objprops branch's Object panel.** `content.sides`
  (`'polygon'`), `content.starPoints`/`content.innerRatio` (`'star'`),
  `content.radius` (`'rounded-rect'`), and `style.stroke`/`style.strokeWidth`
  (any shape) are all plain data on `ObjectNode` today with no edit path from
  an object target, same "read-only, no mutation channel yet" situation as
  the Effects panel's Text section. Whichever branch adds object-property
  editing should treat these as more `content.*`/`style.*` keys through that
  same sanctioned setParam family, not a bespoke shapes-only panel.
- **Adjustment layers (ADJUST block)**: `layer.newAdjustment` (Layers menu
  "New Adjustment Layer", plus a leading "New Adjustment Layer…" bridge item
  in the dynamically-built Adjustments menu: `ui/shell/menubar.ts`'s
  `effectMenus()` prepends it after `buildEffectMenus` runs, so the pure
  grouping function itself stays untouched) inserts a Layer whose
  `source.type === 'core.adjustment'` above the active layer, same
  `siblingInsertPoint` pattern as every other "new layer" command. No F9
  Effects panel changes needed at all: it already edits whichever layer is
  active, and `effect.open`/`effect-dialog.ts`'s target fallback already
  points at the active layer, so selecting an adjustment layer then picking
  Adjustments > Levels (say) just works. `panels/layers.ts`'s row template
  renders a `ph-circle-half` icon (`gd-layer-adjustment-icon`,
  `data-testid="layer-adjustment-icon"`) for `source.type ===
  'core.adjustment'` rows, the only layers-panel change this needed. See
  src/engine/CLAUDE.md's adjustment-layers section for the scheduler side
  (renderNodes branch) and its one real limitation (burn/renderSubtree can't
  reconstruct "what was below", see that doc for why).
- **Layer masks and MASK EDIT MODE (MASKS block).** Layers panel rows show a
  mask chip (`[data-testid="mask-chip"]`, `layers.ts`) when `layer.mask` is
  set (`maskOf(node)`, a layer-only field, `LayerGroup` never has one):
  click enters/exits MASK EDIT MODE (`viewState.maskEditing: LayerId |
  null`), alt-click toggles `enabled` without touching edit mode; CSS shows
  an accent outline while editing and dims when disabled (same idioms as
  `.gd-layer-row.drag-into` and `.gd-tool-btn.disabled`). The Layers menu
  adds Add/Remove/Enable/Disable/Invert Mask commands (`registry.ts`'s MASKS
  block), all acting via `setMask`; `layer.addMask` batches one `addAsset`
  (an opaque-white, canvas-sized raster: `mask-paint.ts`'s
  `whiteMaskBytes`, an all-keep mask so adding one changes nothing until
  painted) + one `setMask` into a single history entry.
  **Routing:** `paint-layer.ts`'s `resolveStrokeTarget` (NOT
  `resolvePaintLayer`, which callers other than paint-tool.ts's brush/
  pencil/eraser still use unchanged) is the one place that checks
  `viewState.maskEditing` and returns `{kind:'mask', asset}` instead of
  `{kind:'layer', layer}`; it falls back to normal layer routing (and clears
  `maskEditing`) if the edited layer or its mask vanished underneath the
  session. `paint-tool.ts` is the only caller wired to it today (Line/Fill
  Selection still call `resolvePaintLayer` directly: masks were scoped to
  brush/pencil/eraser). A mask stroke's CPU-side commit (`mask-paint.ts`,
  see src/engine/CLAUDE.md's mask section for why it can't reuse the GPU
  stroke path) pushes a plain `uiCommand`, not a `patchCommand`: the first
  and, as of this block, only caller of that constructor for a paint
  gesture. **M7 TECH DEBT:** this bypasses edits-as-data (a mask stroke is
  invisible to anything replaying DocEdits) and must be revisited when the
  worker split lands; it also means in-place byte mutation, which is why
  every mutation site calls `engine.invalidateAsset(assetId)` (see
  src/engine/CLAUDE.md's mask section) before `requestFrame`. Escape exits mask edit mode via a **capture-phase** window
  listener (`installMaskEscapeGuard`, installed once in `main.ts`) that
  stops propagation: the only way to guarantee it runs before the several
  independent bubble-phase Escape listeners already in this codebase
  (dialog-shell, layer rename, menubar, marquee deselect, text editor).
  Clicking a different layer row also exits (`layers.ts`'s `setActive`);
  re-clicking the row already being mask-edited does not. The statusbar
  hint ("Editing mask: paint white to reveal, black to hide…") comes from
  `shell/hints.ts`'s `hintFor`: the mask branch's own `currentHint` file
  lost the add/add merge to wave5's TOOL_HINTS SSOT, whose `HintContext`
  gained a `maskEditing` override instead (it outranks every per-tool
  hint);
  `statusbar.ts` suppresses it while a transient `statusMessage` toast is
  showing (they'd otherwise both claim the same `margin-left: auto` slot).
- e2e specs address the app via `window.__gdesign` and data-testid
  attributes (contract documented at the top of tests/e2e/boot.spec.ts).
- **Styling: g-system, vendored at `public/g/` (never hand-edited; re-run
  `node <g-design checkout>/scripts/vendor.mjs public/g`).** App CSS is
  `styles/app.css` (shell regions, canvas, overlays, timeline) importing
  `panels.css` (pane content) and `forms.css` (params form, dialogs); no
  CSS-in-TS anywhere. Classes are `gd-*`, local variables are `--gd-*`,
  greys only through g's alias tokens (`--surface-1/2`, `--text-primary/
  secondary/placeholder`, `--border*`, `--fill-hover/active`). Never
  declare `--bg`, `--accent`, `--card-bg` or any other g compat alias:
  g.css consumes them internally and a consumer that redefines them
  silently restyles g's own components. Icons are inline Phosphor SVG via
  `ui/icons.ts` (generated `icons-data.ts`, `npm run gen:icons`); no icon
  font. Copy is sentence case, verb-first buttons, no em dashes.
- **History is budgeted by bytes, not just entry count** (history-budget
  block, 2026-09). `Command` gained an optional `bytes(): number`
  (app/types.ts, additive); `patchCommand` (`commands/command.ts`) sums
  every `ArrayBuffer`/typed-array found anywhere in its forward edits +
  inverse via a generic recursive walk (not a per-`DocEdit`-op switch, so it
  stays correct as edit/asset shapes grow). `history.ts` evicts from the
  bottom of the stack while the retained total exceeds `HISTORY_BYTE_BUDGET`
  (256MB), same eviction shape as the pre-existing 200-entry `HISTORY_CAP`
  (now the secondary bound). It never evicts the sole remaining entry, even
  one that alone exceeds budget. `history.stats(): {entries, bytes, budget}`
  backs the History panel's `[data-testid="history-budget"]` line ("x MB of
  256 MB", `.gd-history-budget` in `styles/panels.css`). See
  `src/engine/CLAUDE.md`'s stroke-commits note for the other half (region-
  scoped commitRaster, so there's far less to budget in the first place).
