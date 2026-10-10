/**
 * localHost.ts: the in-thread EngineHost facade. This is the only runtime
 * entry point the app uses; workerHost.ts (M7) will implement the identical
 * EngineHost interface over Comlink, so nothing here should leak beyond it.
 */

import type { EngineHost } from './EngineHost';
import type { EngineCaps, LayerId, Seconds } from '../core/types';
import { assetId } from '../core/types';
import { wrapLoopTime } from '../core/loop';
import type { DocumentJSON } from '../doc/json';
import { emptyDocument } from '../doc/json';
import type {
  BlendMeta, BurnRequest, BurnResult, ClockCommand, DocEdit, EffectMeta,
  EngineEvent, ExportRequest, ExportResult, HitResult,
  ReadbackRequest, ReadbackResult, SourceMeta, StrokeConfig, StrokePoint,
} from './protocol';
import type { PassDescriptor } from '../passes/pass';
import { initDevice, onDeviceLost, onUncapturedError } from '../gpu/device';
import { createEmitter } from './events';
import { createBufferPool } from '../gpu/pool-impl';
import { createReadback } from '../gpu/readback';
import { createEngine } from '../core/engine';
import { applyEdits as applyDocEdits, findLayer } from '../doc/document';
import { effects } from '../registry/effects';
import { sources } from '../registry/sources';
import { blends } from '../registry/blends';
import { isRasterStrokeInstance, readRawRgba16f } from '../sources/builtin/raster';
import { burn as burnEdits, type BurnRenderer } from '../burn/burn';
import { exportTargets } from '../registry/exports';
import type { PullFrame } from '../export/types';
import '../registry/builtins';

/** Free-list buffers unused for this many rendered frames are destroyed. */
const TRIM_IDLE_FRAMES = 120;
/** Consecutive failing frames before the transport is halted for good. */
const MAX_CONSECUTIVE_FAILURES = 30;

