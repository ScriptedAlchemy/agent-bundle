import type { Diagnostic } from '../core/diagnostics.ts';
import type { PreparedDevContractMatrix } from '../config/dev-contracts.ts';
import type {
  ProjectEventHub,
  ProjectEventSubscription,
} from './events.ts';
import type {
  DevContractFailure,
  DevContractStatusEvent,
  HostAdoptionStatus,
} from './types.ts';

export type EpochContractEvaluation = DevContractStatusEvent;
export type EpochAdoptionListener = (epochId: string) => void;

export interface EpochAdoptionSource {
  readonly currentEpochId: string | undefined;
  subscribe(listener: EpochAdoptionListener): ProjectEventSubscription;
}

/** Compatibility bridge for direct service construction; product wiring supplies one shared policy. */
export const subscribeToEpochAdoption = (
  adoption: EpochAdoptionSource | undefined,
  eventHub: ProjectEventHub,
  listener: EpochAdoptionListener,
): ProjectEventSubscription => adoption?.subscribe(listener) ?? eventHub.subscribe(
  { afterSequence: eventHub.latestSequence },
  (event) => {
    if (event.type === 'artifact.available') listener(event.epochId);
  },
);

/** A held epoch-store reference; releasing it lets retention reclaim the epoch. */
export interface EpochAdoptionLease {
  close(): Promise<void>;
}

export interface EpochAdoptionPolicyOptions {
  readonly contracts: () => PreparedDevContractMatrix | undefined;
  readonly eventHub: ProjectEventHub;
  /**
   * Leases the adopted epoch for as long as hosts are told to serve it. Store
   * retention keeps only the active epoch, referenced epochs, and a handful of
   * recent unreferenced ones, so without this lease a run of failing rebuilds
   * would delete the last passing epoch while it is still advertised.
   */
  readonly lease?: (epochId: string) => Promise<EpochAdoptionLease>;
  readonly run: (
    epochId: string,
    contracts: PreparedDevContractMatrix,
  ) => Promise<EpochContractEvaluation>;
}

interface PendingEpoch {
  readonly contracts: PreparedDevContractMatrix | undefined;
  readonly epochId: string;
  readonly sequence: number;
}

const runnerDiagnostic = (epochId: string, error: unknown): Diagnostic => Object.freeze({
  code: 'AB7211',
  message: `Development contract matrix failed for epoch ${epochId}: ${
    error instanceof Error ? error.message : String(error)
  }`,
  recovery: 'Fix the fixture declaration or generated MCP server, then rebuild; the last passing host epoch remains active.',
  severity: 'error',
});

const failedEvaluation = (epochId: string, error: unknown): EpochContractEvaluation => Object.freeze({
  diagnostics: Object.freeze([runnerDiagnostic(epochId, error)]),
  epochId,
  failures: Object.freeze([]),
  state: 'failed',
  summary: 'Development contract matrix could not complete.',
});

const leaseFailedEvaluation = (epochId: string, error: unknown): EpochContractEvaluation => Object.freeze({
  diagnostics: Object.freeze([Object.freeze({
    code: 'AB7211',
    message: `Epoch ${epochId} could not be leased for host adoption: ${
      error instanceof Error ? error.message : String(error)
    }`,
    recovery: 'Rebuild so a new epoch is published; the last leased host epoch remains active.',
    severity: 'error',
  } satisfies Diagnostic)]),
  epochId,
  failures: Object.freeze([]),
  state: 'failed',
  summary: 'Adopted epoch could not be leased.',
});

/**
 * One host-facing epoch gate. Workbench playground surfaces continue to follow
 * artifact.available directly; only subscribers here wait for contract proof.
 */
export class EpochAdoptionPolicy implements EpochAdoptionSource {
  readonly #contracts: () => PreparedDevContractMatrix | undefined;
  readonly #eventHub: ProjectEventHub;
  readonly #lease: EpochAdoptionPolicyOptions['lease'];
  readonly #listeners = new Set<EpochAdoptionListener>();
  readonly #run: EpochAdoptionPolicyOptions['run'];
  readonly #subscription: ProjectEventSubscription;
  #closed = false;
  #currentEpochId: string | undefined;
  #currentLease: EpochAdoptionLease | undefined;
  #latestEvaluation: EpochContractEvaluation | undefined;
  #observed = false;
  #pending: PendingEpoch | undefined;
  #processing: Promise<void> | undefined;
  #sequence = 0;

