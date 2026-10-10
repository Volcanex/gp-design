// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/app/commands/registry', () => ({
  downloadExportResult: vi.fn(),
}));

import { openExportVideoDialog } from '../../src/ui/dialogs/export-video';
import type { AppCtx } from '../../src/app/types';
import type { EngineEvent, ExportRequest, ExportResult } from '@engine';

type ProgressListener = (e: EngineEvent) => void;

/** A fake engine whose export() drives progress synchronously through
 * queued microtasks, so tests can await specific points mid-export. */
function fakeEngine(opts: { clock?: { fps: number; duration?: number } } = {}) {
  const doc = { clock: opts.clock ?? { fps: 24, duration: 1.5 } } as any;
  const listeners = new Set<ProgressListener>();
  const emit = (e: EngineEvent) => listeners.forEach((cb) => cb(e));
  const exportCalls: ExportRequest[] = [];

  let resolveExport: ((r: ExportResult) => void) | null = null;
  const exportFn = vi.fn((req: ExportRequest) => {
    exportCalls.push(req);
    return new Promise<ExportResult>((resolve) => { resolveExport = resolve; });
  });

  const engine = {
    getDocument: () => doc,
    export: exportFn,
    on: (_event: string, cb: ProgressListener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as AppCtx['engine'];

  return {
    engine,
    exportCalls,
    emitProgress: (done: number, total: number) => emit({ type: 'export-progress', done, total, label: 'video' }),
    finishExport: (result: ExportResult) => { resolveExport?.(result); },
    listenerCount: () => listeners.size,
  };
}

function q(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('export dialog', () => {
  afterEach(() => {
    document.body.querySelectorAll('div').forEach((el) => el.remove());
  });

  it('defaults from doc.clock (fps, duration) and reflects fps edits in the request', async () => {
    const { engine, exportCalls } = fakeEngine({ clock: { fps: 24, duration: 3 } });
    openExportVideoDialog({ engine } as AppCtx);

    const fpsInput = q('[data-testid="ev-fps"]') as HTMLInputElement;
    expect(fpsInput.value).toBe('24');
    const toInput = q('[data-testid="ev-to"]') as HTMLInputElement;
    expect(toInput.value).toBe('3');

    fpsInput.value = '10';
    fpsInput.dispatchEvent(new Event('change', { bubbles: true }));

    (q('[data-testid="export-video-ok"]') as HTMLButtonElement).click();
    await flush();

    expect(exportCalls).toHaveLength(1);
    expect(exportCalls[0]!.options?.fps).toBe(10);
    expect(exportCalls[0]!.range).toEqual({ from: 0, to: 3 });
  });

  it('falls back to a 2s range when the document has no stated duration', () => {
    const { engine } = fakeEngine({ clock: { fps: 30 } });
    openExportVideoDialog({ engine } as AppCtx);
    const toInput = q('[data-testid="ev-to"]') as HTMLInputElement;
    expect(toInput.value).toBe('2');
  });

  it('disables OK while exporting, and closes (unsubscribing progress) once export settles', async () => {
    const fake = fakeEngine();
    openExportVideoDialog({ engine: fake.engine } as AppCtx);

    const ok = () => q('[data-testid="export-video-ok"]') as HTMLButtonElement;
    expect(ok().disabled).toBe(false);

    ok().click();
    await flush();
    expect(ok().disabled).toBe(true);
    expect(fake.listenerCount()).toBe(1);

    fake.finishExport({ mime: 'video/mp4', data: new ArrayBuffer(0), fileName: 'x.mp4' });
    await flush();
    await flush();

    // onOk's promise resolving lets dialog-shell's deferred close() run: the
    // dialog closes itself once the export settles (dialog-shell.ts's doOk).
    expect(document.querySelector('[data-testid="export-video-dialog"]')).toBeNull();
    expect(fake.listenerCount()).toBe(0);
  });

  it('surfaces strictly increasing progress events as "frame N / M" while running', async () => {
    const fake = fakeEngine();
    openExportVideoDialog({ engine: fake.engine } as AppCtx);
    (q('[data-testid="export-video-ok"]') as HTMLButtonElement).click();
    await flush();

    const seen: { done: number; total: number }[] = [];
    for (const [done, total] of [[1, 10], [2, 10], [3, 10]] as const) {
      fake.emitProgress(done, total);
      await flush();
      const row = document.querySelector('[data-testid="ev-row-progress"] .gd-form-control');
      const match = row?.textContent?.match(/frame (\d+) \/ (\d+)/);
      expect(match).toBeTruthy();
      seen.push({ done: Number(match![1]), total: Number(match![2]) });
    }

    for (let i = 1; i < seen.length; i++) expect(seen[i]!.done).toBeGreaterThan(seen[i - 1]!.done);
    expect(seen.at(-1)).toEqual({ done: 3, total: 10 });

    fake.finishExport({ mime: 'video/mp4', data: new ArrayBuffer(0), fileName: 'x.mp4' });
    await flush();
  });

  it('unsubscribes progress on Cancel mid-export (in-flight export left to settle on its own)', async () => {
    const fake = fakeEngine();
    openExportVideoDialog({ engine: fake.engine } as AppCtx);
    (q('[data-testid="export-video-ok"]') as HTMLButtonElement).click();
    await flush();
    expect(fake.listenerCount()).toBe(1);

    (q('[data-testid="export-video-cancel"]') as HTMLButtonElement).click();
    expect(fake.listenerCount()).toBe(0);

    // A late progress event after cancel must not throw or resurrect the dialog.
    expect(() => fake.emitProgress(5, 10)).not.toThrow();
    fake.finishExport({ mime: 'video/mp4', data: new ArrayBuffer(0), fileName: 'x.mp4' });
    await flush();
  });

  it('sends the png-sequence target when that format is selected', async () => {
    const { engine, exportCalls } = fakeEngine();
    openExportVideoDialog({ engine } as AppCtx);

    const formatSelect = q('[data-testid="ev-format"]') as HTMLSelectElement;
    formatSelect.value = 'png-sequence';
    formatSelect.dispatchEvent(new Event('change', { bubbles: true }));

    (q('[data-testid="export-video-ok"]') as HTMLButtonElement).click();
    await flush();

    expect(exportCalls[0]!.target).toBe('png-sequence');
  });
});
