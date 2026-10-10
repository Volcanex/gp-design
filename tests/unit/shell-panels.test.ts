// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountShell } from '../../src/ui/shell/shell';
import { createMockEngineHost } from '../../src/app/mock/MockEngineHost';
import { layoutState, statusMessage } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';

function stubRect(el: Element, width: number, height: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
}

function stubOffsetSize(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
}

describe('shell: drag-and-drop import + panel placement clamp', () => {
  let root: HTMLElement;
  let app: AppCtx;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
    const canvas = document.createElement('canvas');
    app = { engine: createMockEngineHost() } as AppCtx;
    mountShell(app, root, canvas);
  });

  afterEach(() => {
    root.remove();
    statusMessage.set(null);
  });

  it('imports a dropped image file as a new layer', async () => {
    const bitmap = { width: 4, height: 4, close: () => {} };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    const before = app.engine.getDocument().layers.length;

    const region = root.querySelector('.gd-canvas-region') as HTMLElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
    const dataTransfer = { files: [file] } as unknown as DataTransfer;
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent & { dataTransfer: DataTransfer };
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    region.dispatchEvent(drop);

    await vi.waitFor(() => {
      expect(app.engine.getDocument().layers.length).toBe(before + 1);
    });
    vi.unstubAllGlobals();
  });

  it('surfaces a statusbar message when the dropped file fails to decode', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('bad image')));

    const region = root.querySelector('.gd-canvas-region') as HTMLElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'broken.png', { type: 'image/png' });
    const dataTransfer = { files: [file] } as unknown as DataTransfer;
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent & { dataTransfer: DataTransfer };
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    region.dispatchEvent(drop);

    await vi.waitFor(() => {
      expect(statusMessage.get()).toBe("Couldn't decode image");
    });
    const statusbarEl = root.querySelector('.gd-statusbar') as HTMLElement;
    expect(statusbarEl.querySelector('[data-testid="status-message"]')?.textContent).toBe("Couldn't decode image");
    vi.unstubAllGlobals();
  });
});
