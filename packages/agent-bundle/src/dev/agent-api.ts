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

type AgentApiJsonRecord = Readonly<Record<string, unknown>>;

interface AgentApiDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly recovery?: string;
  readonly severity: 'error' | 'info' | 'warning';
  readonly target?: string;
}

interface AgentApiProjectStatus {
  readonly artifact: unknown;
  readonly build: unknown;
  readonly source: Readonly<{ readonly diagnostics: readonly AgentApiDiagnostic[]; readonly revision?: string; readonly state: string }>;
}

const maximumDiagnosticTextLength = 4_096;
const safeDiagnosticCodePattern = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
const safeDigestPattern = /^[a-f0-9]{64}$/iu;
const safeEpochIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
const safeTargetPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
const safeTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const secretAssignmentPattern = /\b(?:api[_ -]?key|authorization|password|secret|token)\s*(?:=|:)/iu;
const diagnosticMessageFallback = 'Diagnostic details are available in the local workbench.';
const diagnosticRecoveryFallback = 'Recovery guidance is available in the local workbench.';

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

const snapshotValue = (value: unknown): unknown => {
  try {
    return snapshotStrictJsonValue(value);
  } catch {
    return undefined;
  }
};

const snapshotRecord = (value: unknown): AgentApiJsonRecord | undefined => {
  const snapshot = snapshotValue(value);
  return typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot)
    ? snapshot as AgentApiJsonRecord
    : undefined;
};

const snapshotArray = (value: unknown): readonly unknown[] | undefined => {
  const snapshot = snapshotValue(value);
  return Array.isArray(snapshot) ? snapshot : undefined;
};

const safeDigest = (value: unknown): string | undefined =>
  typeof value === 'string' && safeDigestPattern.test(value) ? value : undefined;

const safeDiagnosticCode = (value: unknown): string | undefined =>
  typeof value === 'string' && safeDiagnosticCodePattern.test(value) ? value : undefined;

const safeEpochId = (value: unknown): string | undefined =>
  typeof value === 'string' && safeEpochIdPattern.test(value) ? value : undefined;

const safeTarget = (value: unknown): string | undefined =>
  typeof value === 'string' && safeTargetPattern.test(value) ? value : undefined;

const safeTimestamp = (value: unknown): string | undefined =>
  typeof value === 'string' && safeTimestampPattern.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : undefined;

/** Messages fail closed: any path-like, control, or secret-assignment text is never partially redacted. */
const safeDiagnosticText = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length <= maximumDiagnosticTextLength &&
    !value.includes('/') && !value.includes('\\') && !hasControlCharacter(value) &&
    !secretAssignmentPattern.test(value)
    ? value
    : fallback;

/** Dedicated, detached DTO: only diagnostic fields that can be safely named reach the wire. */
const diagnosticWireDto = (value: unknown): AgentApiDiagnostic | undefined => {
  const diagnostic = snapshotRecord(value);
  if (diagnostic === undefined) return undefined;
  const code = safeDiagnosticCode(diagnostic.code);
  const severity = diagnostic.severity;
  if (code === undefined || (severity !== 'error' && severity !== 'info' && severity !== 'warning')) return undefined;
  const recovery = typeof diagnostic.recovery === 'string'
    ? safeDiagnosticText(diagnostic.recovery, diagnosticRecoveryFallback)
    : undefined;
  const target = safeTarget(diagnostic.target);
  return Object.freeze({
    code,
    message: safeDiagnosticText(diagnostic.message, diagnosticMessageFallback),
    ...(recovery === undefined ? {} : { recovery }),
    severity,
    ...(target === undefined ? {} : { target }),
  });
};

const diagnosticWireDtos = (value: unknown): readonly AgentApiDiagnostic[] => Object.freeze(
  (snapshotArray(value) ?? []).flatMap((diagnostic) => {
    const projected = diagnosticWireDto(diagnostic);
    return projected === undefined ? [] : [projected];
  }),
);

const diagnosticSummaryWireDto = (value: unknown): AgentApiEpochSummary['diagnostics'] | undefined => {
  const summary = snapshotRecord(value);
  if (summary === undefined) return undefined;
  const errors = summary.errors;
  const infos = summary.infos;
  const warnings = summary.warnings;
  if (![errors, infos, warnings].every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) return undefined;
  return Object.freeze({ errors: errors as number, infos: infos as number, warnings: warnings as number });
};

const targetDigestsWireDto = (value: unknown): Readonly<Record<string, string>> | undefined => {
  const targetDigests = snapshotRecord(value);
  if (targetDigests === undefined) return undefined;
  const entries = Object.entries(targetDigests);
  if (entries.length === 0 || entries.some(([target, digest]) => safeTarget(target) === undefined || safeDigest(digest) === undefined)) {
    return undefined;
  }
  return Object.freeze(Object.fromEntries(entries.map(([target, digest]) => [target, digest as string])));
};

