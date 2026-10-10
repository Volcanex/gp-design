// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'lit-html';
import { effectsPanel } from '../../src/ui/panels/effects';
import { applyEdits } from '../../src/engine/doc/document';
import { history } from '../../src/app/commands/app-history';
import { selectionState, viewState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, DocumentJSON, EngineHost } from '@engine';

function freshDoc(): DocumentJSON {
  return {
    version: 1,
    canvas: { width: 1280, height: 720, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [
      {
        id: 'scene-1', kind: 'layer', name: 'Scene', enabled: true,
        source: {
          type: 'core.scene',
          params: {
            scene: [
              {
                id: 'rect-1', name: 'Rect', enabled: true,
                transform: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
                content: { type: 'shape', shape: { shape: 'rect', width: 100, height: 50 } },
                style: {}, liveness: 'live',
              },
              {
                id: 'txt-1', name: 'Text', enabled: true,
                transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
                content: { type: 'text', text: { text: 'hello', font: 'default', size: 24 } },
                style: { fill: [0.5, 0, 0, 1] }, liveness: 'live',
              },
              {
                id: 'img-1', name: 'Image', enabled: true,
                transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
                content: { type: 'image', asset: 'asset-abcdef1234' },
                style: {}, liveness: 'live',
              },
            ],
          },
        },
        chain: [], blendMode: 'normal', opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'live',
      },
    ],
    postChain: [],
    assets: {},
  } as unknown as DocumentJSON;
}

/** Real applyEdits (document.ts): the panel's commits exercise setTransform
 * and the content.* setParam special cases, so this needs a document that
 * actually mutates, mirroring text-tool.test.ts's fakeEngine. */
function fakeEngine(doc: DocumentJSON) {
  return {
    getDocument: () => doc,
    applyEdits: (edits: DocEdit[]) => applyEdits(doc, edits),
    listEffects: () => [],
  } as unknown as EngineHost;
}

function mount(app: AppCtx): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(effectsPanel.render(app), host);
  return host;
}

describe('Effects panel: Object section', () => {
  beforeEach(() => {
    history.clear();
    viewState.set({ zoom: 1, panX: 0, panY: 0, activeLayer: null, collapsedGroups: [] });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is hidden when nothing is selected', () => {
    selectionState.set({ objects: [], marquee: null });
    const doc = freshDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const host = mount(app);
    expect(host.querySelector('[data-testid="effects-object-section"]')).toBeNull();
  });

  it('is hidden for a multi-object selection', () => {
    selectionState.set({ objects: ['rect-1', 'txt-1'], marquee: null });
    const doc = freshDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const host = mount(app);
    expect(host.querySelector('[data-testid="effects-object-section"]')).toBeNull();
  });

  it('shows transform fields + fill for a selected shape, and commits Move/Resize/Rotate as separate labels', () => {
    selectionState.set({ objects: ['rect-1'], marquee: null });
    const doc = freshDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const host = mount(app);

    const x = host.querySelector<HTMLInputElement>('[data-testid="object-x"]')!;
    expect(x.value).toBe('10');
    x.value = '30';
    x.dispatchEvent(new Event('change', { bubbles: true }));
    expect(history.entries().at(-1)).toEqual({ label: 'Move', current: true });

    const width = host.querySelector<HTMLInputElement>('[data-testid="object-width"]')!;
    expect(width.value).toBe('100');

    const rotation = host.querySelector<HTMLInputElement>('[data-testid="object-rotation"]')!;
    rotation.value = '90';
    rotation.dispatchEvent(new Event('change', { bubbles: true }));

    const rect = (doc.layers[0] as any).source.params.scene.find((o: any) => o.id === 'rect-1');
    expect(rect.transform.x).toBe(30);
    expect(Math.abs(rect.transform.rotation - Math.PI / 2)).toBeLessThan(1e-9);
    expect(history.entries().at(-1)).toEqual({ label: 'Rotate', current: true });

    expect(host.querySelector('[data-testid="object-fill"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="object-text"]')).toBeNull();
  });

  it('resize commits scaleX/scaleY derived from the content box, not raw width/height', () => {
    selectionState.set({ objects: ['rect-1'], marquee: null });
    const doc = freshDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const host = mount(app);

    const width = host.querySelector<HTMLInputElement>('[data-testid="object-width"]')!;
    width.value = '200'; // box.width is 100 -> scaleX should become 2
    width.dispatchEvent(new Event('change', { bubbles: true }));

    const rect = (doc.layers[0] as any).source.params.scene.find((o: any) => o.id === 'rect-1');
    expect(rect.transform.scaleX).toBe(2);
    expect(rect.transform.width).toBeUndefined();
  });

  it('shows editable text/size/fill for a selected text object, and commits via content.* setParam', () => {
    selectionState.set({ objects: ['txt-1'], marquee: null });
    const doc = freshDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const host = mount(app);

    const textarea = host.querySelector<HTMLTextAreaElement>('[data-testid="object-text"]')!;
    expect(textarea.value).toBe('hello');
    textarea.value = 'world';
    textarea.dispatchEvent(new Event('change', { bubbles: true }));

    const size = host.querySelector<HTMLInputElement>('[data-testid="object-text-size"]')!;
    expect(size.value).toBe('24');
    size.value = '40';
    size.dispatchEvent(new Event('change', { bubbles: true }));

    const txt = (doc.layers[0] as any).source.params.scene.find((o: any) => o.id === 'txt-1');
    expect(txt.content.text.text).toBe('world');
    expect(txt.content.text.size).toBe(40);
    expect(history.entries().map((e) => e.label)).toEqual(['Edit Text', 'Resize Text']);
    expect(host.querySelector('[data-testid="object-fill"]')).not.toBeNull();
  });

  it('shows only transform + an asset-name label for a selected image object', () => {
    selectionState.set({ objects: ['img-1'], marquee: null });
    const doc = freshDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const host = mount(app);

    expect(host.querySelector('[data-testid="object-x"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="object-fill"]')).toBeNull();
    expect(host.querySelector('[data-testid="object-text"]')).toBeNull();
    expect(host.querySelector('[data-testid="object-image-asset"]')!.textContent).toBe('asset-ab');
  });

  it('committing content.fill via the color popover round-trips through undo', () => {
    selectionState.set({ objects: ['rect-1'], marquee: null });
    const doc = freshDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const host = mount(app);

    const swatch = host.querySelector<HTMLButtonElement>('[data-testid="object-fill"]')!;
    swatch.click();
    const hex = document.querySelector<HTMLInputElement>('[data-testid="pf-color-hex"]')!;
    expect(hex).not.toBeNull();
    hex.value = '#ff0000';
    hex.dispatchEvent(new Event('change', { bubbles: true }));

    const rect = (doc.layers[0] as any).source.params.scene.find((o: any) => o.id === 'rect-1');
    expect(rect.style.fill).toBeDefined();
    expect(history.entries().at(-1)).toEqual({ label: 'Change Fill', current: true });

    history.undo(app);
    const rectAfterUndo = (doc.layers[0] as any).source.params.scene.find((o: any) => o.id === 'rect-1');
    expect(rectAfterUndo.style.fill).toBeUndefined();
  });
});
