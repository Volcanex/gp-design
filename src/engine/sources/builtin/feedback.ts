import type { SourceDescriptor, SourceInstance, SourceCreateContext, FrameContext } from '../source';
import type { ResolvedParams } from '../../params/schema';
import type { PooledBuffer } from '../../gpu/pool';
import { WORKING_FORMAT } from '../../gpu/pool';
import type { PassDescriptor } from '../../passes/pass';
import { effects } from '../../registry/effects';

/**
 * core.feedback: composited trails of everything below this layer, decaying
 * over time. `wantsBackdrop: true` (sources/source.ts's additive diff,
 * 2026-07-07, architect-approved) gets engine.ts's renderNodes to call
 * `setBackdrop()` with the current accumulator (everything below this
 * layer, already composited, for THIS FRAME ONLY) just before this layer
 * renders. render() transforms its own persistent prior capture
 * (zoom/rotate/translate/hueShift) and fades ONLY its alpha (not L, see
 * below), composites this frame's backdrop ON TOP of that faded trail
 * ("trails-under": fresh content stays crisp, history decays behind it,
 * the chosen default; see porter_duff_over below), and copies the result
 * into its own persistent ping-pong texture for next frame's trail. First
 * frame (empty prior capture) reduces to just the backdrop; a layer with no
 * backdrop this frame (nothing below it, or setBackdrop somehow not called)
 * falls back to pure self-echo of its own trail via the same code path.
 * See ensureBackdropInput's placeholder.
 *
 * `fade` decays the trail's ALPHA only, not its recorded L/chroma: a pixel
 * with straight alpha keeps its true recorded color regardless of opacity
 * (Porter-Duff `over` is a no-op on `src`'s own color), so decaying L too
 * would darken the *next* re-composite instead of letting the trail
 * dissolve away, the wrong direction for "fade". Decaying alpha alone
 * already dims the trail's PREMULTIPLIED (visual) brightness, which is what
 * a viewer or a `L * alpha` readback actually sees converge, the property
 * tests/e2e/blendgen.spec.ts's accumulation/decay proof exercises.
 *
 * The transform pass is registered into the `effects` registry by hand
 * with no `menuPath` (mirrors core.image's internal blit pass in image.ts)
 * so it never appears in the Effects menu.
 */
