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
import { isRecord, snapshotStrictJsonValue } from '../core/strict-json.ts';
import {
  diagnosticsListWireDto,
  epochWireIdentities,
  evalRunAdmissionWireDto,
  projectStatusWireDto,
  type AgentApiEpochSummary,
  type AgentApiEvalRunAdmission,
} from './agent-api-wire.ts';
import type { EvalService } from './eval-service.ts';
import type { ProjectStatus } from './types.ts';

export type { AgentApiEpochSummary } from './agent-api-wire.ts';

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
  readonly evals: Pick<EvalService, 'list' | 'read' | 'start' | 'subscribeEvents' | 'suites'>;
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

export type AgentApiCloseFailure = Readonly<{ readonly error: unknown; readonly resource: 'eval' | 'handler' }>;

export class AgentApiCloseError extends Error {
  readonly failures: readonly AgentApiCloseFailure[];

  constructor(failures: readonly AgentApiCloseFailure[]) {
    super('Agent API could not close every operation.');
    this.name = 'AgentApiCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

type AgentApiToolHandler = (
  arguments_: unknown,
  context: { readonly mcpReq: { readonly signal: AbortSignal } },
) => Promise<unknown>;

type AgentApiToolHandlers = Readonly<{
  readonly [Name in AgentApiToolName]: AgentApiToolHandler;
}>;

const apiError = (code: string, message: string): Error & Readonly<{ readonly code: string }> =>
  Object.assign(new Error(message), { code });

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

const argumentAt = (args: unknown, name: string): unknown => {
  if (!isRecord(args)) throw apiError('AGENT_API_ARGUMENT_INVALID', 'Tool arguments are not valid.');
  return args[name];
};

const stringArgument = (args: unknown, name: string): string => {
  const value = argumentAt(args, name);
  if (typeof value !== 'string') throw apiError('AGENT_API_ARGUMENT_INVALID', 'Tool arguments are not valid.');
  return value;
};

const optionalStringArgument = (args: unknown, name: string): string | undefined => {
  const value = argumentAt(args, name);
  if (value === undefined) return undefined;
  return typeof value === 'string'
    ? value
    : (() => { throw apiError('AGENT_API_ARGUMENT_INVALID', 'Tool arguments are not valid.'); })();
};

const objectArgument = (args: unknown, name: string): Record<string, unknown> => {
  const value = argumentAt(args, name);
  if (!isRecord(value)) {
    throw apiError('AGENT_API_ARGUMENT_INVALID', 'Tool arguments are not valid.');
  }
  return value as Record<string, unknown>;
};

const optionalObjectArgument = (args: unknown, name: string): Record<string, unknown> => {
  if (argumentAt(args, name) === undefined) return {};
  return objectArgument(args, name);
};

const stringListArgument = (args: unknown, name: string): readonly string[] | undefined => {
  const value = argumentAt(args, name);
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw apiError('AGENT_API_ARGUMENT_INVALID', 'Tool arguments are not valid.');
  }
  return Object.freeze([...value]);
};

const optionalIntegerArgument = (args: unknown, name: string): number | undefined => {
  const value = argumentAt(args, name);
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
  let current = error;
  for (let depth = 0; depth < 2; depth += 1) {
    const code = ownDataProperty(current, 'code');
    if (typeof code === 'string' && stableErrorCodes.has(code as never)) return code;
    current = ownDataProperty(current, 'cause');
    if (current === undefined) break;
  }
  return 'AGENT_API_OPERATION_FAILED';
};

const safeToolResult = (value: unknown) => {
  const snapshot = snapshotStrictJsonValue(value === undefined ? null : value);
  const structured = isRecord(snapshot) ? snapshot : Object.freeze({ value: snapshot });
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
 * Stateless MCP facade over the already-owned development services. The SDK
 * factory must return a fresh McpServer per HTTP request (it connect()s that
 * instance to a one-shot transport and close()s it after the exchange); tool
 * closures are built once and re-registered. The API only leases epochs and
 * never owns those services.
 */
export class AgentApi {
  readonly #artifacts: AgentApiOptions['artifacts'];
  #closePromise: Promise<void> | undefined;
  #closing = false;
  readonly #coordinator: AgentApiOptions['coordinator'];
  readonly #diagnostics: AgentApiOptions['diagnostics'];
  readonly #evalLifecycleFailures = new Set<unknown>();
  readonly #evalLifecycles = new Map<AbortController, Promise<void>>();
  readonly #epochs: AgentApiEpochStore;
  readonly #evals: AgentApiOptions['evals'];
  readonly #handler: McpHttpHandler;
  readonly #hooks: AgentApiOptions['hooks'];
  readonly #nodeHandler: NodeMcpRequestHandler;
  readonly #operations = new Map<AbortController, Promise<void>>();
  readonly #mcpSessions: AgentApiMcpSessions;
  readonly #skills: AgentApiOptions['skills'];
  readonly #token: string;
  readonly #tools: AgentApiToolHandlers;
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
    this.#tools = this.#createToolRegistrations();
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
    const published = Promise.withResolvers<void>();
    this.#closePromise = published.promise;
    void this.#close().then(published.resolve, published.reject);
    return published.promise;
  }

  async #close(): Promise<void> {
    for (const operation of this.#operations.keys()) {
      operation.abort(apiError('AGENT_API_CLOSED', 'Agent API is closed.'));
    }
    for (const lifecycle of this.#evalLifecycles.keys()) {
      lifecycle.abort(apiError('AGENT_API_CLOSED', 'Agent API is closed.'));
    }
    const handler = await Promise.allSettled([this.#handler.close()]);
    while (this.#operations.size > 0 || this.#evalLifecycles.size > 0) {
      for (const operation of this.#operations.keys()) {
        operation.abort(apiError('AGENT_API_CLOSED', 'Agent API is closed.'));
      }
      for (const lifecycle of this.#evalLifecycles.keys()) {
        lifecycle.abort(apiError('AGENT_API_CLOSED', 'Agent API is closed.'));
      }
      await Promise.allSettled([...this.#operations.values(), ...this.#evalLifecycles.values()]);
    }
    const failures: AgentApiCloseFailure[] = [
      ...handler.flatMap((result): readonly AgentApiCloseFailure[] => result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: 'handler' as const })]
        : []),
      ...[...this.#evalLifecycleFailures].map((error) => Object.freeze({ error, resource: 'eval' as const })),
    ];
    if (failures.length > 0) throw new AgentApiCloseError(failures);
  }

  #createServer(): McpServer {
    // createMcpHandler({ legacy: 'stateless' }) connect()s a factory product to a
    // fresh transport and close()s that product after the POST; a shared instance
    // would be torn down on the first request.
    const server = new McpServer({ name: 'agent-bundle', version: this.#version });
    const tools = this.#tools;
    server.registerTool('project_status', { inputSchema: noArguments }, tools.project_status as never);
    server.registerTool('skills_list', { inputSchema: skillListSchema }, tools.skills_list as never);
    server.registerTool('skill_inspect', { inputSchema: skillInspectSchema }, tools.skill_inspect as never);
    server.registerTool('artifacts_list', { inputSchema: noArguments }, tools.artifacts_list as never);
    server.registerTool('artifact_inspect', { inputSchema: artifactInspectSchema }, tools.artifact_inspect as never);
    server.registerTool('mcp_servers_list', { inputSchema: mcpServersListSchema }, tools.mcp_servers_list as never);
    server.registerTool('mcp_invoke', { inputSchema: mcpInvokeSchema }, tools.mcp_invoke as never);
    server.registerTool('hooks_list', { inputSchema: hooksListSchema }, tools.hooks_list as never);
    server.registerTool('hook_simulate', { inputSchema: hookSimulateSchema }, tools.hook_simulate as never);
    server.registerTool('evals_list', { inputSchema: noArguments }, tools.evals_list as never);
    server.registerTool('eval_run', { inputSchema: evalRunSchema }, tools.eval_run as never);
    server.registerTool('eval_get', { inputSchema: evalGetSchema }, tools.eval_get as never);
    server.registerTool('diagnostics_list', { inputSchema: noArguments }, tools.diagnostics_list as never);
    return server;
  }

  #createToolRegistrations(): AgentApiToolHandlers {
    return Object.freeze({
    project_status: async (_arguments, context) =>
      this.#tool(context.mcpReq.signal, () => Promise.resolve({ status: projectStatusWireDto(this.#coordinator.status()) })),
    skills_list: async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => this.#withEpoch(optionalStringArgument(arguments_, 'epoch'), async (epochId) => ({
        skills: await this.#skills.generatedTree(epochId, stringArgument(arguments_, 'target')),
      }))),
    skill_inspect: async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => this.#withEpoch(optionalStringArgument(arguments_, 'epoch'), async (epochId) => ({
        skill: await this.#skills.generated(
          epochId,
          stringArgument(arguments_, 'target'),
          stringArgument(arguments_, 'skill_id'),
        ),
      }))),
    artifacts_list: async (_arguments, context) =>
      this.#tool(context.mcpReq.signal, async () => ({ epochs: epochWireIdentities(await this.#epochs.listEpochs()) })),
    artifact_inspect: async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => this.#withEpoch(optionalStringArgument(arguments_, 'epoch'), async (epochId) => ({
        artifact: await this.#artifacts.inspect(epochId),
      }))),
    mcp_servers_list: async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => this.#withEpoch(optionalStringArgument(arguments_, 'epoch'), async (epochId) => ({
        servers: await this.#mcpServers(epochId, stringArgument(arguments_, 'target')),
      }))),
    mcp_invoke: async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async (signal) => this.#withEpoch(optionalStringArgument(arguments_, 'epoch'), async (epochId) => {
        const session = await this.#mcpSessions.open({
          epochId,
          serverName: stringArgument(arguments_, 'server'),
          target: stringArgument(arguments_, 'target'),
        });
        try {
          await session.initialize({ signal });
          return { result: await session.callTool({ arguments: optionalObjectArgument(arguments_, 'arguments'), name: stringArgument(arguments_, 'tool'), signal }) };
        } finally {
          await session.close();
        }
      })),
    hooks_list: async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => this.#withEpoch(optionalStringArgument(arguments_, 'epoch'), async (epochId) => {
        const target = optionalStringArgument(arguments_, 'target');
        return {
          hooks: await this.#hooks.list({
            epochId,
            ...(target === undefined ? {} : { target }),
          }),
        };
      })),
    hook_simulate: async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async (signal) => this.#withEpoch(optionalStringArgument(arguments_, 'epoch'), async (epochId) => {
        return {
          simulation: await this.#hooks.simulate({
            epochId,
            hook: stringArgument(arguments_, 'hook'),
            input: { inline: objectArgument(arguments_, 'input') },
            signal,
            target: stringArgument(arguments_, 'target'),
          }),
        };
      })),
    evals_list: async (_arguments, context) =>
      this.#tool(context.mcpReq.signal, async () => {
        const [runs, suites] = await Promise.all([this.#evals.list(), this.#evals.suites()]);
        return { runs, suites };
      }),
    eval_run: async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, (signal) => this.#admitEvalRun(arguments_, signal)),
    eval_get: async (arguments_, context) =>
      this.#tool(context.mcpReq.signal, async () => ({ run: await this.#evals.read(stringArgument(arguments_, 'run_id')) })),
    diagnostics_list: async (_arguments, context) =>
      this.#tool(context.mcpReq.signal, async () => ({ diagnostics: diagnosticsListWireDto(await this.#diagnostics.list()) })),
    });
  }

  /**
   * Admission/subscription/terminal-release protocol for one background eval
   * run: lease the epoch, admit under a lifecycle signal (request cancellation
   * governs admission only), subscribe to run events, and release the
   * subscription and epoch lease exactly once — at the run's terminal event,
   * or immediately when admission or subscription fails before release began.
   */
  async #admitEvalRun(arguments_: unknown, signal: AbortSignal): Promise<{ run: AgentApiEvalRunAdmission }> {
    const caseIds = stringListArgument(arguments_, 'case_ids');
    const suites = stringListArgument(arguments_, 'suites');
    const trials = optionalIntegerArgument(arguments_, 'trials');
    const requestedEpochId = optionalStringArgument(arguments_, 'epoch');
    const reference = requestedEpochId === undefined
      ? await this.#epochs.acquireActiveEpochReference()
      : await this.#epochs.acquireEpochReference(requestedEpochId);
    const lifecycle = new AbortController();
    const lifecycleSettled = Promise.withResolvers<void>();
    const completeLifecycle = (): void => {
      if (this.#evalLifecycles.delete(lifecycle)) lifecycleSettled.resolve();
    };
    let releaseStarted = false;
    let subscription: Awaited<ReturnType<AgentApiOptions['evals']['subscribeEvents']>> | undefined;
    try {
      // Request cancellation governs admission only; an admitted run belongs to its lifecycle.
      signal.throwIfAborted();
      this.#evalLifecycles.set(lifecycle, lifecycleSettled.promise);
      const admission = await this.#evals.start({
        artifact: reference.root,
        ...(caseIds === undefined ? {} : { caseIds }),
        harness: 'deterministic',
        ...(suites === undefined ? {} : { suites }),
        ...(trials === undefined ? {} : { trials }),
        signal: lifecycle.signal,
      });
      subscription = await this.#evals.subscribeEvents(admission.run.id, 0);
      const eventSubscription = subscription;
      let released: Promise<void> | undefined;
      const release = (): Promise<void> => {
        releaseStarted = true;
        released ??= Promise.allSettled([
          Promise.resolve().then(() => eventSubscription.close()),
          reference.close(),
        ]).then((results) => {
          const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
          if (failures.length > 0) {
            throw new AggregateError(failures, 'Agent API eval lifecycle cleanup failed.', { cause: failures[0] });
          }
        }).catch((error) => {
          this.#evalLifecycleFailures.add(error);
          throw error;
        }).finally(completeLifecycle);
        return released;
      };
      const terminal = (kind: string): boolean =>
        kind === 'run.cancelled' || kind === 'run.completed' || kind === 'run.failed';
      if (eventSubscription.replay.events.some((event) => terminal(event.kind))) await release();
      else eventSubscription.activate((event) => {
        if (terminal(event.kind)) void release().catch(() => undefined);
      });
      return { run: evalRunAdmissionWireDto(admission.run) };
    } catch (error) {
      lifecycle.abort(error);
      completeLifecycle();
      if (!releaseStarted) {
        const closingSubscription = subscription;
        const cleanup = await Promise.allSettled([
          ...(closingSubscription === undefined ? [] : [Promise.resolve().then(() => closingSubscription.close())]),
          reference.close(),
        ]);
        const failures = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length > 0) {
          throw new AggregateError([error, ...failures], 'Agent API eval admission and epoch release both failed.', { cause: error });
        }
      }
      throw error;
    }
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
