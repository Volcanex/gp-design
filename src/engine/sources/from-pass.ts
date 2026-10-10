import type { SourceFromPass, SourceDescriptor, SourceInstance, SourceCreateContext } from './source';
import { effects } from '../registry/effects';

/**
 * SourceFromPass's signature is frozen to `(pass) => SourceDescriptor`: it
 * can't take a `liveByDefault` override per call. All pass-wrapped sources
 * are cheap, stateless, and recomputed every frame anyway, so `true` is the
 * sensible universal default here ("plasma yes"); `core.image` doesn't use
 * this helper precisely because it needs `liveByDefault: false` and holds
 * real per-instance GPU state (a decoded upload), so it's a hand-written
 * SourceDescriptor instead.
 */
export const sourceFromPass: SourceFromPass = (pass) => {
  if (!effects.get(pass.id)) {
    effects.register(pass);
  }

  const descriptor: SourceDescriptor = {
    id: pass.id,
    label: pass.label,
    params: pass.params,
    liveByDefault: true,
    create(_ctx: SourceCreateContext): SourceInstance {
      return {
        render(ctx, params, target) {
          ctx.runPass(pass.id, [], params, target);
        },
      };
    },
  };

  return descriptor;
};
