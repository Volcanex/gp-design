/**
 * Shared shape between localHost.export's frame-pull closure and the
 * export/*.ts targets. registry.ts keeps ExportTargetDef.run's `pull`
 * param as `(time: number) => Promise<unknown>` on purpose (clone-free,
 * loosely typed); each target casts it to PullFrame.
 */

export interface FramePixels {
  width: number;
  height: number;
  /** Tightly packed RGBA8, row-major, top-to-bottom. Matches gpu/readback.ts's readUnorm8. */
  data: Uint8Array;
}

/** time omitted = host's current clock time. */
export type PullFrame = (time?: number) => Promise<FramePixels>;
