/**
 * THE engine facade. UI imports ONLY from here (via the @engine alias);
 * engine code never imports from src/ui or src/app. Deep imports from UI
 * code are a review-blocking violation.
 */

export type { EngineHost } from './host/EngineHost';
export type {
  DocEdit, NodePath, ClockCommand, BurnRequest, BurnResult, ExportRequest,
  ExportResult, ReadbackRequest, ReadbackResult, HitResult, PassTiming,
  EngineEvent, EngineEventType, EffectMeta, SourceMeta, BlendMeta,
  StrokeConfig, StrokePoint,
} from './host/protocol';
export type {
  DocumentJSON, LayerNode, Layer, LayerGroup, ObjectNode, ObjectContent,
  ObjectStyle, ShapeSpec, TextSpec, AssetJSON, BakedClip,
} from './doc/json';
export { emptyDocument } from './doc/json';
export type {
  Seconds, LayerId, ObjectId, AssetId, AssetRef, Transform2D, Rect, EngineCaps,
} from './core/types';
export { layerId, objectId, assetId, identityTransform } from './core/types';
export type {
  ParamSpec, ParamsSchema, ParamValue, ParamValues, ResolvedParams,
  ResolvedParam, Keyframe, Lfo,
} from './params/schema';
export type { PassDescriptor, PassInputDecl, PassMetadata } from './passes/pass';
export type { Chain, EffectInstance } from './passes/chain';
export type { SourceDescriptor, SourceInstance } from './sources/source';
export type { BlendModeDef } from './registry/registry';

// Pure, DOM-free helpers the UI needs to compute object bounds without
// duplicating the object-tree walk or the transform math (see
// core/transform2d.ts and doc/object.ts's doc comments).
export { sceneObjects, findLayer } from './doc/document';
export type { LayerLocation } from './doc/document';
export { walkObjects, findObjectInTree, createObject } from './doc/object';
export type { ObjectLocation, CreateObjectPartial } from './doc/object';
export { createGroup } from './doc/layer';
export type { CreateGroupPartial } from './doc/layer';
export {
  contentBoxOf, applyTransform, inverseTransform, transformedCorners, hitTestBox,
} from './core/transform2d';
export type { ContentBox } from './core/transform2d';

// Implementations (Phase 1+). createLocalEngineHost is the only runtime
// entry point the app uses; it is added to this file by engine track D.
export { createLocalEngineHost } from './host/localHost';

// core.lut's packed-2D byte layout, shared with the LUT asset picker
// (ui/dialogs/lut-import.ts) so a .cube/Hald-PNG import produces bytes in
// exactly the tiling core/asset-textures.ts uploads and lut.ts's WGSL reads.
export { packLutBytes, identityLutBytes, invertedLutBytes } from './passes/builtin/lut-bytes';
export type { LutSample } from './passes/builtin/lut-bytes';
