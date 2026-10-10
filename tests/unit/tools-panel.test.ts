import { describe, it, expect } from 'vitest';
import { toolKeyHint } from '../../src/ui/panels/tools';
import { DISABLED_TOOLS, isToolDisabled } from '../../src/app/tool-registry';
import { KEY_BINDINGS } from '../../src/app/keymap/bindings';
import type { ToolId } from '../../src/app/types';

describe('toolKeyHint (derived from bindings.ts, never hand-maintained)', () => {
  // The probe found 7/15 hand-written hints wrong against these real
  // single-key tool.cycle bindings. Assert the derivation matches the SSOT
  // exactly rather than re-hardcoding the (previously wrong) values.
  const expected: Record<ToolId, string> = {
    'select-rect': 'S', 'select-lasso': 'S', 'select-ellipse': 'S', 'select-wand': 'S',
    move: 'M', zoom: 'Z', pan: 'H',
    brush: 'B', pencil: 'P', eraser: 'E', bucket: 'F', gradient: 'G',
    picker: 'K', recolor: 'R', clone: 'L',
    text: 'T', line: 'O', shapes: 'O',
  };

  for (const [id, keys] of Object.entries(expected)) {
    it(`${id} -> ${keys}`, () => {
      expect(toolKeyHint(id as ToolId)).toBe(keys);
    });
  }

  it('never derives a hint that disagrees with a real tool.cycle binding', () => {
    for (const binding of KEY_BINDINGS) {
      if (binding.command !== 'tool.cycle') continue;
      for (const id of binding.args as ToolId[]) {
        expect(toolKeyHint(id)).toBe(binding.keys);
      }
    }
  });
});

describe('DISABLED_TOOLS', () => {
  it('flags exactly the unimplemented tools', () => {
    expect([...DISABLED_TOOLS].sort()).toEqual(
      ['clone', 'recolor', 'select-lasso', 'select-wand'].sort(),
    );
  });

  it('leaves every implemented tool enabled (bucket included, wave 6)', () => {
    const implemented: ToolId[] = [
      'select-rect', 'select-ellipse', 'move', 'zoom', 'pan',
      'brush', 'pencil', 'eraser', 'bucket', 'gradient', 'picker', 'text', 'line', 'shapes',
    ];
    for (const id of implemented) expect(isToolDisabled(id)).toBe(false);
  });
});
