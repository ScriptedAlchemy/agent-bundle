import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  createMcpHandler,
  fromJsonSchema,
  verifyBearerToken,
  type AuthInfo,
  type JsonSchemaType,
  type McpHttpHandler,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';

import { stableJson } from '../core/digest.ts';
import { snapshotStrictJsonValue } from '../core/strict-json.ts';
import type { ProjectStatus } from './types.ts';

export const agentApiToolNames = Object.freeze([
  'project_status',
  'skills_list',
  'skill_inspect',
  'artifacts_list',
  'artifact_inspect',
  'mcp_servers_list',
  'mcp_invoke',
  'hooks_list',
  'hook_simulate',
  'evals_list',
  'eval_run',
  'eval_get',
  'diagnostics_list',
] as const);

export type AgentApiToolName = typeof agentApiToolNames[number];

export interface AgentApiEpochReference {
  close(): Promise<void>;
  readonly epoch: Readonly<{ readonly id: string }>;
  readonly root: string;
}

export interface AgentApiEpochStore {
  acquireActiveEpochReference(): Promise<AgentApiEpochReference>;
  acquireEpochReference(epochId: string): Promise<AgentApiEpochReference>;
  listEpochs(): Promise<readonly AgentApiEpochSummary[]>;
}

/** Deliberately path-free epoch identity permitted on the Agent API wire. */
export interface AgentApiEpochSummary {
  readonly configDigest?: string;
  readonly createdAt?: string;
  readonly diagnostics?: Readonly<{ readonly errors: number; readonly infos: number; readonly warnings: number }>;
  readonly id: string;
  readonly modelDigest?: string;
  readonly projectRevision?: string;
  readonly targetDigests?: Readonly<Record<string, string>>;
}

export interface AgentApiMcpSession {
  callTool(options: Readonly<{ readonly arguments: Record<string, unknown>; readonly name: string; readonly signal?: AbortSignal }>): Promise<unknown>;
  close(): Promise<void>;
  initialize(options?: Readonly<{ readonly signal?: AbortSignal }>): Promise<unknown>;
}

export interface AgentApiMcpSessions {
  open(options: Readonly<{ readonly epochId: string; readonly serverName: string; readonly target: string }>): Promise<AgentApiMcpSession>;
}

export interface AgentApiOptions {
  readonly artifacts: Readonly<{ readonly inspect: (epochId: string) => Promise<unknown> }>;
  readonly coordinator: Readonly<{ readonly status: () => ProjectStatus }>;
  readonly diagnostics: Readonly<{ readonly list: () => Promise<unknown> }>;
  readonly epochs: AgentApiEpochStore;
  readonly evals: Readonly<{
    readonly list: () => Promise<unknown>;
    readonly read: (runId: string) => Promise<unknown>;
    readonly run: (request: Readonly<Record<string, unknown>>) => Promise<unknown>;
    readonly suites: () => Promise<unknown>;
  }>;
  readonly hooks: Readonly<{
    readonly list: (options: Readonly<{ readonly epochId: string; readonly target?: string }>) => Promise<unknown>;
    readonly simulate: (options: Readonly<{
      readonly epochId: string;
      readonly hook: string;
      readonly input: Readonly<{ readonly inline: Record<string, unknown> }>;
      readonly signal?: AbortSignal;
      readonly target: string;
    }>) => Promise<unknown>;
  }>;
  readonly mcpSessions: AgentApiMcpSessions;
  readonly skills: Readonly<{
    readonly generated: (epochId: string, target: string, skillId: string) => Promise<unknown>;
    readonly generatedTree: (epochId: string, target: string) => Promise<unknown>;
  }>;
  /** @internal Trusted test seam for verifying handler shutdown behavior. */
  readonly handlerFactory?: (factory: McpServerFactory) => McpHttpHandler;
  /** Trusted test seam. Production callers obtain the token from AGENT_BUNDLE_AGENT_API_TOKEN. */
  readonly token?: string;
  readonly version?: string;
}

