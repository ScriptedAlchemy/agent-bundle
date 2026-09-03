import type {
  CallToolResult,
  GetPromptResult,
  Implementation,
  Prompt,
  Resource,
  ResourceTemplateType,
  ServerCapabilities,
  Tool,
  Transport,
} from '@modelcontextprotocol/client';
import type { Stream } from 'node:stream';

import type { TargetRegistry } from '../../adapters/registry.ts';
import type { EpochStore } from '../epoch-store.ts';
import type {
  McpSessionBinding,
  McpSessionId,
  McpSessionReplayOverflow,
} from './mcp-session-protocol.ts';
import type { McpSessionTraceSink } from './mcp-session-trace.ts';
import { deepFreeze } from '../../core/freeze.ts';


export interface McpRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeout: number;
}

/**
 * Request metadata carried on the wire as `params._meta`. `progressToken` is
 * the MCP-defined key generated routes consult before sending progress; any
 * other key travels untouched.
 */
export type McpRequestMeta = Readonly<{ readonly progressToken?: string | number } & Record<string, unknown>>;

export interface McpClient {
  callTool(
    params: { readonly _meta?: McpRequestMeta; readonly arguments: Record<string, unknown>; readonly name: string },
    options?: McpRequestOptions,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
  connect(transport: Transport, options?: McpRequestOptions): Promise<void>;
  getPrompt(
    params: { readonly arguments?: Record<string, string>; readonly name: string },
    options?: McpRequestOptions,
  ): Promise<GetPromptResult>;
  getServerCapabilities(): ServerCapabilities | undefined;
  getServerVersion(): Implementation | undefined;
  getNegotiatedProtocolVersion?(): string | undefined;
  getProtocolEra?(): 'legacy' | 'modern' | undefined;
  listPrompts(params?: undefined, options?: McpRequestOptions): Promise<{ readonly prompts: readonly Prompt[] }>;
  listResources(params?: undefined, options?: McpRequestOptions): Promise<{ readonly resources: readonly Resource[] }>;
  listResourceTemplates(
    params?: undefined,
    options?: McpRequestOptions,
  ): Promise<{ readonly resourceTemplates: readonly ResourceTemplateType[] }>;
  listTools(params?: undefined, options?: McpRequestOptions): Promise<{ readonly tools: readonly Tool[] }>;
  readResource(params: { readonly uri: string }, options?: McpRequestOptions): Promise<{ readonly contents: readonly unknown[] }>;
}

export interface StdioTransport extends Transport {
  readonly stderr: Stream | null;
}

export interface StdioOptions {
  readonly args: string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env: Record<string, string>;
  readonly stderr: 'pipe';
}

export interface RemoteTransportOptions {
  readonly headers?: Record<string, string>;
}

export interface OpenMcpSessionOptions extends McpSessionBinding {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly workspaceRoot?: string;
}

export interface McpSessionRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface McpSessionToolCallOptions extends McpSessionRequestOptions {
  /** Forwarded verbatim as the request's `params._meta` (for example a `progressToken`). */
  readonly _meta?: McpRequestMeta;
  readonly arguments: Record<string, unknown>;
  readonly name: string;
  /** A caller-chosen identifier used to cancel an in-flight tool call. */
  readonly requestId?: string;
}

export interface McpSessionPromptOptions extends McpSessionRequestOptions {
  readonly arguments?: Record<string, string>;
  readonly name: string;
}

export interface McpSessionResourceOptions extends McpSessionRequestOptions {
  readonly uri: string;
}

export interface McpSessionConnectionState {
  readonly capabilities: ServerCapabilities | undefined;
  readonly protocolEra: 'legacy' | 'modern' | undefined;
  readonly protocolVersion: string | undefined;
  readonly server: Implementation | undefined;
}

export interface McpSessionFrame {
  readonly direction: 'client' | 'server';
  /** A deep-frozen snapshot of the JSON-RPC object received from or sent to the SDK transport. */
  readonly message: unknown;
  readonly sequence: number;
}

export type McpSessionEvent =
  | Readonly<{ readonly sequence: number; readonly text: string; readonly type: 'stderr' }>
  | Readonly<{ readonly payload: unknown; readonly sequence: number; readonly type: 'progress' }>
  | Readonly<{ readonly payload: unknown; readonly sequence: number; readonly type: 'logging' }>;

export interface McpSessionReplay {
  readonly events: readonly McpSessionEvent[];
  readonly frames: readonly McpSessionFrame[];
  readonly overflow?: McpSessionReplayOverflow;
}

export interface McpSessionServiceOptions {
  readonly createClient?: () => McpClient;
  readonly createStdioTransport?: (options: StdioOptions) => StdioTransport;
  readonly createStreamableHttpTransport?: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly epochStore: EpochStore;
  readonly projectRoot: string;
  readonly registry?: TargetRegistry;
  /** Optional observability sink. It receives safe trace categories, never changes session behavior. */
  readonly traceSink?: McpSessionTraceSink;
}

export interface McpSessionServiceCloseFailure {
  readonly error: unknown;
  readonly resource: 'opening' | 'session';
  readonly sessionId?: McpSessionId;
}

/**
 * The session's pinned artifact epoch is no longer available: the project
 * changed underneath the session (typically another process's build
 * retention, which cannot observe this process's epoch leases). Tool calls
 * fail closed with this error instead of hanging against a vanished artifact.
 */
export class McpSessionStaleEpochError extends Error {
  readonly epochId: string;

  constructor(epochId: string, options?: Readonly<{ readonly cause?: unknown }>) {
    super(
      `MCP session epoch ${JSON.stringify(epochId)} is no longer available; the project changed underneath the session.`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'McpSessionStaleEpochError';
    this.epochId = epochId;
  }
}

/** Reports every session-service lifecycle failure after all tracked work settles. */
export class McpSessionServiceCloseError extends Error {
  readonly failures: readonly McpSessionServiceCloseFailure[];

  constructor(failures: readonly McpSessionServiceCloseFailure[]) {
    super('MCP session service could not close every lifecycle resource.');
    this.name = 'McpSessionServiceCloseError';
    this.failures = deepFreeze(failures.map((failure) => ({ ...failure })));
  }
}
