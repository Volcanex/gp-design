/**
 * FROZEN CONTRACT companion: runChain owns ping-pong for Chain (a layer's
 * effect stack, a group's post, the document's postChain). A pass's input
 * is never its attachment: every step borrows a fresh scratch buffer.
 */

import type { Chain } from './chain';
import type { PooledBuffer } from '../gpu/pool';
import type { FrameContext } from '../sources/source';
import { effects } from '../registry/effects';
import { resolveParams } from '../params/resolve';

export function runChain(chain: Chain, input: PooledBuffer, ctx: FrameContext): PooledBuffer {
  if (chain.length === 0) return input;

  let current = input;
  for (const inst of chain) {
    if (!inst.enabled) continue;

    const desc = effects.require(inst.pass);
    const params = resolveParams(desc.params, inst.params, ctx.time);
    const wrap = desc.metadata.colorSpace === 'rgb';

    let src = current;
    if (wrap) {
      const toRgb = effects.get('core.to-rgb');
      if (!toRgb) {
        throw new Error(`runChain: pass '${inst.pass}' declares colorSpace 'rgb' but core.to-rgb is not registered`);
      }
      const rgbBuf = ctx.borrowScratch(current);
      ctx.runPass('core.to-rgb', [current], {}, rgbBuf);
      src = rgbBuf;
    }

    if (desc.expand) {
      // Macro branch: run each registered sub-pass in turn. 'orig' always
      // means this macro's own input (post-wrap); 'prev' means the previous
      // sub-step's output, defaulting to the macro's input for the first
      // sub-step. Same ping-pong invariant, checked per sub-step.
      const orig = src;
      let prev = src;
      for (const step of desc.expand(params)) {
        const inputTags = step.inputs ?? ['prev'];
        const inputs = inputTags.map((tag) => (tag === 'orig' ? orig : prev));
        const target = ctx.borrowScratch(current);
        if (inputs.some((buf) => buf.view === target.view)) {
          throw new Error(`runChain: ping-pong invariant violated: '${step.pass}' (macro '${inst.pass}') input aliases its target`);
        }
        ctx.runPass(step.pass, inputs, step.params, target);
        prev = target;
      }
      current = prev;
    } else {
      const target = ctx.borrowScratch(current);
      if (target.view === src.view) {
        throw new Error(`runChain: ping-pong invariant violated: '${inst.pass}' input aliases its target`);
      }
      ctx.runPass(inst.pass, [src], params, target);
      current = target;
    }

    if (wrap) {
      const fromRgb = effects.get('core.from-rgb');
      if (!fromRgb) {
        throw new Error(`runChain: pass '${inst.pass}' declares colorSpace 'rgb' but core.from-rgb is not registered`);
      }
      const labBuf = ctx.borrowScratch(current);
      ctx.runPass('core.from-rgb', [current], {}, labBuf);
      current = labBuf;
    }
  }
  return current;
}
