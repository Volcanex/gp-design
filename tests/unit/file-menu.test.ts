// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCommand } from '../../src/app/commands/registry';
import { history } from '../../src/app/commands/app-history';
import { viewState } from '../../src/app/stores';
import { createMockEngineHost } from '../../src/app/mock/MockEngineHost';
import { serializeDocument } from '../../src/app/commands/doc-serialize';
import type { AppCtx } from '../../src/app/types';

function fakeApp(): AppCtx {
  return { engine: createMockEngineHost() };
}

describe('File > New / Save / Open', () => {
  afterEach(() => {
    document.body.querySelectorAll('div').forEach((el) => el.remove());
  });

  it('New opens a dialog whose OK loads a fresh document at the given size and clears history', async () => {
    const app = fakeApp();
    history.push(app, { label: 'noop', run: () => {}, undo: () => {} });
    expect(history.canUndo()).toBe(true);

    executeCommand(app, 'file.new');
    const width = document.querySelector('[data-testid="nd-width"]') as HTMLInputElement;
    const height = document.querySelector('[data-testid="nd-height"]') as HTMLInputElement;
    width.value = '320';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    height.value = '240';
    height.dispatchEvent(new Event('change', { bubbles: true }));
    (document.querySelector('[data-testid="new-document-ok"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(history.canUndo()).toBe(false));
    const doc = app.engine.getDocument();
    expect(doc.canvas.width).toBe(320);
    expect(doc.canvas.height).toBe(240);
    expect(doc.layers.length).toBeGreaterThan(0);
    expect(viewState.get().activeLayer).toBe(doc.layers[doc.layers.length - 1]!.id);
  });

  it('a preset button sets both dimensions at once', async () => {
    const app = fakeApp();
    executeCommand(app, 'file.new');
    (document.querySelector('[data-testid="nd-preset-1920x1080"]') as HTMLButtonElement).click();
    (document.querySelector('[data-testid="new-document-ok"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(app.engine.getDocument().canvas.width).toBe(1920));
    expect(app.engine.getDocument().canvas.height).toBe(1080);
  });

  it('Save downloads the current document as a .gdesign.json blob', () => {
    const app = fakeApp();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      capturedBlob = b as Blob;
      return 'blob:fake';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    executeCommand(app, 'file.save');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(capturedBlob?.type).toBe('application/json');
    clickSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('Open loads a .gdesign.json file as a document (not an image import)', async () => {
    const app = fakeApp();
    const sourceDoc = app.engine.getDocument();
    const json = serializeDocument({ ...sourceDoc, canvas: { ...sourceDoc.canvas, width: 999 } });
    const file = new File([json], 'saved.gdesign.json', { type: 'application/json' });

    // file.open's <input type=file> is never appended to the DOM (it's
    // triggered via .click() alone), so capture it off document.createElement.
    let input: HTMLInputElement | undefined;
    const original = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = original(tag);
      if (tag === 'input') input = el as HTMLInputElement;
      return el;
    });

    executeCommand(app, 'file.open');
    createSpy.mockRestore();
    Object.defineProperty(input, 'files', { value: [file] });
    input!.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(app.engine.getDocument().canvas.width).toBe(999);
    });
  });
});
