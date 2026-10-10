import { describe, it, expect } from 'vitest';
import { applyEdits } from '../../src/engine/doc/document';
import { emptyDocument } from '../../src/engine/doc/json';
import type { DocumentJSON } from '../../src/engine/doc/json';

describe('applyEdits: setDocClock', () => {
  it('replaces doc.clock and inverts back to the original', () => {
    const doc: DocumentJSON = emptyDocument();
    expect(doc.clock).toEqual({ fps: 30 });

    const inverses = applyEdits(doc, [{ op: 'setDocClock', clock: { fps: 60, duration: 4 } }]);
    expect(doc.clock).toEqual({ fps: 60, duration: 4 });
    expect(inverses).toEqual([{ op: 'setDocClock', clock: { fps: 30 } }]);

    applyEdits(doc, inverses);
    expect(doc.clock).toEqual({ fps: 30 });
  });
});
