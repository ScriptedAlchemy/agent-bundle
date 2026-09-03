import { randomUUID } from 'node:crypto';

import { AgentStateError } from '../state/index.js';
import {
  AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS,
  AgentNoticeError,
  type AgentNotice,
  type AgentNoticeLedger,
  type AgentNoticePrincipal,
} from './contract.js';
import { recipientMatchesPrincipal } from './state.js';

/** Consecutive compare-and-swap losses tolerated before a reservation reports failure. */
const MAX_CLAIM_ATTEMPTS = 4;

const isRevisionConflict = (error: unknown): boolean =>
  error instanceof AgentStateError && error.code === 'revision-conflict';

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
  /**
   * Ends the subscription. Resolves only after every observation already in
   * flight has settled, so once it resolves no further signal is sent or
   * budget spent for the connection — a `resources/unsubscribe` acknowledged
   * to the client is honoured even while the store is slow.
   */
  unsubscribe(): Promise<void>;
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
  // Another signaller holds the slot for a send in progress. A hold older than
  // the TTL belongs to a holder that never finalized or released (crashed
  // mid-send) and no longer blocks anyone.
  const reservation = notice.availabilityReservation;
  if (reservation !== undefined && Date.parse(reservation.at) + AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS > nowMs) {
    return false;
  }
  return recipientMatchesPrincipal(notice.recipient, principal);
};

