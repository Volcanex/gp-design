// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mountMenubar, buildEffectMenus } from '../../src/ui/shell/menubar';
import type { AppCtx } from '../../src/app/types';

function fakeApp(): AppCtx {
  const engine = {
    listEffects: () => [
      { id: 'core.levels', label: 'Levels', category: 'adjustment', menuPath: 'Adjustments/Levels', params: {} },
      { id: 'core.curves', label: 'Curves', category: 'adjustment', menuPath: 'Adjustments/Curves', params: {} },
      { id: 'core.invert', label: 'Invert', category: 'look', menuPath: 'Effects/Invert', params: {} },
      { id: 'core.unbound-thing', label: 'Unbound Thing', category: 'look', menuPath: 'Effects/Unbound Thing', params: {} },
    ],
  } as unknown as AppCtx['engine'];
  return { engine };
}

/** Menus are popovers now: every item is in the DOM from mount, so a test
 * reads the menu by its trigger's popovertarget instead of clicking. */
function menuOf(root: HTMLElement, label: string): HTMLElement {
  const trigger = [...root.querySelectorAll('[data-testid="menu-trigger"]')].find((b) => b.textContent?.trim() === label) as HTMLElement;
  return root.querySelector(`#${trigger.getAttribute('popovertarget')}`) as HTMLElement;
}

function hintFor(root: HTMLElement, menuLabel: string, itemLabel: string): string {
  const item = [...menuOf(root, menuLabel).querySelectorAll('[data-testid="menu-item"]')].find(
    (b) => b.querySelector('.gd-menu-label')?.textContent?.trim() === itemLabel,
  ) as HTMLElement;
  return [...item.querySelectorAll('.kbd')].map((k) => k.textContent?.trim()).join('+');
}

describe('menubar effect hints', () => {
  it('only shows the bound shortcut on its own effect, not every generated item', () => {
    const root = document.createElement('div');
    mountMenubar(fakeApp(), root);

    expect(hintFor(root, 'Adjustments', 'Levels')).toBe('Ctrl+L');
    expect(hintFor(root, 'Adjustments', 'Curves')).toBe('Ctrl+Shift+M');

    expect(hintFor(root, 'Effects', 'Invert')).toBe('Ctrl+Shift+I');
    expect(hintFor(root, 'Effects', 'Unbound thing')).toBe('');
  });
});

describe('buildEffectMenus grouping', () => {
  it('skips effects with no menuPath (internal passes like Blit/Composite)', () => {
    const menus = buildEffectMenus([
      { id: 'core.blit', label: 'Blit' },
      { id: 'core.invert', label: 'Invert', menuPath: 'Effects/Invert' },
    ]);
    const effects = menus.find((m) => m.label === 'Effects')!;
    expect(effects.items.map((i) => i.label)).toEqual(['Invert']);
  });

  it('puts ungrouped items first, then groups sorted alphabetically behind a header', () => {
    const menus = buildEffectMenus([
      { id: 'core.zeta', label: 'Zeta', menuPath: 'Effects/Zebra/Zeta' },
      { id: 'core.blur', label: 'Blur', menuPath: 'Effects/Blur' },
      { id: 'core.noise', label: 'Noise', menuPath: 'Effects/Ambient/Noise' },
    ]);
    const effects = menus.find((m) => m.label === 'Effects')!;
    expect(effects.items).toEqual([
      { label: 'Blur', command: 'effect.open', args: 'core.blur' },
      { label: 'Ambient', header: true },
      { label: 'Noise', command: 'effect.open', args: 'core.noise' },
      { label: 'Zebra', header: true },
      { label: 'Zeta', command: 'effect.open', args: 'core.zeta' },
    ]);
  });

  it('a 2-segment menuPath stays ungrouped (unchanged behaviour)', () => {
    const menus = buildEffectMenus([{ id: 'core.levels', label: 'Levels', menuPath: 'Adjustments/Levels' }]);
    expect(menus).toEqual([{ label: 'Adjustments', items: [{ label: 'Levels', command: 'effect.open', args: 'core.levels' }] }]);
  });
});
