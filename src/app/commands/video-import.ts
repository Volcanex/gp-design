/**
 * Video -> baked clip layer. Mirrors image-import.ts's shape: probe/decode,
 * build an addAsset + addLayer edit batch, push through history exactly
 * like any other content command.
 *
 * Decoding: VideoSampleSink (Mediabunny) runs a WebCodecs VideoDecoder under
 * the hood and yields VideoSample per decoded frame in presentation order.
 * VideoSample.copyTo() only exposes the decoder's *native* planes (YUV for
 * almost every real-world codec). It does not convert to RGBA. To get the
 * RGBA8 bytes the baked-clip asset format wants, each kept sample is drawn
 * through a 2D canvas (sample.draw(), which does know how to convert +
 * resize + apply rotation metadata) and read back via getImageData, exactly
 * mirroring the OffscreenCanvas round-trip image-import.ts's downscale path
 * already uses. getImageData is always tightly packed (no row padding), so
 * bytesPerRow = width*4 holds: the assumption core/engine.ts's rgba8unorm
 * baked-clip upload path relies on.
 *
 * The clip is decoded once, up front, into an in-memory frame array: there
 * is no streaming baked-clip source (yet); see the format's frozen-contract
 * note in engine/CLAUDE.md.
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import type { InputVideoTrack, VideoSample } from 'mediabunny';
import type { AppCtx } from '../types';
import type { DocEdit, LayerId, LayerNode } from '@engine';
import { layerId, assetId, identityTransform, findLayer } from '@engine';
import { viewState } from '../stores';
import { history } from './app-history';
import { patchCommand } from './command';
import { pickTargetFps, exceedsHardBudget, estimateBytes, createFrameDecimator } from './video-import-budget';

/** Marks a failure as having happened while opening/probing/decoding the
 * source (bad container, no video track, unsupported codec) so callers can
 * tell that apart from a downstream failure (history push, engine render). */
export class VideoDecodeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'VideoDecodeError';
  }
}

export interface VideoProbe {
  duration: number;
  fps: number;
  width: number;
  height: number;
}

async function openPrimaryVideoTrack(blob: Blob): Promise<{ input: Input; track: InputVideoTrack }> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new VideoDecodeError(new Error('no video track in file'));
  return { input, track };
}

/** Cheap-ish probe for the import dialog: duration from container metadata
 * (falls back to the exact-but-costlier computeDuration when metadata is
 * absent), fps sampled from the first ~100 packets rather than the whole
 * file, and display (post-rotation/PAR) dimensions. */
export async function probeVideo(blob: Blob): Promise<VideoProbe> {
  let input: Input | undefined;
  try {
    const opened = await openPrimaryVideoTrack(blob);
    input = opened.input;
    const { track } = opened;
    const [duration, stats, width, height] = await Promise.all([
      input.getDurationFromMetadata([track]).then((d) => d ?? input!.computeDuration([track])),
      track.computePacketStats(100),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
    ]);
    return { duration, fps: stats.averagePacketRate, width, height };
  } catch (err) {
    throw err instanceof VideoDecodeError ? err : new VideoDecodeError(err);
  } finally {
    input?.dispose();
  }
}

export interface VideoImportOptions {
  from: number;
  to: number;
  targetFps: number;
  halfRes: boolean;
}

/** Mirrors image-import.ts's siblingInsertPoint (kept local rather than
 * imported: small enough to duplicate, and avoids a cross-agent edit to a
 * file another wave-1 workstream may also be touching). New layer lands
 * just above the active one, in ITS OWN sibling list. */
function siblingInsertPoint(app: AppCtx): { parent: LayerId | null; index: number } {
  const doc = app.engine.getDocument();
  const active = viewState.get().activeLayer;
  if (!active) return { parent: null, index: doc.layers.length };
  const found = findLayer(doc, layerId(active));
  if (!found) return { parent: null, index: doc.layers.length };
  return { parent: found.parentId, index: found.index + 1 };
}

function drawSampleToRgba8(sample: VideoSample, canvas: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D): ArrayBuffer {
  sample.draw(ctx, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // getImageData hands back a view backed by its own buffer, but that
  // buffer is only guaranteed valid until the next draw to this canvas:
  // frames are collected across many draws onto the SAME reused canvas, so
  // each frame's bytes must be copied out before the next iteration.
  return imageData.data.buffer.slice(0);
}

export async function importVideoAsLayer(app: AppCtx, blob: Blob, name: string, opts: VideoImportOptions): Promise<void> {
  let input: Input | undefined;
  const frames: ArrayBuffer[] = [];
  try {
    const opened = await openPrimaryVideoTrack(blob);
    input = opened.input;
    const { track } = opened;
    const stats = await track.computePacketStats(100);
    const sourceFps = stats.averagePacketRate;
    const targetFps = pickTargetFps(sourceFps, opts.targetFps);

    const sourceWidth = await track.getDisplayWidth();
    const sourceHeight = await track.getDisplayHeight();
    const width = opts.halfRes ? Math.max(1, Math.round(sourceWidth / 2)) : sourceWidth;
    const height = opts.halfRes ? Math.max(1, Math.round(sourceHeight / 2)) : sourceHeight;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable for video frame readback');

    const sink = new VideoSampleSink(track);
    const decimator = createFrameDecimator(targetFps);

    for await (const sample of sink.samples(opts.from, opts.to)) {
      try {
        if (!decimator.shouldKeep(sample.timestamp)) continue;
        if (exceedsHardBudget(estimateBytes(frames.length + 1, width, height))) {
          // Defensive backstop: the dialog already refuses OK past the hard
          // budget, but a source whose real duration/fps diverges from the
          // probe estimate (VFR content, metadata drift) must not be able
          // to blow past it here regardless.
          break;
        }
        frames.push(drawSampleToRgba8(sample, canvas, ctx));
      } finally {
        sample.close();
      }
    }

    if (frames.length === 0) throw new VideoDecodeError(new Error('no frames decoded in range'));

    const id = assetId(crypto.randomUUID());
    const layer: LayerNode = {
      id: layerId(crypto.randomUUID()),
      kind: 'layer',
      name,
      enabled: true,
      source: { type: 'core.solid', params: {} },
      chain: [],
      blendMode: 'normal',
      opacity: 1,
      transform: identityTransform(),
      liveness: 'baked',
      baked: { clip: id, frames: frames.length, fps: targetFps },
    };

    const doc = app.engine.getDocument();
    const clipDuration = frames.length / targetFps;
    const { parent, index } = siblingInsertPoint(app);
    const edits: DocEdit[] = [
      { op: 'addAsset', id, asset: { type: 'clip', frames, width, height, fps: targetFps, format: 'rgba8unorm' } },
      { op: 'addLayer', parent, index, layer },
      { op: 'setDocClock', clock: { fps: doc.clock.fps, duration: Math.max(doc.clock.duration ?? 0, clipDuration) } },
    ];
    history.push(app, patchCommand('Import Video', edits));
    viewState.update((s) => ({ ...s, activeLayer: layer.id }));
  } catch (err) {
    throw err instanceof VideoDecodeError ? err : new VideoDecodeError(err);
  } finally {
    input?.dispose();
  }
}
