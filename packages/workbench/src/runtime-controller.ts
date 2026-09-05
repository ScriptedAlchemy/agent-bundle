import type {
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
} from '../../agent-bundle/src/contracts/runtime.ts';
import type {
  ProjectEventMessage,
  ProjectReplayGap,
} from '../../agent-bundle/src/contracts/runtime.ts';
import { errorMessage as messageFrom } from './client-helpers.ts';
import { RuntimeClientError, type RuntimeBootstrap } from './runtime-client.ts';
import {
  createRuntimeModel,
  effectFor,
  reduceRuntimeModel,
  type RuntimeModel,
  type RuntimeModelAction,
  type RuntimeProfileOption,
} from './runtime-model.ts';
import type { AgentRenderEvent } from './runtime/agent-document-client.ts';

export type RuntimePlaygroundClient = Readonly<{
  bootstrap(): Promise<RuntimeBootstrap>;
  createRun(request: DevRuntimeInvocationRequest): Promise<DevRuntimeRun>;
  readRun(runId: string): Promise<DevRuntimeRun>;
  readRunDocument(runId: string, signal?: AbortSignal): Promise<readonly AgentRenderEvent[]>;
  readRunFlight(runId: string): Promise<Blob>;
  replayRun(request: DevRuntimeReplayRequest): Promise<DevRuntimeRun>;
  resetState(request: DevRuntimeStateResetRequest): Promise<DevRuntimeStateIdentity>;
}>;

export interface RuntimePlaygroundController {
  close(): void;
  dispatch(action: RuntimeModelAction): void;
  downloadRunFlight(runId: string): Promise<Blob>;
  readRunDocument(runId: string, signal?: AbortSignal): Promise<readonly AgentRenderEvent[]>;
  readonly error: string | undefined;
  receive(event: ProjectEventMessage): Promise<void>;
  readonly model: RuntimeModel;
  subscribe(listener: (model: RuntimeModel) => void): () => void;
  whenIdle(): Promise<void>;
}

export interface RuntimeEventReceiver {
  receive(event: ProjectEventMessage): Promise<void>;
}

export interface RuntimeEventBuffer {
  close(): void;
  install(receiver: RuntimeEventReceiver): void;
  receive(event: ProjectEventMessage): void;
  whenIdle(): Promise<void>;
}

export interface RuntimeEventBufferOptions {
  readonly maximumPendingEvents?: number;
}

export type RuntimeBootstrapRetryPlan = Readonly<{
  readonly closePreControllerIngress: boolean;
  readonly delay: number | undefined;
  readonly retryCount: number;
}>;

export const runtimeBootstrapRetryPlan = (
  retryCount: number,
  receiverInstalled: boolean,
): RuntimeBootstrapRetryPlan => {
  if (!Number.isSafeInteger(retryCount) || retryCount < 0) {
    throw new TypeError('Runtime bootstrap retry count must be a non-negative safe integer.');
  }
  if (retryCount >= 2) {
    return Object.freeze({
      closePreControllerIngress: !receiverInstalled,
      delay: undefined,
      retryCount,
    });
  }
  return Object.freeze({
    closePreControllerIngress: false,
    delay: 250 * 2 ** retryCount,
    retryCount: retryCount + 1,
  });
};

export interface RuntimePlaygroundControllerOptions {
  readonly bootstrap: RuntimeBootstrap;
  readonly client: RuntimePlaygroundClient;
  readonly defaultProfileId?: string;
  readonly profiles: readonly RuntimeProfileOption[];
}

const errorMessage = (reason: unknown): string =>
  messageFrom(reason, 'Runtime request could not be completed.');

const isForegroundEffect = (
  effect: RuntimeModel['activeEffect'] | RuntimeModel['pendingEffect'],
): boolean =>
  effect?.kind === 'create-run' ||
  effect?.kind === 'replay-run' ||
  effect?.kind === 'reset-state';

const hasAcceptedForegroundEffect = (
  previous: RuntimeModel,
  next: RuntimeModel,
): boolean => {
  const existing = new Set(
    [previous.activeEffect, previous.pendingEffect].flatMap((effect) =>
      effect === undefined || !isForegroundEffect(effect) ? [] : [effect.id]),
  );
  return [next.activeEffect, next.pendingEffect].some((effect) =>
    effect !== undefined && isForegroundEffect(effect) && !existing.has(effect.id));
};

