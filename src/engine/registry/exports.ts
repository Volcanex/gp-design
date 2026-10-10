import { createRegistry, type Registry, type ExportTargetDef } from './registry';

export const exportTargets: Registry<ExportTargetDef> = createRegistry<ExportTargetDef>('export target');
