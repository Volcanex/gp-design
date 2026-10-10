# tests

- `unit/`: vitest, node environment (happy-dom only where a spec opts in
  via `// @vitest-environment happy-dom`). No GPU, no WebGPU globals:
  engine modules imported here must not touch `GPUTextureUsage` etc. at
  module top level (use numeric flag literals).
- `e2e/`: Playwright against the systemd-served dist on 127.0.0.1:8095
  (`npm run e2e` builds first; ad-hoc preview servers get reaped by the
  session sandbox: don't use them from agent sessions; a throwaway
  `python3 -m http.server` + GDESIGN_BASE_URL works for worktree builds).
- SwiftShader flags live in playwright.config.ts. Do NOT add the
  Vulkan/ANGLE flag set (hangs adapter acquisition on this Chromium).
- Assert pixels via engine readback (float path is exact under
  SwiftShader), never screenshots. GPU flows drive
  `/engine-test.html` → `window.__engineTest`; UI flows drive `/` →
  `window.__gdesign`.
- **Playwright's evaluate bridge corrupts ArrayBuffers** (round-trips as
  empty objects). Do full paint/edit flows inside ONE page.evaluate; pass
  only plain numbers/strings/arrays back to Node.
- workers: 1 always (~3G free RAM on this host).
- **Never expect()-per-element over readback-sized arrays.** 3.7M expect
  calls (one per pixel byte) block the worker's event loop so hard the
  120s test timeout can't fire. The suite looks WEDGED (worker at ~90%
  CPU, ~1.5GB RSS, browser already closed) and stalls every full run at
  the same test. Plain-loop a max/total diff, assert ONCE (lut.spec.ts's
  picker test is the postmortem). Ship a digest across the bridge where
  possible instead of a full-canvas array (masks.spec.ts's docSnapshot).
- **Pause the auto-playing clock at boot in every app-page spec**
  (`engine.setClock({ cmd: 'pause' })` right after the ready-wait; see
  groups.spec.ts). The boot clock's continuous render loop compounds
  across sequential contexts in the shared browser process under
  SwiftShader until readbacks hang outright.
- `e2e/lib/console.ts`: `watchConsole(page)` attaches before navigation and
  collects `console.error`s and `pageerror`s; call `.assertClean()` at the
  end of any resilience/sweep spec. Use in every new spec added after
  2026-09-09 (the crash-tests workstream).
- `e2e/lib/boot.ts`: `bootAndPause(page)` is the shared `goto('/')` +
  wait-for-ready + pause-the-clock sequence (the bullet above, as one call).
  Existing specs are NOT refactored onto it; write new ones against it.
- `window.__gdesign.debug.failFrames(n)` (main.ts, dev-only, additive to the
  F0 `EngineHost` contract via `EngineHost.debugFailFrames?`) makes the next
  `n` render frames fail synthetically, for exercising localHost.ts's
  `MAX_CONSECUTIVE_FAILURES` error-storm cutoff without a real GPU fault.
  See error-storm.spec.ts.
- **`showToast` (dialog-shell.ts) keeps `[data-testid="toast"]` on the real
  g-system toast**, not just the happy-dom fallback element: it patches the
  attribute onto `g.toast()`'s own DOM node (`.toaster`'s last child) right
  after creating it, since `window.g.toast()`'s return value is typed
  `unknown` in `Window.g` (shell.ts) and its element isn't otherwise
  reachable from the call site.
- **A `popover="manual"` element shown as a sibling of an already-open
  modal `<dialog>` paints above it but is NOT hit-testable there**: a
  reproducible Chromium top-layer quirk (confirmed on the Playwright-bundled
  Chromium this suite uses), not a z-index bug. params-form.ts's
  `openMenuPopover` and effect-dialog.ts's LUT-import popover both detect an
  open `dialog.dlg[open]` and append into it instead of `document.body` for
  exactly this reason. Do the same for any new popover opened from inside
  a dialog's body, or clicks into it will hang under both Playwright and
  real use.
- **Known order-dependent wedge (2026-09-09):** in a serial run the spec
  that boots right after `chain-panel.spec.ts` (alphabetically
  `chain-scratch.spec.ts`) can hang in `waitForFunction(__gdesign.ready)`
  for the full 120s while the shared SwiftShader browser recovers; the
  same spec passes alone in under two seconds, and it reproduced on the
  pre-reskin build too. Also, the full suite run as one process gets killed
  for memory on this host: run it in four batches of ~13 files
  (`ls tests/e2e/*.spec.ts | sed -n '1,13p'` and so on) and rerun any
  boot-timeout alone before calling it a failure.
