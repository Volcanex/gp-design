import { createRegistry, type Registry } from './registry';
import type { PassDescriptor } from '../passes/pass';

export const effects: Registry<PassDescriptor> = createRegistry<PassDescriptor>('effect');
