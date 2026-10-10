/**
 * 'video' export target: loops range.from..range.to at the caller's fps
 * (falls back to 30 if the host didn't supply one; see host/localHost.ts's
 * export(), which now passes the request's own fps through instead of
 * clobbering it with the doc's), pulling one rendered frame at a time and
 * feeding it to Mediabunny's WebCodecs-backed encoder/muxer. Codec/container
 * picked at request time, not hardcoded: h.264/MP4 preferred, then VP9/WebM,
 * then VP8/WebM; first one WebCodecs actually reports as encodable in this
 * environment.
 *
 * Progress: onProgress(done, total, 'video') fires after each encoded frame
 * (the 'export-progress' EngineEvent host/localHost.ts emits from it).
 */

import {
  BufferTarget,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
  canEncodeVideo,
  QUALITY_HIGH,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny';
import type { ExportTargetDef } from '../registry/registry';
import type { ExportRequest, ExportResult } from '../host/protocol';
import type { FramePixels, PullFrame } from './types';

const CANDIDATE_CODECS: readonly VideoCodec[] = ['avc', 'vp9', 'vp8'];

interface Picked {
  codec: VideoCodec;
  format: OutputFormat;
  extension: string;
}

async function pickCodecAndFormat(width: number, height: number): Promise<Picked | null> {
  for (const codec of CANDIDATE_CODECS) {
    // eslint-disable-next-line no-await-in-loop -- codecs must be probed in preference order
    const supported = await canEncodeVideo(codec, { width, height, bitrate: QUALITY_HIGH });
    if (!supported) continue;
    const format = codec === 'avc' ? new Mp4OutputFormat() : new WebMOutputFormat();
    return { codec, format, extension: format.fileExtension };
  }
  return null;
}

export const videoExportTarget: ExportTargetDef = {
  id: 'video',
  label: 'Video',
  mime: 'video/mp4',
  async run(reqUnknown, pullUnknown, onProgress): Promise<ExportResult> {
    const req = reqUnknown as ExportRequest;
    const pull = pullUnknown as PullFrame;

    const fps = (req.options?.['fps'] as number | undefined) ?? 30;
    const from = req.range?.from ?? 0;
    const to = req.range?.to ?? from + 2;
    const total = Math.max(1, Math.round((to - from) * fps));

    const firstFrame: FramePixels = await pull(from);
    const picked = await pickCodecAndFormat(firstFrame.width, firstFrame.height);
    if (!picked) {
      console.info(
        '[gdesign export] video: no encodable codec found (checked avc, vp9, vp8). ' +
          'WebCodecs/environment limitation, not a product gap',
      );
      return {
        mime: 'text/plain',
        data: new TextEncoder().encode('video export unavailable: no supported codec in this environment').buffer,
        fileName: 'gdesign-export-unsupported.txt',
      };
    }

    const target = new BufferTarget();
    const output = new Output({ format: picked.format, target });
    const source = new VideoSampleSource({ codec: picked.codec, bitrate: QUALITY_HIGH });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();

    const frameDuration = 1 / fps;
    let frame = firstFrame;
    // Iterate by frame INDEX (0..total-1), not by repeatedly accumulating
    // `time += frameDuration`: frameDuration (e.g. 0.1 at fps=10) isn't
    // exactly representable in IEEE754, so ten additions of 0.1 land at
    // 0.9999999999999999, not 1.0. A `while (time < to)` loop then sees
    // that as still-less-than `to` and runs an 11th frame for what should
    // be exactly 10 (1s @ 10fps). Computing each frame's time fresh from
    // `from + i * frameDuration` has no accumulated error to trip on.
    for (let i = 0; i < total; i++) {
      const time = from + i * frameDuration;
      if (i > 0) frame = await pull(time);

      const sample = new VideoSample(frame.data as BufferSource, {
        format: 'RGBA',
        codedWidth: frame.width,
        codedHeight: frame.height,
        timestamp: time - from,
        duration: frameDuration,
      });
      // eslint-disable-next-line no-await-in-loop -- must respect encoder backpressure per frame
      await source.add(sample);
      sample.close();
      onProgress?.(i + 1, total, 'video');
    }

    await output.finalize();
    const data = target.buffer ?? new ArrayBuffer(0);
    return { mime: output.format.mimeType, data, fileName: `gdesign-export${picked.extension}` };
  },
};
