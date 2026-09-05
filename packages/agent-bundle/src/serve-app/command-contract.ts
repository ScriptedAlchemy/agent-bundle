/**
 * The ready-line and consent-vocabulary contract shared by
 * `agent-bundle serve-app` and the generated `<plugin> web` command: the
 * consent vocabulary `--allow` accepts and the ready line printed once the
 * App's host listens. One module writes and reads them so the two never
 * drift — a parser that lagged the CLI's own output would leave a command
 * waiting on a server that is already up. Plain Node (the consent vocabulary
 * comes from `core/mcp-app-allow.ts`): it is bundled into generated
 * executables. There is no spawner.
 */
export {
  isServeAppAllowCapability,
  serveAppAllowCapabilities,
  type ServeAppAllowCapability,
} from '../core/mcp-app-allow.ts';

export interface ServeAppReadyLine {
  /** The App selector as the operator gave it: `<server>/<app>` or `<server>/ui://...`. */
  readonly app: string;
  /** The tool whose result opened the App. */
  readonly tool: string;
  /** The host document URL. */
  readonly url: string;
}

/** The stdout line `agent-bundle serve-app` prints once the host is listening. */
export const formatServeAppReadyLine = ({ app, tool, url }: ServeAppReadyLine): string =>
  `MCP App ${app} at ${url} (tool ${tool}; Ctrl-C stops the server)`;

const readyLinePattern =
  /^MCP App (?<app>\S+) at (?<url>https?:\/\/\S+) \(tool (?<tool>\S+); Ctrl-C stops the server\)$/u;

/** The ready line's fields, or `undefined` for any other line of output. */
export const parseServeAppReadyLine = (line: string): ServeAppReadyLine | undefined => {
  const groups = readyLinePattern.exec(line.trimEnd())?.groups;
  if (groups?.['app'] === undefined || groups['tool'] === undefined || groups['url'] === undefined) return undefined;
  return { app: groups['app'], tool: groups['tool'], url: groups['url'] };
};