const isCorrelatedForegroundSuccess = (
  previous: RuntimeModel,
  action: RuntimeModelAction,
): boolean =>
  (action.type === 'reset.received' &&
    previous.activeEffect?.kind === 'reset-state' &&
    previous.activeEffect.id === action.id) ||
  (action.type === 'run.received' &&
    (previous.activeEffect?.kind === 'create-run' ||
      previous.activeEffect?.kind === 'replay-run'));

class RuntimePlaygroundControllerImpl implements RuntimePlaygroundController {
  readonly #client: RuntimePlaygroundClient;
  readonly #listeners = new Set<(model: RuntimeModel) => void>();
  #effectDrain: Promise<void> | undefined;
  #eventTail: Promise<void> = Promise.resolve();
  #error: string | undefined;
  #model: RuntimeModel;
  #mounted = true;

  constructor({
    bootstrap,
    client,
    defaultProfileId,
    profiles,
  }: RuntimePlaygroundControllerOptions) {
    this.#client = client;
    this.#model = createRuntimeModel({ bootstrap, defaultProfileId, profiles });
  }

  get error(): string | undefined {
    return this.#error;
  }

  get model(): RuntimeModel {
    return this.#model;
  }

  downloadRunFlight(runId: string): Promise<Blob> {
    return this.#client.readRunFlight(runId);
  }

  readRunDocument(
    runId: string,
    signal?: AbortSignal,
  ): Promise<readonly AgentRenderEvent[]> {
    return this.#client.readRunDocument(runId, signal);
  }

  close(): void {
    this.#mounted = false;
    this.#listeners.clear();
  }

