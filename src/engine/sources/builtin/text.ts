import type { SourceDescriptor, SourceInstance, SourceCreateContext, FrameContext } from '../source';
import type { ResolvedParams } from '../../params/schema';
import type { PooledBuffer } from '../../gpu/pool';
import { createTextGpu } from './text-gpu';

/**
 * Design note (schema-less free-string param): ParamSpec has no 'string'
 * kind, but ParamValue's union does include `string`, so a plain string is
 * a legal, JSON/structuredClone-safe value to store at
 * `layer.source.params.text` even though it isn't declared in this
 * descriptor's ParamsSchema. resolveParams() previously dropped any key
 * not in the schema when building ResolvedParams (it only iterated
 * Object.keys(schema)). Fixed in params/resolve.ts to also pass through
 * schema-less keys verbatim, so 'text' now survives into what render()
 * receives. The UI's params-form only renders keys present in the schema
 * (confirmed: it maps Object.entries(schema), never the stored value
 * object), so 'text' is simply invisible to the auto-generated form today,
 * harmless until a real text-editing UI exists, but worth flagging: a
 * future 'string' ParamSpec kind would let this go through the same
 * resolve/pack/UI path as everything else instead of a side channel.
 *
 * GPU implementation: the MSDF atlas/pipeline/glyph-geometry machinery lives
 * in text-gpu.ts (extracted so core.scene's text objects can reuse it inside
 * an already-open render pass). This descriptor is now just a thin
 * SourceInstance wrapper: one TextGpu, one own render pass per render(),
 * anchor pinned at the pen origin (this source's `x`/`y` params ARE the pen
 * position, unlike an ObjectNode's anchor-relative transform).
 */
export interface TextParams extends ResolvedParams {
  size: number;
  color: readonly [number, number, number, number];
  x: number;
  y: number;
}

function clearOnly(_device: GPUDevice, encoder: GPUCommandEncoder, target: PooledBuffer): void {
  const rp = encoder.beginRenderPass({
    colorAttachments: [{ view: target.view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
  });
  rp.end();
}

export const text: SourceDescriptor = {
  id: 'core.text',
  label: 'Text',
  params: {
    size: { kind: 'float', default: 64, min: 8, max: 512 },
    color: { kind: 'color', default: [1, 0, 0, 1], space: 'oklab' },
    x: { kind: 'float', default: 0 },
    y: { kind: 'float', default: 0 },
  },
  liveByDefault: false,
  create(ctx: SourceCreateContext): SourceInstance {
    const gpu = createTextGpu(ctx.device);

    return {
      render(frameCtx: FrameContext, params: ResolvedParams, target: PooledBuffer) {
        if (!gpu.isReady()) {
          clearOnly(frameCtx.device, frameCtx.encoder, target);
          return;
        }

        const p = params as unknown as TextParams;
        const str = (params.text as string | undefined) ?? '';

        const rp = frameCtx.encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
        });
        gpu.draw(rp, target.key.width, target.key.height, str, {
          translate: [p.x, p.y],
          anchorLocal: [0, 0],
          size: p.size,
          color: p.color,
        });
        rp.end();
      },
      dispose() {
        gpu.dispose();
      },
    };
  },
};
