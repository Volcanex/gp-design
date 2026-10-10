/**
 * Normalises KeyboardEvents into the combo strings bindings.ts uses, resolves
 * which binding (if any) applies given context, and installs the single
 * window-level listener that dispatches into executeCommand.
 */

import { KEY_BINDINGS, type KeyBinding } from './bindings';
import type { AppCtx } from '../types';
import { executeCommand } from '../commands/registry';

function codeToKey(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

/** Canonical combo, e.g. 'Ctrl+Shift+N'. Modifiers ordered Ctrl, Alt, Shift;
 * letters/digits read from e.code so physical layout stays stable. */
export function normalizeEvent(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, codeToKey(e.code)].join('+');
}

let dialogOpen = false;
/** Track's whether a modal dialog is open. Set by dialog forms (track C). */
export function setDialogOpen(open: boolean): void {
  dialogOpen = open;
}

export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

/** Pure resolution (no side effects). Canvas-scoped bindings are suppressed
 * while typing in a form field or while a dialog is open. */
export function resolveBinding(e: KeyboardEvent): KeyBinding | undefined {
  const combo = normalizeEvent(e);
  const suppressCanvas = dialogOpen || isTextEditingTarget(e.target);
  return KEY_BINDINGS.find((b) => b.keys === combo && !(b.when === 'canvas' && suppressCanvas));
}

function argsEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Matches on command id AND args: generated menu items (effects, tool
 * groups) all share one command id and differ only by args, so matching on
 * id alone would show every unbound effect the first bound effect's hint. */
export function formatKeys(commandId: string, args?: unknown): string {
  return KEY_BINDINGS.find((b) => b.command === commandId && argsEqual(b.args, args))?.keys ?? '';
}

let installedHandler: ((e: KeyboardEvent) => void) | null = null;

export function installKeymap(app: AppCtx): void {
  uninstallKeymap();
  installedHandler = (e: KeyboardEvent) => {
    const binding = resolveBinding(e);
    if (!binding) return;
    e.preventDefault();
    executeCommand(app, binding.command, binding.args);
  };
  window.addEventListener('keydown', installedHandler);
}

export function uninstallKeymap(): void {
  if (installedHandler) window.removeEventListener('keydown', installedHandler);
  installedHandler = null;
}
