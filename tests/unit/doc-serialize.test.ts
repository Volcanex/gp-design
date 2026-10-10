import { describe, expect, it } from 'vitest';
import { serializeDocument, deserializeDocument } from '../../src/app/commands/doc-serialize';
import { emptyDocument, layerId, assetId, identityTransform } from '@engine';
import type { DocumentJSON } from '@engine';

describe('doc-serialize', () => {
  it('round-trips a document with no assets losslessly', async () => {
    const doc = emptyDocument(640, 480);
    const blob = serializeDocument(doc);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/json');
    const json = await blob.text();
    expect(deserializeDocument(json)).toEqual(doc);
  });

  it('round-trips ArrayBuffer asset bytes exactly: JSON.stringify alone would drop them', async () => {
    const doc: DocumentJSON = emptyDocument(64, 64);
    const bytes = new Uint8Array(300); // > one base64 chunk boundary-adjacent size
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const imgId = assetId('img-1');
    doc.assets[imgId] = { type: 'image', mime: 'image/png', data: bytes.buffer, width: 10, height: 10 };
    doc.layers.push({
      id: layerId('l1'), kind: 'layer', name: 'Image', enabled: true,
      source: { type: 'core.image', params: { asset: { asset: imgId } } },
      chain: [], blendMode: 'normal', opacity: 1, transform: identityTransform(), liveness: 'baked',
    });

    // Sanity check: plain JSON.stringify silently drops ArrayBuffer content.
    // This is exactly the corruption Save must avoid.
    const naive = JSON.parse(JSON.stringify(doc));
    expect(naive.assets['img-1'].data).toEqual({});

    const blob = serializeDocument(doc);
    const json = await blob.text();
    const roundTripped = deserializeDocument(json);
    const restoredAsset = roundTripped.assets['img-1'] as { data: ArrayBuffer };
    expect(new Uint8Array(restoredAsset.data)).toEqual(bytes);
  });

  it('round-trips a buffer whose length is an exact multiple of the base64 chunk size (no accidental empty tail chunk)', async () => {
    const doc: DocumentJSON = emptyDocument(8, 8);
    const bytes = new Uint8Array(0xc000 * 2); // exactly 2 chunks
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    const lutId = assetId('lut-1');
    doc.assets[lutId] = { type: 'lut', data: bytes.buffer, size: 16 };

    const blob = serializeDocument(doc);
    const roundTripped = deserializeDocument(await blob.text());
    const restored = roundTripped.assets['lut-1'] as { data: ArrayBuffer };
    expect(new Uint8Array(restored.data)).toEqual(bytes);
  });

  it('round-trips a zero-length asset buffer', async () => {
    const doc: DocumentJSON = emptyDocument(8, 8);
    const lutId = assetId('lut-empty');
    doc.assets[lutId] = { type: 'lut', data: new ArrayBuffer(0), size: 0 };

    const blob = serializeDocument(doc);
    const roundTripped = deserializeDocument(await blob.text());
    const restored = roundTripped.assets['lut-empty'] as { data: ArrayBuffer };
    expect(restored.data.byteLength).toBe(0);
  });

  it('Blob path is byte-identical to a single-string JSON.stringify + base64 wrap (the pre-Blob format)', async () => {
    const doc: DocumentJSON = emptyDocument(32, 32);
    const bytes = new Uint8Array(5000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13) % 256;
    const rasterId = assetId('raster-1');
    doc.assets[rasterId] = { type: 'raster', data: bytes.buffer, width: 32, height: 32 };

    const blobText = await serializeDocument(doc).text();

    // Reference implementation: the ORIGINAL single-string algorithm this
    // Blob path replaces, kept local to this test as the byte-identity
    // ground truth (not exported/reused by app code).
    const MARKER = '__arrayBuffer';
    const referenceJson = JSON.stringify(doc, (_key, value) => {
      if (!(value instanceof ArrayBuffer)) return value;
      const u8 = new Uint8Array(value);
      let binary = '';
      for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return { [MARKER]: btoa(binary) };
    });

    expect(blobText).toBe(referenceJson);
  });

  it('a multi-chunk asset survives into the Blob at its full (base64-inflated) size', () => {
    const doc: DocumentJSON = emptyDocument(8, 8);
    const bytes = new Uint8Array(0xc000 * 3); // several chunk boundaries
    const rasterId = assetId('raster-big');
    doc.assets[rasterId] = { type: 'raster', data: bytes.buffer, width: 8, height: 8 };

    // Blob doesn't expose its constituent parts directly, but the total
    // size must reflect every chunk having reached the Blob: proves the
    // per-chunk splice didn't silently drop data.
    const blob = serializeDocument(doc);
    expect(blob.size).toBeGreaterThanOrEqual(Math.ceil(bytes.length / 3) * 4);
  });
});
