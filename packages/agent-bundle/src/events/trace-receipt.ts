import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentLineage, Observed } from '@agent-bundle/runtime';

import type { RequestLineageProvenance, RequestProvenanceAxis } from '../contracts/request-provenance.ts';
import { isLoopbackHttpOrigin } from '../core/loopback-origin.ts';
import type { EventTraceEvent, EventTraceExecution, EventTraceObserver } from './trace.ts';

/**
 * The receipt a host-invoked hook execution posts to the developer's dev
 * server (#600 PR 2, lane T7). A hook wrapper runs in the host's own process
 * tree, so the kernel {@link EventTraceEvent}s it emits are invisible to the
 * Workbench unless the wrapper carries them out: this module is that carrier.
 *
 * The wire shape is deliberately slim — the execution identity, the kernel's
 * events without their repeated `execution`, the host/session/request ids the
 * native payload names, and the lineage axis the runtime resolved. Never the
 * payload body, tool input or output, the environment, or a filesystem path.
 *
 * Resolution is developer-local by construction: the wrapper reports only
 * when it can find a receipt endpoint — the `AGENT_BUNDLE_DEV_TRACE_URL` /
 * `AGENT_BUNDLE_DEV_TRACE_TOKEN` pair a dev-server-spawned simulation sets,
 * or, for a host's own invocation, the dev install marker beside the wrapper
 * (`.agent-bundle-dev.json`, written by the dev host installer) pointing at
 * the project whose dev server published `<project>/.agent-bundle/hook-receipts.json`.
 * A production install has neither and pays one failed `stat`.
 */

export const EVENT_TRACE_RECEIPT_VERSION = 1 as const;
/** The authenticated foreground route the receipt is posted to. */
export const EVENT_TRACE_RECEIPT_PATH = '/api/trace/receipts';
/** Largest receipt body the dev server accepts. */
export const EVENT_TRACE_RECEIPT_MAX_BYTES = 16 * 1024;
export const EVENT_TRACE_RECEIPT_URL_ENV = 'AGENT_BUNDLE_DEV_TRACE_URL';
export const EVENT_TRACE_RECEIPT_TOKEN_ENV = 'AGENT_BUNDLE_DEV_TRACE_TOKEN';
/** `<projectRoot>/.agent-bundle/<file>`: the endpoint record the dev server publishes for its attached hosts. */
export const EVENT_TRACE_RECEIPT_ENDPOINT_FILE = 'hook-receipts.json';
/**
 * The dev host installer's marker at the installed bundle root
 * (`DEV_INSTALL_MARKER` in `dev/host-install-manager.ts`; spelled here so the
 * wrapper bundle does not pull the installer in — `hook-receipts.test.ts`
 * pins the two equal).
 */
export const DEV_INSTALL_MARKER_FILE = '.agent-bundle-dev.json';
/** How long a wrapper waits on the receipt post before letting the host go. */
export const EVENT_TRACE_RECEIPT_TIMEOUT_MS = 750;

export interface EventTraceReceiptEndpoint {
  readonly token: string;
  /** A loopback HTTP origin (`http://127.0.0.1:<port>`). */
  readonly url: string;
}

/** The ids the native payload names, per `docs/entry-conventions.md`; never the payload itself. */
export interface EventTraceReceiptIdentity {
  /** Claude/Codex `agent_id` else `session_id`; Cursor `conversation_id`. */
  readonly conversationId?: string;
  /** The host's tool-call id (`tool_use_id` / `tool_call_id`) when the event carries one. */
  readonly requestId?: string;
  /** `session_id`, else Cursor's `conversation_id`. */
  readonly sessionId?: string;
}

type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown ? Omit<Value, Key> : never;

/** A kernel event on the wire: the execution identity travels once, on the receipt. */
export type EventTraceReceiptEvent = DistributiveOmit<EventTraceEvent, 'execution'>;

export interface EventTraceReceipt {
  readonly events: readonly EventTraceReceiptEvent[];
  readonly execution: EventTraceExecution;
  readonly identity: EventTraceReceiptIdentity;
  readonly lineage: RequestProvenanceAxis<RequestLineageProvenance>;
  /** Wall-clock instant of `events[0]`; each event's `at` is the tracer's monotonic clock, so `at - events[0].at` offsets from here. */
  readonly startedAt: string;
  readonly version: typeof EVENT_TRACE_RECEIPT_VERSION;
}

