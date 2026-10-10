import { describe, it, expect } from 'vitest';
import { pngSequenceExportTarget } from '../../src/engine/export/png-sequence';
import type { ExportRequest } from '../../src/engine/host/protocol';
import type { FramePixels } from '../../src/engine/export/types';

function stubPull(width = 2, height = 2): (t?: number) => Promise<FramePixels> {
  return async () => ({ width, height, data: new Uint8Array(width * height * 4).fill(128) });
}

describe('png-sequence export target', () => {
  it('produces one tar entry per frame at the requested fps/range', async () => {
    const req: ExportRequest = { target: 'png-sequence', range: { from: 0, to: 0.4 }, options: { fps: 10 } };
    const result = (await pngSequenceExportTarget.run(req, stubPull())) as { mime: string; data: ArrayBuffer };
    expect(result.mime).toBe('application/x-tar');

    const bytes = new Uint8Array(result.data);
    // Count non-zero headers by walking 512-byte blocks until the terminator.
    let offset = 0;
    let count = 0;
    while (offset + 512 <= bytes.length) {
      const header = bytes.subarray(offset, offset + 512);
      if (header.every((b) => b === 0)) break;
      count += 1;
      const sizeStr = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0/g, '').trim();
      const size = parseInt(sizeStr, 8);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(count).toBe(4); // 0.4s at 10fps
  });

  it('reports strictly increasing progress ending at the total frame count', async () => {
    const req: ExportRequest = { target: 'png-sequence', range: { from: 0, to: 0.3 }, options: { fps: 10 } };
    const seen: { done: number; total: number }[] = [];
    await pngSequenceExportTarget.run(req, stubPull(), (done, total, label) => {
      expect(label).toBe('png-sequence');
      seen.push({ done, total });
    });

    expect(seen.length).toBe(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.done).toBeGreaterThan(seen[i - 1]!.done);
    expect(seen.at(-1)!.done).toBe(seen.at(-1)!.total);
  });
});
