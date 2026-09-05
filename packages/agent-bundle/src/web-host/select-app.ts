import { isRecord } from '../core/strict-json.ts';
import {
  selectMcpAppResourceUri,
  type McpAppJsonValue,
  type McpAppToolDefinition,
} from '../dev/mcp-apps/mcp-app-binding-service.ts';
import { canonicalMcpAppJson } from '../dev/mcp-session/mcp-session-apps.ts';

/**
 * App selection shared by every agent-bundle web host. `agent-bundle
 * serve-app` and the generated `<plugin> web` command resolve an operator's
 * `<server>/<app>` selector the same way: to one `ui://` resource the live
 * server actually serves and one tool that declares it as its App, which the
 * host then calls once so the App opens populated — the same input/result
 * pair the Workbench binds when it previews a tool run.
 *
 * Plain Node: the generated bin bundles this module (AB6005), so it carries
 * no Effect and no compiler modules. `session.ts` adapts the SDK client to
 * {@link AppSelectionSource}; tests substitute a fake.
 */

/** What App selection needs from a live MCP session. */
export interface AppSelectionSource {
  callTool(name: string, input: Readonly<Record<string, McpAppJsonValue>>): Promise<McpAppJsonValue>;
  /** The `ui://` resources whose MIME type is the MCP Apps document type. */
  listAppResourceUris(): Promise<readonly string[]>;
  /** Canonical tool definitions (`mcp-session-apps.ts#canonicalMcpAppTool(tool).definition`). */
  listToolDefinitions(): Promise<readonly McpAppToolDefinition[]>;
}

export interface AppSelector {
  readonly name?: string;
  readonly resourceUri?: string;
  readonly server: string;
}

export interface OpenAppRequest {
  /**
   * Arguments for the opening tool call; defaults to `{}`. Any JSON-shaped
   * record is accepted and canonicalized here, so callers holding parsed
   * `--input` JSON or a manifest's `input` pass it through unchanged.
   */
  readonly input?: Readonly<Record<string, unknown>>;
  /** The App's name, resolved against the resources the server serves. Ignored when `resourceUri` is given. */
  readonly name?: string;
  /** A known `ui://` resource URI (a manifest's); still verified against the live server. */
  readonly resourceUri?: string;
  readonly server: string;
  /** The opening tool; defaults to the only tool declaring the App's `_meta.ui.resourceUri`. */
  readonly tool?: string;
}

export interface AppSelection {
  readonly input: Readonly<Record<string, McpAppJsonValue>>;
  readonly resourceUri: string;
  readonly result: McpAppJsonValue;
  readonly server: string;
  readonly tool: McpAppToolDefinition;
}

/** A detached, canonical JSON object, or a `TypeError` naming `label`; the bound of every tool argument record a host sends. */
export const requireJsonObject = (value: unknown, label: string): Readonly<Record<string, McpAppJsonValue>> => {
  const snapshot = canonicalMcpAppJson(value, label);
  if (!isRecord(snapshot)) throw new TypeError(`${label} must be a JSON object.`);
  return snapshot as Readonly<Record<string, McpAppJsonValue>>;
};

/** Splits `<server>/<app>` or `<server>/ui://...` into its server and App parts, rejecting anything else. */
export const parseAppSelector = (value: string): AppSelector => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error('MCP App must be named as <server>/<app> or a ui:// resource URI.');
  const separator = trimmed.indexOf('/');
  if (separator < 1 || separator === trimmed.length - 1) {
    throw new Error(`MCP App ${JSON.stringify(value)} must be named as <server>/<app> or <server>/ui://... .`);
  }
  const server = trimmed.slice(0, separator);
  const rest = trimmed.slice(separator + 1);
  if (rest.startsWith('ui://')) return Object.freeze({ resourceUri: rest, server });
  if (rest.includes('/')) throw new Error(`MCP App name ${JSON.stringify(rest)} must not contain a slash.`);
  return Object.freeze({ name: rest, server });
};

/** The App name a `ui://` resource URI spells: its last path segment without an `.html` suffix. */
export const appNameOf = (resourceUri: string): string | undefined => {
  try {
    const parsed = new URL(resourceUri);
    if (parsed.protocol !== 'ui:') return undefined;
    const segment = parsed.pathname.split('/').filter((part) => part.length > 0).at(-1);
    return segment === undefined ? undefined : segment.replace(/\.html?$/iu, '');
  } catch {
    return undefined;
  }
};

const matchingResourceUris = (resourceUris: readonly string[], request: OpenAppRequest): readonly string[] => {
  if (request.resourceUri !== undefined) return resourceUris.includes(request.resourceUri) ? [request.resourceUri] : [];
  return resourceUris.filter((uri) => appNameOf(uri) === request.name);
};

/**
 * Resolves the App and its opening tool against the live server, then calls
 * the tool once. A known `resourceUri` skips name matching but is still
 * verified against what the server serves; the tool must advertise the App
 * as `_meta.ui.resourceUri`, and without `tool` exactly one may.
 */
export const openApp = async (source: AppSelectionSource, request: OpenAppRequest): Promise<AppSelection> => {
  if (request.resourceUri === undefined && request.name === undefined) {
    throw new Error('MCP App must be named as <server>/<app> or a ui:// resource URI.');
  }
  const [tools, resourceUris] = await Promise.all([source.listToolDefinitions(), source.listAppResourceUris()]);
  const matching = matchingResourceUris(resourceUris, request);
  const available = resourceUris.map((uri) => `${request.server}/${appNameOf(uri) ?? uri}`);
  if (matching.length === 0) {
    throw new Error(
      `MCP server ${JSON.stringify(request.server)} serves no MCP App ${JSON.stringify(request.resourceUri ?? request.name)}` +
      `${available.length === 0 ? ' (it serves no MCP App resources).' : `; available: ${available.join(', ')}.`}`,
    );
  }
  if (matching.length > 1) {
    throw new Error(
      `MCP App ${JSON.stringify(request.name)} names ${String(matching.length)} resources on server ${JSON.stringify(request.server)}; ` +
      `use ${request.server}/<ui://...> to select one of: ${matching.join(', ')}.`,
    );
  }
  const resourceUri = matching[0]!;
  const appTools = tools.filter((tool) => selectMcpAppResourceUri(tool) === resourceUri);
  const selectedTool = request.tool === undefined
    ? appTools.length === 1 ? appTools[0] : undefined
    : appTools.find((tool) => tool.name === request.tool);
  if (selectedTool === undefined) {
    if (request.tool !== undefined) {
      throw new Error(
        `Tool ${JSON.stringify(request.tool)} does not open MCP App ${resourceUri}` +
        `${appTools.length === 0 ? '.' : `; tools that do: ${appTools.map((tool) => tool.name).join(', ')}.`}`,
      );
    }
    throw new Error(appTools.length === 0
      ? `No tool on server ${JSON.stringify(request.server)} declares _meta.ui.resourceUri ${resourceUri}.`
      : `Several tools open MCP App ${resourceUri} (${appTools.map((tool) => tool.name).join(', ')}); choose one with --tool.`);
  }
  const input = requireJsonObject(request.input ?? {}, 'MCP App tool input');
  const result = await source.callTool(selectedTool.name, input);
  return Object.freeze({ input, resourceUri, result, server: request.server, tool: selectedTool });
};
