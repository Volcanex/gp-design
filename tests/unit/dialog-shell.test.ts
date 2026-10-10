// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDialog } from '../../src/ui/dialogs/dialog-shell';
import { resolveBinding, setDialogOpen } from '../../src/app/keymap/keymap';

function key(code: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { code, bubbles: true });
}

describe('dialog-shell gating', () => {
  afterEach(() => setDialogOpen(false));

  it('suppresses canvas-scoped bindings while open, and restores them on every close path', () => {
    // Open: canvas-scoped 'B' (tool.cycle) must be suppressed.
    const okHandle = openDialog({
      dialogTestId: 'd1', okTestId: 'd1-ok', cancelTestId: 'd1-cancel', title: 't',
      body: () => 'body', onOk: () => {}, onCancel: () => {},
    });
    expect(resolveBinding(key('KeyB'))).toBeUndefined();
    (okHandle.host.querySelector('[data-testid="d1-ok"]') as HTMLButtonElement).click();
    expect(resolveBinding(key('KeyB'))?.command).toBe('tool.cycle');

    // Cancel path.
    const cancelHandle = openDialog({
      dialogTestId: 'd2', okTestId: 'd2-ok', cancelTestId: 'd2-cancel', title: 't',
      body: () => 'body', onOk: () => {}, onCancel: () => {},
    });
    expect(resolveBinding(key('KeyB'))).toBeUndefined();
    (cancelHandle.host.querySelector('[data-testid="d2-cancel"]') as HTMLButtonElement).click();
    expect(resolveBinding(key('KeyB'))?.command).toBe('tool.cycle');

    // Escape path.
    openDialog({
      dialogTestId: 'd3', okTestId: 'd3-ok', cancelTestId: 'd3-cancel', title: 't',
      body: () => 'body', onOk: () => {}, onCancel: () => {},
    });
    expect(resolveBinding(key('KeyB'))).toBeUndefined();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(resolveBinding(key('KeyB'))?.command).toBe('tool.cycle');
  });

  it('Escape cancels and Enter OKs', () => {
    const onOk = vi.fn();
    const onCancel = vi.fn();
    openDialog({
      dialogTestId: 'd4', okTestId: 'd4-ok', cancelTestId: 'd4-cancel', title: 't',
      body: () => 'body', onOk, onCancel,
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOk).not.toHaveBeenCalled();

    openDialog({
      dialogTestId: 'd5', okTestId: 'd5-ok', cancelTestId: 'd5-cancel', title: 't',
      body: () => 'body', onOk, onCancel,
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onOk).toHaveBeenCalledTimes(1);
  });

  it('focuses inside the dialog on open', () => {
    openDialog({
      dialogTestId: 'd6', okTestId: 'd6-ok', cancelTestId: 'd6-cancel', title: 't',
      body: () => 'body', onOk: () => {}, onCancel: () => {},
    });
    const card = document.querySelector('[data-testid="d6"]');
    expect(card?.contains(document.activeElement)).toBe(true);
  });
});
