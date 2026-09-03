import { basename, dirname, resolve } from 'node:path';

import {
  agent,
  type AgentRequestContext,
  type AgentStateHandle,
  type JsonObject,
  type JsonValue,
} from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';

import { appendLogLine, resolveLog, type ResolvedLog } from './log.js';
import type { CaptureEvents, CaptureSummary, CapturesState } from './state.js';

export type CaptureKind = CaptureSummary['kind'];
export type CaptureRuntime = CaptureSummary['runtime'];

/** Native payload keys that identify a conversation, agent, turn, or tool call on some host. */
export const IDENTITY_KEYS = Object.freeze([
  'conversation_id',
  'generation_id',
  'session_id',
  'subagent_id',
  'parent_conversation_id',
  'parent_session_id',
  'tool_call_id',
  'tool_use_id',
  'agent_id',
  'agent_type',
  'subagent_type',
  'is_parallel_worker',
  'is_background_agent',
  'transcript_path',
  'agent_transcript_path',
  'turn_id',
  'thread_id',
  'task_id',
  'teammate_name',
  'team_name',
  'model',
  'user_email',
  'cwd',
  'workspace_roots',
  'source',
  'hook_event_name',
] as const);

const ENV_NAME_PREFIXES = Object.freeze([
  'CURSOR_',
  'CLAUDE_',
  'CODEX_',
  'AGENT_BUNDLE_',
  'PLUGIN_',
  'HOST_TEST_',
  'MCP_',
  'ANTHROPIC_',
  'OPENAI_',
] as const);

// `progressToken` is MCP plumbing, not a credential.
const SECRET_KEY = /(?:(?<!progress)(?<!progress_)token|secret|password|passwd|api[_-]?key|authorization|credential|cookie|private[_-]?key)/iu;
const SECRET_VALUE = /^(?:Bearer\s+\S+|(?:sk|ghp|gho|ghu|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/u;

export const redactSecrets = (value: JsonValue, key = ''): JsonValue => {
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key) || SECRET_VALUE.test(value)) return '[redacted]';
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, key));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [nestedKey, nested] of Object.entries(value)) {
      out[nestedKey] = redactSecrets(nested, nestedKey);
    }
    return out;
  }
  return value;
};

/** Variable names only — values never leave the process, redacted or not. */
export const environmentNames = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] => Object.keys(environment)
  .filter((name) => ENV_NAME_PREFIXES.some((prefix) => name.startsWith(prefix)) || name === 'TERM_PROGRAM')
  .sort((left, right) => left.localeCompare(right));

const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;

export const extractIds = (native: Readonly<Record<string, unknown>>): Record<string, string | boolean | number | null> => {
  const ids: Record<string, string | boolean | number | null> = {};
  for (const key of IDENTITY_KEYS) {
    const value = native[key];
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' || value === null) {
      ids[key] = typeof value === 'string' && value.length > 1024 ? `${value.slice(0, 1021)}...` : value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      ids[key] = value.join('\u0000');
    }
  }
  return ids;
};

const detectRuntime = (context: AgentRequestContext, argv: readonly string[]): CaptureRuntime => {
  const entry = argv[1];
  const leaf = entry === undefined ? undefined : basename(dirname(resolve(entry)));
  switch (context.invocation.kind) {
    case 'event':
      return leaf === 'hooks' ? 'standalone-hook' : 'shared-runtime';
    case 'tool':
      return 'mcp-server';
    case 'cli':
      return 'cli';
    case 'script':
      return 'script';
    case 'workbench':
      return 'unknown';
    default: {
      const unreachable: never = context.invocation.kind;
      throw new Error(`Unhandled invocation kind ${String(unreachable)}`);
    }
  }
};

/** The framework request context as the route observed it, minus non-data members. */
export const snapshotRequest = (context: AgentRequestContext): JsonObject => {
  const lineage = (context as AgentRequestContext & { readonly lineage?: unknown }).lineage;
  return {
    actor: asJson(context.actor),
    capabilities: asJson(context.capabilities),
    hasNotices: context.notices !== undefined,
    hasState: context.state !== undefined,
    host: asJson(context.host),
    invocation: asJson(context.invocation),
    ...(lineage === undefined ? {} : { lineage: asJson(lineage) }),
    providers: {
      keys: Object.keys(context.providers).sort((left, right) => left.localeCompare(right)),
      processLifetime: asJson(context.providers.processLifetime),
    },
    session: asJson(context.session),
    workspace: asJson(context.workspace),
  };
};

export interface CaptureInput {
  readonly event?: AgentEventRouteProps;
  readonly kind: CaptureKind;
  /** Anything the surface saw that the framework context does not carry (raw MCP `extra`, argv). */
  readonly observed?: JsonObject;
}