export type AgentApiCloseFailure = Readonly<{ readonly error: unknown; readonly resource: 'handler' }>;

export class AgentApiCloseError extends Error {
  readonly failures: readonly AgentApiCloseFailure[];

  constructor(failures: readonly AgentApiCloseFailure[]) {
    super('Agent API could not close every operation.');
    this.name = 'AgentApiCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

const apiError = (code: string, message: string): Error & Readonly<{ readonly code: string }> =>
  Object.assign(new Error(message), { code });

interface Settlement<T> {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
}

/** Publishes a close result before synchronous abort listeners can reenter close(). */
const settlement = <T>(): Settlement<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, reject, resolve });
};

const objectSchema = (
  properties: Record<string, JsonSchemaType>,
  required: readonly string[] = [],
) => fromJsonSchema({ additionalProperties: false, properties, required: [...required], type: 'object' });

const noArguments = objectSchema({});
const epochArgument = { minLength: 1, type: 'string' };
const targetArgument = { minLength: 1, type: 'string' };
const identifierArgument = { minLength: 1, type: 'string' };

const skillListSchema = objectSchema({ epoch: epochArgument, target: targetArgument }, ['target']);
const skillInspectSchema = objectSchema({ epoch: epochArgument, skill_id: identifierArgument, target: targetArgument }, ['skill_id', 'target']);
const artifactInspectSchema = objectSchema({ epoch: epochArgument });
const mcpServersListSchema = objectSchema({ epoch: epochArgument, target: targetArgument }, ['target']);
const mcpInvokeSchema = objectSchema({
  arguments: { additionalProperties: true, type: 'object' },
  epoch: epochArgument,
  server: identifierArgument,
  target: targetArgument,
  tool: identifierArgument,
}, ['server', 'target', 'tool']);
const hooksListSchema = objectSchema({ epoch: epochArgument, target: targetArgument });
const hookSimulateSchema = objectSchema({
  epoch: epochArgument,
  hook: identifierArgument,
  input: { additionalProperties: true, type: 'object' },
  target: targetArgument,
}, ['hook', 'input', 'target']);
const evalRunSchema = objectSchema({
  case_ids: { items: identifierArgument, type: 'array' },
  epoch: epochArgument,
  suites: { items: identifierArgument, type: 'array' },
  trials: { maximum: 100, minimum: 1, type: 'integer' },
});
const evalGetSchema = objectSchema({ run_id: identifierArgument }, ['run_id']);

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const stringArgument = (args: Record<string, unknown>, name: string): string => {
  const value = args[name];
  if (typeof value !== 'string') throw apiError('AGENT_API_ARGUMENT_INVALID', 'Tool arguments are not valid.');
  return value;
};

const optionalStringArgument = (args: Record<string, unknown>, name: string): string | undefined => {
  const value = args[name];
  if (value === undefined) return undefined;
  return typeof value === 'string'
    ? value
    : (() => { throw apiError('AGENT_API_ARGUMENT_INVALID', 'Tool arguments are not valid.'); })();
};

const objectArgument = (args: Record<string, unknown>, name: string): Record<string, unknown> => {
  const value = args[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw apiError('AGENT_API_ARGUMENT_INVALID', 'Tool arguments are not valid.');
  }
  return value as Record<string, unknown>;
};

const optionalObjectArgument = (args: Record<string, unknown>, name: string): Record<string, unknown> => {
  if (args[name] === undefined) return {};
  return objectArgument(args, name);
};

const stringListArgument = (args: Record<string, unknown>, name: string): readonly string[] | undefined => {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw apiError('AGENT_API_ARGUMENT_INVALID', 'Tool arguments are not valid.');
  }
  return Object.freeze([...value]);
};

const optionalIntegerArgument = (args: Record<string, unknown>, name: string): number | undefined => {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw apiError('AGENT_API_ARGUMENT_INVALID', 'Tool arguments are not valid.');
  return value as number;
};

