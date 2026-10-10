// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatKeys,
  isTextEditingTarget,
  normalizeEvent,
  resolveBinding,
  setDialogOpen,
} from '../../src/app/keymap/keymap';

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('normalizeEvent', () => {
  it('normalises plain letters via e.code', () => {
    expect(normalizeEvent(key({ code: 'KeyB' }))).toBe('B');
  });

  it('orders modifiers Ctrl, Alt, Shift', () => {
    expect(normalizeEvent(key({ code: 'KeyN', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+N');
    expect(normalizeEvent(key({ code: 'KeyZ', ctrlKey: true, altKey: true, shiftKey: true }))).toBe('Ctrl+Alt+Shift+Z');
  });

  it('treats Cmd (metaKey) as Ctrl', () => {
    expect(normalizeEvent(key({ code: 'KeyZ', metaKey: true }))).toBe('Ctrl+Z');
  });

  it('normalises digits via e.code', () => {
    expect(normalizeEvent(key({ code: 'Digit0', ctrlKey: true }))).toBe('Ctrl+0');
  });

  it('passes brackets and F-keys through verbatim', () => {
    expect(normalizeEvent(key({ code: 'BracketLeft' }))).toBe('BracketLeft');
    expect(normalizeEvent(key({ code: 'BracketRight', ctrlKey: true }))).toBe('Ctrl+BracketRight');
    expect(normalizeEvent(key({ code: 'F5' }))).toBe('F5');
    expect(normalizeEvent(key({ code: 'F5', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+F5');
  });

  it('normalises Ctrl+Equal / Ctrl+Minus', () => {
    expect(normalizeEvent(key({ code: 'Equal', ctrlKey: true }))).toBe('Ctrl+Equal');
    expect(normalizeEvent(key({ code: 'Minus', ctrlKey: true }))).toBe('Ctrl+Minus');
  });
});

describe('isTextEditingTarget', () => {
  it('is true for inputs, textareas and contenteditable elements', () => {
    expect(isTextEditingTarget(document.createElement('input'))).toBe(true);
    expect(isTextEditingTarget(document.createElement('textarea'))).toBe(true);
    const div = document.createElement('div');
    div.contentEditable = 'true';
    expect(isTextEditingTarget(div)).toBe(true);
  });

  it('is false for plain elements and non-elements', () => {
    expect(isTextEditingTarget(document.createElement('div'))).toBe(false);
    expect(isTextEditingTarget(null)).toBe(false);
  });
});

describe('context suppression', () => {
  afterEach(() => setDialogOpen(false));

  it('suppresses canvas-scoped bindings when the target is text-editing', () => {
    const input = document.createElement('input');
    const e = key({ code: 'KeyB' });
    Object.defineProperty(e, 'target', { value: input });
    expect(resolveBinding(e)).toBeUndefined();
  });

  it('does not suppress global bindings (Ctrl+Z) for text-editing targets', () => {
    const input = document.createElement('input');
    const e = key({ code: 'KeyZ', ctrlKey: true });
    Object.defineProperty(e, 'target', { value: input });
    expect(resolveBinding(e)?.command).toBe('edit.undo');
  });

  it('suppresses canvas-scoped bindings while a dialog is open', () => {
    setDialogOpen(true);
    const e = key({ code: 'KeyB' });
    expect(resolveBinding(e)).toBeUndefined();
  });

  it('resolves canvas-scoped bindings normally otherwise', () => {
    const e = key({ code: 'KeyB' });
    expect(resolveBinding(e)?.command).toBe('tool.cycle');
  });
});

describe('formatKeys', () => {
  it('returns the bound key combo for a command id', () => {
    expect(formatKeys('edit.undo')).toBe('Ctrl+Z');
    expect(formatKeys('layer.new')).toBe('Ctrl+Shift+N');
  });

  it('returns an empty string for an unbound command', () => {
    expect(formatKeys('nonexistent.command')).toBe('');
  });

  it('matches on args, not just command id, for commands sharing one id', () => {
    // Every Effects/Adjustments menu item is 'effect.open' with a different
    // args string. Only the bound one (core.levels) should show a hint.
    expect(formatKeys('effect.open', 'core.levels')).toBe('Ctrl+L');
    expect(formatKeys('effect.open', 'core.curves')).toBe('Ctrl+Shift+M');
    expect(formatKeys('effect.open', 'core.some-unbound-effect')).toBe('');
  });

  it('does not match a bound command when called without matching args', () => {
    expect(formatKeys('effect.open')).toBe('');
    expect(formatKeys('effect.open', 'core.levels')).toBe('Ctrl+L');
  });

  it('matches array args by deep equality, not identity', () => {
    // tool.cycle bindings carry array args (e.g. the S group): a fresh
    // array with the same contents must still match.
    expect(formatKeys('tool.cycle', ['select-rect', 'select-lasso', 'select-ellipse', 'select-wand'])).toBe('S');
    expect(formatKeys('tool.cycle', ['brush'])).toBe('B');
    expect(formatKeys('tool.cycle', ['brush', 'extra'])).toBe('');
  });
});
