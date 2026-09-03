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

export interface EpochAdoptionPolicyOptions {
  readonly contracts: () => PreparedDevContractMatrix | undefined;
  readonly eventHub: ProjectEventHub;
  readonly run: (
    epochId: string,
    contracts: PreparedDevContractMatrix,
  ) => Promise<EpochContractEvaluation>;
}

interface PendingEpoch {
  readonly contracts: PreparedDevContractMatrix;
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

/**
 * One host-facing epoch gate. Workbench playground surfaces continue to follow
 * artifact.available directly; only subscribers here wait for contract proof.
 */
export class EpochAdoptionPolicy implements EpochAdoptionSource {
  readonly #contracts: () => PreparedDevContractMatrix | undefined;
  readonly #eventHub: ProjectEventHub;
  readonly #listeners = new Set<EpochAdoptionListener>();
  readonly #run: EpochAdoptionPolicyOptions['run'];
  readonly #subscription: ProjectEventSubscription;
  #closed = false;
  #currentEpochId: string | undefined;
  #latestEvaluation: EpochContractEvaluation | undefined;
  #observed = false;
  #pending: PendingEpoch | undefined;
  #processing: Promise<void> | undefined;
  #sequence = 0;

  constructor(options: EpochAdoptionPolicyOptions) {
    this.#contracts = options.contracts;
    this.#eventHub = options.eventHub;
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
    const contracts = this.#contracts();
    if (contracts === undefined) {
      this.#latestEvaluation = undefined;
      this.#adopt(epochId);
      return;
    }
    this.#sequence += 1;
    this.#pending = Object.freeze({
      contracts,
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
  }

  async #drain(): Promise<void> {
    while (!this.#closed && this.#pending !== undefined) {
      const candidate = this.#pending;
      this.#pending = undefined;
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
      if (evaluation.state === 'passed') this.#adopt(candidate.epochId);
    }
  }

  #adopt(epochId: string): void {
    this.#currentEpochId = epochId;
    for (const listener of this.#listeners) {
      try {
        listener(epochId);
      } catch {
        // Adoption consumers own their async failure reporting; one cannot starve its peers.
      }
    }
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