  dispatch(action: RuntimeModelAction): void {
    if (!this.#mounted) return;
    const previous = this.#model;
    this.#model = reduceRuntimeModel(this.#model, action);
    if (
      this.#error !== undefined &&
      (hasAcceptedForegroundEffect(previous, this.#model) ||
        isCorrelatedForegroundSuccess(previous, action))
    ) {
      this.#error = undefined;
    }
    this.#notify();
    this.#scheduleEffects();
  }

  receive(event: ProjectEventMessage): Promise<void> {
    if (!this.#mounted) return Promise.resolve();
    const received = this.#eventTail.then(async () => {
      if (!this.#mounted) return;
      this.dispatch({ event, type: 'event.received' });
      await this.#waitForEffects();
    });
    this.#eventTail = received.catch((reason: unknown) => {
      if (this.#mounted) this.#error = errorMessage(reason);
    });
    return received;
  }

  subscribe(listener: (model: RuntimeModel) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async whenIdle(): Promise<void> {
    while (this.#mounted) {
      const events = this.#eventTail;
      await events;
      const effects = this.#effectDrain;
      if (effects !== undefined) {
        await effects;
        continue;
      }
      if (effectFor(this.#model) !== undefined) {
        this.#scheduleEffects();
        continue;
      }
      return;
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#model);
  }

  #scheduleEffects(): void {
    if (
      !this.#mounted ||
      this.#effectDrain !== undefined ||
      effectFor(this.#model) === undefined
    ) {
      return;
    }
    this.#effectDrain = this.#drainEffects().finally(() => {
      this.#effectDrain = undefined;
      this.#scheduleEffects();
    });
  }

  async #waitForEffects(): Promise<void> {
    while (this.#mounted) {
      const effects = this.#effectDrain;
      if (effects !== undefined) {
        await effects;
        continue;
      }
      if (effectFor(this.#model) === undefined) return;
      this.#scheduleEffects();
    }
  }

  async #drainEffects(): Promise<void> {
    while (this.#mounted) {
      const effect = effectFor(this.#model);
      if (effect === undefined) return;
      try {
        switch (effect.kind) {
          case 'bootstrap':
            this.dispatch({
              bootstrap: await this.#client.bootstrap(),
              type: 'bootstrap.received',
            });
            break;
          case 'create-run':
            this.dispatch({
              run: await this.#client.createRun(effect.request),
              type: 'run.received',
            });
            break;
          case 'read-run':
            this.dispatch({
              run: await this.#client.readRun(effect.runId),
              type: 'run.received',
            });
            break;
          case 'replay-run':
            this.dispatch({
              run: await this.#client.replayRun(effect.request),
              type: 'run.received',
            });
            break;
          case 'reset-state':
            this.dispatch({
              id: effect.id,
              state: await this.#client.resetState(effect.request),
              type: 'reset.received',
            });
            break;
          default: {
            const exhaustive: never = effect;
            return exhaustive;
          }
        }
      } catch (reason) {
        if (!this.#mounted) return;
        this.#error = errorMessage(reason);
        this.dispatch(
          reason instanceof RuntimeClientError && reason.code === 'AB8204'
            ? { id: effect.id, type: 'effect.conflict' }
            : { id: effect.id, type: 'effect.settled' },
        );
      }
    }
  }
}

export const createRuntimePlaygroundController = (
  options: RuntimePlaygroundControllerOptions,
): RuntimePlaygroundController => new RuntimePlaygroundControllerImpl(options);

class RuntimeEventBufferImpl implements RuntimeEventBuffer {
  #closed = false;
  #installing = false;
  readonly #maximumPendingEvents: number;
  #pending: ProjectEventMessage[] = [];
  #replayGap: ProjectReplayGap | undefined;
  #receiver: RuntimeEventReceiver | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor({ maximumPendingEvents = 64 }: RuntimeEventBufferOptions = {}) {
    if (
      !Number.isSafeInteger(maximumPendingEvents) ||
      maximumPendingEvents < 1
    ) {
      throw new TypeError(
        'Runtime event buffer capacity must be a positive safe integer.',
      );
    }
    this.#maximumPendingEvents = maximumPendingEvents;
  }

  close(): void {
    this.#closed = true;
    this.#pending = [];
    this.#replayGap = undefined;
    this.#receiver = undefined;
  }

  install(receiver: RuntimeEventReceiver): void {
    if (this.#closed || this.#installing || this.#receiver !== undefined) return;
    this.#installing = true;
    this.#tail = this.#tail.then(async () => {
      if (this.#closed) return;
      const pending =
        this.#replayGap === undefined
          ? this.#pending
          : [this.#replayGap, ...this.#pending];
      this.#pending = [];
      this.#replayGap = undefined;
      for (const event of pending) await receiver.receive(event);
      if (!this.#closed) this.#receiver = receiver;
    }).then(
      () => { this.#installing = false; },
      () => { this.#installing = false; },
    );
  }

  receive(event: ProjectEventMessage): void {
    this.#tail = this.#tail.then(async () => {
      if (this.#closed) return;
      const receiver = this.#receiver;
      if (receiver === undefined) {
        if (event.type === 'runtime.event' || event.type === 'replay.gap') {
          this.#queue(event);
        }
        return;
      }
      await receiver.receive(event);
    }).catch(() => undefined);
  }

  whenIdle(): Promise<void> {
    return this.#tail;
  }

  #queue(event: ProjectEventMessage): void {
    if (event.type === 'replay.gap') {
      this.#pending = [];
      this.#mergeReplayGap(event);
      return;
    }
    this.#pending.push(event);
    if (this.#pending.length <= this.#maximumPendingEvents) return;
    const dropped = this.#pending.splice(
      0,
      this.#pending.length - this.#maximumPendingEvents,
    );
    const sequences = dropped.flatMap((message) =>
      message.type === 'runtime.event' ? [message.sequence] : []);
    if (sequences.length === 0) return;
    const earliestDroppedSequence = Math.min(...sequences);
    const latestDroppedSequence = Math.max(...sequences);
    this.#mergeReplayGap(Object.freeze({
      earliestAvailableSequence: latestDroppedSequence + 1,
      latestDroppedSequence,
      requestedAfterSequence: earliestDroppedSequence - 1,
      type: 'replay.gap' as const,
    }));
  }

  #mergeReplayGap(next: ProjectReplayGap): void {
    const previous = this.#replayGap;
    if (previous === undefined) {
      this.#replayGap = Object.freeze({ ...next });
      return;
    }
    const latestDroppedSequence = Math.max(
      previous.latestDroppedSequence,
      next.latestDroppedSequence,
    );
    this.#replayGap = Object.freeze({
      earliestAvailableSequence: Math.max(
        previous.earliestAvailableSequence,
        next.earliestAvailableSequence,
        latestDroppedSequence + 1,
      ),
      latestDroppedSequence,
      requestedAfterSequence: Math.min(
        previous.requestedAfterSequence,
        next.requestedAfterSequence,
      ),
      type: 'replay.gap',
    });
  }
}

export const createRuntimeEventBuffer = (
  options?: RuntimeEventBufferOptions,
): RuntimeEventBuffer => new RuntimeEventBufferImpl(options);
