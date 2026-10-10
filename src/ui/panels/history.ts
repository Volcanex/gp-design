/** History pane (F6). Click an entry to undo/redo-walk to that point. */

import { html } from 'lit-html';
import { classMap } from 'lit-html/directives/class-map.js';
import { repeat } from 'lit-html/directives/repeat.js';
import type { AppCtx, PanelHost } from '../../app/types';
import { history } from '../../app/commands/app-history';
import { icon } from '../icons';

export const historyPanel: PanelHost = {
  id: 'history',
  title: 'History',
  toggleKey: 'F6',
  defaultPosition: { corner: 'tr', x: 8, y: 8 },
  render(app: AppCtx) {
    const entries = history.entries();
    const stats = history.stats();
    const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
    return html`
      <ol class="gd-history-list" aria-label="History">
        ${repeat(
          entries,
          (_e, i) => i,
          (e, i) => html`
            <li
              class=${classMap({ 'gd-history-row': true, current: e.current })}
              data-testid="history-row"
              aria-current=${e.current ? 'step' : 'false'}
              @click=${() => history.jumpTo(app, i)}
            >
              <span class="gd-history-marker">${e.current ? icon('caret-right') : ''}</span>
              <span class="gd-history-label">${e.label}</span>
            </li>
          `,
        )}
        ${entries.length === 0 ? html`<li class="gd-history-empty">Nothing to undo yet</li>` : ''}
      </ol>
      <div class="gd-history-budget num" data-testid="history-budget" data-tip="Memory held by undo history">
        ${mb(stats.bytes)} MB of ${mb(stats.budget)} MB
      </div>
    `;
  },
};
