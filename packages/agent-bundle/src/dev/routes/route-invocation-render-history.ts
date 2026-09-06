/**
 * The one retention policy for a route invocation's render-event history.
 *
 * Every place a render stream is retained — the service's live replay buffer,
 * the completed envelope (`events`), `GET /api/routes/invocations/<id>`, the
 * terminal `final` stream message, and the Workbench's live window — applies
 * this window, so no reader can rehydrate what another evicted. The window is
 * bounded by event count and by serialized bytes; the newest event and the
 * newest document-bearing event (`shell`, `replace`, or `complete`) are never
 * evicted, so a reader always folds to a coherent latest document. Everything
 * older is disposable intermediate history. The final Agent Document itself
 * is retained separately on the envelope (`document`) and is never truncated
 * here: the runtime bounds it (`maxDocumentBytes`) before it reaches us.
 *
 * Browser-safe: no Node imports. The Workbench reaches it through
 * `contracts/invocations.ts`.
 */
import type { AgentDocument, AgentRenderEvent } from '@agent-bundle/runtime';

import { deepFreeze } from '../../core/freeze.ts';

export interface RouteInvocationRenderHistoryLimits {
  /** Serialized UTF-8 bytes of the retained events, summed. */
  readonly maxBytes: number;
  readonly maxEvents: number;
}

/**
 * 256 events and 2 MiB. The window exceeds `maxBytes` only by what its two
 * pinned events need; the runtime caps one event at `maxEventBytes`
 * (1 MiB + 1 KiB), so a runtime-produced window never holds more than
 * 2 MiB + 2 KiB.
 */
export const routeInvocationRenderHistoryLimits: RouteInvocationRenderHistoryLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxEvents: 256,
});

/** What the policy evicted from a completed run; present on the envelope only when something was. */
export interface RouteInvocationRenderRetention {
  /** Serialized bytes of the evicted events. */
  readonly evictedBytes: number;
  /** Render events evicted, oldest first; `events` holds the remaining `producedEvents - evictedEvents`. */
  readonly evictedEvents: number;
  /** Every render event the run published, retained or not. */
  readonly producedEvents: number;
  /** Serialized bytes of the retained `events`. */
  readonly retainedBytes: number;
}

interface RetainedRenderEvent {
  readonly bytes: number;
  readonly event: AgentRenderEvent;
}

/** An immutable retained window; `retainRenderEvent` derives the next one. */
export interface RetainedRenderEvents {
  readonly entries: readonly RetainedRenderEvent[];
  readonly evictedBytes: number;
  readonly evictedEvents: number;
  /** The newest `shell`, `replace`, or `complete` entry, pinned against eviction. */
  readonly latestDocument?: RetainedRenderEvent;
  readonly producedEvents: number;
  readonly retainedBytes: number;
}

export const emptyRetainedRenderEvents: RetainedRenderEvents = Object.freeze({
  entries: Object.freeze([]),
  evictedBytes: 0,
  evictedEvents: 0,
  producedEvents: 0,
  retainedBytes: 0,
});

const encoder = new TextEncoder();

export const renderEventBytes = (event: AgentRenderEvent): number =>
  encoder.encode(JSON.stringify(event)).byteLength;

const bearsDocument = (event: AgentRenderEvent): boolean =>
  event.type === 'shell' || event.type === 'replace' || event.type === 'complete';

/**
 * Appends `event` and evicts the oldest disposable entries until the window
 * fits both bounds again. The newest entry and the pinned document entry are
 * never evicted, so a window can exceed `maxBytes` only when those two alone
 * do. Returns the next window and the evicted events, oldest first.
 */
export const retainRenderEvent = (
  retained: RetainedRenderEvents,
  event: AgentRenderEvent,
  limits: RouteInvocationRenderHistoryLimits = routeInvocationRenderHistoryLimits,
): Readonly<{ readonly evicted: readonly AgentRenderEvent[]; readonly retained: RetainedRenderEvents }> => {
  const entry: RetainedRenderEvent = Object.freeze({ bytes: renderEventBytes(event), event });
  const latestDocument = bearsDocument(event) ? entry : retained.latestDocument;
  const entries = [...retained.entries, entry];
  const evicted: AgentRenderEvent[] = [];
  let retainedBytes = retained.retainedBytes + entry.bytes;
  let evictedBytes = retained.evictedBytes;
  let index = 0;
  while ((entries.length > limits.maxEvents || retainedBytes > limits.maxBytes) && index < entries.length - 1) {
    const candidate = entries[index]!;
    if (candidate === latestDocument) {
      index += 1;
      continue;
    }
    entries.splice(index, 1);
    retainedBytes -= candidate.bytes;
    evictedBytes += candidate.bytes;
    evicted.push(candidate.event);
  }
  return Object.freeze({
    evicted: Object.freeze(evicted),
    retained: Object.freeze({
      entries: Object.freeze(entries),
      evictedBytes,
      evictedEvents: retained.evictedEvents + evicted.length,
      ...(latestDocument === undefined ? {} : { latestDocument }),
      producedEvents: retained.producedEvents + 1,
      retainedBytes,
    }),
  });
};

export const retainedRenderEvents = (retained: RetainedRenderEvents): readonly AgentRenderEvent[] =>
  Object.freeze(retained.entries.map((entry) => entry.event));

/** The document a reader folds to after eviction: the pinned newest `shell`, `replace`, or `complete`. */
export const retainedLatestDocument = (retained: RetainedRenderEvents): AgentDocument | undefined => {
  const event = retained.latestDocument?.event;
  return event === undefined || event.type === 'progress' || event.type === 'error' ? undefined : event.document;
};

/** The envelope's truncation indication; `undefined` while nothing has been evicted. */
export const renderRetention = (retained: RetainedRenderEvents): RouteInvocationRenderRetention | undefined =>
  retained.evictedEvents === 0
    ? undefined
    : deepFreeze({
        evictedBytes: retained.evictedBytes,
        evictedEvents: retained.evictedEvents,
        producedEvents: retained.producedEvents,
        retainedBytes: retained.retainedBytes,
      });
