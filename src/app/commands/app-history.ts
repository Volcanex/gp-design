/** The app-wide History singleton. Dialogs and panels import THIS, not createHistory. */

import { createHistory } from './history';

export const history = createHistory();
