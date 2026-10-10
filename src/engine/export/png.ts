/**
 * 'png' export target: renders one frame (default: the host's current clock
 * time) and encodes it canvas-free via png-encoder.ts.
 */

import type { ExportTargetDef } from '../registry/registry';
import type { ExportRequest, ExportResult } from '../host/protocol';
import type { PullFrame } from './types';
import { encodePng } from './png-encoder';

export const pngExportTarget: ExportTargetDef = {
  id: 'png',
  label: 'PNG',
  mime: 'image/png',
  async run(reqUnknown, pullUnknown, onProgress): Promise<ExportResult> {
    const req = reqUnknown as ExportRequest;
    const pull = pullUnknown as PullFrame;

    onProgress?.(0, 1, 'png');
    const frame = await pull(req.range?.from);
    onProgress?.(1, 1, 'png');
    // See host/localHost.ts export(): this is the colour space the pixels
    // were ACTUALLY rendered in, not doc.canvas.outputColorSpace, so the
    // PNG's colour chunk always matches its bytes.
    const colorSpace = (req.options?.['colorSpace'] as 'srgb' | 'display-p3' | undefined) ?? 'srgb';

    const data = await encodePng(frame, colorSpace);
    return { mime: 'image/png', data, fileName: `gdesign-export-${Date.now()}.png` };
  },
};
