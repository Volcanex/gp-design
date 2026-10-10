/**
 * MockEngineHost: full EngineHost facade over a 2D canvas, so every UI
 * workstream runs and tests without the real engine. Solid-colour layers
 * render; effects are no-ops but carry REAL params schemas so forms and
 * menus are exercised for real. Swapped for createLocalEngineHost at
 * Phase 2 integration; nothing outside main.ts should know which is live.
 *
 * Inverse-edit semantics here mirror the contract the real engine
 * implements (applyEdits returns inverse edits in reverse order).
 */

import type { EngineHost } from '../../engine/host/EngineHost';
import type {
  BlendMeta, BurnRequest, BurnResult, ClockCommand, DocEdit, EffectMeta,
  EngineEvent, EngineEventType, ExportRequest, ExportResult, HitResult,
  ReadbackRequest, ReadbackResult, SourceMeta, StrokeConfig, StrokePoint,
} from '../../engine/host/protocol';
import type { DocumentJSON, Layer, LayerNode } from '../../engine/doc/json';
import { emptyDocument } from '../../engine/doc/json';
import type { EngineCaps, LayerId, Seconds } from '../../engine/core/types';
import { wrapLoopTime } from '../../engine/core/loop';
import type { PassDescriptor } from '../../engine/passes/pass';
import { oklabToSrgbCss } from './mock-color';

const MOCK_EFFECTS: EffectMeta[] = [
  {
    id: 'core.exposure', label: 'Exposure', category: 'adjustment',
    menuPath: 'Adjustments/Exposure',
    params: {
      exposure: { kind: 'float', default: 0, min: -4, max: 4, step: 0.01, unit: 'EV', animatable: true, label: 'Exposure' },
    },
  },
  {
    id: 'core.dither-bluenoise', label: 'Blue-noise Dither', category: 'look',
    menuPath: 'Effects/Dither',
    params: {
      levels: { kind: 'int', default: 8, min: 2, max: 256, label: 'Levels' },
      amount: { kind: 'float', default: 1, min: 0, max: 1, step: 0.01, animatable: true, label: 'Amount' },
      mode: { kind: 'enum', default: 'per-channel', options: ['per-channel', 'palette'], label: 'Mode' },
    },
  },
];

