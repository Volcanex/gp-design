import { describe, expect, it } from 'vitest';
import { hintFor, isStarterDoc, CANVAS_HINT_TEXT } from '../../src/ui/shell/hints';
import { history } from '../../src/app/commands/app-history';
import { DISABLED_TOOLS } from '../../src/app/tool-registry';
import type { ToolId } from '../../src/app/types';

const ALL_TOOLS: ToolId[] = [
  'select-rect', 'select-lasso', 'select-ellipse', 'select-wand',
  'move', 'zoom', 'pan',
  'brush', 'pencil', 'eraser', 'bucket', 'gradient',
  'picker', 'recolor', 'clone',
  'text', 'line', 'shapes',
];

describe('hintFor: exhaustive coverage', () => {
  it('returns a non-empty hint for every ToolId, selected and not', () => {
    history.clear();
    for (const tool of ALL_TOOLS) {
      const disabled = DISABLED_TOOLS.has(tool);
      for (const hasSelection of [false, true]) {
        const hint = hintFor({ tool, disabled, hasSelection });
        expect(typeof hint).toBe('string');
        expect(hint.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('hintFor: disabled tools', () => {
  it('always reads "Not implemented yet", regardless of selection', () => {
    for (const tool of DISABLED_TOOLS) {
      expect(hintFor({ tool, disabled: true, hasSelection: false })).toBe('Not implemented yet');
      expect(hintFor({ tool, disabled: true, hasSelection: true })).toBe('Not implemented yet');
    }
  });
});

describe('hintFor: move tool + selection', () => {
  it('differs between no-selection and selection variants', () => {
    history.push({ engine: null as never }, { label: 'x', run: () => {}, undo: () => {} });
    const noSel = hintFor({ tool: 'move', disabled: false, hasSelection: false });
    const withSel = hintFor({ tool: 'move', disabled: false, hasSelection: true });
    expect(noSel).not.toBe(withSel);
    expect(withSel.toLowerCase()).toContain('drag');
    history.clear();
  });

  it('falls back to a paste/drop hint on the pristine starter doc with no selection', () => {
    history.clear();
    expect(isStarterDoc()).toBe(true);
    const hint = hintFor({ tool: 'move', disabled: false, hasSelection: false });
    expect(hint.toLowerCase()).toMatch(/drop|paste/);
  });

  it('does not use the empty-doc fallback once history has entries', () => {
    history.clear();
    history.push({ engine: null as never }, { label: 'x', run: () => {}, undo: () => {} });
    expect(isStarterDoc()).toBe(false);
    const hint = hintFor({ tool: 'move', disabled: false, hasSelection: false });
    expect(hint).toBe('Click an object to select, drag to move, drag handles to resize (Shift locks aspect)');
    history.clear();
  });
});

describe('hintFor: derived key labels', () => {
  it('mentions the real brush-size and colour-swap shortcuts, not stale hardcoded ones', () => {
    const hint = hintFor({ tool: 'brush', disabled: false, hasSelection: false });
    expect(hint).toContain('[');
    expect(hint).toContain(']');
    expect(hint).toContain('X');
  });
});

describe('isStarterDoc', () => {
  it('is true only when history is empty', () => {
    history.clear();
    expect(isStarterDoc()).toBe(true);
    history.push({ engine: null as never }, { label: 'x', run: () => {}, undo: () => {} });
    expect(isStarterDoc()).toBe(false);
    history.clear();
  });
});

describe('CANVAS_HINT_TEXT', () => {
  it('names the paint/shapes/text/effects shortcuts', () => {
    expect(CANVAS_HINT_TEXT).toContain('B');
    expect(CANVAS_HINT_TEXT).toContain('O');
    expect(CANVAS_HINT_TEXT).toContain('T');
    expect(CANVAS_HINT_TEXT).toContain('F9');
  });
});

describe('hintFor: mask-edit mode', () => {
  it('outranks the per-tool hint while maskEditing is set', () => {
    const hint = hintFor({ tool: 'brush', disabled: false, hasSelection: false, maskEditing: true });
    expect(hint).toMatch(/mask/i);
    expect(hint).toMatch(/paint white to reveal, black to hide/i);
  });
});