/** Explicit safe epoch identity; manifest/root/source fields are intentionally not represented. */
const epochWireIdentity = (value: unknown): AgentApiEpochSummary | undefined => {
  const epoch = snapshotRecord(value);
  if (epoch === undefined) return undefined;
  const id = safeEpochId(epoch.id);
  if (id === undefined) return undefined;
  const configDigest = safeDigest(epoch.configDigest);
  const createdAt = safeTimestamp(epoch.createdAt);
  const diagnostics = diagnosticSummaryWireDto(epoch.diagnostics);
  const modelDigest = safeDigest(epoch.modelDigest);
  const projectRevision = safeDigest(epoch.projectRevision);
  const targetDigests = targetDigestsWireDto(epoch.targetDigests);
  return Object.freeze({
    ...(configDigest === undefined ? {} : { configDigest }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    id,
    ...(modelDigest === undefined ? {} : { modelDigest }),
    ...(projectRevision === undefined ? {} : { projectRevision }),
    ...(targetDigests === undefined ? {} : { targetDigests }),
  });
};

const epochWireIdentities = (value: unknown): readonly AgentApiEpochSummary[] => Object.freeze(
  (snapshotArray(value) ?? []).flatMap((epoch) => {
    const projected = epochWireIdentity(epoch);
    return projected === undefined ? [] : [projected];
  }),
);

const sourceWireDto = (value: unknown): AgentApiProjectStatus['source'] => {
  const source = snapshotRecord(value);
  const state = source?.state;
  const revision = safeDigest(source?.revision);
  return Object.freeze({
    diagnostics: diagnosticWireDtos(source?.diagnostics),
    ...(revision === undefined ? {} : { revision }),
    state: state === 'invalid' || state === 'ready' || state === 'unknown' ? state : 'unknown',
  });
};

const buildAttemptWireDto = (value: unknown): unknown | undefined => {
  const attempt = snapshotRecord(value);
  if (attempt === undefined) return undefined;
  const outcome = attempt.outcome;
  const id = safeEpochId(attempt.id);
  const sourceRevision = safeDigest(attempt.sourceRevision);
  const startedAt = safeTimestamp(attempt.startedAt);
  if (id === undefined || sourceRevision === undefined || startedAt === undefined ||
    (outcome !== 'failed' && outcome !== 'running' && outcome !== 'succeeded')) return undefined;
  const completedAt = safeTimestamp(attempt.completedAt);
  if (outcome === 'running') {
    return Object.freeze({ diagnostics: diagnosticWireDtos(attempt.diagnostics), id, outcome, sourceRevision, startedAt });
  }
  if (completedAt === undefined) return undefined;
  const result = snapshotRecord(attempt.result);
  const epoch = epochWireIdentity(result?.epoch);
  return Object.freeze({
    completedAt,
    diagnostics: diagnosticWireDtos(attempt.diagnostics),
    id,
    outcome,
    ...(outcome === 'succeeded' && epoch !== undefined ? { result: Object.freeze({ epoch }) } : {}),
    sourceRevision,
    startedAt,
  });
};

const artifactWireDto = (value: unknown): unknown => {
  const artifact = snapshotRecord(value);
  const state = artifact?.state;
  if (artifact === undefined || (state !== 'active' && state !== 'stale')) return Object.freeze({ state: 'missing' });
  const activeEpoch = epochWireIdentity(artifact.activeEpoch);
  const currentSourceRevision = safeDigest(artifact.currentSourceRevision);
  return Object.freeze({
    ...(activeEpoch === undefined ? {} : { activeEpoch }),
    ...(currentSourceRevision === undefined ? {} : { currentSourceRevision }),
    state,
  });
};

const buildWireDto = (value: unknown): unknown => {
  const build = snapshotRecord(value);
  const state = build?.state;
  const activeAttempt = buildAttemptWireDto(build?.activeAttempt);
  const lastAttempt = buildAttemptWireDto(build?.lastAttempt);
  if (state === 'building' && activeAttempt !== undefined) {
    return Object.freeze({ activeAttempt, ...(lastAttempt === undefined ? {} : { lastAttempt }), state });
  }
  if (state === 'failed' && lastAttempt !== undefined) return Object.freeze({ lastAttempt, state });
  return Object.freeze({ ...(lastAttempt === undefined ? {} : { lastAttempt }), state: 'idle' });
};

/** Explicit status DTO that carries only safe state, epoch identity, and projected diagnostics. */
const projectStatusWireDto = (value: unknown): AgentApiProjectStatus => {
  const status = snapshotRecord(value);
  return Object.freeze({
    artifact: artifactWireDto(status?.artifact),
    build: buildWireDto(status?.build),
    source: sourceWireDto(status?.source),
  });
};

/** Flattens only known diagnostic arrays from a direct service result or a ProjectStatus-shaped result. */
const diagnosticsListWireDto = (value: unknown): readonly AgentApiDiagnostic[] => {
  const result = snapshotRecord(value);
  if (result === undefined) return Object.freeze([]);
  const direct = snapshotArray(result.diagnostics);
  if (direct !== undefined) return diagnosticWireDtos(direct);
  const source = snapshotRecord(result.source);
  const build = snapshotRecord(result.build);
  const activeAttempt = snapshotRecord(build?.activeAttempt);
  const lastAttempt = snapshotRecord(build?.lastAttempt);
  return Object.freeze([
    ...diagnosticWireDtos(source?.diagnostics),
    ...diagnosticWireDtos(activeAttempt?.diagnostics),
    ...diagnosticWireDtos(lastAttempt?.diagnostics),
  ]);
};

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
      this.#tool(context.mcpReq.signal, () => Promise.resolve({ status: projectStatusWireDto(this.#coordinator.status()) })));
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
      this.#tool(context.mcpReq.signal, async () => ({ epochs: epochWireIdentities(await this.#epochs.listEpochs()) })));
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
      this.#tool(context.mcpReq.signal, async () => ({ diagnostics: diagnosticsListWireDto(await this.#diagnostics.list()) })));
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
