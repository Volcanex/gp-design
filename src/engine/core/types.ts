/**
 * FROZEN CONTRACT (F0). Changes require architect sign-off: builders code
 * against these types; a unilateral edit here breaks parallel workstreams.
 */

export type Seconds = number;
export type LayerId = string & { readonly __brand: 'LayerId' };
export type ObjectId = string & { readonly __brand: 'ObjectId' };
export type AssetId = string & { readonly __brand: 'AssetId' };

export const layerId = (s: string) => s as LayerId;
export const objectId = (s: string) => s as ObjectId;
export const assetId = (s: string) => s as AssetId;

/** Reference to an entry in DocumentJSON.assets. */
export interface AssetRef {
  asset: AssetId;
}

/** 2D affine transform. Rotation in radians, anchor in 0..1 of content box. */
export interface Transform2D {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  anchorX: number;
  anchorY: number;
}

export const identityTransform = (): Transform2D => ({
  x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5,
});

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the device init discovered. Informs test paths and UI warnings. */
export interface EngineCaps {
  adapterInfo: { vendor: string; architecture: string };
  float16Renderable: boolean;
  float32Filterable: boolean;
  timestampQueries: boolean;
  preferredCanvasFormat: GPUTextureFormat;
  displayP3: boolean;
}
