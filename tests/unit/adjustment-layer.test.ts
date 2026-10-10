// @vitest-environment happy-dom
/**
 * Unit coverage for the ADJUST block (see gdesign-wt/adjust). The scheduler
 * branch itself (core/engine.ts's renderNodes) needs a real GPU device and
 * has no lightweight fake-device path in this repo (see registries.test.ts's
 * doc comment on the same limitation for wantsBackdrop/renderNodes). That
 * behaviour is covered by tests/e2e/adjustment.spec.ts instead. This file
 * covers what IS unit-testable: the new-layer command batch shape, the
 * Layers-menu/Adjustments-menu wiring, and the layers-panel indicator icon.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { executeCommand } from '../../src/app/commands/registry';
import { mountMenubar, buildEffectMenus } from '../../src/ui/shell/menubar';
import { applyEdits } from '../../src/engine/doc/document';
import { history } from '../../src/app/commands/app-history';
import { viewState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, DocumentJSON, EngineHost } from '@engine';

function fakeEngine(doc: DocumentJSON): EngineHost {
  return {
    getDocument: () => doc,
    applyEdits: (edits: DocEdit[]) => applyEdits(doc, edits),
    listBlendModes: () => [{ id: 'normal', label: 'Normal' }],
  } as unknown as EngineHost;
}

function emptyDoc(): DocumentJSON {
  return {
    version: 1,
    canvas: { width: 1280, height: 720, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [],
    postChain: [],
    assets: {},
  } as unknown as DocumentJSON;
}

describe('layer.newAdjustment command', () => {
  beforeEach(() => {
    history.clear();
    viewState.update((s) => ({ ...s, activeLayer: null }));
  });

  it('inserts a Layer whose source.type is core.adjustment, with an empty chain, in one undo step', () => {
    const doc = emptyDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };

    executeCommand(app, 'layer.newAdjustment');

    expect(doc.layers).toHaveLength(1);
    const layer = doc.layers[0]!;
    expect(layer.kind).toBe('layer');
    expect(layer.kind === 'layer' && layer.source.type).toBe('core.adjustment');
    expect(layer.chain).toEqual([]);
    expect(layer.kind === 'layer' && layer.liveness).toBe('live'); // adjustment layers can't be baked
    expect(viewState.get().activeLayer).toBe(layer.id);
    expect(history.entries().map((e) => e.label)).toEqual(['New Adjustment Layer']);
  });

  it('inserts above the active layer, mirroring layer.new\'s siblingInsertPoint', () => {
    const doc = emptyDoc();
    doc.layers.push({
      id: 'base' as never, kind: 'layer', name: 'Base', enabled: true,
      source: { type: 'core.solid', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, liveness: 'baked',
    });
    viewState.update((s) => ({ ...s, activeLayer: 'base' }));
    const app: AppCtx = { engine: fakeEngine(doc) };

    executeCommand(app, 'layer.newAdjustment');

    expect(doc.layers).toHaveLength(2);
    expect(doc.layers[0]!.id).toBe('base');
    expect(doc.layers[1]!.kind === 'layer' && doc.layers[1]!.source.type).toBe('core.adjustment');
  });
});

describe('Adjustments menu New Adjustment Layer bridge', () => {
  it('leads the Adjustments menu, ahead of the registered adjustment effects', () => {
    const engine = {
      listEffects: () => [
        { id: 'core.levels', label: 'Levels', category: 'adjustment', menuPath: 'Adjustments/Levels', params: {} },
      ],
    } as unknown as AppCtx['engine'];
    const app: AppCtx = { engine };
    const root = document.createElement('div');
    mountMenubar(app, root);

    const trigger = [...root.querySelectorAll('[data-testid="menu-trigger"]')].find((b) => b.textContent?.trim() === 'Adjustments') as HTMLElement;
    const menu = root.querySelector(`#${trigger.getAttribute('popovertarget')}`) as HTMLElement;

    const itemLabels = [...menu.querySelectorAll('[data-testid="menu-item"] .gd-menu-label')].map((s) => s.textContent?.trim());
    expect(itemLabels[0]).toBe('New adjustment layer');
    expect(itemLabels).toContain('Levels');
  });

  // buildEffectMenus itself stays pure/unchanged: the bridge lives in
  // menubar.ts's effectMenus() wrapper, exercised above via mountMenubar.
  it('buildEffectMenus alone (no bridge) is unaffected', () => {
    const menus = buildEffectMenus([{ id: 'core.levels', label: 'Levels', menuPath: 'Adjustments/Levels' }]);
    expect(menus).toEqual([{ label: 'Adjustments', items: [{ label: 'Levels', command: 'effect.open', args: 'core.levels' }] }]);
  });
});

describe('layers panel adjustment-layer row indicator', () => {
  it('shows the indicator icon only for a core.adjustment layer, not an ordinary layer', async () => {
    const { layersPanel } = await import('../../src/ui/panels/layers');
    const { render } = await import('lit-html');
    const doc = emptyDoc();
    doc.layers.push(
      {
        id: 'solid-1' as never, kind: 'layer', name: 'Solid', enabled: true,
        source: { type: 'core.solid', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, liveness: 'baked',
      },
      {
        id: 'adj-1' as never, kind: 'layer', name: 'Adjustment 1', enabled: true,
        source: { type: 'core.adjustment', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, liveness: 'live',
      },
    );
    const app: AppCtx = { engine: fakeEngine(doc) };
    const root = document.createElement('div');
    render(layersPanel.render(app), root);

    const rows = [...root.querySelectorAll('[data-testid="layer-row"]')];
    expect(rows).toHaveLength(2);
    // displayOrder is top-first: row 0 = 'Adjustment 1' (last pushed = top of stack).
    expect(rows[0]!.querySelector('[data-testid="layer-adjustment-icon"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-testid="layer-adjustment-icon"]')).toBeNull();
  });
});
