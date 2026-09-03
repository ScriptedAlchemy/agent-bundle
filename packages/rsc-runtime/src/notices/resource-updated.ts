import { randomUUID } from 'node:crypto';

import type {
  AgentNotice,
  AgentNoticeLedger,
  AgentNoticePrincipal,
} from './contract.js';
import { recipientMatchesPrincipal } from './state.js';

/** The reserved inbox resource URI every generated stateful MCP server registers. */
export const AGENT_NOTICE_INBOX_URI = 'agent-bundle://notices/inbox';

/** The store a long-lived MCP server process opens to observe the ledger it shares with its render worker. */
export interface AgentNoticeInboxStore {
  close(): Promise<void>;
  noticeLedger(): Promise<AgentNoticeLedger>;
}

export interface CreateNoticeInboxSignallerOptions {
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
  readonly store: AgentNoticeInboxStore;
}

export type AgentNoticeInboxSignalOutcome =
  | {
    readonly kind: 'idle';
    readonly reason: 'no-subscription' | 'nothing-eligible';
    readonly revision: number | undefined;
  }
  | { readonly kind: 'signalled'; readonly noticeIds: readonly string[]; readonly revision: number }
  | { readonly error: unknown; readonly kind: 'failed'; readonly stage: 'read' | 'record' | 'send' };

/**
 * One MCP connection's subscription to the notice inbox resource, and the
 * `mcp-resource-updated` delivery route over it (#99 stage 4).
 *
 * The route is honest by construction: a `notifications/resources/updated`
 * signal asks the subscribed client to re-read the inbox, so the ledger
 * records it as an availability receipt on the notices the signal was about
 * and never as delivery. Signals are evaluated only when the owning server
 * finishes a render — an already-connected surface, never an implied timer —
 * and every send is bounded: a notice is signalled at most once per
 * subscription and at most `retryBudget` times durably, `nextAttemptAt`
 * defers it, and expiry, withdrawal, attempts, and acknowledgement remove it.
 * Re-reads of the inbox (exposure receipts) and the availability receipts
 * themselves advance the ledger without producing a further signal, so a
 * subscribed client can never be driven into a refetch loop.
 */
export interface AgentNoticeInboxSignaller {
  readonly inboxUri: typeof AGENT_NOTICE_INBOX_URI;
  readonly subscribed: boolean;
  close(): Promise<void>;
  /**
   * Runs after one completed render: reads the ledger and, when the
   * subscriber has newly eligible pending notices, sends exactly one
   * `resources/updated` through `send` and records the availability receipt.
   * Never throws; failures are returned so the render path stays unaffected.
   */
  observe(send: () => Promise<void>): Promise<AgentNoticeInboxSignalOutcome>;
  /**
   * Records the connection as the inbox subscriber for `principal`. Fails
   * closed: the durable store must be readable before a subscription exists,
   * so an unavailable store yields a rejected subscribe instead of a
   * subscription that could never be honoured.
   */
  subscribe(principal: AgentNoticePrincipal): Promise<void>;
  unsubscribe(): void;
}

interface InboxSubscription {
  readonly id: string;
  readonly principal: AgentNoticePrincipal;
  readonly signalled: Set<string>;
}

const eligibleForSignal = (
  notice: AgentNotice,
  principal: AgentNoticePrincipal,
  nowMs: number,
): boolean => {
  switch (notice.state) {
    case 'pending':
      break;
    case 'attempted':
    case 'expired':
    case 'unavailable':
    case 'withdrawn':
    case 'acknowledged':
      return false;
    default: {
      const exhaustive: never = notice.state;
      return exhaustive;
    }
  }
  if (Date.parse(notice.createdAt) > nowMs) return false;
  if (notice.expiresAt !== undefined && Date.parse(notice.expiresAt) <= nowMs) return false;
  // Not due yet: evaluated only on completed renders; V1 never implies a timer.
  if (notice.nextAttemptAt !== undefined && Date.parse(notice.nextAttemptAt) > nowMs) return false;
  if ((notice.availability?.count ?? 0) >= (notice.retryBudget ?? 1)) return false;
  return recipientMatchesPrincipal(notice.recipient, principal);
};

export const createNoticeInboxSignaller = (
  options: CreateNoticeInboxSignallerOptions,
): AgentNoticeInboxSignaller => {
  const now = options.now ?? ((): Date => new Date());
  let subscription: InboxSubscription | undefined;
  let signalSequence = 0;
  // Observations serialize so two renders completing together cannot both
  // select the same notice and send two signals for one revision.
  let queue: Promise<unknown> = Promise.resolve();

  const observeOnce = async (send: () => Promise<void>): Promise<AgentNoticeInboxSignalOutcome> => {
    const current = subscription;
    if (current === undefined) {
      return Object.freeze({ kind: 'idle', reason: 'no-subscription', revision: undefined });
    }
    let ledger: AgentNoticeLedger;
    let snapshot: Awaited<ReturnType<AgentNoticeLedger['read']>>;
    try {
      ledger = await options.store.noticeLedger();
      snapshot = await ledger.read();
    } catch (error) {
      return Object.freeze({ error, kind: 'failed' as const, stage: 'read' as const });
    }
    const at = now().toISOString();
    const nowMs = Date.parse(at);
    const noticeIds = Object.freeze(snapshot.notices
      .filter((notice) => !current.signalled.has(notice.id) && eligibleForSignal(notice, current.principal, nowMs))
      .map((notice) => notice.id)
      .toSorted((left, right) => left.localeCompare(right)));
    if (noticeIds.length === 0) {
      return Object.freeze({ kind: 'idle', reason: 'nothing-eligible', revision: snapshot.revision });
    }
    // The subscription may have been replaced while the ledger was read; a
    // signal for a stale subscriber must not be sent or recorded.
    if (subscription !== current) {
      return Object.freeze({ kind: 'idle', reason: 'no-subscription', revision: snapshot.revision });
    }
    try {
      await send();
    } catch (error) {
      return Object.freeze({ error, kind: 'failed' as const, stage: 'send' as const });
    }
    for (const id of noticeIds) current.signalled.add(id);
    signalSequence += 1;
    try {
      const committed = await ledger.signalAvailability({
        at,
        idempotencyKey: `agent-notices:availability:${current.id}:${String(signalSequence)}`,
        noticeIds,
      });
      return Object.freeze({ kind: 'signalled', noticeIds, revision: committed.revision });
    } catch (error) {
      return Object.freeze({ error, kind: 'failed' as const, stage: 'record' as const });
    }
  };

  return Object.freeze({
    inboxUri: AGENT_NOTICE_INBOX_URI,
    get subscribed(): boolean {
      return subscription !== undefined;
    },
    close(): Promise<void> {
      subscription = undefined;
      return options.store.close();
    },
    observe(send: () => Promise<void>): Promise<AgentNoticeInboxSignalOutcome> {
      const run = queue.then(() => observeOnce(send));
      queue = run.catch(() => undefined);
      return run;
    },
    async subscribe(principal: AgentNoticePrincipal): Promise<void> {
      const ledger = await options.store.noticeLedger();
      await ledger.read();
      subscription = Object.freeze({
        id: randomUUID(),
        principal,
        signalled: new Set<string>(),
      });
    },
    unsubscribe(): void {
      subscription = undefined;
    },
  });
};
