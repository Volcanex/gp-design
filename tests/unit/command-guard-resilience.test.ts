// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeCommand } from '../../src/app/commands/registry';
import { history } from '../../src/app/commands/app-history';
import { selectionState, statusMessage, viewState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, DocumentJSON, EngineHost } from '@engine';

/** A command whose run() unconditionally calls app.engine.getDocument():
 * good enough to make an incomplete/broken host throw synchronously without
 * touching a GPU, exercising executeCommand's own try/catch guard. */
const COMMAND_ID = 'layer.new';

function brokenEngine(): EngineHost {
  // Deliberately missing getDocument/applyEdits: same idea as a host mid-
  // teardown or a mock left half-implemented, not a realistic prod state,
  // just enough to make table['layer.new'].run(app) throw.
  return {} as unknown as EngineHost;
}

function sceneDoc(): DocumentJSON {
  return {
    version: 1,
    canvas: { width: 1280, height: 720, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [],
    postChain: [],
    assets: {},
  } as unknown as DocumentJSON;
}

function workingEngine(doc: DocumentJSON): EngineHost {
  return {
    getDocument: () => doc,
    applyEdits: (edits: DocEdit[]) => {
      // Minimal stand-in: only 'addLayer' is exercised here.
      for (const edit of edits) {
        if ((edit as { op: string }).op === 'addLayer') {
          doc.layers.push((edit as { layer: DocumentJSON['layers'][number] }).layer);
        }
      }
      return [];
    },
  } as unknown as EngineHost;
}

describe('executeCommand guard', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
    viewState.update((s) => ({ ...s, activeLayer: null }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a throwing command is caught, logged once, and surfaced as a status message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app: AppCtx = { engine: brokenEngine() };

    expect(() => executeCommand(app, COMMAND_ID)).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toContain(COMMAND_ID);
    expect(statusMessage.get()).toMatch(/Couldn't run/);
  });

  it('a later, valid command still runs after a prior command threw', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenApp: AppCtx = { engine: brokenEngine() };
    executeCommand(brokenApp, COMMAND_ID);

    const doc = sceneDoc();
    const app: AppCtx = { engine: workingEngine(doc) };
    executeCommand(app, COMMAND_ID);

    expect(doc.layers).toHaveLength(1);
  });

  it('an unknown command id warns and no-ops, never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app: AppCtx = { engine: brokenEngine() };
    expect(() => executeCommand(app, 'not.a.real.command')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
