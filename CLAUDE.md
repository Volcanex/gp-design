# gp-design

Repo `Volcanex/gp-design` (was `gdesign`), checked out at `~/gp-design`;
`~/gdesign` is a compat symlink. The systemd unit is still `gdesign`.

WebGPU compositing editor at design.gabrielpenman.com: paint.net face,
TouchDesigner-style float/OKLab pipeline underneath, Figma-ish retained
document model. 100% client-side compute; `server/main.py` only serves
`dist/` and answers `/health`.

**Owner:** Gabriel Penman
**Run:** `npm run dev` (Vite), `npm run build`, `npm run test` (vitest),
`npm run e2e` (Playwright)
**Deploy:** `npm run deploy` (= build + `systemctl restart gdesign`; the
unit serves `dist/` on 127.0.0.1:8095 behind nginx). **e2e runs against
that served dist, so an undeployed fix is also an untested one**: the
July-to-September 2026 gap shipped a two-month-old build.

## Architecture: the seven primitives

Buffer, Pass, Chain, Source, Layer, Object, Document (+ Engine, the
scheduler). Everything else (every effect, generator, blend mode, export
target) is DATA registered into these. If a change wants an eighth
primitive, it's suspicious: make it content instead.

## Non-negotiables (violations are review-blocking)

- All intermediate buffers are `rgba16float` and hold **OKLab**
  (L, a, b, straight alpha), not RGB. Sources convert to OKLab as their
  last step; present/export converts to display space once. An effect that
  truly needs RGB declares `metadata.colorSpace: 'rgb'`.
- Quantise/dither to 8-bit happens ONLY at present/export.
- Everything is time-aware: render(t), never render().
- `src/engine/` is DOM-free and UI imports it only via `@engine`
  (= `src/engine/index.ts`); engine never imports `src/ui`/`src/app`.
  This boundary is the future Worker/Comlink split (M7).
- `DocumentJSON` and everything in `host/protocol.ts` must survive
  structuredClone (enforced by `tests/unit/doc-clone.test.ts`).
- `applyEdits(edits) → inverse edits` is the ONLY document mutation
  channel. Undo = applying inverses.
- Files marked `FROZEN CONTRACT` change only with architect sign-off.

## Gotchas

- **No GPU on this host.** Tests run WebGPU via SwiftShader. The flag set
  in `playwright.config.ts` is empirically verified; do NOT add the
  Vulkan/ANGLE flags: they hang adapter acquisition. Caps spike
  (`tests/e2e/caps.spec.ts`) confirms rgba16float render + exact float
  readback works. Pixel tests use the float path.
- Assert pixels via engine readback, never screenshots (headless
  SwiftShader has no real display; P3 canvas can't be screenshot-verified).
- `public/g/` is vendored g-system (`design = "g-system@x"` in
  pyproject): never edit, re-run its `scripts/vendor.mjs` to update. UI
  work loads the `g-design` skill first; see `src/ui/CLAUDE.md`'s styling
  bullet for the local rules (`gd-*` classes, `--gd-*` variables, no g
  compat aliases).
- **Nothing may freeze silently.** `localHost.ts` re-arms the frame loop
  before doing any work and guards every listener; `store.ts` guards every
  subscriber; `main.ts` installs window error/rejection handlers, a
  `boot().catch` page and a pinned fatal banner; 30 consecutive failing
  frames or a GPU OOM halt the transport with that banner. A new event
  path must keep those properties (tests: `tests/e2e/resilience.spec.ts`,
  `error-storm.spec.ts`, `boot-fallback.spec.ts`).
- RAM is tight (~3G free): builds and Playwright must run serially
  (`workers: 1`, keep it).
- Playwright browsers live in /root/.cache/ms-playwright; version-locked
  to the `@playwright/test` in package.json (`npx playwright install
  chromium` after bumping it).

<!-- DOCS:START -->

## Docs index

- `agents/CLAUDE.md`: agents/: kickoff briefs for parallel worktree work
- `src/engine/CLAUDE.md`: src/engine: the GPU core
- `src/engine/sources/remote/CLAUDE.md`: src/engine/sources/remote: bridged scenes from render.gabrielpenman.com
- `src/ui/CLAUDE.md`: src/ui + src/app: the paint.net face
- `tests/CLAUDE.md`: tests
- `tests/fixtures/CLAUDE.md`: tests/fixtures

<!-- DOCS:END -->
