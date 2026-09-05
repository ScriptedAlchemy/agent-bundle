import { isRecord } from '../core/strict-json.ts';
import {
  selectMcpAppResourceUri,
  type McpAppJsonValue,
  type McpAppToolDefinition,
} from '../dev/mcp-apps/mcp-app-binding-service.ts';
import { canonicalMcpAppJson } from '../dev/mcp-session/mcp-session-apps.ts';

export interface AppSelectionSource {
  callTool(name: string, input: Readonly<Record<string, McpAppJsonValue>>): Promise<McpAppJsonValue>;
  listAppResourceUris(): Promise<readonly string[]>;
  listToolDefinitions(): Promise<readonly McpAppToolDefinition[]>;
}

export interface AppSelector {
  readonly name?: string;
  readonly resourceUri?: string;
  readonly server: string;
}

export interface OpenAppRequest {
  readonly input?: Readonly<Record<string, unknown>>;
  readonly name?: string;
  readonly resourceUri?: string;
  readonly server: string;
  readonly tool?: string;
}

export interface AppSelection {
  readonly input: Readonly<Record<string, McpAppJsonValue>>;
  readonly resourceUri: string;
  readonly result: McpAppJsonValue;
  readonly server: string;
  readonly tool: McpAppToolDefinition;
}

export const requireJsonObject = (value: unknown, label: string): Readonly<Record<string, McpAppJsonValue>> => {
  const snapshot = canonicalMcpAppJson(value, label);
  if (!isRecord(snapshot)) throw new TypeError(`${label} must be a JSON object.`);
  return snapshot;
};

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

/** An App opening resolved against the live server, before its opening tool has been called. */
export interface ResolvedAppOpening {
  readonly input: Readonly<Record<string, McpAppJsonValue>>;
  readonly resourceUri: string;
  readonly server: string;
  readonly tool: McpAppToolDefinition;
}

/**
 * Resolves the App and its opening tool against the live server without
 * calling the tool. A known `resourceUri` skips name matching but is still
 * verified against what the server serves; the tool must advertise the App
 * as `_meta.ui.resourceUri`, and without `tool` exactly one may.
 */
export const resolveAppOpening = async (source: AppSelectionSource, request: OpenAppRequest): Promise<ResolvedAppOpening> => {
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
  return Object.freeze({ input, resourceUri, server: request.server, tool: selectedTool });
};

/** {@link resolveAppOpening}, then exactly one call of the resolved opening tool. */
export const openApp = async (source: AppSelectionSource, request: OpenAppRequest): Promise<AppSelection> => {
  const resolved = await resolveAppOpening(source, request);
  const result = await source.callTool(resolved.tool.name, resolved.input);
  return Object.freeze({ ...resolved, result });
};