const stableErrorCodes = new Set([
  'AGENT_API_ARGUMENT_INVALID',
  'AGENT_API_CLOSED',
  'EPOCH_ALREADY_EXISTS',
  'EPOCH_ID_INVALID',
  'EPOCH_MANIFEST_INVALID',
  'EPOCH_METADATA_INVALID',
  'EPOCH_NOT_FOUND',
  'EPOCH_STAGING_CLOSED',
  'EPOCH_STAGING_INVALID',
  'EPOCH_TARGET_INVALID',
  'EPOCH_TARGET_SET_INVALID',
  'ARTIFACT_INSPECTION_INVALID',
  'ARTIFACT_INSPECTION_RELEASE_FAILED',
  'ARTIFACT_INSPECTION_RUNTIME_INVALID',
  'SKILL_DOCUMENT_UNAVAILABLE',
  'SKILL_EPOCH_UNAVAILABLE',
  'SKILL_RESOURCE_UNAVAILABLE',
  'SKILL_TARGET_UNAVAILABLE',
  'EVAL_ARTIFACT_OUTSIDE_PROJECT',
  'EVAL_HARNESS_UNSUPPORTED',
  'EVAL_RUN_NOT_FOUND',
  'EVAL_SELECTION_EMPTY',
  'EVAL_SEMANTIC_GRADER_UNSUPPORTED',
  'EVAL_TARGET_MISSING',
  'EVAL_TRIALS_INVALID',
] as const);

/** Reads only an own data descriptor: hostile accessors and Proxy traps are never evaluated. */
const ownDataProperty = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

const safeErrorCode = (error: unknown): string => {
  const code = ownDataProperty(error, 'code');
  return typeof code === 'string' && stableErrorCodes.has(code as never)
    ? code
    : 'AGENT_API_OPERATION_FAILED';
};

const sensitiveWireKey = (key: string): boolean => {
  const normalized = key.toLowerCase();
  return normalized === 'root' || normalized === 'cwd' || normalized === 'env' ||
    normalized === 'command' || normalized.includes('path');
};

const absolutePathValue = (value: string): boolean =>
  value.startsWith('/') || /^[a-z]:[\\/]/iu.test(value);

/** Removes filesystem identities from nested status/list payloads before JSON snapshotting. */
const wireSafeProjection = (value: unknown): unknown => {
  const snapshot = snapshotStrictJsonValue(value);
  const project = (candidate: typeof snapshot): typeof snapshot => {
    if (typeof candidate === 'string') return absolutePathValue(candidate) ? '[redacted]' : candidate;
    if (candidate === null || typeof candidate !== 'object') return candidate;
    if (Array.isArray(candidate)) return Object.freeze(candidate.map(project));
    return Object.freeze(Object.fromEntries(Object.entries(candidate)
      .filter(([key]) => !sensitiveWireKey(key))
      .map(([key, nested]) => [key, project(nested)])));
  };
  return project(snapshot);
};

const epochWireIdentity = (epoch: AgentApiEpochSummary): AgentApiEpochSummary => Object.freeze({
  ...(typeof epoch.configDigest === 'string' ? { configDigest: epoch.configDigest } : {}),
  ...(typeof epoch.createdAt === 'string' ? { createdAt: epoch.createdAt } : {}),
  ...(epoch.diagnostics === undefined ? {} : { diagnostics: Object.freeze({
    errors: epoch.diagnostics.errors,
    infos: epoch.diagnostics.infos,
    warnings: epoch.diagnostics.warnings,
  }) }),
  id: epoch.id,
  ...(typeof epoch.modelDigest === 'string' ? { modelDigest: epoch.modelDigest } : {}),
  ...(typeof epoch.projectRevision === 'string' ? { projectRevision: epoch.projectRevision } : {}),
  ...(epoch.targetDigests === undefined ? {} : { targetDigests: Object.freeze(Object.fromEntries(
    Object.entries(epoch.targetDigests).filter(([, digest]) => typeof digest === 'string'),
  )) }),
});

