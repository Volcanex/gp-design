// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openEffectDialog } from '../../src/ui/dialogs/effect-dialog';
import { viewState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit } from '@engine';
import { layerId } from '@engine';

function makeDoc(): any {
  return {
    version: 1,
    canvas: { width: 100, height: 100, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [
      {
        id: 'l1', kind: 'layer', name: 'L1', enabled: true,
        source: { type: 'core.solid', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'baked',
      },
    ],
    postChain: [],
    assets: {},
  };
}

/** A fake engine with real setChain semantics (mutates the live doc, returns
 * the correct inverse). Mirrors document.ts's resolveChainContainer. */
function fakeEngine() {
  const doc = makeDoc();
  const engine = {
    getDocument: () => doc,
    applyEdits(edits: DocEdit[]) {
      const inverses: DocEdit[] = [];
      for (const edit of edits as any[]) {
        if (edit.op === 'setChain') {
          const node = doc.layers.find((l: any) => l.id === edit.target.id);
          const old = node.chain;
          node.chain = edit.chain;
          inverses.unshift({ op: 'setChain', target: edit.target, chain: old });
        }
      }
      return inverses;
    },
    listEffects: () => [
      {
        id: 'core.exposure', label: 'Exposure', category: 'adjustment', menuPath: 'Adjustments/Exposure',
        params: { exposure: { kind: 'float', default: 0, min: -4, max: 4, step: 0.01, label: 'Exposure' } },
      },
    ],
    on: () => () => {},
  } as unknown as AppCtx['engine'];
  return { engine, doc };
}

describe('effect dialog cancel revert', () => {
  afterEach(() => {
    document.body.querySelectorAll('div').forEach((el) => el.remove());
  });

  it('Cancel fully reverts the doc even with a pending debounced preview', () => {
    vi.useFakeTimers();
    const { engine, doc } = fakeEngine();
    const app = { engine } as AppCtx;
    viewState.update((s) => ({ ...s, activeLayer: 'l1' }));
    const before = JSON.stringify(doc);

    openEffectDialog(app, 'core.exposure');
    const slider = document.querySelector('[data-testid="pf-slider-exposure"]') as HTMLInputElement;
    slider.value = '2';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(10); // less than the 30ms debounce: preview hasn't fired yet

    (document.querySelector('[data-testid="effect-cancel"]') as HTMLButtonElement).click();
    vi.advanceTimersByTime(100);

    expect(JSON.stringify(doc)).toBe(before);
    vi.useRealTimers();
  });

  it('root cause: a scrub-drag left mid-gesture when Cancel fires must not resurrect the effect', () => {
    // params-form.ts's startScrub attaches window-level mousemove/mouseup
    // listeners that only detach on an actual mouseup: closing the dialog
    // (Cancel/OK/Escape) doesn't touch them. If the scrub is still "held"
    // when Cancel is clicked, a leaked mousemove can still call preview(),
    // scheduling a debounced applyEdits that reapplies the effect onto the
    // already-reverted document.
    vi.useFakeTimers();
    const { engine, doc } = fakeEngine();
    const app = { engine } as AppCtx;
    viewState.update((s) => ({ ...s, activeLayer: 'l1' }));
    const before = JSON.stringify(doc);

    openEffectDialog(app, 'core.exposure');
    const label = document.querySelector('[data-testid="pf-label-exposure"]') as HTMLElement;
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 }));

    (document.querySelector('[data-testid="effect-cancel"]') as HTMLButtonElement).click();

    // Mouse button never released (test never fires 'mouseup'): the leaked
    // scrub listener is still live and gets one more move.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 80 }));
    vi.advanceTimersByTime(100);

    expect(JSON.stringify(doc)).toBe(before);
    vi.useRealTimers();
  });

  it('OK commits exactly one history entry with the final params', () => {
    const { engine, doc } = fakeEngine();
    const app = { engine } as AppCtx;
    viewState.update((s) => ({ ...s, activeLayer: 'l1' }));

    openEffectDialog(app, 'core.exposure');
    const slider = document.querySelector('[data-testid="pf-slider-exposure"]') as HTMLInputElement;
    slider.value = '1.5';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-testid="effect-ok"]') as HTMLButtonElement).click();

    expect(doc.layers[0].chain).toHaveLength(1);
    expect(doc.layers[0].chain[0].params.exposure).toBe(1.5);
  });
});

