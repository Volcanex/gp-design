/**
 * Bucket tool: CPU flood fill directly on the raster asset's bytes. No GPU
 * work needed, raster assets are already CPU-side bytes by design (see
 * doc/json.ts's AssetJSON('raster')). One click resolves the target layer
 * via resolvePaintLayer (never refuses, see paint-layer.ts), decodes its
 * existing raster asset (or treats an absent one as an all-transparent
 * doc.canvas-sized surface, exactly like a fresh Paint layer looks to a
 * brush stroke), floods from the click point, and commits the result as ONE
 * undo step: commitRaster alone if the layer already has a raster asset, or
 * addAsset + setParam + commitRaster for a brand-new one, the same edit
 * shape localHost.ts's endStroke() builds for a first brush stroke, so
 * localHost's applyEdits -> invalidateRasterInstances resyncs the GPU
 * texture from the new bytes exactly like a stroke commit does.
 */

import type { AppCtx, ToolId } from '../../app/types';
import type { AssetJSON, DocEdit } from '@engine';
import { assetId, layerId } from '@engine';
import { selectionState, toolState, DEFAULT_BUCKET_TOLERANCE } from '../../app/stores';
import { history } from '../../app/commands/app-history';
import { patchCommand } from '../../app/commands/command';
import { resolvePaintLayer } from './paint-layer';
import { floodFill } from './flood-fill';
import { decodeRgba16f, encodeRgba16f } from './raster-codec';
import type { ToolHandler, ToolPoint } from './viewport';

const RASTER_BYTES_PER_PIXEL = 8; // rgba16float: 4 channels * 2 bytes

type RasterAsset = Extract<AssetJSON, { type: 'raster' }>;

function isRasterAsset(asset: AssetJSON | undefined): asset is RasterAsset {
  return asset?.type === 'raster';
}

export function createBucketToolHandler(app: AppCtx): ToolHandler {
  function fill(pt: ToolPoint, tool: ToolId): void {
    if (tool !== 'bucket') return;

    const target = resolvePaintLayer(app);
    const doc = app.engine.getDocument();
    const layer = doc.layers.find((l) => l.id === target);
    if (!layer || layer.kind !== 'layer') return;

    const { width, height } = doc.canvas;
    const existingRef = layer.source.params['asset'] as { asset: string } | undefined;
    const existingAsset = existingRef ? doc.assets[existingRef.asset] : undefined;
    const usableAsset = isRasterAsset(existingAsset) && existingAsset.width === width && existingAsset.height === height
      ? existingAsset
      : undefined;

    const { primary, bucketTolerance } = toolState.get();
    const marquee = selectionState.get().marquee;

    const result = floodFill({
      width,
      height,
      pixels: usableAsset ? decodeRgba16f(usableAsset.data) : null,
      seed: { x: pt.x, y: pt.y },
      fillColor: primary,
      tolerance: bucketTolerance ?? DEFAULT_BUCKET_TOLERANCE,
      clip: marquee ?? undefined,
    });
    if (!result.region) return;

    const newBytes = encodeRgba16f(new Float32Array(result.data));

    const edits: DocEdit[] = [];
    let targetAssetId = usableAsset ? existingRef!.asset : undefined;
    if (!targetAssetId) {
      targetAssetId = `raster-${target}`;
      edits.push({
        op: 'addAsset',
        id: targetAssetId,
        asset: { type: 'raster', data: new ArrayBuffer(width * height * RASTER_BYTES_PER_PIXEL), width, height },
      });
      edits.push({
        op: 'setParam',
        target: { kind: 'layer', id: layerId(target) },
        key: 'asset',
        value: { asset: assetId(targetAssetId) },
      });
    }
    edits.push({
      op: 'commitRaster',
      layer: layerId(target),
      asset: targetAssetId,
      data: newBytes,
      region: result.region,
    });

    history.push(app, patchCommand('Bucket Fill', edits));
  }

  return {
    down(pt, tool) {
      fill(pt, tool);
    },
    move() {
      // No live preview / drag-fill: one click, one fill (paint.net semantics).
    },
    up() {},
  };
}
