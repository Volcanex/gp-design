/**
 * FROZEN CONTRACT (F0). The one facade UI code talks to. localHost.ts
 * implements it in-thread (Phase 1, track D); workerHost.ts (M7) implements
 * the identical interface over Comlink. UI code must not change when that
 * swap happens, which is why every argument and return type here is
 * structured-clone-safe (canvas crosses via transferControlToOffscreen).
 */

import type { EngineCaps } from '../core/types';
import type { DocumentJSON } from '../doc/json';
import type {
  BlendMeta, BurnRequest, BurnResult, ClockCommand, DocEdit, EffectMeta,
  EngineEvent, EngineEventType, ExportRequest, ExportResult, HitResult,
  ReadbackRequest, ReadbackResult, SourceMeta, StrokeConfig, StrokePoint,
} from './protocol';
import type { PassDescriptor } from '../passes/pass';

export interface EngineHost {
  init(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<EngineCaps>;
  dispose(): Promise<void>;

  loadDocument(doc: DocumentJSON): Promise<void>;
  getDocument(): DocumentJSON;

  /**
   * THE mutation channel. Applies atomically, renders next frame, and
   * returns inverse edits in reverse order (apply them to undo).
   */
  applyEdits(edits: DocEdit[]): DocEdit[];

  setClock(cmd: ClockCommand): void;
  /** One render while paused. */
  requestFrame(): void;

  /**
   * ADDITIVE DIFF (2026-07-08, architect-approved, MASKS follow-up): tells
   * the engine an asset's bytes were mutated IN PLACE (mask painting's live
   * preview, commitRaster-idiom writers) so any GPU texture derived from
   * them must re-upload. Needed because a byte-sampling signature can never
   * reliably detect a localized brush stamp (the shipped sampler's stride
   * was row-aligned: it only ever read column 0). Structured-clone-safe
   * (a string id), so M7's workerHost can forward it verbatim.
   */
  invalidateAsset(id: string): void;

  /** Paint-tool stroke streaming: preview live, commit on end. */
  beginStroke(config: StrokeConfig): void;
  strokePoint(p: StrokePoint): void;
  /** Commits stroke to the raster asset; returns the edit batch (one undo step). */
  endStroke(): Promise<DocEdit[]>;

  burn(req: BurnRequest): Promise<BurnResult>;
  export(req: ExportRequest): Promise<ExportResult>;
  /** Tests + eyedropper. Reads the post-present quantised target or float accumulator. */
  readback(req: ReadbackRequest): Promise<ReadbackResult>;
  hitTest(x: number, y: number): Promise<HitResult>;

  /** Plugin surface: a WGSL string + JSON schema crosses any boundary. */
  registerEffect(desc: PassDescriptor): void;
  listEffects(): EffectMeta[];
  listSources(): SourceMeta[];
  listBlendModes(): BlendMeta[];

  /**
   * ADDITIVE DIFF (2026-07-12, leak-fix pass): live GPU buffer-pool
   * footprint, for the statusbar's memory readout. The app reporting its
   * own memory pressure is what makes the next leak visible immediately
   * instead of as a frozen machine. Optional (mock hosts needn't implement)
   * and structured-clone-safe, so M7's workerHost can forward it verbatim.
   */
  memoryStats?(): { bytes: number; peakBytes: number } | null;

  /**
   * ADDITIVE, non-frozen (2026-09-09, crash-tests workstream): a dev-only
   * test hook, not part of the F0 contract above. Makes the next `n`
   * renderNow() calls fail synthetically so the error-storm cutoff
   * (MAX_CONSECUTIVE_FAILURES in localHost.ts) can be exercised without a
   * real GPU fault. Optional so a mock host needn't implement it.
   */
  debugFailFrames?(n: number): void;

  on(event: EngineEventType, cb: (e: EngineEvent) => void): () => void;
}