const safeToolResult = (value: unknown) => {
  const snapshot = snapshotStrictJsonValue(value === undefined ? null : value);
  const structured = snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot
    : Object.freeze({ value: snapshot });
  return {
    content: [{ text: stableJson(structured), type: 'text' as const }],
    structuredContent: structured,
  };
};

const failedToolResult = (error: unknown) => {
  const structured = Object.freeze({ error: Object.freeze({ code: safeErrorCode(error), message: 'The requested operation could not be completed.' }) });
  return {
    content: [{ text: stableJson(structured), type: 'text' as const }],
    isError: true,
    structuredContent: structured,
  };
};

const tokenDigest = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** Always compares same-size digests so bearer length is not an early branch. */
export const agentApiTokenEquals = (expected: string, received: string): boolean =>
  timingSafeEqual(tokenDigest(expected), tokenDigest(received));

const writeWebResponse = async (response: ServerResponse, result: Response): Promise<void> => {
  const headers = Object.fromEntries(result.headers.entries());
  response.writeHead(result.status, headers);
  response.end(new Uint8Array(await result.arrayBuffer()));
};

/** Resolves the optional fixed bearer secret without exposing its value. */
export const agentApiTokenFromEnvironment = (environment: NodeJS.ProcessEnv = process.env): string | undefined => {
  const token = environment.AGENT_BUNDLE_AGENT_API_TOKEN;
  return typeof token === 'string' && token.trim().length > 0 ? token : undefined;
};

/**
 * Stateless MCP facade over the already-owned development services. Every request
 * receives a fresh MCP server; the API only leases epochs and never owns those services.
 */
export class AgentApi {
  readonly #artifacts: AgentApiOptions['artifacts'];
  #closePromise: Promise<void> | undefined;
  #closing = false;
  readonly #coordinator: AgentApiOptions['coordinator'];
  readonly #diagnostics: AgentApiOptions['diagnostics'];
  readonly #epochs: AgentApiEpochStore;
  readonly #evals: AgentApiOptions['evals'];
  readonly #handler: McpHttpHandler;
  readonly #hooks: AgentApiOptions['hooks'];
  readonly #nodeHandler: NodeMcpRequestHandler;
  readonly #operations = new Map<AbortController, Promise<void>>();
  readonly #mcpSessions: AgentApiMcpSessions;
  readonly #skills: AgentApiOptions['skills'];
  readonly #token: string;
  readonly #version: string;