export interface OpenEventTraceReceiptOptions {
  /** `import.meta.url` of the wrapper; the dev install marker is looked up beside its directory. */
  readonly anchor: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly execution: EventTraceExecution;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

/**
 * One execution's receipt in the making. `observer` is handed to the tracer;
 * `identity` and `lineage` project what the wrapper learned; `send` posts
 * once and never throws — a hook's exit code belongs to the route, not to
 * the Workbench.
 */
export interface EventTraceReceiptRecorder {
  readonly endpoint: EventTraceReceiptEndpoint;
  readonly observer: EventTraceObserver;
  identity(native: Readonly<Record<string, unknown>>): void;
  lineage(observed: Observed<AgentLineage>): void;
  send(): Promise<void>;
}

const nativeString = (native: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = native[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/** The host/session/request ids a native payload names, by the host vocabulary in `docs/entry-conventions.md`. */
export const eventTraceReceiptIdentity = (
  host: string,
  native: Readonly<Record<string, unknown>>,
): EventTraceReceiptIdentity => {
  const sessionId = nativeString(native, 'session_id') ?? nativeString(native, 'conversation_id');
  const conversationId = host === 'cursor'
    ? nativeString(native, 'conversation_id')
    : nativeString(native, 'agent_id') ?? nativeString(native, 'session_id');
  const requestId = nativeString(native, 'tool_use_id') ?? nativeString(native, 'tool_call_id');
  return Object.freeze({
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
};

/** The lineage axis on the wire: the runtime's `Observed<AgentLineage>` without its live `tree`. */
export const eventTraceReceiptLineage = (
  observed: Observed<AgentLineage>,
): RequestProvenanceAxis<RequestLineageProvenance> => {
  if (observed.state === 'unavailable') return Object.freeze({ reason: observed.reason, state: 'unavailable' });
  const { conversation, depth, generation, parent, resolution, root, subagent } = observed.value;
  return Object.freeze({
    source: observed.source,
    state: 'available',
    value: Object.freeze({
      conversation,
      depth,
      ...(generation === undefined ? {} : { generation }),
      ...(parent === undefined ? {} : { parent }),
      resolution,
      root,
      ...(subagent === undefined
        ? {}
        : {
            subagent: Object.freeze({
              id: subagent.id,
              ...(subagent.isParallelWorker === undefined ? {} : { isParallelWorker: subagent.isParallelWorker }),
              ...(subagent.toolCallId === undefined ? {} : { toolCallId: subagent.toolCallId }),
              ...(subagent.type === undefined ? {} : { type: subagent.type }),
            }),
          }),
    }),
  });
};

const receiptEndpoint = (url: unknown, token: unknown): EventTraceReceiptEndpoint | undefined =>
  isLoopbackHttpOrigin(url) && typeof token === 'string' && token.trim() !== ''
    ? Object.freeze({ token, url })
    : undefined;

const readJsonRecord = async (path: string): Promise<Readonly<Record<string, unknown>> | undefined> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Readonly<Record<string, unknown>>)
    : undefined;
};

/** The endpoint record a dev server publishes for its attached hosts. */
export const eventTraceReceiptEndpointPath = (projectRoot: string): string =>
  join(projectRoot, '.agent-bundle', EVENT_TRACE_RECEIPT_ENDPOINT_FILE);

/**
 * Finds the dev server a hook execution should report to, or `undefined` in
 * production. Environment first (a dev-server-spawned simulation), then the
 * dev install marker beside the wrapper's directory, whose `projectRoot`
 * names the project whose running dev server published its endpoint record.
 */
export const resolveEventTraceReceiptEndpoint = async (
  options: Pick<OpenEventTraceReceiptOptions, 'anchor' | 'env'>,
): Promise<EventTraceReceiptEndpoint | undefined> => {
  const fromEnv = receiptEndpoint(options.env[EVENT_TRACE_RECEIPT_URL_ENV], options.env[EVENT_TRACE_RECEIPT_TOKEN_ENV]);
  if (fromEnv !== undefined) return fromEnv;
  let markerPath: string;
  try {
    markerPath = fileURLToPath(new URL(`../${DEV_INSTALL_MARKER_FILE}`, options.anchor));
  } catch {
    return undefined;
  }
  const marker = await readJsonRecord(markerPath);
  if (marker === undefined || typeof marker.projectRoot !== 'string' || marker.projectRoot === '') return undefined;
  const record = await readJsonRecord(eventTraceReceiptEndpointPath(marker.projectRoot));
  return record === undefined ? undefined : receiptEndpoint(record.url, record.token);
};

const withoutExecution = (event: EventTraceEvent): EventTraceReceiptEvent => {
  const { execution: _execution, ...rest } = event;
  return rest;
};

/**
 * Opens the receipt for one execution: resolves the endpoint and, when there
 * is one, returns the recorder whose `observer` the tracer feeds. `undefined`
 * means no dev server is listening and the wrapper traces nothing.
 */
export const openEventTraceReceipt = async (
  options: OpenEventTraceReceiptOptions,
): Promise<EventTraceReceiptRecorder | undefined> => {
  const endpoint = await resolveEventTraceReceiptEndpoint(options);
  if (endpoint === undefined) return undefined;
  const now = options.now ?? (() => new Date());
  const post = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? EVENT_TRACE_RECEIPT_TIMEOUT_MS;
  const events: EventTraceReceiptEvent[] = [];
  let startedAt: string | undefined;
  let identity: EventTraceReceiptIdentity = Object.freeze({});
  let lineage: RequestProvenanceAxis<RequestLineageProvenance> = Object.freeze({
    reason: 'not-provided',
    state: 'unavailable',
  });
  let sent = false;
  const recorder: EventTraceReceiptRecorder = {
    endpoint,
    identity: (native) => {
      identity = eventTraceReceiptIdentity(options.execution.host, native);
    },
    lineage: (observed) => {
      lineage = eventTraceReceiptLineage(observed);
    },
    observer: (event) => {
      startedAt ??= now().toISOString();
      events.push(withoutExecution(event));
    },
    send: async () => {
      if (sent || startedAt === undefined) return;
      sent = true;
      const receipt: EventTraceReceipt = {
        events,
        execution: options.execution,
        identity,
        lineage,
        startedAt,
        version: EVENT_TRACE_RECEIPT_VERSION,
      };
      const body = JSON.stringify(receipt);
      if (Buffer.byteLength(body, 'utf8') > EVENT_TRACE_RECEIPT_MAX_BYTES) return;
      try {
        await post(new URL(EVENT_TRACE_RECEIPT_PATH, endpoint.url), {
          body,
          headers: {
            authorization: `Bearer ${endpoint.token}`,
            'content-type': 'application/json',
          },
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // The Workbench is an observer of the hook, never a participant in its outcome.
      }
    },
  };
  return Object.freeze(recorder);
};
