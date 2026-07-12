import * as core from '@actions/core';

/**
 * Octokit's own log shape, which every client already carries as `octokit.log`.
 * Reusing it — rather than inventing a second logger — is what lets the sink
 * ride along with the client that is already passed to everything that logs.
 */
export interface Logger {
  debug: (message: string) => unknown;
  error: (message: string) => unknown;
  info: (message: string) => unknown;
  warn: (message: string) => unknown;
}

/** The runner's sink, and the default: an Action must keep emitting workflow commands. */
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

/** For an embedder that wants none of the above on its stdout. */
export const silentLog: Logger = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};
