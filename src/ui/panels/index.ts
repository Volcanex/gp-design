/** Panel registry: every pane the shell docks. Styles live in styles/panels.css. */

import type { AppCtx, PanelHost } from '../../app/types';
import { toolsPanel } from './tools';
import { historyPanel } from './history';
import { layersPanel } from './layers';
import { colorsPanel } from './colors';
import { effectsPanel } from './effects';

/** Pane hosts in the order the shell may ask for them; the shell decides
 * where each one docks (stores.ts's PANE_ORDER, `tools` is the rail). */
export function allPanels(_app: AppCtx): PanelHost[] {
  return [toolsPanel, historyPanel, layersPanel, colorsPanel, effectsPanel];
}
