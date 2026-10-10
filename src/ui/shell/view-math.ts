/**
 * Pure pan/zoom math shared by shell-commands, viewport, and shell's resize
 * handling. Single coordinate system: panX/panY IS the canvas's top-left in
 * canvas-region coordinates (see app.css: .gd-canvas-region no longer
 * flex-centres the canvas).
 */

import { clampZoom } from './shell-commands';

export interface Size {
  width: number;
  height: number;
}

export interface Pan {
  x: number;
  y: number;
}

/** Canvas must keep at least this many px overlapping the region on each axis. */
const MIN_VISIBLE_PX = 48;

/** Largest zoom that fits doc inside region with margin on all sides. */
export function fitZoom(region: Size, doc: Size, margin = 24): number {
  return clampZoom(Math.min((region.width - 2 * margin) / doc.width, (region.height - 2 * margin) / doc.height));
}

/** Pan that centres the (zoomed) doc inside the region. */
export function centeredPan(region: Size, doc: Size, zoom: number): Pan {
  return { x: (region.width - doc.width * zoom) / 2, y: (region.height - doc.height * zoom) / 2 };
}

function clampAxis(value: number, canvasExtent: number, regionExtent: number): number {
  const low = MIN_VISIBLE_PX - canvasExtent;
  const high = regionExtent - MIN_VISIBLE_PX;
  return high >= low ? Math.min(Math.max(value, low), high) : (low + high) / 2;
}

/** Keeps at least MIN_VISIBLE_PX of the canvas intersecting the region on each axis. */
export function clampPan(pan: Pan, region: Size, doc: Size, zoom: number): Pan {
  return {
    x: clampAxis(pan.x, doc.width * zoom, region.width),
    y: clampAxis(pan.y, doc.height * zoom, region.height),
  };
}
