/**
 * 'png-sequence' export target: same frame loop shape as video.ts, but each
 * frame is encoded as a standalone PNG (png-encoder.ts, shared with the
 * 'png' target) and the set is bundled into a single .tar (tar.ts, no zip
 * dependency) instead of triggering N separate downloads.
 */

import type { ExportTargetDef } from '../registry/registry';
import type { ExportRequest, ExportResult } from '../host/protocol';
import type { PullFrame } from './types';
import { encodePng } from './png-encoder';
import { buildTar, type TarEntry } from './tar';

export const pngSequenceExportTarget: ExportTargetDef = {
  id: 'png-sequence',
  label: 'PNG Sequence (.tar)',
  mime: 'application/x-tar',
  async run(reqUnknown, pullUnknown, onProgress): Promise<ExportResult> {
    const req = reqUnknown as ExportRequest;
    const pull = pullUnknown as PullFrame;

    const fps = (req.options?.['fps'] as number | undefined) ?? 30;
    const from = req.range?.from ?? 0;
    const to = req.range?.to ?? from + 2;
    const colorSpace = (req.options?.['colorSpace'] as 'srgb' | 'display-p3' | undefined) ?? 'srgb';
    const frameDuration = 1 / fps;
    const total = Math.max(1, Math.round((to - from) * fps));

    const entries: TarEntry[] = [];
    let time = from;
    for (let i = 0; i < total; i++) {
      // eslint-disable-next-line no-await-in-loop -- frames must be pulled+encoded in order
      const frame = await pull(time);
      // eslint-disable-next-line no-await-in-loop -- see above
      const png = await encodePng(frame, colorSpace);
      entries.push({ name: `frame-${String(i).padStart(4, '0')}.png`, data: new Uint8Array(png) });
      onProgress?.(i + 1, total, 'png-sequence');
      time += frameDuration;
    }

    return {
      mime: 'application/x-tar',
      data: buildTar(entries),
      fileName: 'gdesign-export-sequence.tar',
    };
  },
};