export const createNoticeInboxSignaller = (
  options: CreateNoticeInboxSignallerOptions,
): AgentNoticeInboxSignaller => {
  const now = options.now ?? ((): Date => new Date());
  let subscription: InboxSubscription | undefined;
  let signalSequence = 0;
  // Observations and subscription changes serialize on one queue: two renders
  // completing together cannot both select the same notice and send two
  // signals for one revision, and an unsubscribe (or re-subscribe) that
  // overlaps an observation awaiting the store takes effect only after that
  // observation settles, never between its eligibility read and its send.
  let queue: Promise<unknown> = Promise.resolve();
  // Unsubscribes requested while an observation awaits the store are counted
  // synchronously so that observation yields before spending any budget: the
  // client asked to stop, so nothing is claimed or sent on its behalf.
  let pendingUnsubscribes = 0;
  const serialized = <T>(step: () => Promise<T>): Promise<T> => {
    const run = queue.then(step);
    queue = run.catch(() => undefined);
    return run;
  };

  /**
   * Reserves the budget slot of every newly eligible notice as one
   * compare-and-swap against the revision the eligibility was computed from.
   * Two server processes over one durable store therefore cannot both send for
   * a notice's single slot: the loser sees `revision-conflict`, re-reads, and
   * finds the slot reserved. The reservation spends nothing; the receipt is
   * recorded only after the protocol write succeeds. A bounded number of
   * conflicts is retried because unrelated writers (publishes, exposures) also
   * move the revision.
   */
  const claim = async (
    ledger: AgentNoticeLedger,
    current: InboxSubscription,
  ): Promise<
    | {
      readonly at: string;
      readonly kind: 'claimed';
      readonly noticeIds: readonly string[];
      readonly reservationKey: string;
      readonly revision: number;
    }
    | { readonly kind: 'nothing-eligible'; readonly revision: number }
    | { readonly kind: 'unsubscribed' }
    | { readonly error: unknown; readonly kind: 'failed'; readonly stage: 'read' | 'record' }
  > => {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      let snapshot: Awaited<ReturnType<AgentNoticeLedger['read']>>;
      try {
        snapshot = await ledger.read();
      } catch (error) {
        return { error, kind: 'failed', stage: 'read' };
      }
      if (pendingUnsubscribes > 0 || subscription !== current) return { kind: 'unsubscribed' };
      const at = now().toISOString();
      const nowMs = Date.parse(at);
      const noticeIds = Object.freeze(snapshot.notices
        .filter((notice) => !current.signalled.has(notice.id) && eligibleForSignal(notice, current.principal, nowMs))
        .map((notice) => notice.id)
        .toSorted((left, right) => left.localeCompare(right)));
      if (noticeIds.length === 0) return { kind: 'nothing-eligible', revision: snapshot.revision };
      signalSequence += 1;
      const reservationKey = `${current.id}:${String(signalSequence)}`;
      try {
        const committed = await ledger.reserveAvailability({
          at,
          expectedRevision: snapshot.revision,
          idempotencyKey: `agent-notices:availability:reserve:${reservationKey}`,
          noticeIds,
          reservationKey,
        });
        return { at, kind: 'claimed', noticeIds, reservationKey, revision: committed.revision };
      } catch (error) {
        if (!isRevisionConflict(error)) return { error, kind: 'failed', stage: 'record' };
      }
    }
    return {
      error: new AgentNoticeError(
        'invalid-input',
        `Notice availability reservation lost ${String(MAX_CLAIM_ATTEMPTS)} consecutive revision races`,
      ),
      kind: 'failed',
      stage: 'record',
    };
  };

  const observeOnce = async (send: () => Promise<void>): Promise<AgentNoticeInboxSignalOutcome> => {
    const current = subscription;
    if (current === undefined) {
      return Object.freeze({ kind: 'idle', reason: 'no-subscription', revision: undefined });
    }
    let ledger: AgentNoticeLedger;
    try {
      ledger = await options.store.noticeLedger();
    } catch (error) {
      return Object.freeze({ error, kind: 'failed' as const, stage: 'read' as const });
    }
    if (pendingUnsubscribes > 0) {
      return Object.freeze({ kind: 'idle', reason: 'no-subscription', revision: undefined });
    }
    const claimed = await claim(ledger, current);
    switch (claimed.kind) {
      case 'failed':
        return Object.freeze({ error: claimed.error, kind: 'failed' as const, stage: claimed.stage });
      case 'nothing-eligible':
        return Object.freeze({ kind: 'idle', reason: 'nothing-eligible', revision: claimed.revision });
      case 'unsubscribed':
        return Object.freeze({ kind: 'idle', reason: 'no-subscription', revision: undefined });
      case 'claimed':
        break;
      default: {
        const exhaustive: never = claimed;
        return exhaustive;
      }
    }
    // The slot is held durably before the wire write so no other process sends
    // for it too, but nothing is spent yet: a failed send releases the hold and
    // the notice stays eligible for the next observation, while a successful
    // send finalizes the hold into the availability receipt. Only the receipt
    // means the protocol write succeeded.
    try {
      await send();
    } catch (error) {
      try {
        await ledger.releaseAvailability({
          idempotencyKey: `agent-notices:availability:release:${claimed.reservationKey}`,
          noticeIds: claimed.noticeIds,
          reservationKey: claimed.reservationKey,
        });
      } catch {
        // The hold expires on its own after the reservation TTL; the send
        // failure is the outcome worth reporting.
      }
      return Object.freeze({ error, kind: 'failed' as const, stage: 'send' as const });
    }
    for (const id of claimed.noticeIds) current.signalled.add(id);
    try {
      const committed = await ledger.signalAvailability({
        at: claimed.at,
        idempotencyKey: `agent-notices:availability:signal:${claimed.reservationKey}`,
        noticeIds: claimed.noticeIds,
        reservationKey: claimed.reservationKey,
      });
      return Object.freeze({ kind: 'signalled', noticeIds: claimed.noticeIds, revision: committed.revision });
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
      return serialized(() => observeOnce(send));
    },
    subscribe(principal: AgentNoticePrincipal): Promise<void> {
      return serialized(async () => {
        const ledger = await options.store.noticeLedger();
        await ledger.read();
        subscription = Object.freeze({
          id: randomUUID(),
          principal,
          signalled: new Set<string>(),
        });
      });
    },
    unsubscribe(): Promise<void> {
      pendingUnsubscribes += 1;
      return serialized(async () => {
        pendingUnsubscribes -= 1;
        subscription = undefined;
      });
    },
  });
};