  constructor(options: EpochAdoptionPolicyOptions) {
    this.#contracts = options.contracts;
    this.#eventHub = options.eventHub;
    this.#lease = options.lease;
    this.#run = options.run;
    this.#subscription = options.eventHub.subscribe(
      { afterSequence: options.eventHub.latestSequence },
      (event) => {
        if (event.type === 'artifact.available') this.#consider(event.epochId);
      },
    );
  }

  get currentEpochId(): string | undefined {
    return this.#currentEpochId;
  }

  /** The Workbench-facing snapshot of what hosts serve and why. */
  status(): HostAdoptionStatus {
    return Object.freeze({
      ...(this.#currentEpochId === undefined ? {} : { adoptedEpochId: this.#currentEpochId }),
      ...(this.#latestEvaluation === undefined ? {} : { contracts: this.#latestEvaluation }),
      mode: this.#contracts() === undefined ? 'direct' : 'gated',
    });
  }

  /**
   * Considers an epoch that was already active before any `artifact.available`
   * reached this policy — the cold-start last-good case, where a failing
   * initial build publishes nothing but hosts must still serve the prior epoch.
   * A no-op once any epoch has been observed.
   */
  seed(epochId: string): void {
    if (this.#closed || this.#observed) return;
    this.#consider(epochId);
  }

  #consider(epochId: string): void {
    if (this.#closed) return;
    this.#observed = true;
    this.#sequence += 1;
    this.#pending = Object.freeze({
      contracts: this.#contracts(),
      epochId,
      sequence: this.#sequence,
    });
    this.#processing ??= this.#drain().finally(() => {
      this.#processing = undefined;
    });
  }

  subscribe(listener: EpochAdoptionListener): ProjectEventSubscription {
    if (this.#closed) throw new Error('Epoch adoption policy is closed.');
    this.#listeners.add(listener);
    return Object.freeze({
      unsubscribe: () => this.#listeners.delete(listener),
    });
  }

  settled(): Promise<void> {
    return this.#processing ?? Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscription.unsubscribe();
    this.#pending = undefined;
    await this.#processing;
    this.#listeners.clear();
    const lease = this.#currentLease;
    this.#currentLease = undefined;
    await lease?.close();
  }

  async #drain(): Promise<void> {
    while (!this.#closed && this.#pending !== undefined) {
      const candidate = this.#pending;
      this.#pending = undefined;
      if (candidate.contracts === undefined) {
        this.#latestEvaluation = undefined;
        await this.#adopt(candidate);
        continue;
      }
      let evaluation: EpochContractEvaluation;
      try {
        evaluation = await this.#run(candidate.epochId, candidate.contracts);
      } catch (error) {
        evaluation = failedEvaluation(candidate.epochId, error);
      }
      if (this.#closed || candidate.sequence !== this.#sequence) continue;
      this.#latestEvaluation = evaluation;
      this.#eventHub.publish({
        epochId: candidate.epochId,
        payload: evaluation,
        type: 'dev.contract.status',
      });
      if (evaluation.state === 'passed') await this.#adopt(candidate);
    }
  }

  /**
   * Pins the candidate before announcing it and releases the previous pin only
   * afterwards, so there is never a moment where the advertised epoch is
   * unleased. A candidate that cannot be leased is not adopted: hosts keep the
   * previous epoch and the failure is published as contract status.
   */
  async #adopt(candidate: PendingEpoch): Promise<void> {
    let lease: EpochAdoptionLease | undefined;
    if (this.#lease !== undefined) {
      try {
        lease = await this.#lease(candidate.epochId);
      } catch (error) {
        if (this.#closed || candidate.sequence !== this.#sequence) return;
        this.#latestEvaluation = leaseFailedEvaluation(candidate.epochId, error);
        this.#eventHub.publish({
          epochId: candidate.epochId,
          payload: this.#latestEvaluation,
          type: 'dev.contract.status',
        });
        return;
      }
      if (this.#closed || candidate.sequence !== this.#sequence) {
        await lease.close().catch(() => undefined);
        return;
      }
    }
    const previous = this.#currentLease;
    this.#currentLease = lease;
    this.#currentEpochId = candidate.epochId;
    for (const listener of this.#listeners) {
      try {
        listener(candidate.epochId);
      } catch {
        // Adoption consumers own their async failure reporting; one cannot starve its peers.
      }
    }
    await previous?.close().catch(() => undefined);
  }
}

export const contractFailures = (
  failures: readonly Readonly<{ readonly check: string; readonly routeId: string }>[],
): readonly DevContractFailure[] => {
  const checks = new Map<string, Set<string>>();
  for (const failure of failures) {
    const route = checks.get(failure.routeId) ?? new Set<string>();
    route.add(failure.check);
    checks.set(failure.routeId, route);
  }
  return Object.freeze([...checks.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([routeId, routeChecks]) => Object.freeze({
      checks: Object.freeze([...routeChecks].sort()),
      routeId,
    })));
};
