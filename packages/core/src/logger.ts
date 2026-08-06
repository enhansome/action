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

/** Library default: routes diagnostics to the console without a runner dependency. */
export const consoleLog: Logger = {
  debug: message => {
    console.debug(message);
  },
  error: message => {
    console.error(message);
  },
  info: message => {
    console.info(message);
  },
  warn: message => {
    console.warn(message);
  },
};

/** For an embedder that wants none of the above on its stdout. */
export const silentLog: Logger = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};
