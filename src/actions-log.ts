import * as core from '@actions/core';

import type { Logger } from '@enhansome/core';

/**
 * The GitHub Actions runner's sink: emits `::debug::` / `::warning::` workflow
 * commands. Action-only — kept out of the library entry (`index.ts`) so that
 * importing the library doesn't drag `@actions/core` into a consumer's bundle.
 */
export const actionsLog: Logger = {
  debug: message => {
    core.debug(message);
  },
  error: message => {
    core.error(message);
  },
  info: message => {
    core.info(message);
  },
  warn: message => {
    core.warning(message);
  },
};
