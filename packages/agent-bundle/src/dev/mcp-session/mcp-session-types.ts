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
  StandardSchemaV1,
} from '@modelcontextprotocol/client';
import type { Stream } from 'node:stream';

import type { TargetRegistry } from '../../adapters/registry.ts';
import type { DevPlatformRuntime } from '../platform-runtime.ts';
import type { EpochStore } from '../epoch-store.ts';
import type {
  McpSessionBinding,
  McpSessionId,
  McpSessionReplayOverflow,
} from './mcp-session-protocol.ts';
import type { McpSessionTraceSink } from './mcp-session-trace.ts';
import type { TracePublisher } from '../trace/trace-hub.ts';
import { CodedError } from '../../core/errors.ts';
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
  /**
   * One request outside the SDK's typed method surface — the `2025-11-25`
   * task methods — validated against the SDK schema of its result. Optional
   * so a narrow test double stays a valid client; a session whose client
   * lacks it refuses task operations.
   */
  request?<T extends StandardSchemaV1>(
    request: { readonly method: string; readonly params?: Record<string, unknown> },
    resultSchema: T,
    options?: McpRequestOptions,
  ): Promise<StandardSchemaV1.InferOutput<T>>;
}

/** The `params.task` of a task-augmented `tools/call` (MCP `2025-11-25` Tasks). */
export interface McpSessionTaskCreation {
  readonly pollInterval?: number;
  readonly ttl?: number;
}

/**
 * A task-augmented tool call (#369): the request carries `params.task` and the
 * server answers with a `CreateTaskResult` handle instead of the tool result,
 * which `getTaskResult` then retrieves.
 */
export interface McpSessionTaskCallOptions extends McpSessionToolCallOptions {
  readonly task: McpSessionTaskCreation;
}

export interface McpSessionTaskOptions extends McpSessionRequestOptions {
  readonly taskId: string;
}

export interface McpSessionTaskListOptions extends McpSessionRequestOptions {
  readonly cursor?: string;
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
  /** The dev server's session runtime; absent, each program runs on its own `platformLayer`. */
  readonly platformRuntime?: DevPlatformRuntime;
  /**
   * The Workbench's unified trace (#600). Every session lowers its frames,
   * notifications, stderr, and lifecycle onto it through
   * `createMcpSessionTraceSink`; absent, nothing is published.
   */
  readonly trace?: TracePublisher;
  /** Optional observability sink. It receives safe trace categories, never changes session behavior. */
  readonly traceSink?: McpSessionTraceSink;
}

export interface McpSessionServiceCloseFailure {
  readonly error: unknown;
  readonly resource: 'opening' | 'session';
  readonly sessionId?: McpSessionId;
}

export type McpSessionErrorCode =
  | 'duplicate-request-id'
  | 'invalid-request-id'
  | 'invalid-server-name'
  | 'not-initialized'
  | 'service-closed'
  | 'session-closed';

/**
 * Expected session-lifecycle failures on the Effect error channel: the
 * session or its service is closed, a protocol call ran before `initialize`,
 * or a request was admitted with an invalid or already-active `requestId`.
 * These ride the fail channel as a `CodedError` (never `Effect.die`) and
 * rethrow unchanged at `src/effect/boundary.ts`, so Promise callers keep the
 * exact messages they saw before the class existed.
 */
export class McpSessionError extends CodedError<McpSessionErrorCode> {
  constructor(code: McpSessionErrorCode, message: string) {
    super('McpSessionError', code, message);
  }

  static closed(): McpSessionError {
    return new McpSessionError('session-closed', 'MCP session is closed.');
  }

  static duplicateRequestId(requestId: string): McpSessionError {
    return new McpSessionError(
      'duplicate-request-id',
      `MCP session request ${JSON.stringify(requestId)} is already active.`,
    );
  }

  static invalidRequestId(): McpSessionError {
    return new McpSessionError('invalid-request-id', 'MCP session requestId must be nonempty.');
  }

  static invalidServerName(): McpSessionError {
    return new McpSessionError('invalid-server-name', 'MCP server name must be nonempty.');
  }

  static notInitialized(): McpSessionError {
    return new McpSessionError('not-initialized', 'MCP session must initialize before protocol operations.');
  }

  static serviceClosed(): McpSessionError {
    return new McpSessionError('service-closed', 'MCP session service is closed.');
  }
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