const feedbackPass: PassDescriptor = {
  id: 'core.feedback',
  label: 'Feedback (internal)',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let centered = in.uv - vec2f(0.5);
  let c = cos(-params.rotate);
  let s = sin(-params.rotate);
  let rotated = vec2f(c * centered.x - s * centered.y, s * centered.x + c * centered.y);
  let scaled = rotated / max(params.zoom, 0.0001);
  let sourcePos = scaled - params.translate;
  let sampleUv = sourcePos + vec2f(0.5);

  // textureSample must run in UNIFORM control flow: WGSL rejects calling
  // it inside an if-block whose condition depends on a per-pixel value
  // like sampleUv (a real compile error, not a lint: the shader module
  // fails to build, every pass using it silently renders all-zero; see
  // this repo's CLAUDE.md "a shader compile error does not throw" gotcha).
  // Sample unconditionally (clamped so the coordinate itself is always
  // valid) and mask the out-of-bounds case afterward with select() instead.
  let inBounds = sampleUv.x >= 0.0 && sampleUv.x <= 1.0 && sampleUv.y >= 0.0 && sampleUv.y <= 1.0;
  var c4 = textureSample(input0, samp0, clamp(sampleUv, vec2f(0.0), vec2f(1.0)));
  c4 = select(vec4f(0.0, 0.0, 0.0, 0.0), c4, inBounds);
  // fade decays alpha only (see the module doc comment on why L stays).
  c4.a = c4.a * params.fade;
  let hc = cos(params.hueShift);
  let hs = sin(params.hueShift);
  let ab = vec2f(hc * c4.y - hs * c4.z, hs * c4.y + hc * c4.z);
  let trail = vec4f(c4.x, ab.x, ab.y, c4.a);

  // trails-under: fresh backdrop content stays crisp on top; wherever the
  // backdrop is transparent, the faded/transformed trail shows through.
  let backdrop = textureSample(input1, samp1, in.uv);
  return porter_duff_over(trail, backdrop);
}
`,
  includes: ['blend'],
  inputs: [{ name: 'input0' }, { name: 'input1' }],
  params: {
    zoom: { kind: 'float', default: 1.02, min: 0.5, max: 2, step: 0.001, animatable: true },
    rotate: { kind: 'float', default: 0, min: -3.14159, max: 3.14159, step: 0.001, animatable: true },
    translate: { kind: 'vec2', default: [0, 0], min: -1, max: 1, animatable: true },
    fade: { kind: 'float', default: 0.9, min: 0, max: 1, step: 0.001, animatable: true },
    hueShift: { kind: 'float', default: 0, min: -3.14159, max: 3.14159, step: 0.001, animatable: true },
  },
  metadata: { category: 'core', description: 'Transforms+fades a persistent prior-frame trail, then composites the current backdrop over it (internal, see core.feedback source).' },
};

if (!effects.get(feedbackPass.id)) {
  effects.register(feedbackPass);
}

/** Wraps a raw persistent GPUTexture as a PooledBuffer for runPass, never
 * borrowed from/returned to BufferPool, lifetime owned by this instance
 * (mirrors sources/builtin/image.ts's wrapAsPooledBuffer). */
function wrapPersistent(texture: GPUTexture, view: GPUTextureView): PooledBuffer {
  return {
    texture,
    view,
    key: { width: texture.width, height: texture.height, format: texture.format, usage: texture.usage },
    generation: 0,
  };
}

export const feedback: SourceDescriptor = {
  id: 'core.feedback',
  label: 'Feedback',
  params: feedbackPass.params,
  liveByDefault: true,
  wantsBackdrop: true,
  create(ctx: SourceCreateContext): SourceInstance {
    const device = ctx.device;

    // Ping/pong pair: each frame samples FROM one texture and copies the
    // frame's (backdrop-composited) output TO the other, so a render pass
    // never samples and writes the same texture. WebGPU zero-initializes
    // new textures, so before the first copy ever lands, sampling either
    // one yields fully transparent: "first frame = just the backdrop"
    // falls out of that for free (see the WGSL above).
    let textures: [GPUTexture, GPUTexture] | null = null;
    let views: [GPUTextureView, GPUTextureView] | null = null;
    let width = 0;
    let height = 0;
    let current = 0;

    function ensureTextures(w: number, h: number): void {
      if (textures && width === w && height === h) return;
      textures?.forEach((t) => t.destroy());
      const make = () =>
        device.createTexture({
          size: [w, h],
          format: WORKING_FORMAT,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
      const a = make();
      const b = make();
      textures = [a, b];
      views = [a.createView(), b.createView()];
      current = 0;
      width = w;
      height = h;
    }

    // setBackdrop's contract (sources/source.ts) forbids retaining the
    // reference past the render() call it precedes. Captured here and
    // cleared the instant render() reads it, never held across frames.
    let backdrop: PooledBuffer | null = null;

    // 1x1 fully-transparent fallback for the (should-be-rare) case
    // render() runs with no backdrop set this frame: reduces the shader
    // to pure self-echo of its own trail rather than crashing on a missing
    // bind-group input.
    let placeholderTexture: GPUTexture | null = null;
    let placeholderView: GPUTextureView | null = null;
    function ensureBackdropInput(): PooledBuffer {
      if (backdrop) {
        const b = backdrop;
        backdrop = null;
        return b;
      }
      if (!placeholderTexture) {
        placeholderTexture = device.createTexture({
          size: [1, 1],
          format: WORKING_FORMAT,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        placeholderView = placeholderTexture.createView();
      }
      return wrapPersistent(placeholderTexture, placeholderView!);
    }

    return {
      setBackdrop(b: PooledBuffer) {
        backdrop = b;
      },
      render(frameCtx: FrameContext, params: ResolvedParams, target: PooledBuffer) {
        ensureTextures(target.key.width, target.key.height);
        const [texA, texB] = textures!;
        const [viewA, viewB] = views!;
        const prevTexture = current === 0 ? texA : texB;
        const prevView = current === 0 ? viewA : viewB;

        frameCtx.runPass(
          feedbackPass.id,
          [wrapPersistent(prevTexture, prevView), ensureBackdropInput()],
          params,
          target,
        );

        // Copy this frame's (backdrop-composited) output into the OTHER
        // slot, never the one we just sampled from (target has COPY_SRC
        // via RENDER_TARGET_USAGE, gpu/pool.ts; our textures have COPY_DST).
        const nextTexture = current === 0 ? texB : texA;
        frameCtx.encoder.copyTextureToTexture(
          { texture: target.texture },
          { texture: nextTexture },
          [target.key.width, target.key.height],
        );
        current = 1 - current;
      },
      dispose() {
        textures?.forEach((t) => t.destroy());
        textures = null;
        views = null;
        placeholderTexture?.destroy();
        placeholderTexture = null;
      },
    };
  },
};
