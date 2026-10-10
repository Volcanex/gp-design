import type { SourceDescriptor, SourceInstance, SourceCreateContext, FrameContext } from '../source';
import type { ResolvedParams } from '../../params/schema';
import type { PooledBuffer } from '../../gpu/pool';
import type { AssetRef } from '../../core/types';
import type { AssetJSON } from '../../doc/json';
import type { PassDescriptor } from '../../passes/pass';
import { effects } from '../../registry/effects';
import { decodeImageAsset, createPlaceholderTexture, type DecodedTexture } from '../../core/image-decode';

/**
 * ctx.getAsset() hands back the raw DocumentJSON.assets entry (AssetJSON),
 * not a decoded bitmap. Encode/decode is this source's own job, via
 * core/image-decode.ts (shared with core.scene's image objects). Decoding is
 * async, so a placeholder is served until it lands (and forever, if the
 * asset is missing/wrong-type/undecodable: a bad or absent asset must
 * never fail a frame).
 */

const imageBlitPass: PassDescriptor = {
  id: 'core.image.blit',
  label: 'Image (internal)',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let s = textureSample(input0, samp0, in.uv);
  return vec4f(linear_srgb_to_oklab(srgb_decode(s.rgb)), s.a);
}
`,
  includes: ['oklab', 'srgb'],
  inputs: [{ name: 'input0' }],
  params: {},
  metadata: { category: 'core', description: 'Uploaded image (sRGB) -> OKLab.' },
};

if (!effects.get(imageBlitPass.id)) {
  effects.register(imageBlitPass);
}

/**
 * Wraps a raw uploaded GPUTexture as a PooledBuffer so it can be passed to
 * FrameContext.runPass (which only accepts pool-shaped inputs; a frozen
 * contract, source.ts). This buffer is never borrowed from or returned to
 * BufferPool; its lifetime is owned by this source instance and torn down
 * in dispose(), so a synthetic generation of 0 is fine: it's never
 * checked against pool state.
 */
function wrapAsPooledBuffer(texture: GPUTexture, view: GPUTextureView): PooledBuffer {
  return {
    texture,
    view,
    key: { width: texture.width, height: texture.height, format: texture.format, usage: texture.usage },
    generation: 0,
  };
}

export const image: SourceDescriptor = {
  id: 'core.image',
  label: 'Image',
  params: {
    asset: { kind: 'asset', assetType: 'image' },
  },
  liveByDefault: false,
  create(ctx: SourceCreateContext): SourceInstance {
    let uploaded: (DecodedTexture & { assetId: string }) | null = null;
    let placeholder: DecodedTexture | null = null;
    let decodingFor: string | null = null;
    let warnedFor: string | null = null;

    function ensurePlaceholder() {
      if (!placeholder) placeholder = createPlaceholderTexture(ctx.device);
      return placeholder;
    }

    function beginDecode(assetId: string, asset: Extract<AssetJSON, { type: 'image' }>) {
      if (decodingFor === assetId) return;
      decodingFor = assetId;
      decodeImageAsset(ctx.device, asset)
        .then((decoded) => {
          const prev = uploaded;
          uploaded = { assetId, ...decoded };
          if (prev) prev.texture.destroy();
        })
        .catch((err) => console.warn(`core.image: decode failed for asset "${assetId}"`, err))
        .finally(() => {
          if (decodingFor === assetId) decodingFor = null;
        });
    }

    /** Never throws: a missing/wrong-type/undecodable asset renders the
     * placeholder (transparent) and warns once instead of killing the frame. */
    function ensureUploaded(assetRef: AssetRef) {
      if (uploaded && uploaded.assetId === assetRef.asset) return uploaded;

      const asset = ctx.getAsset(assetRef.asset) as AssetJSON | undefined;
      if (!asset || asset.type !== 'image') {
        if (warnedFor !== assetRef.asset) {
          warnedFor = assetRef.asset;
          console.warn(
            asset
              ? `core.image: asset "${assetRef.asset}" has type "${asset.type}", expected "image"`
              : `core.image: asset "${assetRef.asset}" missing from document`,
          );
        }
        return ensurePlaceholder();
      }
      warnedFor = null;
      beginDecode(assetRef.asset, asset);
      return uploaded ?? ensurePlaceholder();
    }

    return {
      render(frameCtx: FrameContext, params: ResolvedParams, target: PooledBuffer) {
        const assetRef = params.asset as AssetRef;
        const { texture, view } = ensureUploaded(assetRef);
        frameCtx.runPass(imageBlitPass.id, [wrapAsPooledBuffer(texture, view)], {}, target);
      },
      dispose() {
        uploaded?.texture.destroy();
        uploaded = null;
        placeholder?.texture.destroy();
        placeholder = null;
      },
    };
  },
};
