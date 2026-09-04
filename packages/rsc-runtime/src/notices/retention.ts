import {
  AGENT_NOTICE_DEFAULT_RETENTION,
  AgentNoticeError,
  type AgentNotice,
  type AgentNoticeRetentionPolicy,
} from './contract.js';
import { noticeSettledAt } from './state.js';

/** Caller-supplied overrides; omitted fields resolve from {@link AGENT_NOTICE_DEFAULT_RETENTION}. */
export type AgentNoticeRetentionInput = Partial<AgentNoticeRetentionPolicy>;

/**
 * Resolves and validates a retention policy. Every field is a positive
 * integer: a zero TTL or cap would prune notices the moment they settle,
 * which is a distinct feature (and one no acceptance item asks for), and a
 * zero journal bound would compact on every write.
 */
export const resolveNoticeRetentionPolicy = (
  input: AgentNoticeRetentionInput | undefined,
): AgentNoticeRetentionPolicy => {
  const resolved = { ...AGENT_NOTICE_DEFAULT_RETENTION, ...input };
  for (const field of ['maxJournalBytes', 'maxTerminal', 'terminalTtlMs'] as const) {
    const value = resolved[field];
    if (!Number.isInteger(value) || value < 1) {
      throw new AgentNoticeError('invalid-input', `Notice retention ${field} must be an integer >= 1`);
    }
  }
  return Object.freeze(resolved);
};

/**
 * Ids the policy prunes at `at`: every terminal notice settled at least
 * `terminalTtlMs` ago, plus — when more than `maxTerminal` terminal notices
 * would remain — the earliest-settled of the rest until the cap holds. Order
 * is deterministic (settled time, then id) so two processes evaluating the
 * same state choose the same ids.
 */
export const selectPrunableNotices = (
  notices: readonly AgentNotice[],
  policy: AgentNoticeRetentionPolicy,
  at: string,
): readonly string[] => {
  const nowMs = Date.parse(at);
  const settled = notices
    .flatMap((notice) => {
      const settledAt = noticeSettledAt(notice);
      return settledAt === undefined ? [] : [{ id: notice.id, settledAt, settledMs: Date.parse(settledAt) }];
    })
    .toSorted((left, right) => left.settledMs - right.settledMs || left.id.localeCompare(right.id));
  const expired = settled.filter((entry) => entry.settledMs + policy.terminalTtlMs <= nowMs);
  const kept = settled.length - expired.length;
  const overflow = kept > policy.maxTerminal
    ? settled.filter((entry) => entry.settledMs + policy.terminalTtlMs > nowMs).slice(0, kept - policy.maxTerminal)
    : [];
  return Object.freeze([...expired, ...overflow].map((entry) => entry.id));
};

/** True while the policy treats the notice as terminal history rather than live work. */
export const noticeIsTerminal = (notice: AgentNotice): boolean => noticeSettledAt(notice) !== undefined;
