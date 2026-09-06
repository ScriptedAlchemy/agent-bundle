import {
  StreamableHTTPClientTransport,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { resolve } from 'node:path';

import { isHostSessionId } from '../contracts/host-sessions.ts';
import { isRecord } from '../core/strict-json.ts';
import { discoverDevServerUrl } from './dev-lock.ts';

export const HOST_MCP_DEV_SESSION_HEADER = 'x-agent-bundle-dev-session';
export const HOST_MCP_DEV_PID_HEADER = 'x-agent-bundle-dev-pid';

/** The proxy always names its pid; the session id rides along only when the host forwarded the env. */
export const hostMcpProxyRequestInit = (
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  pid = process.pid,
): { readonly requestInit: { readonly headers: Readonly<Record<string, string>> } } => {
  const session = env.AGENT_BUNDLE_DEV_SESSION;
  return {
    requestInit: {
      headers: {
        [HOST_MCP_DEV_PID_HEADER]: String(pid),
        ...(isHostSessionId(session) ? { [HOST_MCP_DEV_SESSION_HEADER]: session } : {}),
      },
    },
  };
};

export const hostMcpUnavailableCode = 'AB8025';

export interface RunHostMcpProxyOptions {
  readonly projectRoot: string;
  readonly serverName: string;
  readonly target?: string;
  readonly url?: string;
  readonly writeDiagnostic?: (message: string) => void;
}

const unavailableMessage = 'Development MCP server is unavailable.';

const loopbackOrigin = (value: string): string => {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
    url.origin !== value
  ) {
    throw new TypeError('Development MCP proxy URL must be a loopback HTTP origin.');
  }
  return url.origin;
};

const requestId = (message: JSONRPCMessage): string | number | undefined => {
  const value: unknown = message;
  if (!isRecord(value) || !Object.hasOwn(value, 'method') || !Object.hasOwn(value, 'id')) return undefined;
  const id = value.id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
};

const errorResponse = (
  id: string | number,
  cause: unknown,
): JSONRPCMessage => ({
  error: {
    code: -32_603,
    data: {
      code: hostMcpUnavailableCode,
      detail: cause instanceof Error ? cause.message : String(cause),
    },
    message: unavailableMessage,
  },
  id,
  jsonrpc: '2.0',
});

const hostEndpoint = (origin: string, serverName: string, target: string): URL => {
  const endpoint = new URL(`/mcp/host/${encodeURIComponent(serverName)}`, origin);
  endpoint.searchParams.set('target', target);
  return endpoint;
};

/**
 * Stable stdio transport bridge used by host MCP configuration. The stdio
 * process owns no plugin artifact and remains connected while the foreground
 * server swaps epochs behind its stateful HTTP session.
 */
export const runHostMcpProxy = async (options: RunHostMcpProxyOptions): Promise<number> => {
  if (options.serverName.trim().length === 0) throw new TypeError('Development MCP proxy server name must be nonempty.');
  const target = options.target ?? 'portable';
  if (target.trim().length === 0) throw new TypeError('Development MCP proxy target must be nonempty.');
  const projectRoot = resolve(options.projectRoot);
  const writeDiagnostic = options.writeDiagnostic ?? ((message: string) => {
    process.stderr.write(`${message}\n`);
  });
  const stdio = new StdioServerTransport();
  let remote: Transport | undefined;
  let failed = false;
  let reportedUnavailable = false;
  let shuttingDown = false;
  const reportUnavailable = (cause: unknown): void => {
    failed = true;
    if (reportedUnavailable) return;
    reportedUnavailable = true;
    const detail = cause instanceof Error ? ` ${cause.message}` : '';
    writeDiagnostic(`[${hostMcpUnavailableCode}] ${unavailableMessage}${detail}`);
  };
  const rejectRequest = async (message: JSONRPCMessage, cause: unknown): Promise<void> => {
    reportUnavailable(cause);
    const id = requestId(message);
    if (id !== undefined) await stdio.send(errorResponse(id, cause));
    await stdio.close();
  };

  try {
    const origin = loopbackOrigin(options.url ?? await discoverDevServerUrl({ projectRoot }));
    const transport = new StreamableHTTPClientTransport(
      hostEndpoint(origin, options.serverName, target),
      hostMcpProxyRequestInit(),
    );
    remote = transport;
    transport.onmessage = (message) => {
      void stdio.send(message).catch(reportUnavailable);
    };
    transport.onerror = reportUnavailable;
    transport.onclose = () => {
      if (shuttingDown) return;
      reportUnavailable(new Error('The foreground HTTP transport closed.'));
      void stdio.close();
    };
    await transport.start();
  } catch (error) {
    reportUnavailable(error);
  }

  const closed = Promise.withResolvers<void>();
  stdio.onclose = () => {
    shuttingDown = true;
    void remote?.close().finally(closed.resolve);
    if (remote === undefined) closed.resolve();
  };
  stdio.onerror = reportUnavailable;
  stdio.onmessage = (message) => {
    const transport = remote;
    if (transport === undefined) {
      void rejectRequest(message, new Error('No running development server was discovered.'));
      return;
    }
    void transport.send(message).catch((error: unknown) => rejectRequest(message, error));
  };
  await stdio.start();
  await closed.promise;
  return failed ? 1 : 0;
};
