import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentLineage, Observed } from '@agent-bundle/runtime';

import type { RequestLineageProvenance, RequestProvenanceAxis } from '../contracts/request-provenance.ts';
import { isLoopbackHttpOrigin } from '../core/loopback-origin.ts';
import type { EventTraceEvent, EventTraceExecution, EventTraceObserver } from './trace.ts';

/**
 * Carries a host hook's kernel events to an attached development server.
 * Receipts contain execution and correlation metadata, never payloads,
 * environment values, or filesystem paths.
 */

export const EVENT_TRACE_RECEIPT_VERSION = 1 as const;
export const EVENT_TRACE_RECEIPT_PATH = '/api/trace/receipts';
export const EVENT_TRACE_RECEIPT_MAX_BYTES = 16 * 1024;
export const EVENT_TRACE_RECEIPT_URL_ENV = 'AGENT_BUNDLE_DEV_TRACE_URL';
export const EVENT_TRACE_RECEIPT_TOKEN_ENV = 'AGENT_BUNDLE_DEV_TRACE_TOKEN';
export const EVENT_TRACE_RECEIPT_ENDPOINT_FILE = 'hook-receipts.json';
/**
 * The dev host installer's marker at the installed bundle root
 * (`DEV_INSTALL_MARKER` in `dev/host-install-manager.ts`; spelled here so the
 * wrapper bundle does not pull the installer in — `hook-receipts.test.ts`
 * pins the two equal).
 */
export const DEV_INSTALL_MARKER_FILE = '.agent-bundle-dev.json';
export const EVENT_TRACE_RECEIPT_TIMEOUT_MS = 750;

export interface EventTraceReceiptEndpoint {
  readonly token: string;
  readonly url: string;
}

export interface EventTraceReceiptIdentity {
  readonly conversationId?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
}

type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown ? Omit<Value, Key> : never;

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
  if (record === undefined || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid)) return undefined;
  if (record.pid !== process.pid) {
    try {
      process.kill(record.pid, 0);
    } catch {
      return undefined;
    }
  }
  return receiptEndpoint(record.url, record.token);
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
  const post = options.fetch ?? fetch;
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
      startedAt ??= new Date().toISOString();
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
          signal: AbortSignal.timeout(EVENT_TRACE_RECEIPT_TIMEOUT_MS),
        });
      } catch {
        // The Workbench is an observer of the hook, never a participant in its outcome.
      }
    },
  };
  return Object.freeze(recorder);
};