  constructor(options: AgentApiOptions) {
    const token = options.token ?? agentApiTokenFromEnvironment();
    if (token === undefined) {
      throw apiError(
        'AGENT_API_TOKEN_REQUIRED',
        'Agent API requires AGENT_BUNDLE_AGENT_API_TOKEN before it can be enabled.',
      );
    }
    this.#artifacts = options.artifacts;
    this.#coordinator = options.coordinator;
    this.#diagnostics = options.diagnostics;
    this.#epochs = options.epochs;
    this.#evals = options.evals;
    this.#hooks = options.hooks;
    this.#mcpSessions = options.mcpSessions;
    this.#skills = options.skills;
    this.#token = token;
    this.#version = options.version ?? '0.1.0';
    this.#handler = options.handlerFactory?.(() => this.#createServer()) ??
      createMcpHandler(() => this.#createServer(), { legacy: 'stateless' });
    this.#nodeHandler = toNodeHandler(this.#handler);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.#closing) {
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      response.end('{"error":"Agent API is closed."}');
      return;
    }
    let auth: AuthInfo;
    try {
      auth = await verifyBearerToken(request.headers.authorization, {
        verifier: {
          verifyAccessToken: async (candidate) => {
            if (!agentApiTokenEquals(this.#token, candidate)) {
              throw new OAuthError(OAuthErrorCode.InvalidToken, 'Bearer token is invalid.');
            }
            return {
              clientId: 'agent-bundle',
              expiresAt: Math.floor(Date.now() / 1_000) + 60,
              scopes: [],
              token: candidate,
            };
          },
        },
      });
    } catch (error) {
      await writeWebResponse(response, bearerAuthChallengeResponse(error));
      return;
    }
    const authorized = request as IncomingMessage & { auth?: AuthInfo };
    authorized.auth = auth;
    try {
      await this.#nodeHandler(authorized, response);
    } finally {
      delete authorized.auth;
    }
  }

  close(): Promise<void> {
    const closing = this.#closePromise;
    if (closing !== undefined) return closing;
    this.#closing = true;
    const published = settlement<void>();
    this.#closePromise = published.promise;
    void this.#close().then(published.resolve, published.reject);
    return published.promise;
  }

  async #close(): Promise<void> {
    for (const operation of this.#operations.keys()) {
      operation.abort(apiError('AGENT_API_CLOSED', 'Agent API is closed.'));
    }
    const handler = await Promise.allSettled([this.#handler.close()]);
    await Promise.allSettled([...this.#operations.values()]);
    const failures = handler.flatMap((result): readonly AgentApiCloseFailure[] => result.status === 'rejected'
      ? [Object.freeze({ error: result.reason, resource: 'handler' as const })]
      : []);
    if (failures.length > 0) throw new AgentApiCloseError(failures);
  }

  #createServer(): McpServer {
    const server = new McpServer({ name: 'agent-bundle', version: this.#version });
    server.registerTool('project_status', { inputSchema: noArguments }, async (_arguments, context) =>
      this.#tool(context.mcpReq.signal, () => Promise.resolve({ status: wireSafeProjection(this.#coordinator.status()) })));
    server.registerTool('skills_list', { inputSchema: skillListSchema }, async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => this.#withEpoch(optionalStringArgument(asRecord(arguments_), 'epoch'), async (epochId) => ({
        skills: await this.#skills.generatedTree(epochId, stringArgument(asRecord(arguments_), 'target')),
      }))));
    server.registerTool('skill_inspect', { inputSchema: skillInspectSchema }, async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => this.#withEpoch(optionalStringArgument(asRecord(arguments_), 'epoch'), async (epochId) => ({
        skill: await this.#skills.generated(
          epochId,
          stringArgument(asRecord(arguments_), 'target'),
          stringArgument(asRecord(arguments_), 'skill_id'),
        ),
      }))));
    server.registerTool('artifacts_list', { inputSchema: noArguments }, async (_arguments, context) =>
      this.#tool(context.mcpReq.signal, async () => ({ epochs: (await this.#epochs.listEpochs()).map(epochWireIdentity) })));
    server.registerTool('artifact_inspect', { inputSchema: artifactInspectSchema }, async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => this.#withEpoch(optionalStringArgument(asRecord(arguments_), 'epoch'), async (epochId) => ({
        artifact: await this.#artifacts.inspect(epochId),
      }))));
    server.registerTool('mcp_servers_list', { inputSchema: mcpServersListSchema }, async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => this.#withEpoch(optionalStringArgument(asRecord(arguments_), 'epoch'), async (epochId) => ({
        servers: await this.#mcpServers(epochId, stringArgument(asRecord(arguments_), 'target')),
      }))));
    server.registerTool('mcp_invoke', { inputSchema: mcpInvokeSchema }, async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async (signal) => this.#withEpoch(optionalStringArgument(asRecord(arguments_), 'epoch'), async (epochId) => {
        const args = asRecord(arguments_);
        const session = await this.#mcpSessions.open({
          epochId,
          serverName: stringArgument(args, 'server'),
          target: stringArgument(args, 'target'),
        });
        try {
          await session.initialize({ signal });
          return { result: await session.callTool({ arguments: optionalObjectArgument(args, 'arguments'), name: stringArgument(args, 'tool'), signal }) };
        } finally {
          await session.close();
        }
      })));
    server.registerTool('hooks_list', { inputSchema: hooksListSchema }, async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => this.#withEpoch(optionalStringArgument(asRecord(arguments_), 'epoch'), async (epochId) => ({
        hooks: await this.#hooks.list({
          epochId,
          ...(optionalStringArgument(asRecord(arguments_), 'target') === undefined
            ? {}
            : { target: optionalStringArgument(asRecord(arguments_), 'target') }),
        }),
      }))));
    server.registerTool('hook_simulate', { inputSchema: hookSimulateSchema }, async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async (signal) => this.#withEpoch(optionalStringArgument(asRecord(arguments_), 'epoch'), async (epochId) => {
        const args = asRecord(arguments_);
        return {
          simulation: await this.#hooks.simulate({
            epochId,
            hook: stringArgument(args, 'hook'),
            input: { inline: objectArgument(args, 'input') },
            signal,
            target: stringArgument(args, 'target'),
          }),
        };
      })));
    server.registerTool('evals_list', { inputSchema: noArguments }, async (_arguments, context) =>
      this.#tool(context.mcpReq.signal, async () => ({ runs: await this.#evals.list(), suites: await this.#evals.suites() })));
    server.registerTool('eval_run', { inputSchema: evalRunSchema }, async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async (signal) => this.#withEpoch(optionalStringArgument(asRecord(arguments_), 'epoch'), async (_epochId, root) => {
        const args = asRecord(arguments_);
        const caseIds = stringListArgument(args, 'case_ids');
        const suites = stringListArgument(args, 'suites');
        const trials = optionalIntegerArgument(args, 'trials');
        return {
          run: await this.#evals.run({
            artifact: root,
            ...(caseIds === undefined ? {} : { caseIds }),
            ...(suites === undefined ? {} : { suites }),
            ...(trials === undefined ? {} : { trials }),
            signal,
          }),
        };
      })));
    server.registerTool('eval_get', { inputSchema: evalGetSchema }, async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => ({ run: await this.#evals.read(stringArgument(asRecord(arguments_), 'run_id')) })));
    server.registerTool('diagnostics_list', { inputSchema: noArguments }, async (_arguments, context) =>
      this.#tool(context.mcpReq.signal, async () => ({ diagnostics: await this.#diagnostics.list() })));
    return server;
  }

  async #mcpServers(epochId: string, target: string): Promise<unknown> {
    const inspection = await this.#artifacts.inspect(epochId) as Partial<{
      readonly runtime: Readonly<{ readonly mcpServers: readonly Readonly<{ readonly target: string }>[] }>;
    }>;
    return inspection.runtime?.mcpServers.filter((server) => server.target === target) ?? [];
  }

  async #tool(requestSignal: AbortSignal, operation: (signal: AbortSignal) => Promise<unknown>) {
    try {
      return safeToolResult(await this.#operation(requestSignal, operation));
    } catch (error) {
      return failedToolResult(error);
    }
  }

  async #operation<Result>(requestSignal: AbortSignal, operation: (signal: AbortSignal) => Promise<Result>): Promise<Result> {
    if (this.#closing) throw apiError('AGENT_API_CLOSED', 'Agent API is closed.');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, requestSignal]);
    let settle!: () => void;
    const completed = new Promise<void>((resolvePromise) => { settle = resolvePromise; });
    this.#operations.set(controller, completed);
    try {
      return await operation(signal);
    } finally {
      this.#operations.delete(controller);
      settle();
    }
  }

  async #withEpoch<Result>(
    requestedEpochId: string | undefined,
    operation: (epochId: string, root: string) => Promise<Result>,
  ): Promise<Result> {
    const reference = requestedEpochId === undefined
      ? await this.#epochs.acquireActiveEpochReference()
      : await this.#epochs.acquireEpochReference(requestedEpochId);
    try {
      return await operation(reference.epoch.id, reference.root);
    } finally {
      await reference.close();
    }
  }
}
