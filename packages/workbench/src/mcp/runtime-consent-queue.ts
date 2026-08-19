import type { McpAppConsentChallenge } from './mcp-app-client.ts';

export type RuntimeConsentDecision = 'allow-once' | 'deny';

/** Opaque Workbench-only identity for one currently visible FIFO consent entry. */
export interface RuntimeConsentQueueCurrent {
  readonly challenge: McpAppConsentChallenge;
}

interface RuntimeConsentQueueEntry {
  readonly current: RuntimeConsentQueueCurrent;
  readonly onAbort: () => void;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (decision: RuntimeConsentDecision) => void;
  readonly signal?: AbortSignal;
}

export interface RuntimeConsentQueue {
  readonly current: RuntimeConsentQueueCurrent | undefined;
  request(challenge: McpAppConsentChallenge, signal?: AbortSignal): Promise<RuntimeConsentDecision>;
  resolve(current: RuntimeConsentQueueCurrent, decision: RuntimeConsentDecision): boolean;
  resolveAll(decision: RuntimeConsentDecision): void;
}

const aborted = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('Aborted', 'AbortError');

/** Workbench-owned FIFO for visible action-consent prompts. Aborted entries never reach a decision route. */
export const createRuntimeConsentQueue = (
  onCurrentChange: (current: RuntimeConsentQueueCurrent | undefined) => void,
): RuntimeConsentQueue => {
  const entries: RuntimeConsentQueueEntry[] = [];
  const publish = (): void => onCurrentChange(entries[0]?.current);
  const remove = (entry: RuntimeConsentQueueEntry): boolean => {
    const index = entries.indexOf(entry);
    if (index < 0) return false;
    entries.splice(index, 1);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    if (index === 0) publish();
    return true;
  };

  return Object.freeze({
    get current(): RuntimeConsentQueueCurrent | undefined {
      return entries[0]?.current;
    },
    request: (challenge: McpAppConsentChallenge, signal?: AbortSignal): Promise<RuntimeConsentDecision> => new Promise((resolve, reject) => {
      const onAbort = () => {
        if (remove(entry)) reject(aborted(signal!));
      };
      const entry = { current: Object.freeze({ challenge }), onAbort, reject, resolve, signal };
      if (signal?.aborted) {
        reject(aborted(signal));
        return;
      }
      entries.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (entries.length === 1) publish();
    }),
    resolve: (current: RuntimeConsentQueueCurrent, decision: RuntimeConsentDecision): boolean => {
      const entry = entries[0];
      if (entry === undefined || entry.current !== current) return false;
      remove(entry);
      entry.resolve(decision);
      return true;
    },
    resolveAll: (decision: RuntimeConsentDecision): void => {
      for (const entry of [...entries]) {
        remove(entry);
        entry.resolve(decision);
      }
    },
  });
};
