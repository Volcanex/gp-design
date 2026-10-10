/**
 * The application menubar: g-system's `.g-menubar` over ordinary `.menu`
 * popovers (Popover API: light dismiss, Escape and arrow keys come from
 * g-ui.js, hover-to-switch from the menubar fragment). Adjustments and
 * Effects are built from app.engine.listEffects(), grouped by
 * EffectMeta.menuPath (split on '/', first segment is the top menu).
 *
 * The menus are rendered once and re-rendered in place on layout changes
 * (the Window menu's check marks). lit-html keeps the same `.menu` elements
 * across renders, which matters: g-ui.js's initMenu binds to the element
 * once and does not guard against a second init.
 */

import { html, nothing, render } from 'lit-html';
import type { AppCtx } from '../../app/types';
import { executeCommand } from '../../app/commands/registry';
import { formatKeys } from '../../app/keymap/keymap';
import { layoutState } from '../../app/stores';
import { icon } from '../icons';

interface MenuItem {
  label: string;
  command?: string;
  args?: unknown;
  run?: () => void;
  disabled?: boolean;
  separator?: boolean;
  /** Non-interactive group label (`.menu-heading`). */
  header?: boolean;
  /** Reads the current state for a check mark. */
  checked?: () => boolean;
}

interface Menu {
  label: string;
  items: MenuItem[];
}

const sep: MenuItem = { separator: true, label: '' };

function fileMenu(): Menu {
  return {
    label: 'File',
    items: [
      { label: 'New document…', command: 'file.new' },
      { label: 'Open…', command: 'file.open' },
      { label: 'Save', command: 'file.save' },
      sep,
      { label: 'Export image…', command: 'file.export' },
      { label: 'Export video…', command: 'file.exportVideo' },
    ],
  };
}

function editMenu(): Menu {
  return {
    label: 'Edit',
    items: [
      { label: 'Undo', command: 'edit.undo' },
      { label: 'Redo', command: 'edit.redo' },
      sep,
      { label: 'Cut', command: 'edit.cut' },
      { label: 'Copy', command: 'edit.copy' },
      { label: 'Copy merged', command: 'edit.copyMerged' },
      { label: 'Paste', command: 'edit.paste' },
      { label: 'Paste as layer', command: 'edit.pasteAsLayer' },
      sep,
      { label: 'Select all', command: 'edit.selectAll' },
      { label: 'Deselect', command: 'edit.deselect' },
      { label: 'Delete objects', command: 'edit.deleteSelected' },
      { label: 'Fill selection', command: 'edit.fillSelection' },
      sep,
      { label: 'Repeat last effect', command: 'edit.repeatEffect' },
    ],
  };
}

function viewMenu(): Menu {
  const theme = () => document.documentElement.dataset.theme ?? 'dark';
  return {
    label: 'View',
    items: [
      { label: 'Zoom in', command: 'view.zoomIn' },
      { label: 'Zoom out', command: 'view.zoomOut' },
      { label: 'Actual size', command: 'view.actualSize' },
      { label: 'Zoom to window', command: 'view.zoomToWindow' },
      { label: 'Zoom to selection', command: 'view.zoomToSelection' },
      { label: 'Appearance', header: true },
      { label: 'Dark', command: 'view.theme', args: 'dark', checked: () => theme() === 'dark' },
      { label: 'Light', command: 'view.theme', args: 'light', checked: () => theme() === 'light' },
      { label: 'Match system', command: 'view.theme', args: 'system', checked: () => theme() === 'system' },
    ],
  };
}

function layersMenu(): Menu {
  return {
    label: 'Layers',
    items: [
      { label: 'New layer', command: 'layer.new' },
      { label: 'New adjustment layer', command: 'layer.newAdjustment' },
      { label: 'Duplicate layer', command: 'layer.duplicate' },
      { label: 'Delete layer', command: 'layer.delete' },
      sep,
      { label: 'Group', command: 'layer.group' },
      { label: 'Ungroup', command: 'layer.ungroup' },
      sep,
      { label: 'Add mask', command: 'layer.addMask' },
      { label: 'Remove mask', command: 'layer.removeMask' },
      { label: 'Enable mask', command: 'layer.enableMask' },
      { label: 'Disable mask', command: 'layer.disableMask' },
      { label: 'Invert mask', command: 'layer.toggleMaskInvert' },
      sep,
      { label: 'Merge down', command: 'layer.mergeDown' },
      { label: 'Flatten', command: 'layer.flatten' },
      { label: 'Layer properties…', command: 'layer.properties' },
      sep,
      { label: 'Toggle visibility', command: 'layer.toggleVisibility' },
      { label: 'Select layer above', command: 'layer.selectAbove' },
      { label: 'Select layer below', command: 'layer.selectBelow' },
    ],
  };
}

function insertMenu(): Menu {
  return {
    label: 'Insert',
    items: [
      { label: 'Scene layer', command: 'scene.newLayer' },
      sep,
      { label: 'Rectangle', command: 'object.insertRect' },
      { label: 'Ellipse', command: 'object.insertEllipse' },
      { label: 'Polygon', command: 'object.insertPolygon' },
      { label: 'Star', command: 'object.insertStar' },
      { label: 'Rounded rectangle', command: 'object.insertRoundedRect' },
      { label: 'Text', command: 'object.insertText' },
      sep,
      { label: 'Plasma layer', command: 'source.insertPlasma' },
      { label: 'Gradient layer', command: 'source.insertGradient' },
      { label: 'Noise layer', command: 'source.insertNoise' },
      { label: 'Feedback layer', command: 'source.insertFeedback' },
    ],
  };
}

