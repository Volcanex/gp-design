/**
 * GPU test harness for engine-test.html. Boots a localHost onto #c and
 * exposes window.__engineTest for Playwright specs to drive directly:
 * no UI, no app shell, just the engine.
 */

import { createLocalEngineHost } from './host/localHost';
import { emptyDocument } from './doc/json';
import { layerId, objectId, identityTransform } from './core/types';
import type { DocumentJSON, ObjectNode } from './doc/json';
import { createObject } from './doc/object';
import type { ParamValues } from './params/schema';
import * as mediabunny from 'mediabunny';

declare global {
  interface Window {
    __engineTest?: {
      host: ReturnType<typeof createLocalEngineHost>;
      ready: Promise<void>;
      loadGold(): Promise<void>;
      loadText(text: string, opts?: { size?: number; color?: [number, number, number, number]; x?: number; y?: number; bg?: [number, number, number, number] }): Promise<void>;
      loadPlasma(): Promise<void>;
      loadRaster(): Promise<void>;
      loadThreeD(opts?: {
        model?: string;
        spin?: number;
        fov?: number;
        distance?: number;
        colorA?: [number, number, number, number];
        colorB?: [number, number, number, number];
        light?: [number, number, number];
        chain?: { pass: string; params?: ParamValues }[];
      }): Promise<void>;
      /** A scene layer over a solid background, one rect object at a known
       * position/size, for scene.spec.ts's render/hitTest/transform tests. */
      loadScene(): Promise<{ layer: string; object: string }>;
      // FX-BLENDGEN block (own this block; see gdesign-wt/blendgen).
      /** Two full-canvas solid layers (base below, src above with the given
       * blend mode at opacity 1). Since src is fully opaque, the composited
       * centre pixel equals blend(base, src) exactly (no porter-duff mixing
       * to model in-test). */
      loadBlendTest(
        blendMode: string,
        base: [number, number, number, number],
        src: [number, number, number, number],
      ): Promise<void>;
      loadNoise(opts?: {
        mode?: string;
        scale?: number;
        speed?: number;
        seed?: number;
        colorA?: [number, number, number, number];
        colorB?: [number, number, number, number];
      }): Promise<void>;
      /** Solid base layer + a core.feedback layer above it (normal blend,
       * opacity 1). Returns the base layer's id so a spec can remove it
       * (host.applyEdits) partway through a multi-frame test. `baseOpacity`
       * defaults to 1 for general use, but the accumulation/decay e2e proof
       * needs it < 1: a fully opaque backdrop overwrites the feedback
       * layer's trail every frame (Porter-Duff `over` degenerates to just
       * `src` when `src.a` = 1), so there's no memory for the trail to
       * carry, and nothing to observe accumulating. */
      loadFeedback(opts?: {
        base?: [number, number, number, number];
        baseOpacity?: number;
        zoom?: number;
        rotate?: number;
        translate?: [number, number];
        fade?: number;
        hueShift?: number;
      }): Promise<{ baseLayer: string; feedbackLayer: string }>;
      // end FX-BLENDGEN block
      /**
       * `mediabunny`'s module namespace, re-exported for specs that need to
       * demux an export result. `import('mediabunny')` as a bare specifier
       * INSIDE page.evaluate can't resolve in a real browser: bare
       * specifiers need an import map, and Vite only rewrites imports it
       * can see statically in its own module graph, not code injected raw
       * via Playwright's evaluate. This harness file IS part of that graph
       * (it's the engine-test.html entry point), so it can import
       * mediabunny normally and hand the already-resolved module back.
       */
      mediabunny: typeof mediabunny;
    };
  }
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const host = createLocalEngineHost();

/**
 * OKLab values verified against src/app/mock/mock-color.ts's sRGB<-OKLab math
 * (inverted by hand): sRGB red (1,0,0) linear -> LMS cube-root -> OKLab gives
 * L=0.62796, a=0.22486, b=0.12585. A neutral grey has a=b=0 by construction;
 * L=0.59987 corresponds to roughly sRGB mid-grey.
 */
function goldDocument(): DocumentJSON {
  const doc = emptyDocument(64, 64);
  doc.layers.push({
    id: layerId('layer1'),
    kind: 'layer',
    name: 'Red',
    enabled: true,
    source: { type: 'core.solid', params: { color: [0.62796, 0.22486, 0.12585, 1] } },
    chain: [{ id: 'fx1', pass: 'core.exposure', params: { exposure: 1 }, enabled: true }],
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
  });
  doc.layers.push({
    id: layerId('layer2'),
    kind: 'layer',
    name: 'Grey',
    enabled: true,
    source: { type: 'core.solid', params: { color: [0.59987, 0, 0, 1] } },
    chain: [],
    blendMode: 'normal',
    opacity: 0.5,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
  });
  return doc;
}

/** A single full-canvas plasma layer, high speed so t=0 vs t=1 clearly differ. */
function plasmaDocument(): DocumentJSON {
  const doc = emptyDocument(64, 64);
  doc.layers.push({
    id: layerId('plasma1'),
    kind: 'layer',
    name: 'Plasma',
    enabled: true,
    source: { type: 'core.plasma', params: { scale: 8, speed: 6 } },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
  });
  return doc;
}

/** A single empty raster layer (no asset yet) ready for stroke tests. */
function rasterDocument(): DocumentJSON {
  const doc = emptyDocument(64, 64);
  doc.layers.push({
    id: layerId('raster1'),
    kind: 'layer',
    name: 'Raster',
    enabled: true,
    source: { type: 'core.raster', params: {} },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
  });
  return doc;
}

/** rect object at doc (10,10)-(30,25): a 20x15 red rect anchored top-left,
 * over a dark background, so a readback can sample well inside vs. outside. */
function sceneDocument(): { doc: DocumentJSON; layer: string; object: string } {
  const doc = emptyDocument(64, 64);
  const sceneLayerId = layerId('scene1');
  const object = objectId('rect1');
  doc.layers.push({
    id: layerId('bg1'),
    kind: 'layer',
    name: 'Background',
    enabled: true,
    source: { type: 'core.solid', params: { color: [0.15, 0, 0, 1] } },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'live',
  });
  const rect: ObjectNode = createObject({
    id: object,
    name: 'Rect',
    content: { type: 'shape', shape: { shape: 'rect', width: 20, height: 15 } },
    style: { fill: [0.62796, 0.22486, 0.12585, 1] }, // sRGB red -> OKLab, per goldDocument's note
    transform: { x: 10, y: 10, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 },
  });
  doc.layers.push({
    id: sceneLayerId,
    kind: 'layer',
    name: 'Scene',
    enabled: true,
    // See document.ts's module doc comment: ObjectNode[] is a structurally
    // valid ParamValue but TypeScript has no union member saying so.
    source: { type: 'core.scene', params: { scene: [rect] as unknown as import('./params/schema').ParamValue } },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'live',
  });
  return { doc, layer: sceneLayerId, object };
}

// FX-BLENDGEN block (own this block; see gdesign-wt/blendgen).

/** base (bottom) + src (top, given blend mode, opacity 1), both full-canvas
 * solid layers, so the composited centre pixel equals blend(base, src)
 * exactly (src.a=1 means porter_duff_over degenerates to "just src"). */
function blendTestDocument(
  blendMode: string,
  base: [number, number, number, number],
  src: [number, number, number, number],
): DocumentJSON {
  const doc = emptyDocument(64, 64);
  doc.layers.push({
    id: layerId('base'),
    kind: 'layer',
    name: 'Base',
    enabled: true,
    source: { type: 'core.solid', params: { color: base } },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'live',
  });
  doc.layers.push({
    id: layerId('src'),
    kind: 'layer',
    name: 'Src',
    enabled: true,
    source: { type: 'core.solid', params: { color: src } },
    chain: [],
    blendMode,
    opacity: 1,
    transform: identityTransform(),
    liveness: 'live',
  });
  return doc;
}

function noiseDocument(opts: {
  mode?: string;
  scale?: number;
  speed?: number;
  seed?: number;
  colorA?: [number, number, number, number];
  colorB?: [number, number, number, number];
} = {}): DocumentJSON {
  const doc = emptyDocument(64, 64);
  doc.layers.push({
    id: layerId('noise1'),
    kind: 'layer',
    name: 'Noise',
    enabled: true,
    source: {
      type: 'core.noise',
      params: {
        mode: opts.mode ?? 'fbm',
        scale: opts.scale ?? 4,
        speed: opts.speed ?? 0.5,
        seed: opts.seed ?? 0,
        colorA: opts.colorA ?? [0.6, 0.15, -0.05, 1],
        colorB: opts.colorB ?? [0.2, -0.05, 0.1, 1],
      },
    },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'live',
  });
  return doc;
}

/** Solid base layer (bottom) + a core.feedback layer above it, normal blend
 * at opacity 1. `baseOpacity` matters. See loadFeedback's doc comment on
 * the window.__engineTest interface above (a fully opaque base leaves the
 * feedback layer's trail no memory to accumulate). */
function feedbackDocument(opts: {
  base?: [number, number, number, number];
  baseOpacity?: number;
  zoom?: number;
  rotate?: number;
  translate?: [number, number];
  fade?: number;
  hueShift?: number;
} = {}): { doc: DocumentJSON; baseLayer: string; feedbackLayer: string } {
  const doc = emptyDocument(64, 64);
  const baseLayer = layerId('base');
  const feedbackLayer = layerId('feedback1');
  doc.layers.push({
    id: baseLayer,
    kind: 'layer',
    name: 'Base',
    enabled: true,
    source: { type: 'core.solid', params: { color: opts.base ?? [0.6, 0.1, 0.05, 1] } },
    chain: [],
    blendMode: 'normal',
    opacity: opts.baseOpacity ?? 1,
    transform: identityTransform(),
    liveness: 'live',
  });
  doc.layers.push({
    id: feedbackLayer,
    kind: 'layer',
    name: 'Feedback',
    enabled: true,
    source: {
      type: 'core.feedback',
      params: {
        zoom: opts.zoom ?? 1.0,
        rotate: opts.rotate ?? 0,
        translate: opts.translate ?? [0, 0],
        fade: opts.fade ?? 0.9,
        hueShift: opts.hueShift ?? 0,
      },
    },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'live',
  });
  return { doc, baseLayer, feedbackLayer };
}
// end FX-BLENDGEN block

const ready = host.init(canvas).then(() => undefined);

/**
 * core.text needs its atlas to load asynchronously before it renders
 * anything but transparent; this waits a few frames so Playwright specs
 * don't have to hand-roll polling. Placed at the end of the file (rather
 * than a new module) to keep this shared harness a single small diff
 * surface: p2-sources also edits this file.
 */
function textDocument(
  text: string,
  opts: { size?: number; color?: [number, number, number, number]; x?: number; y?: number; bg?: [number, number, number, number] } = {},
): DocumentJSON {
  const doc = emptyDocument(128, 64);
  doc.layers.push({
    id: layerId('bg'),
    kind: 'layer',
    name: 'Background',
    enabled: true,
    source: { type: 'core.solid', params: { color: opts.bg ?? [0.2, 0, 0, 1] } },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
  });
  doc.layers.push({
    id: layerId('text'),
    kind: 'layer',
    name: 'Text',
    enabled: true,
    source: {
      type: 'core.text',
      params: {
        text,
        size: opts.size ?? 48,
        color: opts.color ?? [0.9, 0, 0, 1],
        x: opts.x ?? 4,
        y: opts.y ?? 4,
      },
    },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
  });
  return doc;
}

/**
 * core.3d over a fully transparent canvas (no background layer), so
 * "background stays alpha 0" is trivially checkable straight off the
 * source's own output. `chain` lets p3-3d's spec exercise a layer chain
 * (e.g. core.dither) on top of the 3D render like any other source.
 */
function threeDDocument(opts: {
  model?: string;
  spin?: number;
  fov?: number;
  distance?: number;
  colorA?: [number, number, number, number];
  colorB?: [number, number, number, number];
  light?: [number, number, number];
  chain?: { pass: string; params?: ParamValues }[];
} = {}): DocumentJSON {
  const doc = emptyDocument(64, 64);
  doc.layers.push({
    id: layerId('threed1'),
    kind: 'layer',
    name: '3D',
    enabled: true,
    source: {
      type: 'core.3d',
      params: {
        model: opts.model ?? 'cube',
        spin: opts.spin ?? 0.5,
        fov: opts.fov ?? 50,
        distance: opts.distance ?? 3,
        colorA: opts.colorA ?? [0.75, 0.09, 0.12, 1],
        colorB: opts.colorB ?? [0.55, -0.02, -0.16, 1],
        light: opts.light ?? [0.5, 0.8, 0.3],
      },
    },
    chain: (opts.chain ?? []).map((c, i) => ({ id: `fx${i}`, pass: c.pass, params: c.params ?? {}, enabled: true })),
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
  });
  return doc;
}

window.__engineTest = {
  host,
  ready,
  async loadGold() {
    await host.loadDocument(goldDocument());
  },
  async loadText(text, opts) {
    await host.loadDocument(textDocument(text, opts));
    // Atlas fetch is async; re-request a few frames so it has time to land.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 50));
      host.requestFrame();
    }
  },
  async loadPlasma() {
    await host.loadDocument(plasmaDocument());
  },
  async loadRaster() {
    await host.loadDocument(rasterDocument());
  },
  async loadThreeD(opts) {
    await host.loadDocument(threeDDocument(opts));
  },
  async loadScene() {
    const { doc, layer, object } = sceneDocument();
    await host.loadDocument(doc);
    return { layer, object };
  },
  // FX-BLENDGEN block (own this block; see gdesign-wt/blendgen).
  async loadBlendTest(blendMode, base, src) {
    await host.loadDocument(blendTestDocument(blendMode, base, src));
  },
  async loadNoise(opts) {
    await host.loadDocument(noiseDocument(opts));
  },
  async loadFeedback(opts) {
    const { doc, baseLayer, feedbackLayer } = feedbackDocument(opts);
    await host.loadDocument(doc);
    return { baseLayer, feedbackLayer };
  },
  // end FX-BLENDGEN block
  mediabunny,
};
