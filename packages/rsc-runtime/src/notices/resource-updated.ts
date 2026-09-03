import { randomUUID } from 'node:crypto';

import { AgentStateError, canonicalJson } from '../state/index.js';
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

/** How long `close()` waits on the store for the owed-receipt drain and the store close by default. */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/** Marks a store or wire wait that shutdown abandoned rather than awaited. */
const CLOSED: unique symbol = Symbol('agent-notices:signaller-closed');

/** Bounds one wait by a promise that settles when the wait must be given up. */
type Bound = <T>(pending: Promise<T>) => Promise<T | typeof CLOSED>;

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
  /**
   * Upper bound on how long `close()` waits on the store to commit owed
   * receipts and to close. A store that never answers cannot pin server
   * teardown; a receipt still owed past the bound is lost with the process and
   * its hold lapses after the reservation TTL. Defaults to 5 seconds.
   */
  readonly closeTimeoutMs?: number;
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
  /**
   * Commits any receipt still owed for a send that reached the wire, then
   * closes the store. Never waits on a client's wire, and never waits on the
   * store past `closeTimeoutMs`: a `resources/updated` write or ledger call
   * still pending is abandoned with its outcome unknown — an owed receipt gets
   * one bounded chance to land and is otherwise lost with the process — and
   * the hold it took lapses after the reservation TTL like any holder gone
   * mid-send.
   */
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
   * subscription that could never be honoured. Repeating the call for the
   * same principal while subscribed is idempotent and keeps what has already
   * been signalled; tracking resets only after `unsubscribe()` or when the
   * principal changes.
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
  // a fact, so the receipt is retried with the same idempotency key — on an
  // independent timer that also renews the hold, before every later
  // observation, and on close — until it lands or the hold is lost. The memory
  // dedupe alone would otherwise let a restarted signaller spend the same slot
  // again once the abandoned hold lapsed.
  const pendingReceipts = new Map<string, PendingReceipt>();
  let receiptRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let renewalSequence = 0;
  let closed = false;
  let resolveClosing: () => void = () => undefined;
  const closing = new Promise<void>((resolve) => {
    resolveClosing = resolve;
  });
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  // Every wait on the store or the wire inside an observation is raced against
  // shutdown: a ledger call that never answers must not pin the queue and, with
  // it, the server's teardown. The abandoned call's outcome is unknown, so
  // nothing is inferred from it — an owed receipt stays owed, a hold lapses.
  const untilClosed = <T>(pending: Promise<T>): Promise<T | typeof CLOSED> =>
    Promise.race([pending, closing.then((): typeof CLOSED => CLOSED)]);
  const abandoned = (what: string): AgentNoticeError =>
    new AgentNoticeError('aborted', `Notice inbox signaller closed while ${what} was pending`);
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
      let snapshot: Awaited<ReturnType<AgentNoticeLedger['read']>> | typeof CLOSED;
      try {
        snapshot = await untilClosed(ledger.read());
      } catch (error) {
        return { error, kind: 'failed', stage: 'read' };
      }
      // Shutdown ends the subscription; nothing is claimed or sent for it.
      if (snapshot === CLOSED || pendingUnsubscribes > 0 || subscription !== current) return { kind: 'unsubscribed' };
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
        const committed = await untilClosed(ledger.reserveAvailability({
          at,
          expectedRevision: snapshot.revision,
          idempotencyKey: `agent-notices:availability:reserve:${reservationKey}`,
          noticeIds,
          reservationKey,
        }));
        // Whether the hold landed is unknown; if it did, it lapses after the TTL.
        if (committed === CLOSED) return { kind: 'unsubscribed' };
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

  const isReservationLost = (error: unknown): boolean =>
    error instanceof AgentNoticeError && error.code === 'reservation-lost';

  /**
   * Retries every owed receipt, renewing its hold first so the slot stays ours
   * while the ledger recovers. A receipt whose hold was lost (the ledger could
   * not be reached for a whole TTL and another signaller took over) can never
   * be recorded — the takeover's send is the one the budget counts — so it is
   * dropped and reported once. The first failure is returned so the caller
   * reports it. Every wait is bounded by `bound`: a commit the ledger never
   * answers is abandoned with the receipt still owed, never inferred either way.
   */
  const drainPendingReceipts = async (ledger: AgentNoticeLedger, bound: Bound): Promise<unknown> => {
    for (const receipt of [...pendingReceipts.values()]) {
      renewalSequence += 1;
      try {
        await bound(ledger.reserveAvailability({
          at: now().toISOString(),
          idempotencyKey: `agent-notices:availability:renew:${receipt.reservationKey}:owed:${String(renewalSequence)}`,
          noticeIds: receipt.noticeIds,
          reservationKey: receipt.reservationKey,
        }));
      } catch {
        // The commit below is the write that matters; a failed renewal only
        // shortens how long the hold survives a longer outage.
      }
      try {
        const committed = await bound(commitReceipt(ledger, receipt));
        if (committed === CLOSED) return abandoned('an owed availability receipt');
        pendingReceipts.delete(receipt.reservationKey);
      } catch (error) {
        if (isReservationLost(error)) pendingReceipts.delete(receipt.reservationKey);
        return error;
      }
    }
    return undefined;
  };

  /**
   * Keeps retrying owed receipts on the renewal cadence, independently of
   * renders: a server that receives no further render past the TTL would
   * otherwise let its hold lapse while a wire-successful send stayed unrecorded.
   * The timer exists only while a receipt is owed.
   */
  const scheduleReceiptRetry = (): void => {
    if (closed || receiptRetryTimer !== undefined || pendingReceipts.size === 0) return;
    receiptRetryTimer = setTimeout(() => {
      receiptRetryTimer = undefined;
      void serialized(async () => {
        if (closed || pendingReceipts.size === 0) return;
        try {
          const ledger = await untilClosed(options.store.noticeLedger());
          if (ledger !== CLOSED) await drainPendingReceipts(ledger, untilClosed);
        } catch {
          // Retried on the next tick.
        }
      }).finally(scheduleReceiptRetry);
    }, renewalIntervalMs);
    receiptRetryTimer.unref?.();
  };

  /**
   * Keeps a hold alive while its protocol write is pending. A write that
   * outlives the TTL would otherwise let another process treat the hold as
   * abandoned and send too; renewing under the same key refreshes `at`, and
   * the reducer refuses a renewal once a different key has legitimately taken
   * over, so a holder that could not renew for a whole TTL never steals back.
   * The timer exists only for the duration of one in-flight send, and a
   * renewal still awaiting the ledger when the send settles is awaited before
   * the caller releases or finalizes the hold: a renewal landing afterwards
   * would re-create a hold nobody owns and block the slot for a whole TTL.
   * That wait ends with shutdown, though — `close()` never blocks on a ledger
   * write that has not answered — and a renewal that lands after an abandoned
   * send only moves the lapse of a hold that was already being left to lapse.
   */
  const renewWhile = async <T>(
    ledger: AgentNoticeLedger,
    hold: { readonly noticeIds: readonly string[]; readonly reservationKey: string },
    pending: Promise<T>,
  ): Promise<T> => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let renewing: Promise<void> | undefined;
    const tick = (): void => {
      if (stopped) return;
      renewalSequence += 1;
      renewing = ledger.reserveAvailability({
        at: now().toISOString(),
        idempotencyKey: `agent-notices:availability:renew:${hold.reservationKey}:${String(renewalSequence)}`,
        noticeIds: hold.noticeIds,
        reservationKey: hold.reservationKey,
      }).catch(() => undefined).then(() => {
        renewing = undefined;
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
      if (renewing !== undefined) await Promise.race([renewing, closing]);
    }
  };

  const observeOnce = async (send: () => Promise<void>): Promise<AgentNoticeInboxSignalOutcome> => {
    const current = subscription;
    if (current === undefined && pendingReceipts.size === 0) {
      return Object.freeze({ kind: 'idle', reason: 'no-subscription', revision: undefined });
    }
    let ledger: AgentNoticeLedger | typeof CLOSED;
    try {
      ledger = await untilClosed(options.store.noticeLedger());
    } catch (error) {
      return Object.freeze({ error, kind: 'failed' as const, stage: 'read' as const });
    }
    if (ledger === CLOSED) return Object.freeze({ kind: 'idle', reason: 'no-subscription', revision: undefined });
    // Receipts owed from earlier sends come first: they are facts about the
    // wire, and a ledger that cannot take them is not one to spend against.
    const owed = await drainPendingReceipts(ledger, untilClosed);
    if (owed !== undefined) {
      scheduleReceiptRetry();
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
    // The wire is the one dependency the signaller cannot bound — a subscriber
    // that stops reading leaves the write pending forever — so shutdown does
    // not wait on it: the send is abandoned with its outcome unknown and its
    // hold is left to lapse after the TTL, exactly as for a holder that
    // vanished mid-send.
    let wire: void | typeof CLOSED;
    try {
      wire = await renewWhile(ledger, claimed, untilClosed(send()));
    } catch (error) {
      try {
        await untilClosed(ledger.releaseAvailability({
          idempotencyKey: `agent-notices:availability:release:${claimed.reservationKey}`,
          noticeIds: claimed.noticeIds,
          reservationKey: claimed.reservationKey,
        }));
      } catch {
        // The hold expires on its own after the reservation TTL; the send
        // failure is the outcome worth reporting.
      }
      return Object.freeze({ error, kind: 'failed' as const, stage: 'send' as const });
    }
    if (wire === CLOSED) {
      // Whether the write reached the client is unknowable now, so neither a
      // receipt nor a release would be honest; the hold lapses on its own.
      return Object.freeze({
        error: abandoned('a resources/updated write'),
        kind: 'failed' as const,
        stage: 'send' as const,
      });
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
      const committed = await untilClosed(commitReceipt(ledger, receipt));
      if (committed === CLOSED) {
        // Still owed: the close-time drain gets one bounded chance to land it.
        return Object.freeze({
          error: abandoned('an availability receipt commit'),
          kind: 'failed' as const,
          stage: 'record' as const,
        });
      }
      pendingReceipts.delete(receipt.reservationKey);
      return Object.freeze({ kind: 'signalled', noticeIds: claimed.noticeIds, revision: committed.revision });
    } catch (error) {
      if (isReservationLost(error)) {
        pendingReceipts.delete(receipt.reservationKey);
      } else {
        scheduleReceiptRetry();
      }
      return Object.freeze({ error, kind: 'failed' as const, stage: 'record' as const });
    }
  };

  return Object.freeze({
    inboxUri: AGENT_NOTICE_INBOX_URI,
    get subscribed(): boolean {
      return subscription !== undefined;
    },
    close(): Promise<void> {
      closed = true;
      // Unblocks an observation whose protocol write never settles so the
      // queue — and this close behind it — cannot wait on a client's wire.
      resolveClosing();
      if (receiptRetryTimer !== undefined) {
        clearTimeout(receiptRetryTimer);
        receiptRetryTimer = undefined;
      }
      return serialized(async () => {
        subscription = undefined;
        // The drain and the store close get one bounded chance: a store that
        // never answers must not pin teardown, and a receipt still owed past
        // the bound is lost with the process; its hold lapses after the TTL.
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<typeof CLOSED>((resolve) => {
          deadlineTimer = setTimeout(() => resolve(CLOSED), closeTimeoutMs);
          deadlineTimer.unref?.();
        });
        const untilDeadline: Bound = (pending) => Promise.race([pending, deadline]);
        try {
          if (pendingReceipts.size > 0) {
            try {
              const ledger = await untilDeadline(options.store.noticeLedger());
              if (ledger !== CLOSED) await drainPendingReceipts(ledger, untilDeadline);
            } catch {
              // Reported by the observation that owed it; nothing more to do here.
            }
          }
          await untilDeadline(options.store.close());
        } finally {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        }
      });
    },
    observe(send: () => Promise<void>): Promise<AgentNoticeInboxSignalOutcome> {
      return serialized(() => observeOnce(send));
    },
    subscribe(principal: AgentNoticePrincipal): Promise<void> {
      return serialized(async () => {
        const ledger = await untilClosed(options.store.noticeLedger());
        if (ledger === CLOSED || await untilClosed(ledger.read()) === CLOSED) {
          throw abandoned('a resources/subscribe');
        }
        // A client that repeats resources/subscribe without unsubscribing is
        // still the same continuously subscribed connection: keeping its
        // signalled set means a notice with retryBudget > 1 is not re-sent
        // (and its budget not spent again) for a subscription that never
        // lapsed. Tracking resets only after a completed unsubscribe or when
        // the connection's observed identity actually changed.
        if (subscription !== undefined && canonicalJson(subscription.principal) === canonicalJson(principal)) {
          return;
        }
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
