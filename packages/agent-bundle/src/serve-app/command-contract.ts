/**
 * The `agent-bundle serve-app` command's wire contract, shared by the CLI
 * that implements it and `agent-bundle/serve-app-command` (#558), which
 * spawns it from a routed command: the consent vocabulary `--allow` accepts
 * and the ready line printed once the App's host listens. One module writes
 * and reads them so the two never drift — a parser that lagged the CLI's own
 * output would leave a routed command waiting on a server that is already
 * up. Plain Node, no imports: it is bundled into generated executables.
 */
import type { McpAppConsentCapability } from '../dev/mcp-apps/mcp-app-consent.ts';

/**
 * The consent capabilities `--allow` may approve on the operator's behalf:
 * the App-initiated actions. Browser hardware and clipboard permissions
 * (`camera`, `microphone`, `geolocation`, `clipboard-write`) always wait for
 * an Allow/Deny decision in the host page, as in the Workbench.
 */
export const serveAppAllowCapabilities = [
  'call-tool', 'download-file', 'open-external-link', 'request-display-mode',
] as const satisfies readonly McpAppConsentCapability[];

export type ServeAppAllowCapability = (typeof serveAppAllowCapabilities)[number];

export const isServeAppAllowCapability = (value: string): value is ServeAppAllowCapability =>
  (serveAppAllowCapabilities as readonly string[]).includes(value);

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