export interface CaptureRecord {
  readonly env: { readonly names: readonly string[] };
  readonly event?: { readonly canonical: JsonValue; readonly native: JsonValue };
  readonly host: string;
  readonly ids: Record<string, string | boolean | number | null>;
  readonly kind: CaptureKind;
  readonly observed?: JsonObject;
  readonly process: {
    readonly cwd: string;
    readonly entry: string | null;
    readonly execPath: string;
    readonly nodeVersion: string;
    readonly pid: number;
    readonly ppid: number;
    readonly uptimeMs: number;
  };
  readonly recordedAt: string;
  readonly request: JsonObject;
  readonly runtime: CaptureRuntime;
  readonly sequence: number;
}

let sequence = 0;

const processFacts = (): CaptureRecord['process'] => ({
  cwd: process.cwd(),
  entry: process.argv[1] ?? null,
  execPath: process.execPath,
  nodeVersion: process.version,
  pid: process.pid,
  ppid: process.ppid,
  uptimeMs: Math.round(process.uptime() * 1000),
});

/**
 * Records an observation from a surface that has no framework request scope
 * (the hand-rolled `host-test-raw` stdio server): the raw MCP envelope is the
 * whole point, so it is stored verbatim minus secret-looking values.
 */
export const captureRaw = (host: string, observed: JsonObject): { readonly log: ResolvedLog; readonly record: CaptureRecord } => {
  const log = resolveLog();
  sequence += 1;
  const record: CaptureRecord = {
    env: { names: environmentNames() },
    host,
    ids: {},
    kind: 'mcp',
    observed: redactSecrets(observed) as JsonObject,
    process: processFacts(),
    recordedAt: new Date().toISOString(),
    request: { unavailable: 'hand-rolled stdio server: no framework request context is mounted' },
    runtime: 'mcp-server',
    sequence,
  };
  appendLogLine(log, asJson(record));
  return { log, record };
};

export interface CaptureOutcome {
  readonly log: ResolvedLog;
  readonly record: CaptureRecord;
  readonly state:
    | { readonly revision: number; readonly state: 'committed' }
    | { readonly reason: string; readonly state: 'unavailable' };
}

const captureState = (context: AgentRequestContext): AgentStateHandle<CapturesState, CaptureEvents> | undefined =>
  context.state as AgentStateHandle<CapturesState, CaptureEvents> | undefined;

/**
 * Records one observation: the complete raw host payload, the framework's
 * canonical request context, process identity, and environment variable
 * names. The plain NDJSON line is written first (it is the complete record);
 * the durable kernel keeps a bounded summary for cross-process correlation.
 */
export const capture = async (input: CaptureInput): Promise<CaptureOutcome> => {
  const context = await agent();
  const log = resolveLog();
  const runtime = detectRuntime(context, process.argv);
  const native = input.event?.native ?? {};
  const host = context.host.state === 'available'
    ? context.host.value.name
    : input.event?.canonical.provenance.host ?? 'unknown';
  sequence += 1;
  const recordedAt = new Date().toISOString();
  const record: CaptureRecord = {
    env: { names: environmentNames() },
    ...(input.event === undefined
      ? {}
      : {
          event: {
            canonical: asJson(input.event.canonical),
            native: redactSecrets(asJson(input.event.native)),
          },
        }),
    host,
    ids: extractIds(native),
    kind: input.kind,
    ...(input.observed === undefined ? {} : { observed: redactSecrets(input.observed) as JsonObject }),
    process: processFacts(),
    recordedAt,
    request: snapshotRequest(context),
    runtime,
    sequence,
  };
  appendLogLine(log, asJson(record));

  const state = captureState(context);
  if (state === undefined) {
    return { log, record, state: { reason: 'no state handle mounted on this request', state: 'unavailable' } };
  }
  const summary: CaptureSummary = {
    ...(input.event === undefined ? {} : { event: input.event.canonical.event, nativeEvent: input.event.canonical.provenance.nativeEvent }),
    host,
    ids: record.ids,
    invocationId: context.invocation.id,
    kind: input.kind,
    recordedAt,
    runtime,
    sequence,
  };
  try {
    const committed = await state.dispatch('captured', summary, {
      idempotencyKey: `capture:${input.event?.canonical.idempotencyKey ?? context.invocation.id}`,
      signal: context.signal,
    });
    return { log, record, state: { revision: committed.revision, state: 'committed' } };
  } catch (error) {
    return {
      log,
      record,
      state: { reason: error instanceof Error ? error.message : String(error), state: 'unavailable' },
    };
  }
};