describe('effect dialog edit-in-place (opts.instanceId)', () => {
  afterEach(() => {
    document.body.querySelectorAll('div').forEach((el) => el.remove());
  });

  it('seeds params from the existing instance, not defaults', () => {
    const { engine, doc } = fakeEngine();
    doc.layers[0].chain = [{ id: 'existing-1', pass: 'core.exposure', params: { exposure: 2.5 }, enabled: true }];
    const app = { engine } as AppCtx;
    viewState.update((s) => ({ ...s, activeLayer: 'l1' }));

    openEffectDialog(app, 'core.exposure', { target: { kind: 'layer', id: layerId('l1') }, instanceId: 'existing-1' });

    const slider = document.querySelector('[data-testid="pf-slider-exposure"]') as HTMLInputElement;
    expect(Number(slider.value)).toBe(2.5);
  });

  it('title gains an "Edit " prefix', () => {
    const { engine, doc } = fakeEngine();
    doc.layers[0].chain = [{ id: 'existing-1', pass: 'core.exposure', params: { exposure: 0 }, enabled: true }];
    const app = { engine } as AppCtx;
    viewState.update((s) => ({ ...s, activeLayer: 'l1' }));

    openEffectDialog(app, 'core.exposure', { target: { kind: 'layer', id: layerId('l1') }, instanceId: 'existing-1' });

    expect(document.querySelector('.dlg-title')!.textContent).toBe('Edit Exposure');
  });

  it('OK replaces the matching entry in place: no duplicate, position preserved', () => {
    const { engine, doc } = fakeEngine();
    doc.layers[0].chain = [
      { id: 'fx-a', pass: 'core.exposure', params: { exposure: 1 }, enabled: true },
      { id: 'fx-b', pass: 'core.exposure', params: { exposure: -1 }, enabled: false },
    ];
    const app = { engine } as AppCtx;
    viewState.update((s) => ({ ...s, activeLayer: 'l1' }));

    openEffectDialog(app, 'core.exposure', { target: { kind: 'layer', id: layerId('l1') }, instanceId: 'fx-a' });
    const slider = document.querySelector('[data-testid="pf-slider-exposure"]') as HTMLInputElement;
    slider.value = '3';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-testid="effect-ok"]') as HTMLButtonElement).click();

    expect(doc.layers[0].chain).toHaveLength(2);
    expect(doc.layers[0].chain[0].id).toBe('fx-a');
    expect(doc.layers[0].chain[0].params.exposure).toBe(3);
    expect(doc.layers[0].chain[1].id).toBe('fx-b');
    expect(doc.layers[0].chain[1].params.exposure).toBe(-1); // untouched
  });

  it('Cancel restores the pre-edit chain exactly (edited instance keeps its original params)', () => {
    const { engine, doc } = fakeEngine();
    doc.layers[0].chain = [{ id: 'fx-a', pass: 'core.exposure', params: { exposure: 1 }, enabled: true }];
    const app = { engine } as AppCtx;
    viewState.update((s) => ({ ...s, activeLayer: 'l1' }));
    const before = JSON.stringify(doc.layers[0].chain);

    openEffectDialog(app, 'core.exposure', { target: { kind: 'layer', id: layerId('l1') }, instanceId: 'fx-a' });
    const slider = document.querySelector('[data-testid="pf-slider-exposure"]') as HTMLInputElement;
    slider.value = '3';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-testid="effect-cancel"]') as HTMLButtonElement).click();

    expect(JSON.stringify(doc.layers[0].chain)).toBe(before);
  });
});