function windowMenu(): Menu {
  const visible = (id: string) => () => layoutState.get().panels[id]?.visible ?? false;
  return {
    label: 'Window',
    items: [
      { label: 'Tools', command: 'panel.toggle', args: 'tools', checked: visible('tools') },
      { label: 'Layers', command: 'panel.toggle', args: 'layers', checked: visible('layers') },
      { label: 'Effects', command: 'panel.toggle', args: 'effects', checked: visible('effects') },
      { label: 'Colours', command: 'panel.toggle', args: 'colors', checked: visible('colors') },
      { label: 'History', command: 'panel.toggle', args: 'history', checked: visible('history') },
      { label: 'Timeline', command: 'panel.toggle', args: 'timeline', checked: visible('timeline') },
      sep,
      { label: 'Reset layout', command: 'panel.reset' },
    ],
  };
}

interface EffectMenuInput {
  id: string;
  label: string;
  menuPath?: string;
}

/**
 * Pure grouping transform, extracted for unit testing. Effects with no
 * menuPath are SKIPPED (not menu-worthy: internal passes like Blit/
 * Composite/to-rgb/from-rgb have none and must not leak into the Effects
 * menu). menuPath segments: [top] alone falls back to the effect's own
 * label as an ungrouped item; [top, leaf] is ungrouped; [top, group,
 * ...leaf] nests under a group. Groups render sorted alphabetically, after
 * the top menu's ungrouped items, each behind a non-interactive header.
 * Labels are passed through verbatim; sentence case is applied at render.
 */
export function buildEffectMenus(effects: EffectMenuInput[]): Menu[] {
  const tops = new Map<string, { ungrouped: MenuItem[]; groups: Map<string, MenuItem[]> }>();
  for (const meta of effects) {
    if (meta.menuPath == null) continue;
    const segments = meta.menuPath.split('/');
    const top = segments[0] || 'Effects';
    if (!tops.has(top)) tops.set(top, { ungrouped: [], groups: new Map() });
    const bucket = tops.get(top)!;
    const item = { command: 'effect.open', args: meta.id };
    if (segments.length >= 3) {
      const group = segments[1]!;
      const leaf = segments.slice(2).join('/');
      if (!bucket.groups.has(group)) bucket.groups.set(group, []);
      bucket.groups.get(group)!.push({ ...item, label: leaf });
    } else {
      const leaf = segments.length === 2 ? segments[1]! : meta.label;
      bucket.ungrouped.push({ ...item, label: leaf });
    }
  }
  return [...tops.entries()].map(([label, bucket]) => {
    const items: MenuItem[] = [...bucket.ungrouped];
    const sortedGroups = [...bucket.groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [group, groupItems] of sortedGroups) {
      items.push({ label: group, header: true });
      items.push(...groupItems);
    }
    return { label, items };
  });
}

function effectMenus(app: AppCtx): Menu[] {
  const menus = buildEffectMenus(app.engine.listEffects());
  // "New adjustment layer" leads the Adjustments menu (not just Layers) so
  // the concept is discoverable where users already look for adjustments.
  const adjustments = menus.find((m) => m.label === 'Adjustments');
  if (adjustments) {
    adjustments.items.unshift({ label: 'New adjustment layer', command: 'layer.newAdjustment' }, sep);
  }
  return menus;
}

/**
 * Sentence case at the boundary: effect labels come from engine metadata
 * in Title Case ("Drop Shadow"). Lowercases each later word that is a
 * plain capitalised word; acronyms (LUT, RGB) and hyphenated technical
 * terms keep their case.
 */
export function sentenceCase(label: string): string {
  return label
    .split(' ')
    .map((word, i) => (i > 0 && /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))
    .join(' ');
}

const KEY_DISPLAY: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '+',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Space: 'Space',
  Delete: 'Del',
  Escape: 'Esc',
};

function keyParts(commandId: string, args: unknown): string[] {
  const keys = formatKeys(commandId, args);
  if (!keys) return [];
  return keys.split('+').map((k) => KEY_DISPLAY[k] ?? k);
}

const slug = (label: string) => `gd-menu-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

export function mountMenubar(app: AppCtx, root: HTMLElement): void {
  root.dataset.testid = 'menubar';
  const menus = [fileMenu(), editMenu(), viewMenu(), layersMenu(), insertMenu(), ...effectMenus(app), windowMenu()];

  const activate = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.run) item.run();
    else if (item.command) executeCommand(app, item.command, item.args);
    renderMenubar();
  };

  function renderMenubar(): void {
    render(
      html`${menus.map(
        (menu) => html`
          <button type="button" class="g-menubar-item" data-testid="menu-trigger" popovertarget=${slug(menu.label)}>
            ${menu.label}
          </button>
          <div class="menu" popover id=${slug(menu.label)} data-testid="menu-dropdown">
            ${menu.items.map((item) =>
              item.separator
                ? html`<hr class="separator" />`
                : item.header
                ? html`<div class="menu-heading" data-testid="menu-heading">${item.label}</div>`
                : html`
                    <button
                      type="button"
                      class="menu-item"
                      data-testid="menu-item"
                      ?disabled=${item.disabled}
                      aria-checked=${item.checked ? (item.checked() ? 'true' : 'false') : nothing}
                      @click=${() => activate(item)}
                    >
                      <span class="gd-menu-check">${item.checked?.() ? icon('check') : nothing}</span>
                      <span class="gd-menu-label">${sentenceCase(item.label)}</span>
                      ${item.command ? keyParts(item.command, item.args).map((k) => html`<span class="kbd">${k}</span>`) : nothing}
                    </button>
                  `,
            )}
          </div>
        `,
      )}`,
      root,
    );
  }

  layoutState.subscribe(renderMenubar);
  renderMenubar();
}
