import { createRegistry, type Registry, type BlendModeDef } from './registry';

export const blends: Registry<BlendModeDef> = createRegistry<BlendModeDef>('blend mode');
