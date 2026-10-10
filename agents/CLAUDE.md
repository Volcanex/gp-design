# agents/: kickoff briefs for parallel worktree work

One brief per workstream; `_template.md` is the starter. Prune a brief once
its branch merges.

## Worktree discipline

- Create with `git worktree add ../gdesign-wt-<name> -b <name> main` and
  `ln -s <main checkout>/node_modules node_modules` inside it (the
  tree shares the main checkout's install; never `npm install` in a
  worktree).
- `npx tsc --noEmit` and `npx vitest run` must both be clean before you
  report done. Run them from the worktree.
- e2e against a worktree: `npx vite build`, then
  `python3 -m http.server <port> -d dist &` and
  `GDESIGN_BASE_URL=http://127.0.0.1:<port> npx playwright test <spec>`.
  Ports 8120-8129 are reserved for this; the brief names yours. Kill the
  server when done. Run ONLY the specs your brief names, one spec file at
  a time: this host has ~3 GB free and every Chromium under SwiftShader
  costs a large slice of it. The full suite runs at the merge gate on main.
- Never touch `dist/` on the main checkout, never restart `gdesign`, never
  push. Commit on your branch with imperative messages that explain why.
- Files headed `FROZEN CONTRACT` are off limits without sign-off from the
  steering session; say so in your report if a task seems to need one.
- Read `CLAUDE.md`, `src/engine/CLAUDE.md`, `src/ui/CLAUDE.md` and
  `tests/CLAUDE.md` first. The conventions in them are enforced at review.
