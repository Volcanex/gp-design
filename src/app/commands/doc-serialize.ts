/**
 * File > Save / Open (.gdesign.json) round-trip. DocumentJSON is otherwise
 * plain JSON (structuredClone-safe, per doc/json.ts's FROZEN CONTRACT) except
 * for asset ArrayBuffers (image/lut/font/raster/clip bytes): JSON.stringify
 * silently drops those (ArrayBuffer -> "{}"), so they're base64-wrapped on
 * the way out and unwrapped on the way in.
 *
 * serializeDocument returns a Blob assembled from PARTS rather than one JS
 * string: a doc with a baked video clip can carry ~700MB of asset bytes,
 * and base64 inflates that by ~4/3. A single `JSON.stringify` result string
 * of that size risks V8's string length limit and throws deep inside a
 * setTimeout (registry.ts's file.save), invisible until it happens. Building
 * the JSON with each ArrayBuffer replaced by a short placeholder token keeps
 * the STRINGIFIED text small; each buffer's base64 is then chunked (CHUNK
 * bytes at a time, chosen as a multiple of 3 so no chunk boundary lands mid
 * base64-group and needs premature padding) and spliced back in as separate
 * Blob parts, so the concatenated bytes on disk are IDENTICAL to what the
 * old single-string version produced (see doc-serialize.test.ts's byte-for-
 * byte proof), but no individual JS string built along the way approaches
 * that size. Also keeps String.fromCharCode under its own argument-count
 * limit, same reasoning as the pre-existing per-chunk approach it replaces.
 */

import type { DocumentJSON } from '@engine';

const CHUNK = 0xc000; // 49152 bytes: a multiple of 3, well under the safe String.fromCharCode spread-argument count.
const MARKER = '__arrayBuffer';
/** Alnum + underscore only, deliberately: JSON.stringify never escapes it, so it round-trips through the JSON text unchanged and is trivial to locate/splice. */
const PLACEHOLDER_PREFIX = 'GDESIGN_AB_PLACEHOLDER_7f2e9c4a_';

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Recursively replaces every ArrayBuffer in `value` with a `{__arrayBuffer: <placeholder token>}` marker, collecting the real buffers (in traversal order) into `buffers`. */
function replaceBuffers(value: unknown, buffers: ArrayBuffer[]): unknown {
  if (value instanceof ArrayBuffer) {
    const token = `${PLACEHOLDER_PREFIX}${buffers.length}`;
    buffers.push(value);
    return { [MARKER]: token };
  }
  if (Array.isArray(value)) return value.map((v) => replaceBuffers(v, buffers));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceBuffers(v, buffers);
    return out;
  }
  return value;
}

/** Appends `buf`'s base64 encoding to `parts` as separate chunk strings (never one joined string). */
function pushBase64Parts(parts: BlobPart[], buf: ArrayBuffer): void {
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    parts.push(btoa(String.fromCharCode(...slice)));
  }
}

export function serializeDocument(doc: DocumentJSON): Blob {
  const buffers: ArrayBuffer[] = [];
  const placeholderDoc = replaceBuffers(doc, buffers);
  const json = JSON.stringify(placeholderDoc);

  const parts: BlobPart[] = [];
  let cursor = 0;
  for (let i = 0; i < buffers.length; i++) {
    const token = `${PLACEHOLDER_PREFIX}${i}`;
    const idx = json.indexOf(token, cursor);
    if (idx === -1) throw new Error(`serializeDocument: placeholder ${i} missing from JSON output`);
    if (idx > cursor) parts.push(json.slice(cursor, idx));
    pushBase64Parts(parts, buffers[i]!);
    cursor = idx + token.length;
  }
  if (cursor < json.length) parts.push(json.slice(cursor));
  return new Blob(parts, { type: 'application/json' });
}

export function deserializeDocument(json: string): DocumentJSON {
  return JSON.parse(json, (_key, value) =>
    value && typeof value === 'object' && typeof value[MARKER] === 'string'
      ? base64ToBuffer(value[MARKER])
      : value,
  ) as DocumentJSON;
}