export function createLocalEngineHost(): EngineHost {
  let doc: DocumentJSON = emptyDocument();
  let bundle: Awaited<ReturnType<typeof initDevice>> | null = null;
  let pool: ReturnType<typeof createBufferPool> | null = null;
  let engine: ReturnType<typeof createEngine> | null = null;
  let raf = 0;
  let playing = false;
  /** Set by stopTransport(): the session can no longer render (lost device,
   * OOM, error storm). Play requests are refused so nothing spins. */
  let fatal = false;
  let consecutiveFailures = 0;
  let time = 0;
  let frameCount = 0;
  let fps = 30;
  /** Transport loop range, or undefined for unlooped play. Wraps only during playback; seek stays free. */
  let loopRange: { from: Seconds; to: Seconds } | undefined;
  /** Layer targeted by the in-progress stroke, or null between strokes. */
  let strokeLayer: LayerId | null = null;

  const emitter = createEmitter<EngineEvent>();
  const emit = emitter.emit;
  /** Dev-only hook installed by __gdesign.debug.failFrames() (main.ts).
   * See debugFailFrames below. Left null in production. */
  let failFramesRemaining = 0;

  function rebuildEngine(): void {
    if (!bundle || !pool) return;
    engine?.dispose();
    engine = createEngine(bundle, pool, doc);
  }

  /**
   * A single bad frame (e.g. a source erroring on unexpected doc state)
   * must never brick the session: tick()'s next requestAnimationFrame is on
   * the far side of this call, so an uncaught throw here would permanently
   * stop the render loop (and applyEdits/init/loadDocument, which all also
   * call renderNow()). Caught, reported once via the 'error' event, and the
   * caller keeps ticking.
   */
  function renderNow(): void {
    if (!engine) return;
    try {
      if (failFramesRemaining > 0) {
        failFramesRemaining -= 1;
        throw new Error('[gdesign] debugFailFrames: synthetic renderFrame failure');
      }
      engine.renderFrame(time, frameCount, { present: true });
    } catch (err) {
      console.error('[gdesign] renderFrame failed', err);
      consecutiveFailures += 1;
      // A frame that fails every time is not "one bad frame": it logs at
      // frame rate forever and each attempt can leak retained buffers. Stop
      // the transport and tell the user, same path as a lost device.
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stopTransport();
        emit({
          type: 'error',
          message: 'Rendering keeps failing. Save your work (File > Save) and reload the page.',
          fatal: true,
        });
        return;
      }
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err), fatal: false });
      return;
    }
    consecutiveFailures = 0;
    frameCount += 1;
    emit({ type: 'frame', time, frame: frameCount });
    // The pool's free-lists otherwise grow to peak size and stay there
    // forever (every unique buffer size keeps its bucket for the session).
    // Ageing them per rendered frame frees anything unused for ~4s at 30fps;
    // steady-state buffers are re-borrowed every frame so never age.
    pool?.trim(TRIM_IDLE_FRAMES);
  }

  /** Halts playback for good (device lost, error storm, OOM): the loop must
   * not keep submitting work to a device that can no longer take it. */
  function stopTransport(): void {
    playing = false;
    cancelAnimationFrame(raf);
    fatal = true;
  }

  /**
   * Every applyEdits() call (forward, undo, or redo, since all three go
   * through this one channel) may have changed a raster layer's asset
   * bytes underneath an already-live SourceInstance (commitRaster mutates
   * asset.data in place, so there's no cheap way for the instance to notice
   * on its own). Unconditionally invalidating every cached raster instance
   * is the simplest correct fix: a stale invalidate just costs one redundant
   * texture upload next render(), which is cheap and idempotent.
   */
  function invalidateRasterInstances(): void {
    if (!engine) return;
    for (const inst of engine.listSourceInstances()) {
      if (isRasterStrokeInstance(inst)) inst.invalidateAsset();
    }
  }

  function tick(): void {
    if (!playing) return;
    // Re-arm FIRST. Nothing below may be allowed to skip the next frame;
    // stopTransport() cancels this handle when playback must actually end.
    raf = requestAnimationFrame(tick);
    time += 1 / fps;
    time = wrapLoopTime(time, loopRange);
    renderNow();
    emit({ type: 'clock', playing, time });
  }

  return {
    async init(canvas): Promise<EngineCaps> {
      bundle = await initDevice(canvas, doc.canvas.outputColorSpace);
      // No recovery is attempted (a lost device invalidates every resource
      // the engine holds). Stop the loop so we don't spin submitting to a
      // dead device, and tell the UI so the user gets a reload banner
      // instead of a silently frozen canvas.
      onDeviceLost(bundle.device, (info) => {
        stopTransport();
        emit({ type: 'error', message: `GPU device lost (${info.reason || 'unknown'}). Save your work and reload the page.`, fatal: true });
      });
      // Validation and out-of-memory errors otherwise go only to devtools.
      // OOM is the error class that precedes a lost device, so it takes the
      // fatal path while the page can still be saved; validation errors are
      // reported once per distinct message.
      onUncapturedError(bundle.device, (err) => {
        if (err.kind === 'oom') {
          stopTransport();
          emit({ type: 'error', message: 'The GPU ran out of memory. Save your work and reload the page.', fatal: true });
          return;
        }
        emit({ type: 'error', message: `GPU error: ${err.message}`, fatal: false });
      });
      pool = createBufferPool(bundle.device);
      fps = doc.clock.fps;
      rebuildEngine();
      emit({ type: 'caps', caps: bundle.caps });
      renderNow();
      return bundle.caps;
    },

    async dispose(): Promise<void> {
      cancelAnimationFrame(raf);
      playing = false;
      engine?.dispose();
      // trim(0) ages every free-list entry past the threshold, i.e. destroy
      // all pooled textures. Anything still live/retained at this point is
      // a caller bug and gets released by device GC instead.
      pool?.trim(0);
      bundle = null;
      pool = null;
      engine = null;
    },

    async loadDocument(next): Promise<void> {
      doc = next;
      fps = doc.clock.fps;
      rebuildEngine();
      renderNow();
    },

    getDocument: () => doc,

    applyEdits(edits: DocEdit[]): DocEdit[] {
      const inverses = applyDocEdits(doc, edits);
      invalidateRasterInstances();
      // MEMORY-EVICTION block: forward, undo, AND redo all funnel through
      // this one channel, so this is the one place that needs to notice a
      // layer/asset dropping out of the doc and free its GPU caches.
      engine?.reconcile();
      emit({ type: 'document-changed', edits, origin: 'ui' });
      renderNow();
      return inverses;
    },

    setClock(cmd: ClockCommand): void {
      if (cmd.cmd === 'play') {
        if (fatal) return;
        playing = true;
        raf = requestAnimationFrame(tick);
      }
      if (cmd.cmd === 'pause') {
        playing = false;
        cancelAnimationFrame(raf);
      }
      if (cmd.cmd === 'seek') {
        time = cmd.time;
        renderNow();
      }
      if (cmd.cmd === 'setFps') {
        fps = cmd.fps;
        doc.clock.fps = cmd.fps;
      }
      if (cmd.cmd === 'setLoop') {
        loopRange = cmd.range;
      }
      emit({ type: 'clock', playing, time });
    },

    requestFrame(): void {
      renderNow();
    },

    invalidateAsset(id: string): void {
      engine?.invalidateAsset(id);
    },

    beginStroke(config: StrokeConfig): void {
      strokeLayer = null;
      const found = findLayer(doc, config.layer);
      if (!found || found.node.kind !== 'layer' || found.node.source.type !== 'core.raster') {
        console.info('beginStroke: target layer is not a raster layer, ignoring');
        return;
      }
      const inst = engine?.getSourceInstance(config.layer);
      if (!inst || !isRasterStrokeInstance(inst)) {
        console.info('beginStroke: raster source instance not ready, ignoring');
        return;
      }
      inst.beginStroke(config);
      strokeLayer = config.layer;
    },

    strokePoint(p: StrokePoint): void {
      if (!strokeLayer || !engine) return;
      const inst = engine.getSourceInstance(strokeLayer);
      if (!inst || !isRasterStrokeInstance(inst)) return;
      inst.strokePoint(p);
      renderNow(); // live preview: drains the batch inside the layer's next render()
    },

    async endStroke(): Promise<DocEdit[]> {
      const layer = strokeLayer;
      strokeLayer = null;
      if (!layer || !engine || !bundle) return [];
      const inst = engine.getSourceInstance(layer);
      if (!inst || !isRasterStrokeInstance(inst)) return [];

      inst.endStroke();
      renderNow(); // flushes any still-pending points from the last strokePoint

      // Region-scoped: only the stroke's own bounding box (brush footprint,
      // clamped to canvas) gets read back and committed, not the whole
      // canvas. A full-canvas commitRaster + its full-canvas inverse was
      // ~15MB per stroke at 720p regardless of how small the brush touch
      // was. A stroke that touched nothing (bounds null) commits nothing.
      const bounds = inst.strokeBounds();
      if (!bounds) return [];
      const result = await inst.readBack(bounds);

      const found = findLayer(doc, layer);
      if (!found || found.node.kind !== 'layer') return [];
      const existingAsset = found.node.source.params['asset'] as { asset: string } | undefined;

      const edits: DocEdit[] = [];
      let targetAssetId = existingAsset?.asset;
      if (!targetAssetId) {
        targetAssetId = `raster-${layer}`;
        edits.push({
          op: 'addAsset',
          id: targetAssetId,
          asset: {
            type: 'raster',
            data: new ArrayBuffer(result.canvasWidth * result.canvasHeight * 8),
            width: result.canvasWidth,
            height: result.canvasHeight,
          },
        });
        edits.push({
          op: 'setParam',
          target: { kind: 'layer', id: found.node.id },
          key: 'asset',
          value: { asset: assetId(targetAssetId) },
        });
      }
      edits.push({
        op: 'commitRaster',
        layer: found.node.id,
        asset: targetAssetId,
        data: result.data,
        region: bounds,
      });

      // UNAPPLIED: the caller wraps this batch in its own history/undo
      // command and applies it exactly once via applyEdits (the sole
      // mutation channel), same as burn/mergeDown. Applying is then a
      // visual no-op: the GPU backing texture already shows these pixels
      // from the live-preview stamps made during the stroke. Undo later
      // replaying commitRaster's inverse is what invalidateRasterInstances
      // (called from applyEdits above) exists to catch.
      return edits;
    },

    async burn(req: BurnRequest): Promise<BurnResult> {
      if (!engine || !bundle) return { edits: [] };
      const device = bundle.device;
      const activeEngine = engine;
      const renderer: BurnRenderer = async (target, t) => {
        const result = activeEngine.renderSubtree(target, t, frameCount);
        if (!result) return null;
        try {
          const data = await readRawRgba16f(device, result.buffer.texture, result.width, result.height);
          return { data, width: result.width, height: result.height };
        } finally {
          result.buffer.release();
        }
      };
      return burnEdits(doc, req, time, renderer);
    },

    async export(req: ExportRequest): Promise<ExportResult> {
      if (!engine || !bundle || !pool) throw new Error('export: engine not initialised');
      const target = exportTargets.require(req.target);

      // Render-without-present, same idiom as readback() below: one frame
      // at a given (or current) clock time, quantised to display bytes.
      const pull: PullFrame = async (t) => {
        if (!engine || !bundle || !pool) return { width: 0, height: 0, data: new Uint8Array(0) };
        const { accumulator } = engine.renderFrame(t ?? time, frameCount, { keepAccumulator: true });
        if (!accumulator) return { width: 0, height: 0, data: new Uint8Array(0) };
        try {
          const quantised = engine.presenter.toQuantised(accumulator, pool);
          try {
            const rb = createReadback(bundle.device);
            const data = await rb.readUnorm8(quantised.texture, quantised.key.width, quantised.key.height);
            return { width: quantised.key.width, height: quantised.key.height, data };
          } finally {
            pool.return(quantised);
          }
        } finally {
          accumulator.release();
        }
      };

      // The colour space the pixels were ACTUALLY rendered in. Mirrors
      // present.ts's own useP3 decision (bundle.context's configured
      // colorSpace), not doc.canvas.outputColorSpace: headless SwiftShader
      // never configures a context (gpu/device.ts), so toQuantised always
      // produces sRGB bytes there regardless of the doc's stated intent.
      // Reading it off bundle keeps the export tag truthful in both cases.
      const colorSpace = bundle.context?.getConfiguration()?.colorSpace ?? 'srgb';
      const fps = (req.options?.['fps'] as number | undefined) ?? doc.clock.fps;
      const fullReq: ExportRequest = {
        ...req,
        options: { ...req.options, colorSpace, fps, docJson: JSON.stringify(doc) },
      };
      const onProgress = (done: number, total: number, label: string) => {
        emit({ type: 'export-progress', done, total, label });
      };
      return target.run(fullReq, pull, onProgress) as Promise<ExportResult>;
    },

    async readback(req: ReadbackRequest): Promise<ReadbackResult> {
      if (!engine || !bundle || !pool) {
        return { width: 0, height: 0, data: new ArrayBuffer(0), via: req.via };
      }
      const { accumulator } = engine.renderFrame(time, frameCount, { keepAccumulator: true });
      if (!accumulator) {
        return { width: 0, height: 0, data: new ArrayBuffer(0), via: req.via };
      }
      const readback = createReadback(bundle.device);
      try {
        if (req.via === 'float') {
          const data = await readback.readFloat(accumulator.texture, accumulator.key.width, accumulator.key.height);
          return { width: accumulator.key.width, height: accumulator.key.height, data: data.buffer as ArrayBuffer, via: 'float' };
        }
        const quantised = engine.presenter.toQuantised(accumulator, pool);
        try {
          const data = await readback.readUnorm8(quantised.texture, quantised.key.width, quantised.key.height);
          return { width: quantised.key.width, height: quantised.key.height, data: data.buffer as ArrayBuffer, via: 'quantised' };
        } finally {
          pool.return(quantised);
        }
      } finally {
        accumulator.release();
      }
    },

    /**
     * Design: walk the layer tree top-down (reverse of doc order, since
     * later siblings composite on top; same convention layers-logic.ts's
     * displayOrder uses for the panel), descending into enabled groups
     * (groups carry no transform, so doc-space coords pass through
     * unchanged), and return the first hit + its layer.
     */
    async hitTest(x: number, y: number): Promise<HitResult> {
      if (!engine) return { layer: null, object: null };
      const eng = engine;
      const walk = (nodes: typeof doc.layers): HitResult | null => {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          const node = nodes[i]!;
          if (!node.enabled) continue;
          if (node.kind === 'group') {
            const hit = walk(node.children);
            if (hit) return hit;
            continue;
          }
          if (node.source.type !== 'core.scene') continue;
          const inst = eng.getSourceInstance(node.id);
          if (!inst?.hitTest) continue;
          const hit = inst.hitTest(x, y, time);
          if (hit) return { layer: node.id, object: hit };
        }
        return null;
      };
      return walk(doc.layers) ?? { layer: null, object: null };
    },

    memoryStats() {
      if (!pool) return null;
      const s = pool.stats();
      // MEMORY-EVICTION block: pool.stats() alone only ever counted the
      // scratch buffer pool. The per-layer/per-asset caches this pass adds
      // eviction for (engine.ts's clip/mask texture caches, asset-textures'
      // LUT/image cache) live OUTSIDE the pool (raw device.createTexture),
      // so without folding engine.memoryBytes() in here, evicting them would
      // be functionally correct but invisible to this readout, the exact
      // gap that would make a memory-eviction e2e assertion against this
      // field pass trivially whether or not eviction actually ran.
      const e = engine?.memoryBytes() ?? { bytes: 0, peakBytes: 0 };
      return { bytes: s.bytes + e.bytes, peakBytes: s.peakBytes + e.peakBytes };
    },

    /** Debug-only, additive: makes the next `n` renderNow() calls throw
     * synthetically, exercising the MAX_CONSECUTIVE_FAILURES error-storm
     * cutoff on demand (error-storm.spec.ts) without needing a real GPU
     * fault. See __gdesign.debug.failFrames in main.ts. */
    debugFailFrames(n: number): void {
      failFramesRemaining = n;
    },

    registerEffect(desc: PassDescriptor): void {
      effects.register(desc);
    },
    listEffects: (): EffectMeta[] =>
      effects.list().map((d) => ({
        id: d.id, label: d.label, category: d.metadata.category, menuPath: d.metadata.menuPath, params: d.params,
      })),
    listSources: (): SourceMeta[] =>
      sources.list().map((s) => ({ id: s.id, label: s.label, liveByDefault: s.liveByDefault, params: s.params })),
    listBlendModes: (): BlendMeta[] => blends.list().map((b) => ({ id: b.id, label: b.label })),

    on(event, cb) {
      return emitter.on(event, cb);
    },
  };
}
