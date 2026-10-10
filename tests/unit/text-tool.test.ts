// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mountTextEditor, createTextToolHandler } from '../../src/ui/canvas/text-tool';
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
        source: { type: 'core.scene', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'live',
      },
    ],
    postChain: [],
    assets: {},
  } as unknown as DocumentJSON;
}

/** Real applyEdits (document.ts), not a stub: the text editor's commit path
 * exercises setParam's content.text special case, so it needs a document
 * that actually mutates. */
function fakeEngine(doc: DocumentJSON) {
  return {
    getDocument: () => doc,
    applyEdits: (edits: DocEdit[]) => applyEdits(doc, edits),
  } as unknown as EngineHost;
}

/** doc.layers[0]'s scene array, typed just enough for these assertions.
 * ObjectNode content is a discriminated union the frozen json.ts doesn't
 * narrow through a raw params bag, so this stays a local test cast. */
function sceneOf(doc: DocumentJSON): { content: { type: string; text: { text: string } } }[] {
  return (doc.layers[0] as unknown as { source: { params: { scene: { content: { type: string; text: { text: string } } }[] } } }).source.params.scene;
}

function mountDom() {
  const canvasRegion = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.style.width = '1280px';
  canvas.style.height = '720px';
  canvas.style.transform = 'translate(0px, 0px)';
  canvasRegion.appendChild(canvas);
  document.body.appendChild(canvasRegion);
  return { canvasRegion, canvas };
}

describe('text tool + floating editor', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
    viewState.set({ zoom: 1, panX: 0, panY: 0, activeLayer: 'scene-1', collapsedGroups: [], maskEditing: null });
  });

  // Each test mounts its own textarea into document.body; happy-dom only
  // lets one element hold focus document-wide, so a leftover focused
  // textarea from a prior test fires a spurious 'blur' (-> commit()) the
  // instant the next test's textarea.focus() steals it. Clear the DOM
  // between tests so focus never crosses test boundaries.
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('click inserts a text object at that point and opens the editor immediately', async () => {
    const doc = freshDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const { canvasRegion, canvas } = mountDom();
    const editor = mountTextEditor(app, canvasRegion, canvas);
    const handler = createTextToolHandler(editor);

    handler.down({ x: 100, y: 100, pressure: 1 }, 'text');

    const scene = (doc.layers[0] as { source: { params: { scene?: unknown[] } } }).source.params.scene;
    expect(scene).toHaveLength(1);
    const textarea = canvasRegion.querySelector<HTMLTextAreaElement>('[data-testid="text-editor"]')!;
    expect(textarea.style.display).not.toBe('none');
    // Focus is deferred one macrotask (setTimeout 0) past the click. See
    // text-tool.ts's comment: the browser's own default mousedown focus
    // handling would otherwise steal it right back.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(textarea);
  });

  it('Enter commits content.text via patchCommand as one undo step', () => {
    const doc = freshDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const { canvasRegion, canvas } = mountDom();
    const editor = mountTextEditor(app, canvasRegion, canvas);
    const handler = createTextToolHandler(editor);

    handler.down({ x: 100, y: 100, pressure: 1 }, 'text');
    const textarea = canvasRegion.querySelector<HTMLTextAreaElement>('[data-testid="text-editor"]')!;
    textarea.value = 'Hello';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const scene = sceneOf(doc);
    expect(scene[0]!.content.text.text).toBe('Hello');
    expect(textarea.style.display).toBe('none');
    expect(history.entries()).toEqual([{ label: 'Insert Object', current: false }, { label: 'Edit Text', current: true }]);
  });

  it('Escape cancels without writing content.text', () => {
    const doc = freshDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const { canvasRegion, canvas } = mountDom();
    const editor = mountTextEditor(app, canvasRegion, canvas);
    const handler = createTextToolHandler(editor);

    handler.down({ x: 100, y: 100, pressure: 1 }, 'text');
    const textarea = canvasRegion.querySelector<HTMLTextAreaElement>('[data-testid="text-editor"]')!;
    textarea.value = 'Should not be saved';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const scene = sceneOf(doc);
    expect(scene[0]!.content.text.text).toBe('');
    expect(textarea.style.display).toBe('none');
    expect(history.entries()).toEqual([{ label: 'Insert Object', current: true }]);
  });

  it('double-click on an existing text object (move tool) opens the editor pre-filled', () => {
    const doc = freshDoc();
    const scene = doc.layers[0] as unknown as { source: { params: { scene?: unknown[] } } };
    scene.source.params.scene = [{
      id: 'txt-1', name: 'Text', enabled: true,
      transform: { x: 200, y: 100, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
      content: { type: 'text', text: { text: 'Existing', font: 'default', size: 48 } },
      style: {}, liveness: 'live',
    }];
    const app: AppCtx = { engine: fakeEngine(doc) };
    const { canvasRegion, canvas } = mountDom();
    const editor = mountTextEditor(app, canvasRegion, canvas);

    editor.openForObject('scene-1', 'txt-1');

    const textarea = canvasRegion.querySelector<HTMLTextAreaElement>('[data-testid="text-editor"]')!;
    expect(textarea.value).toBe('Existing');
    expect(textarea.style.display).not.toBe('none');
  });
});