export function createMockEngineHost(): EngineHost {
  let doc: DocumentJSON = emptyDocument();
  let canvas: HTMLCanvasElement | null = null;
  let playing = false;
  let time = 0;
  let frame = 0;
  let raf = 0;
  let loopRange: { from: Seconds; to: Seconds } | undefined;
  const listeners = new Map<EngineEventType, Set<(e: EngineEvent) => void>>();
  const registered: EffectMeta[] = [...MOCK_EFFECTS];

  const emit = (e: EngineEvent) => listeners.get(e.type)?.forEach((cb) => cb(e));

  function findLayer(nodes: LayerNode[], id: string): { node: LayerNode; parent: LayerNode[] } | null {
    for (const node of nodes) {
      if (node.id === id) return { node, parent: nodes };
      if (node.kind === 'group') {
        const hit = findLayer(node.children, id);
        if (hit) return hit;
      }
    }
    return null;
  }

  function applyOne(edit: DocEdit): DocEdit | null {
    switch (edit.op) {
      case 'addLayer': {
        const siblings = edit.parent
          ? (findLayer(doc.layers, edit.parent)?.node as { children: LayerNode[] })?.children
          : doc.layers;
        if (!siblings) return null;
        siblings.splice(edit.index, 0, edit.layer);
        return { op: 'removeLayer', id: edit.layer.id };
      }
      case 'removeLayer': {
        const hit = findLayer(doc.layers, edit.id);
        if (!hit) return null;
        const index = hit.parent.indexOf(hit.node);
        hit.parent.splice(index, 1);
        return { op: 'addLayer', parent: null, index, layer: hit.node };
      }
      case 'reorderLayer': {
        const hit = findLayer(doc.layers, edit.id);
        if (!hit) return null;
        const from = hit.parent.indexOf(hit.node);
        hit.parent.splice(from, 1);
        doc.layers.splice(edit.index, 0, hit.node);
        return { op: 'reorderLayer', id: edit.id, parent: null, index: from };
      }
      case 'setBlend': {
        const hit = findLayer(doc.layers, edit.id);
        if (!hit) return null;
        const prev = (hit.node as Layer).blendMode;
        (hit.node as Layer).blendMode = edit.mode;
        return { op: 'setBlend', id: edit.id, mode: prev };
      }
      case 'setOpacity': {
        const hit = findLayer(doc.layers, edit.id);
        if (!hit) return null;
        const prev = (hit.node as Layer).opacity;
        (hit.node as Layer).opacity = edit.value;
        return { op: 'setOpacity', id: edit.id, value: prev };
      }
      case 'setEnabled': {
        const hit = findLayer(doc.layers, edit.id as LayerId);
        if (!hit) return null;
        const prev = hit.node.enabled;
        hit.node.enabled = edit.enabled;
        return { op: 'setEnabled', id: edit.id, enabled: prev };
      }
      case 'renameNode': {
        const hit = findLayer(doc.layers, edit.id as LayerId);
        if (!hit) return null;
        const prev = hit.node.name;
        hit.node.name = edit.name;
        return { op: 'renameNode', id: edit.id, name: prev };
      }
      case 'setParam': {
        if (edit.target.kind !== 'layer') return null;
        const hit = findLayer(doc.layers, edit.target.id);
        if (!hit || hit.node.kind !== 'layer') return null;
        const prev = hit.node.source.params[edit.key];
        hit.node.source.params[edit.key] = edit.value;
        return prev === undefined
          ? null
          : { op: 'setParam', target: edit.target, key: edit.key, value: prev };
      }
      default:
        return null;
    }
  }

  function render() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#131316';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const drawNodes = (nodes: LayerNode[]) => {
      for (const node of nodes) {
        if (!node.enabled) continue;
        if (node.kind === 'group') { drawNodes(node.children); continue; }
        const opacity = typeof node.opacity === 'number' ? node.opacity : 1;
        ctx.globalAlpha = opacity;
        const color = node.source.params['color'];
        ctx.fillStyle = Array.isArray(color)
          ? oklabToSrgbCss(color as number[])
          : `hsl(${(hash(node.id) % 360)}, 60%, 55%)`;
        ctx.fillRect(0, 0, canvas!.width, canvas!.height);
      }
    };
    drawNodes(doc.layers);
    ctx.globalAlpha = 1;
    frame += 1;
    emit({ type: 'frame', time, frame });
  }

  function tick() {
    if (!playing) return;
    time += 1 / doc.clock.fps;
    time = wrapLoopTime(time, loopRange);
    render();
    emit({ type: 'clock', playing, time });
    raf = requestAnimationFrame(tick);
  }

  return {
    async init(target) {
      canvas = target as HTMLCanvasElement;
      const caps: EngineCaps = {
        adapterInfo: { vendor: 'mock', architecture: 'canvas2d' },
        float16Renderable: true,
        float32Filterable: false,
        timestampQueries: false,
        preferredCanvasFormat: 'bgra8unorm',
        displayP3: false,
      };
      emit({ type: 'caps', caps });
      render();
      return caps;
    },
    async dispose() {
      cancelAnimationFrame(raf);
      canvas = null;
    },
    async loadDocument(next) {
      doc = next;
      render();
    },
    getDocument: () => doc,
    applyEdits(edits) {
      const inverses: DocEdit[] = [];
      for (const edit of edits) {
        const inv = applyOne(edit);
        if (inv) inverses.unshift(inv);
      }
      emit({ type: 'document-changed', edits, origin: 'ui' });
      render();
      return inverses;
    },
    setClock(cmd: ClockCommand) {
      if (cmd.cmd === 'play') { playing = true; raf = requestAnimationFrame(tick); }
      if (cmd.cmd === 'pause') { playing = false; cancelAnimationFrame(raf); }
      if (cmd.cmd === 'seek') { time = cmd.time; render(); }
      if (cmd.cmd === 'setFps') doc.clock.fps = cmd.fps;
      if (cmd.cmd === 'setLoop') loopRange = cmd.range;
      emit({ type: 'clock', playing, time });
    },
    requestFrame: render,
    invalidateAsset: () => {},
    beginStroke(_config: StrokeConfig) {},
    strokePoint(_p: StrokePoint) {},
    async endStroke() { return []; },
    async burn(_req: BurnRequest): Promise<BurnResult> { return { edits: [] }; },
    async export(_req: ExportRequest): Promise<ExportResult> {
      return { mime: 'image/png', data: new ArrayBuffer(0), fileName: 'mock.png' };
    },
    async readback(req: ReadbackRequest): Promise<ReadbackResult> {
      if (!canvas) return { width: 0, height: 0, data: new ArrayBuffer(0), via: 'quantised' };
      const ctx = canvas.getContext('2d')!;
      const region = req.region ?? { x: 0, y: 0, width: canvas.width, height: canvas.height };
      const img = ctx.getImageData(region.x, region.y, region.width, region.height);
      return { width: region.width, height: region.height, data: img.data.buffer, via: 'quantised' };
    },
    async hitTest(): Promise<HitResult> { return { layer: null, object: null }; },
    registerEffect(desc: PassDescriptor) {
      registered.push({
        id: desc.id, label: desc.label, category: desc.metadata.category,
        menuPath: desc.metadata.menuPath, params: desc.params,
      });
    },
    listEffects: () => [...registered],
    listSources: (): SourceMeta[] => [
      {
        id: 'core.solid', label: 'Solid Colour', liveByDefault: false,
        params: { color: { kind: 'color', default: [0.6, 0.1, -0.05, 1], space: 'oklab', label: 'Colour' } },
      },
    ],
    listBlendModes: (): BlendMeta[] => [
      { id: 'normal', label: 'Normal' },
      { id: 'multiply', label: 'Multiply' },
      { id: 'screen', label: 'Screen' },
      { id: 'overlay', label: 'Overlay' },
    ],
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => listeners.get(event)!.delete(cb);
    },
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
