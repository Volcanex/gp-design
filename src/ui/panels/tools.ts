/**
 * Tools panel (F5). One button per ToolId. The type only has a single
 * "selection" entry point (`select-rect`) even though four select variants
 * exist: the button activates/highlights for any select-* tool; a flyout
 * for lasso/ellipse/wand is a later pass, not this one.
 *
 * Shortcut hints are DERIVED from bindings.ts's tool.cycle bindings (never
 * hand-maintained here) so the panel can't drift from the real keymap.
 */

import { html, nothing } from 'lit-html';
import type { AppCtx, PanelHost, ToolId } from '../../app/types';
import { toolState, DEFAULT_BUCKET_TOLERANCE } from '../../app/stores';
import { isToolDisabled } from '../../app/tool-registry';
import { KEY_BINDINGS } from '../../app/keymap/bindings';
import { icon, type IconName } from '../icons';

interface ToolDef {
  id: ToolId;
  icon: IconName;
  name: string;
}

const TOOLS: ToolDef[] = [
  { id: 'select-rect', icon: 'selection', name: 'Selection' },
  { id: 'move', icon: 'arrows-out-cardinal', name: 'Move' },
  { id: 'zoom', icon: 'magnifying-glass', name: 'Zoom' },
  { id: 'pan', icon: 'hand', name: 'Pan' },
  { id: 'brush', icon: 'paint-brush', name: 'Brush' },
  { id: 'pencil', icon: 'pencil-simple', name: 'Pencil' },
  { id: 'eraser', icon: 'eraser', name: 'Eraser' },
  { id: 'bucket', icon: 'paint-bucket', name: 'Bucket' },
  { id: 'gradient', icon: 'gradient', name: 'Gradient' },
  { id: 'picker', icon: 'eyedropper', name: 'Colour picker' },
  { id: 'recolor', icon: 'swap', name: 'Recolour' },
  { id: 'clone', icon: 'stamp', name: 'Clone stamp' },
  { id: 'text', icon: 'text-t', name: 'Text' },
  { id: 'line', icon: 'line-segment', name: 'Line' },
  { id: 'shapes', icon: 'shapes', name: 'Shapes' },
];

/** Finds the single-key hint for a tool: the tool.cycle binding whose args
 * group contains this tool id. Undefined if none binds it (shouldn't happen
 * for a listed tool, but a missing hint beats a wrong one). */
export function toolKeyHint(id: ToolId): string | undefined {
  const binding = KEY_BINDINGS.find(
    (b) => b.command === 'tool.cycle' && Array.isArray(b.args) && (b.args as ToolId[]).includes(id),
  );
  return binding?.keys;
}

function isActive(active: ToolId, id: ToolId): boolean {
  if (id === 'select-rect') return active.startsWith('select-');
  return active === id;
}

function selectTool(id: ToolId): void {
  if (isToolDisabled(id)) return;
  toolState.update((s) => ({ ...s, active: id }));
}

const SHAPE_LABEL: Record<string, string> = {
  rect: 'rectangle',
  ellipse: 'ellipse',
  polygon: 'polygon',
  star: 'star',
  'rounded-rect': 'rounded rectangle',
};

/** Shapes tool's tooltip names which shape kind it currently inserts
 * (toolState.lastShape, set by the Insert menu, see registry.ts's SHAPES
 * block). This repo has no separate statusbar hint line for tool mode, so
 * this tooltip IS the hint surface for it. */
function tooltipFor(t: ToolDef): string {
  if (isToolDisabled(t.id)) return `${t.name}: not implemented yet`;
  const key = toolKeyHint(t.id);
  const base = key ? `${t.name} (${key})` : t.name;
  if (t.id === 'shapes') return `${base}, inserts a ${SHAPE_LABEL[toolState.get().lastShape ?? 'rect']}`;
  return base;
}

export const toolsPanel: PanelHost = {
  id: 'tools',
  title: 'Tools',
  toggleKey: 'F5',
  defaultPosition: { corner: 'tl', x: 8, y: 8 },
  render(_app: AppCtx) {
    const state = toolState.get();
    const tolerance = state.bucketTolerance ?? DEFAULT_BUCKET_TOLERANCE;
    return html`
      <div class="gd-tools">
        <div class="gd-tools-grid" role="toolbar" aria-label="Tools" aria-orientation="vertical">
          ${TOOLS.map(
            (t) => html`
              <button
                type="button"
                class="btn btn-tertiary btn-icon btn-sm gd-tool-btn"
                aria-pressed=${isActive(state.active, t.id) ? 'true' : 'false'}
                aria-label=${t.name}
                ?disabled=${isToolDisabled(t.id)}
                data-tip=${tooltipFor(t)}
                data-tool=${t.id}
                @click=${() => selectTool(t.id)}
              >
                ${icon(t.icon)}
              </button>
            `,
          )}
        </div>
        <label class="gd-rail-field">
          <span class="gd-rail-label">Size</span>
          <span class="g-slider gd-rail-slider">
            <input
              type="range"
              min="1"
              max="500"
              aria-label="Brush size"
              .value=${String(state.brushSize)}
              @input=${(e: Event) => {
                const value = Number((e.target as HTMLInputElement).value);
                toolState.update((s) => ({ ...s, brushSize: value }));
              }}
            />
          </span>
          <span class="gd-rail-value num" data-testid="brush-size-value">${state.brushSize}px</span>
        </label>
        ${state.active === 'bucket'
          ? html`
              <label class="gd-rail-field">
                <span class="gd-rail-label">Tolerance</span>
                <span class="g-slider gd-rail-slider">
                  <input
                    type="range"
                    min="0"
                    max="0.5"
                    step="0.01"
                    aria-label="Bucket tolerance"
                    data-testid="bucket-tolerance"
                    .value=${String(tolerance)}
                    @input=${(e: Event) => {
                      const value = Number((e.target as HTMLInputElement).value);
                      toolState.update((s) => ({ ...s, bucketTolerance: value }));
                    }}
                  />
                </span>
                <span class="gd-rail-value num" data-testid="bucket-tolerance-value">${tolerance.toFixed(2)}</span>
              </label>
            `
          : nothing}
      </div>
    `;
  },
};
