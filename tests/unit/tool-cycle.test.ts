// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { shellExecute } from '../../src/ui/shell/shell-commands';
import { toolState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import type { EngineHost } from '@engine';

describe('tool.cycle skips DISABLED_TOOLS', () => {
  beforeEach(() => {
    toolState.set({ active: 'select-rect', brushSize: 24, primary: [0, 0, 0, 1], secondary: [1, 1, 1, 1], editing: 'primary' });
  });

  it('cycles straight past select-lasso/select-wand to the next enabled variant', () => {
    const app = {} as AppCtx as { engine: EngineHost };
    shellExecute(app as AppCtx, 'tool.cycle', ['select-rect', 'select-lasso', 'select-ellipse', 'select-wand']);
    expect(toolState.get().active).toBe('select-ellipse');
    shellExecute(app as AppCtx, 'tool.cycle', ['select-rect', 'select-lasso', 'select-ellipse', 'select-wand']);
    expect(toolState.get().active).toBe('select-rect');
  });

  it('is a no-op when every tool in the group is disabled', () => {
    toolState.update((s) => ({ ...s, active: 'clone' }));
    const app = {} as AppCtx;
    shellExecute(app, 'tool.cycle', ['clone']);
    expect(toolState.get().active).toBe('clone');
  });
});
