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
  /**
   * How often a hold is renewed while its `send()` is still pending. Defaults
   * to a third of `AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS` so a live
   * holder never lapses; only a holder whose process is gone does.
   */
  readonly reservationRenewalIntervalMs?: number;
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
  /** Commits any receipt still owed for a send that reached the wire, then closes the store. */
  close(): Promise<void>;
  /**
   * Runs after one completed render: first commits any receipt still owed from
   * an earlier send, then reads the ledger and, when the subscriber has newly
   * eligible pending notices, holds their budget slot, sends exactly one
   * `resources/updated` through `send` (renewing the hold while the write is
   * pending), and records the availability receipt once the write succeeded.
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

/** A send that succeeded on the wire whose availability receipt has not been committed yet. */
interface PendingReceipt {
  readonly at: string;
  readonly noticeIds: readonly string[];
  readonly reservationKey: string;
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
  const renewalIntervalMs = options.reservationRenewalIntervalMs
    ?? Math.floor(AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS / 3);
  let subscription: InboxSubscription | undefined;
  let signalSequence = 0;
  // Sends that reached the wire but whose receipt commit failed. The send is
  // a fact, so the receipt is retried with the same idempotency key on every
  // later observation (and on close) until it lands; the memory dedupe alone
  // would otherwise let a restarted signaller spend the same slot again once
  // the abandoned hold lapsed.
  const pendingReceipts = new Map<string, PendingReceipt>();
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

  /** Commits the receipt for one wire-successful send; idempotent across retries. */
  const commitReceipt = (
    ledger: AgentNoticeLedger,
    receipt: PendingReceipt,
  ): Promise<Awaited<ReturnType<AgentNoticeLedger['read']>>> => ledger.signalAvailability({
    at: receipt.at,
    idempotencyKey: `agent-notices:availability:signal:${receipt.reservationKey}`,
    noticeIds: receipt.noticeIds,
    reservationKey: receipt.reservationKey,
  });

  /** Retries every outstanding receipt; the first failure is returned so the caller reports it. */
  const drainPendingReceipts = async (ledger: AgentNoticeLedger): Promise<unknown> => {
    for (const receipt of [...pendingReceipts.values()]) {
      try {
        await commitReceipt(ledger, receipt);
        pendingReceipts.delete(receipt.reservationKey);
      } catch (error) {
        return error;
      }
    }
    return undefined;
  };

  /**
   * Keeps a hold alive while its protocol write is pending. A write that
   * outlives the TTL would otherwise let another process treat the hold as
   * abandoned and send too; renewing under the same key refreshes `at`, and
   * the reducer refuses a renewal once a different key has legitimately taken
   * over, so a holder that could not renew for a whole TTL never steals back.
   * The timer exists only for the duration of one in-flight send.
   */
  const renewWhile = async <T>(
    ledger: AgentNoticeLedger,
    hold: { readonly noticeIds: readonly string[]; readonly reservationKey: string },
    pending: Promise<T>,
  ): Promise<T> => {
    let renewals = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      if (stopped) return;
      renewals += 1;
      const renewal = renewals;
      void ledger.reserveAvailability({
        at: now().toISOString(),
        idempotencyKey: `agent-notices:availability:renew:${hold.reservationKey}:${String(renewal)}`,
        noticeIds: hold.noticeIds,
        reservationKey: hold.reservationKey,
      }).catch(() => undefined).then(() => {
        if (stopped) return;
        timer = setTimeout(tick, renewalIntervalMs);
        timer.unref?.();
      });
    };
    timer = setTimeout(tick, renewalIntervalMs);
    timer.unref?.();
    try {
      return await pending;
    } finally {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const observeOnce = async (send: () => Promise<void>): Promise<AgentNoticeInboxSignalOutcome> => {
    const current = subscription;
    if (current === undefined && pendingReceipts.size === 0) {
      return Object.freeze({ kind: 'idle', reason: 'no-subscription', revision: undefined });
    }
    let ledger: AgentNoticeLedger;
    try {
      ledger = await options.store.noticeLedger();
    } catch (error) {
      return Object.freeze({ error, kind: 'failed' as const, stage: 'read' as const });
    }
    // Receipts owed from earlier sends come first: they are facts about the
    // wire, and a ledger that cannot take them is not one to spend against.
    const owed = await drainPendingReceipts(ledger);
    if (owed !== undefined) {
      return Object.freeze({ error: owed, kind: 'failed' as const, stage: 'record' as const });
    }
    if (current === undefined || pendingUnsubscribes > 0) {
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
      await renewWhile(ledger, claimed, send());
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
    // The wire write succeeded: this subscription never sends for these notices
    // again, and the receipt is owed until it commits.
    for (const id of claimed.noticeIds) current.signalled.add(id);
    const receipt: PendingReceipt = Object.freeze({
      at: claimed.at,
      noticeIds: claimed.noticeIds,
      reservationKey: claimed.reservationKey,
    });
    pendingReceipts.set(receipt.reservationKey, receipt);
    try {
      const committed = await commitReceipt(ledger, receipt);
      pendingReceipts.delete(receipt.reservationKey);
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
      return serialized(async () => {
        subscription = undefined;
        if (pendingReceipts.size > 0) {
          try {
            await drainPendingReceipts(await options.store.noticeLedger());
          } catch {
            // A receipt still owed at close is lost with the process; the hold
            // it left behind lapses after the TTL.
          }
        }
        await options.store.close();
      });
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
