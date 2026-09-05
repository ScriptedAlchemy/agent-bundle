/** Plain Node wire contract shared by `serve-app` and generated `web` commands. */
export {
  isServeAppAllowCapability,
  serveAppAllowCapabilities,
  type ServeAppAllowCapability,
} from '../core/mcp-app-allow.ts';

export interface ServeAppReadyLine {
  readonly app: string;
  readonly tool: string;
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
