import { Client, type Resource, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { randomUUID } from 'node:crypto';
import type { Stream } from 'node:stream';

import type {
  McpAppBridgeResource,
  McpAppBridgeSession,
  McpAppBridgeTool,
  McpAppJsonValue,
  McpAppSessionAuthority,
  McpAppSessionLease,
  McpAppToolDefinition,
} from '../dev/mcp-apps/mcp-app-binding-service.ts';
import { MCP_APP_MIME_TYPE } from '../dev/mcp-apps/mcp-app-bridge.ts';
import { mcpAppPreviewHostInfo } from '../dev/mcp-apps/mcp-app-preview-host.ts';
import {
  canonicalMcpAppJson,
  canonicalMcpAppResource,
  canonicalMcpAppTool,
  mcpAppClientCapabilities,
} from '../dev/mcp-session/mcp-session-apps.ts';
import { requireJsonObject, type AppSelectionSource } from './select-app.ts';

/**
 * The one stdio session behind an agent-bundle web host: a launched MCP
 * server (the plugin's own packed executable, spawned exactly as `mcp run`
 * spawns it) connected through the SDK client, exposed both as the
 * `McpAppBridgeSession` the App host stack leases and as the
 * `AppSelectionSource` App selection reads. Plain Node plus
 * `@modelcontextprotocol/client`: the generated bin bundles it (AB6005).
 */

const maxStderrBytes = 64 * 1024;

/** How to spawn the MCP server: `services/mcp-run.ts#ResolvedMcpStdioLaunch` and a manifest `web` entry both resolve to this. */
export interface StdioLaunch {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface StdioAppSession {
  readonly bridge: McpAppBridgeSession;
  /** Settles once the server connection has ended, whether by `close()` or on its own. */
  readonly closed: Promise<void>;
  /** App selection over this session's tools and `ui://` resources. */
  readonly selection: AppSelectionSource;
  readonly sessionId: string;
  /** The server's captured stderr so far (bounded), for the error a failed start reports. */
  readonly stderr: () => string;
  close(): Promise<void>;
  watchClosed(listener: () => void): () => void;
}

const captureStderr = (stream: Stream | null): (() => string) => {
  if (stream === null) return () => '';
  let captured = '';
  stream.on('data', (chunk: unknown) => {
    if (captured.length >= maxStderrBytes) return;
    captured = `${captured}${String(chunk)}`.slice(0, maxStderrBytes);
  });
  return () => captured;
};

/**
 * Launches the server and connects; a start that fails within `timeoutMs`
 * rejects with the server's stderr attached. Every request over the session
 * carries the same timeout.
 */
export const openStdioAppSession = async (
  launch: StdioLaunch,
  identity: Readonly<{ readonly serverName: string; readonly target: string }>,
  timeoutMs: number,
): Promise<StdioAppSession> => {
  const client = new Client({ name: mcpAppPreviewHostInfo.name, version: mcpAppPreviewHostInfo.version }, {
    capabilities: mcpAppClientCapabilities,
  });
  const transport = new StdioClientTransport({
    args: [...launch.args],
    command: launch.command,
    cwd: launch.cwd,
    env: { ...launch.env },
    stderr: 'pipe',
  });
  const stderr = captureStderr(transport.stderr);
  const closedGate = Promise.withResolvers<void>();
  const listeners = new Set<() => void>();
  let closed = false;
  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    closedGate.resolve();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A close watcher must never disrupt teardown.
      }
    }
    listeners.clear();
  };
  transport.onclose = markClosed;
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (error) {
    markClosed();
    const output = stderr();
    throw new Error(
      `The packed MCP server did not start: ${error instanceof Error ? error.message : String(error)}` +
      `${output.length === 0 ? '' : `\nserver stderr:\n${output}`}`,
      { cause: error },
    );
  }
  // The transport's own onclose is installed by the SDK client on connect;
  // chain ours behind it so an unexpected server exit still settles `closed`.
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    try {
      sdkOnClose?.();
    } finally {
      markClosed();
    }
  };
  const assertActive = (): void => {
    if (closed) throw new Error('The bound MCP server connection is closed.');
  };
  const requestOptions = Object.freeze({ timeout: timeoutMs });
  let bridgeTools: Promise<readonly McpAppBridgeTool[]> | undefined;
  let bridgeResources: Promise<readonly McpAppBridgeResource[]> | undefined;
  const listTools = async (): Promise<readonly Tool[]> => Object.freeze([...(await client.listTools(undefined, requestOptions)).tools]);
  const listResources = async (): Promise<readonly Resource[]> => Object.freeze([...(await client.listResources(undefined, requestOptions)).resources]);
  const sessionId = randomUUID();
  const bridge: McpAppBridgeSession = Object.freeze({
    callTool: async ({ arguments: toolArguments, name }: { readonly arguments: McpAppJsonValue | undefined; readonly name: string }) => {
      assertActive();
      const argumentsSnapshot = requireJsonObject(toolArguments ?? {}, 'MCP App tool arguments');
      const result = await client.callTool({ arguments: { ...argumentsSnapshot }, name }, requestOptions);
      assertActive();
      return canonicalMcpAppJson(result, 'MCP App tool result');
    },
    identity: Object.freeze({ epochId: `web-host:${sessionId}`, serverName: identity.serverName, sessionId, target: identity.target }),
    listBridgeResources: async () => {
      assertActive();
      bridgeResources ??= listResources().then((resources) => Object.freeze(resources.map(canonicalMcpAppResource)));
      const resources = await bridgeResources;
      assertActive();
      return resources;
    },
    listBridgeTools: async () => {
      assertActive();
      bridgeTools ??= listTools().then((tools) => Object.freeze(tools.map(canonicalMcpAppTool)));
      const tools = await bridgeTools;
      assertActive();
      return tools;
    },
    readResource: async ({ uri }: { readonly uri: string }) => {
      assertActive();
      const result = await client.readResource({ uri }, requestOptions);
      assertActive();
      return canonicalMcpAppJson(result, 'MCP App resource result');
    },
  });
  const selection: AppSelectionSource = Object.freeze({
    callTool: (name: string, input: Readonly<Record<string, McpAppJsonValue>>) => bridge.callTool({ arguments: input, name }),
    listAppResourceUris: async (): Promise<readonly string[]> => {
      assertActive();
      const resources = await listResources();
      assertActive();
      return Object.freeze(resources.filter((resource) => resource.mimeType === MCP_APP_MIME_TYPE).map((resource) => resource.uri));
    },
    listToolDefinitions: async (): Promise<readonly McpAppToolDefinition[]> => {
      assertActive();
      const tools = await listTools();
      assertActive();
      return Object.freeze(tools.map((tool) => canonicalMcpAppTool(tool).definition));
    },
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    bridge,
    close: () => {
      closing ??= client.close().catch(() => undefined).then(markClosed);
      return closing;
    },
    closed: closedGate.promise,
    selection,
    sessionId,
    stderr,
    watchClosed: (listener: () => void) => {
      if (closed) {
        listener();
        return () => undefined;
      }
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
};

/** The one bound session, leased to every App binding the host page creates. */
export const sessionAuthorityFor = (session: StdioAppSession): McpAppSessionAuthority => Object.freeze({
  acquireAppLease: async (sessionId: string): Promise<McpAppSessionLease> => {
    if (sessionId !== session.sessionId) throw new Error(`Unknown MCP App session ${JSON.stringify(sessionId)}.`);
    return Object.freeze({
      release: async () => undefined,
      session: session.bridge,
      watchSessionClosed: (listener: (reason?: unknown) => Promise<void> | void) => {
        let closedNow = false;
        const unsubscribe = session.watchClosed(() => {
          closedNow = true;
          void listener();
        });
        return Object.freeze({ closed: closedNow, unsubscribe });
      },
    });
  },
});
