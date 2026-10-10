/**
 * LayerNode factories. Groups have no source/transform/liveness/baked:
 * that's the Layer/LayerGroup split in doc/json.ts, not an omission here.
 */

import type { LayerId } from '../core/types';
import { identityTransform } from '../core/types';
import type { Chain } from '../passes/chain';
import type { ParamValue, ParamValues } from '../params/schema';
import type { Layer, LayerGroup, LayerNode, BakedClip } from './json';

export interface CreateLayerPartial {
  id: LayerId;
  name: string;
  source: { type: string; params: ParamValues };
  chain?: Chain;
  blendMode?: string;
  opacity?: ParamValue;
  transform?: ReturnType<typeof identityTransform>;
  enabled?: boolean;
  baked?: BakedClip;
}

export function createLayer(partial: CreateLayerPartial, liveness: 'live' | 'baked' = 'live'): Layer {
  const layer: Layer = {
    id: partial.id,
    kind: 'layer',
    name: partial.name,
    enabled: partial.enabled ?? true,
    source: partial.source,
    chain: partial.chain ?? [],
    blendMode: partial.blendMode ?? 'normal',
    opacity: partial.opacity ?? 1,
    transform: partial.transform ?? identityTransform(),
    liveness,
  };
  if (partial.baked) layer.baked = partial.baked;
  return layer;
}

export interface CreateGroupPartial {
  id: LayerId;
  name: string;
  children?: LayerNode[];
  chain?: Chain;
  blendMode?: string;
  opacity?: ParamValue;
  enabled?: boolean;
}

export function createGroup(partial: CreateGroupPartial): LayerGroup {
  return {
    id: partial.id,
    kind: 'group',
    name: partial.name,
    enabled: partial.enabled ?? true,
    children: partial.children ?? [],
    chain: partial.chain ?? [],
    blendMode: partial.blendMode ?? 'normal',
    opacity: partial.opacity ?? 1,
  };
}
