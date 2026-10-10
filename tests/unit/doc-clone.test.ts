import { describe, it, expect } from 'vitest';
import { emptyDocument } from '../../src/engine/doc/json';
import { layerId, identityTransform } from '../../src/engine/core/types';
import type { DocumentJSON } from '../../src/engine/doc/json';

/**
 * The M7 worker split depends on DocumentJSON staying structured-clone-safe.
 * If this test fails, someone put a class instance, function, or GPU handle
 * into the document model. That is a contract violation, not a test bug.
 */
describe('DocumentJSON clone safety', () => {
  it('round-trips through structuredClone deep-equal', () => {
    const doc: DocumentJSON = emptyDocument(64, 64);
    doc.layers.push({
      id: layerId('l1'),
      kind: 'layer',
      name: 'test',
      enabled: true,
      source: { type: 'core.solid', params: { color: [0.5, 0.1, -0.1, 1] } },
      chain: [{ id: 'fx1', pass: 'core.exposure', params: { exposure: { track: [{ t: 0, v: 0 }, { t: 1, v: 2, ease: 'cubic' }] } }, enabled: true }],
      blendMode: 'normal',
      opacity: 0.9,
      transform: identityTransform(),
      liveness: 'live',
    });
    doc.layers.push({
      id: layerId('g1'),
      kind: 'group',
      name: 'group',
      enabled: true,
      children: [],
      chain: [],
      blendMode: 'multiply',
      opacity: 1,
    });
    const cloned = structuredClone(doc);
    expect(cloned).toEqual(doc);
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it('round-trips a clip asset with format present and absent', () => {
    const doc: DocumentJSON = emptyDocument(64, 64);
    doc.assets['clip-a'] = { type: 'clip', frames: [new ArrayBuffer(8)], width: 4, height: 4, fps: 24 };
    doc.assets['clip-b'] = {
      type: 'clip', frames: [new ArrayBuffer(4)], width: 4, height: 4, fps: 24, format: 'rgba8unorm',
    };
    const cloned = structuredClone(doc);
    expect(cloned).toEqual(doc);
    expect('format' in doc.assets['clip-a']!).toBe(false);
  });

  it('round-trips a layer param holding an lfo value', () => {
    const doc: DocumentJSON = emptyDocument(64, 64);
    doc.layers.push({
      id: layerId('l1'),
      kind: 'layer',
      name: 'lfo-test',
      enabled: true,
      source: {
        type: 'core.solid',
        params: { color: [0.5, 0, 0, 1], amount: { lfo: { shape: 'sine', freq: 1, amp: 1, offset: 0, phase: 0 } } },
      },
      chain: [],
      blendMode: 'normal',
      opacity: 1,
      transform: identityTransform(),
      liveness: 'live',
    });
    const cloned = structuredClone(doc);
    expect(cloned).toEqual(doc);
  });
});
