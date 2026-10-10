import { createRegistry, type Registry } from './registry';
import type { SourceDescriptor } from '../sources/source';

export const sources: Registry<SourceDescriptor> = createRegistry<SourceDescriptor>('source');
