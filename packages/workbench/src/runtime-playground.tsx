import React, { useEffect, useRef, useState } from 'react';

import type {
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
} from '../../agent-bundle/src/dev/runtime-protocol.ts';
import type { ProjectEventMessage, ProjectReplayGap } from '../../agent-bundle/src/dev/types.ts';
import { RuntimeClientError, type RuntimeBootstrap } from './runtime-client.ts';
import { McpJsonInput, serializeJsonValue, type ImmutableJsonValue } from './mcp/mcp-json-input.tsx';
import {
  createRuntimeModel,
  effectFor,
  reduceRuntimeModel,
  type RuntimeModel,
  type RuntimeModelAction,
  type RuntimeProfileOption,
} from './runtime-model.ts';
import type {
  RuntimeAppPreviewRenderer,
  RuntimeLiveMcpPageAdapter,
} from './runtime-stage.tsx';

const RuntimeStage = React.lazy(async () => ({ default: (await import('./runtime-stage.tsx')).RuntimeStage }));
const RuntimeInspector = React.lazy(async () => ({ default: (await import('./runtime-inspector.tsx')).RuntimeInspector }));

export type RuntimePlaygroundClient = Readonly<{
  bootstrap(): Promise<RuntimeBootstrap>;
  createRun(request: DevRuntimeInvocationRequest): Promise<DevRuntimeRun>;
  readRun(runId: string): Promise<DevRuntimeRun>;
  replayRun(request: DevRuntimeReplayRequest): Promise<DevRuntimeRun>;
  resetState(request: DevRuntimeStateResetRequest): Promise<DevRuntimeStateIdentity>;
}>;

export interface RuntimePlaygroundController {
  close(): void;
  dispatch(action: RuntimeModelAction): void;
  readonly error: string | undefined;
  receive(event: ProjectEventMessage): Promise<void>;
  readonly model: RuntimeModel;
  subscribe(listener: (model: RuntimeModel) => void): () => void;
  whenIdle(): Promise<void>;
}

export interface RuntimeAppPreviewLifecycle {
  close(): Promise<void>;
}

export type RuntimeAppPreviewLifecycleRegistrar = (handle: RuntimeAppPreviewLifecycle) => () => void;

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
  /** Bounded Runtime events until the controller is available; replay repair is retained separately. */
  readonly maximumPendingEvents?: number;
}

export type RuntimeBootstrapRetryPlan = Readonly<{
  readonly closePreControllerIngress: boolean;
  readonly delay: number | undefined;
  readonly retryCount: number;
}>;

/** Keeps bootstrap retries bounded without ever severing an already-installed Runtime receiver. */
export const runtimeBootstrapRetryPlan = (
  retryCount: number,
  receiverInstalled: boolean,
): RuntimeBootstrapRetryPlan => {
  if (!Number.isSafeInteger(retryCount) || retryCount < 0) throw new TypeError('Runtime bootstrap retry count must be a non-negative safe integer.');
  if (retryCount >= 2) return Object.freeze({ closePreControllerIngress: !receiverInstalled, delay: undefined, retryCount });
  return Object.freeze({ closePreControllerIngress: false, delay: 250 * 2 ** retryCount, retryCount: retryCount + 1 });
};

export interface RuntimePlaygroundControllerOptions {
  readonly bootstrap: RuntimeBootstrap;
  readonly client: RuntimePlaygroundClient;
  readonly profiles: readonly RuntimeProfileOption[];
}

export const runtimePlaygroundLiveMcpPageAdapter: RuntimeLiveMcpPageAdapter = Object.freeze({ kind: 'disabled' });

const errorMessage = (reason: unknown): string => reason instanceof Error
  ? reason.message
  : 'Runtime request could not be completed.';

const isForegroundEffect = (effect: RuntimeModel['activeEffect'] | RuntimeModel['pendingEffect']): boolean =>
  effect?.kind === 'create-run' || effect?.kind === 'replay-run' || effect?.kind === 'reset-state';

const hasAcceptedForegroundEffect = (previous: RuntimeModel, next: RuntimeModel): boolean => {
  const existing = new Set([previous.activeEffect, previous.pendingEffect].flatMap((effect) =>
    effect === undefined || !isForegroundEffect(effect) ? [] : [effect.id]));
  return [next.activeEffect, next.pendingEffect].some((effect) =>
    effect !== undefined && isForegroundEffect(effect) && !existing.has(effect.id));
};

const isCorrelatedForegroundSuccess = (previous: RuntimeModel, action: RuntimeModelAction): boolean =>
  (action.type === 'reset.received' && previous.activeEffect?.kind === 'reset-state' && previous.activeEffect.id === action.id) ||
  (action.type === 'run.received' && (previous.activeEffect?.kind === 'create-run' || previous.activeEffect?.kind === 'replay-run'));

class RuntimePlaygroundControllerImpl implements RuntimePlaygroundController {
  readonly #client: RuntimePlaygroundClient;
  readonly #listeners = new Set<(model: RuntimeModel) => void>();
  #effectDrain: Promise<void> | undefined;
  #eventTail: Promise<void> = Promise.resolve();
  #error: string | undefined;
  #model: RuntimeModel;
  #mounted = true;

  constructor({ bootstrap, client, profiles }: RuntimePlaygroundControllerOptions) {
    this.#client = client;
    this.#model = createRuntimeModel({ bootstrap, profiles });
  }

  get error(): string | undefined {
    return this.#error;
  }

  get model(): RuntimeModel {
    return this.#model;
  }

  close(): void {
    this.#mounted = false;
    this.#listeners.clear();
  }

  dispatch(action: RuntimeModelAction): void {
    if (!this.#mounted) return;
    const previous = this.#model;
    this.#model = reduceRuntimeModel(this.#model, action);
    if (this.#error !== undefined && (hasAcceptedForegroundEffect(previous, this.#model) || isCorrelatedForegroundSuccess(previous, action))) {
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
    if (!this.#mounted || this.#effectDrain !== undefined || effectFor(this.#model) === undefined) return;
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
        if (effect.kind === 'bootstrap') {
          this.dispatch({ bootstrap: await this.#client.bootstrap(), type: 'bootstrap.received' });
        } else if (effect.kind === 'create-run') {
          this.dispatch({ run: await this.#client.createRun(effect.request), type: 'run.received' });
        } else if (effect.kind === 'read-run') {
          this.dispatch({ run: await this.#client.readRun(effect.runId), type: 'run.received' });
        } else if (effect.kind === 'replay-run') {
          this.dispatch({ run: await this.#client.replayRun(effect.request), type: 'run.received' });
        } else {
          this.dispatch({ id: effect.id, state: await this.#client.resetState(effect.request), type: 'reset.received' });
        }
      } catch (reason) {
        if (!this.#mounted) return;
        this.#error = errorMessage(reason);
        this.dispatch(reason instanceof RuntimeClientError && reason.code === 'AB8204'
          ? { id: effect.id, type: 'effect.conflict' }
          : { id: effect.id, type: 'effect.settled' });
      }
    }
  }
}

export const createRuntimePlaygroundController = (options: RuntimePlaygroundControllerOptions): RuntimePlaygroundController =>
  new RuntimePlaygroundControllerImpl(options);

class RuntimeEventBufferImpl implements RuntimeEventBuffer {
  #closed = false;
  #installing = false;
  readonly #maximumPendingEvents: number;
  #pending: ProjectEventMessage[] = [];
  #replayGap: ProjectReplayGap | undefined;
  #receiver: RuntimeEventReceiver | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor({ maximumPendingEvents = 64 }: RuntimeEventBufferOptions = {}) {
    if (!Number.isSafeInteger(maximumPendingEvents) || maximumPendingEvents < 1) {
      throw new TypeError('Runtime event buffer capacity must be a positive safe integer.');
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
      const pending = this.#replayGap === undefined ? this.#pending : [this.#replayGap, ...this.#pending];
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
        if (event.type === 'runtime.event' || event.type === 'replay.gap') this.#queue(event);
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
    const dropped = this.#pending.splice(0, this.#pending.length - this.#maximumPendingEvents);
    const sequences = dropped.flatMap((message) => message.type === 'runtime.event' ? [message.sequence] : []);
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
    const latestDroppedSequence = Math.max(previous.latestDroppedSequence, next.latestDroppedSequence);
    this.#replayGap = Object.freeze({
      earliestAvailableSequence: Math.max(previous.earliestAvailableSequence, next.earliestAvailableSequence, latestDroppedSequence + 1),
      latestDroppedSequence,
      requestedAfterSequence: Math.min(previous.requestedAfterSequence, next.requestedAfterSequence),
      type: 'replay.gap',
    });
  }
}

export const createRuntimeEventBuffer = (options?: RuntimeEventBufferOptions): RuntimeEventBuffer => new RuntimeEventBufferImpl(options);

export interface RuntimePlaygroundProps {
  readonly controller: RuntimePlaygroundController;
  readonly registerAppPreviewLifecycle?: RuntimeAppPreviewLifecycleRegistrar;
  readonly renderAppPreview?: RuntimeAppPreviewRenderer;
}

const selectedRun = (model: RuntimeModel): DevRuntimeRun | undefined =>
  model.history.find((entry) => entry.id === model.selectedRunId);

const selectedLastGoodRun = (model: RuntimeModel): DevRuntimeRun | undefined =>
  model.history.find((entry) => entry.id === model.lastGoodRunId);

const selectedSurface = (model: RuntimeModel) => model.surfaces.find((entry) => entry.id === model.selectedSurfaceId);

const selectedProfile = (model: RuntimeModel) => model.profiles.find((entry) => entry.id === model.selectedProfileId);

type RuntimeDisplayIdentity = Readonly<{
  readonly hmrClientCount: number | 'Unknown';
  readonly stateIdentity: DevRuntimeStateIdentity | undefined;
}>;

const runtimeDisplayIdentityFor = (model: RuntimeModel): RuntimeDisplayIdentity => {
  const surfaceId = model.selectedSurfaceId;
  const hmrClientCount = surfaceId !== undefined && model.hmrClientCountKnownSurfaces.includes(surfaceId)
    ? model.hmrClientCountBySurface[surfaceId] ?? 0
    : 'Unknown';
  const vector = model.status?.activeVector;
  return Object.freeze({
    hmrClientCount,
    stateIdentity: model.stateIdentity ?? (vector === undefined
      ? undefined
      : Object.freeze({ stateStoreId: vector.stateStoreId, stateVersion: vector.stateVersion })),
  });
};

export const runtimeDataAttributesFor = (model: RuntimeModel): Readonly<Record<string, string>> => {
  const vector = model.status?.activeVector;
  if (vector === undefined) return Object.freeze({});
  const identity = runtimeDisplayIdentityFor(model);
  return Object.freeze({
    'data-runtime-artifact-epoch': vector.artifactEpochId ?? 'Not packaged',
    'data-runtime-event-sequence': String(model.lastConsumedEventSequence),
    'data-runtime-generation': vector.runtimeGenerationId,
    'data-runtime-hmr-client-count': String(identity.hmrClientCount),
    'data-runtime-hmr-ready': String(model.status?.hmrReady === true),
    'data-runtime-provider-session': vector.providerSessionId,
    'data-runtime-source-revision': vector.sourceRevision,
    'data-runtime-state-version': String(identity.stateIdentity?.stateVersion ?? 'Unknown'),
  });
};

const historyLabel = (run: DevRuntimeRun): string => [
  run.status,
  run.surfaceId,
  run.target,
  `provider ${run.vector.providerSessionId.slice(-8)}`,
  `generation ${run.vector.runtimeGenerationId.slice(-8)}`,
  `state ${run.vector.stateVersion}`,
  new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(run.startedAt)),
].join(' · ');

const resetSeedLabel = (request: DevRuntimeStateResetRequest): string =>
  request.seed === undefined ? 'No fixture seed' : JSON.stringify(request.seed);

export const RuntimePlayground = ({ controller, registerAppPreviewLifecycle, renderAppPreview }: RuntimePlaygroundProps): React.ReactNode => {
  const [model, setModel] = useState(controller.model);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const invokingRef = useRef<HTMLButtonElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const requestErrorRef = useRef<HTMLParagraphElement>(null);
  const resetStatusRef = useRef<HTMLParagraphElement>(null);
  const confirmationOutcome = useRef<'cancelled' | 'confirmed' | undefined>(undefined);
  const resetEffectId = useRef<string | undefined>(undefined);
  const priorConfirmation = useRef(model.confirmation);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const surface = selectedSurface(model);
  const run = selectedRun(model);
  const evidenceSurface = run === undefined ? surface : model.surfaces.find((entry) => entry.id === run.surfaceId) ?? surface;
  const lastGoodRun = selectedLastGoodRun(model);
  const profile = selectedProfile(model);
  const attributes = runtimeDataAttributesFor(model);
  const requestError = controller.error;
  const activeVector = model.status?.activeVector;
  const displayIdentity = runtimeDisplayIdentityFor(model);
  const interactionLocked = model.activeEffect !== undefined || model.confirmation !== undefined;
  const resetDisabled = interactionLocked || model.stateIdentity === undefined;

  const replaceDraft = (next: ImmutableJsonValue): void => {
    controller.dispatch({ input: next, raw: serializeJsonValue(next), type: 'draft.replace' });
  };

  const cancelConfirmation = (): void => {
    if (confirmationPending) return;
    confirmationOutcome.current = 'cancelled';
    controller.dispatch({ type: 'confirmation.cancel' });
  };

  const requestReset = (): void => {
    if (interactionLocked) return;
    setConfirmationPending(false);
    controller.dispatch({ type: 'reset.request' });
  };

  const confirmConfirmation = (): void => {
    if (confirmationPending || model.confirmation === undefined) return;
    confirmationOutcome.current = 'confirmed';
    setConfirmationPending(true);
    controller.dispatch({ type: 'confirmation.confirm' });
    const effect = controller.model.activeEffect;
    resetEffectId.current = effect?.kind === 'reset-state' ? effect.id : undefined;
  };

  useEffect(() => {
    setModel(controller.model);
    return controller.subscribe(setModel);
  }, [controller]);
  useEffect(() => {
    if (model.confirmation !== undefined && priorConfirmation.current === undefined) {
      setConfirmationPending(false);
      cancelRef.current?.focus();
    } else if (priorConfirmation.current?.kind === 'run' && confirmationOutcome.current === 'cancelled') {
      invokingRef.current?.focus();
    } else if (priorConfirmation.current?.kind === 'reset' && confirmationOutcome.current === 'cancelled') {
      resetRef.current?.focus();
    }
    if (model.confirmation === undefined) {
      confirmationOutcome.current = undefined;
      setConfirmationPending(false);
    }
    priorConfirmation.current = model.confirmation;
  }, [model.confirmation]);
  useEffect(() => {
    const resetCompleted = resetEffectId.current !== undefined && model.resetCompletion?.effectId === resetEffectId.current;
    if (model.activeEffect !== undefined || resetEffectId.current === undefined) return;
    resetEffectId.current = undefined;
    if (resetCompleted) resetStatusRef.current?.focus();
    else if (requestError !== undefined) requestErrorRef.current?.focus();
  }, [model.activeEffect, model.resetCompletion, requestError]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (model.confirmation === undefined) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelConfirmation();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [cancelRef.current, confirmRef.current].filter((control): control is HTMLButtonElement => control !== null);
      if (controls.length === 0) return;
      const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0 ? controls.length - 1 : currentIndex - 1
        : currentIndex === controls.length - 1 ? 0 : currentIndex + 1;
      event.preventDefault();
      controls[nextIndex]?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, model.confirmation, confirmationPending]);

  if (model.status === undefined) return null;
  return <section aria-labelledby="runtime-playground-heading" className="runtime-playground" {...attributes}>
    <div inert={interactionLocked || undefined}>
    <header className="runtime-playground-heading">
      <div><p className="runtime-eyebrow">Optional development capability</p><h1 id="runtime-playground-heading">Runtime Playground</h1><p>Provider-owned React Server Component inspection and replay evidence.</p></div>
      <p aria-live="polite" className="runtime-status" ref={resetStatusRef} tabIndex={-1}>
        {model.status.hmrReady ? 'HMR endpoint ready' : 'HMR endpoint unavailable'} · {model.status.state}
      </p>
    </header>
    <dl aria-label="Runtime identity" className="runtime-identity">
      <div><dt>Provider state</dt><dd>{model.status.state}</dd></div>
      <div><dt>HMR endpoint ready</dt><dd>{String(model.status.hmrReady)}</dd></div>
      <div><dt>Browser HMR clients</dt><dd>{displayIdentity.hmrClientCount}</dd></div>
      <div><dt>Provider session ID</dt><dd>{activeVector?.providerSessionId ?? 'Not available'}</dd></div>
      <div><dt>Runtime generation ID</dt><dd>{activeVector?.runtimeGenerationId ?? 'Not available'}</dd></div>
      <div><dt>Source revision</dt><dd>{activeVector?.sourceRevision ?? 'Not available'}</dd></div>
      <div><dt>Artifact epoch ID</dt><dd>{activeVector?.artifactEpochId ?? 'Not packaged'}</dd></div>
      <div><dt>State store ID</dt><dd>{displayIdentity.stateIdentity?.stateStoreId ?? 'Not available'}</dd></div>
      <div><dt>State version</dt><dd>{displayIdentity.stateIdentity?.stateVersion ?? 'Not available'}</dd></div>
      <div><dt>Last event sequence</dt><dd>{model.lastConsumedEventSequence}</dd></div>
      <div><dt>Target</dt><dd>{model.selectedTarget ?? 'Not available'}</dd></div>
      <div><dt>Profile version</dt><dd>{profile?.version ?? 'Not available'}</dd></div>
      <div><dt>Evidence</dt><dd>{profile?.evidence ?? 'Not available'}</dd></div>
    </dl>
    {model.replayGap === undefined ? undefined : <p className="runtime-gap" role="alert">Events {model.replayGap.requestedAfterSequence + 1}–{model.replayGap.latestDroppedSequence} were unavailable.</p>}
    {model.announcements.map((message, index) => <p aria-live="polite" className="runtime-announcement" key={`${message}-${index}`}>{message}</p>)}
    <div className="runtime-controls">
      <label>Surface<select aria-label="Runtime surface" disabled={interactionLocked} onChange={(event) => controller.dispatch({ surfaceId: event.currentTarget.value, type: 'selection.surface' })} value={surface?.id ?? ''}>
        {model.surfaces.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select></label>
      <label>Fixture<select aria-label="Runtime fixture" disabled={interactionLocked} onChange={(event) => controller.dispatch({ fixtureId: event.currentTarget.value, type: 'selection.fixture' })} value={model.selectedFixtureId ?? ''}>
        {(surface?.fixtures ?? []).map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.label}</option>)}
      </select></label>
      <label>Target<select aria-label="Runtime target" disabled={interactionLocked} onChange={(event) => controller.dispatch({ target: event.currentTarget.value, type: 'selection.target' })} value={model.selectedTarget ?? ''}>
        {(surface?.targets ?? []).map((target) => <option key={target} value={target}>{target}</option>)}
      </select></label>
      <label>Profile<select aria-label="Runtime profile" disabled={interactionLocked} onChange={(event) => controller.dispatch({ profileId: event.currentTarget.value, type: 'selection.profile' })} value={model.selectedProfileId ?? ''}>
        {model.profiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select></label>
      <p className="runtime-profile-disclaimer">Profile simulation is evidence-only and does not claim real host parity.</p>
    </div>
    <div className="runtime-input">
      <McpJsonInput
        allowNonObjectJson
        disabled={interactionLocked}
        formLabel="Schema form"
        id="runtime-input"
        invalidJsonLabel="Draft JSON is invalid. Repair the raw input before running."
        label="Runtime input"
        onChange={replaceDraft}
        onRawDraftChange={(raw) => controller.dispatch({ raw, type: 'draft.raw' })}
        onSubmit={(next) => {
          replaceDraft(next);
          controller.dispatch({ type: 'run.request' });
        }}
        rawDraft={model.draft.raw}
        schema={surface?.inputSchema}
        submitLabel="Run"
        submitRef={invokingRef}
        value={model.draft.input}
      />
    </div>
    <div className="runtime-actions">
      <button disabled={resetDisabled} onClick={requestReset} ref={resetRef} type="button">Reset fixture state</button>
    </div>
    </div>
    {model.confirmation === undefined ? undefined : <div aria-describedby="runtime-confirmation-copy" aria-modal="true" className="runtime-confirmation" role="dialog">
      <h2>{model.confirmation.kind === 'reset' ? 'Reset fixture state?' : 'Run mutable runtime surface?'}</h2>
      {model.confirmation.kind === 'reset' ? <>
        <p id="runtime-confirmation-copy">This resets the selected provider-owned state store and then queues one follow-up runtime run.</p>
        <dl className="runtime-reset-summary">
          <div><dt>State store</dt><dd>{model.confirmation.request.stateStoreId}</dd></div>
          <div><dt>Fixture seed</dt><dd><code>{resetSeedLabel(model.confirmation.request)}</code></dd></div>
        </dl>
      </> : <p id="runtime-confirmation-copy">This sends one provider-owned runtime request.</p>}
      <button disabled={confirmationPending} onClick={cancelConfirmation} ref={cancelRef} type="button">Cancel</button>
      <button disabled={confirmationPending} onClick={confirmConfirmation} ref={confirmRef} type="button">Confirm</button>
    </div>}
    <div inert={interactionLocked || undefined}>
    {requestError === undefined ? undefined : <p className="runtime-request-error" ref={requestErrorRef} role="alert" tabIndex={-1}>{requestError}</p>}
    <div className="runtime-layout">
      <section aria-label="Runtime run history" className="runtime-history"><h2>Run history</h2><ol>{model.history.map((entry) => <li data-runtime-run-id={entry.id} key={entry.id}>
        <button aria-pressed={entry.id === model.selectedRunId} disabled={interactionLocked} onClick={controller.dispatch.bind(controller, { runId: entry.id, type: 'selection.run' })} type="button">{historyLabel(entry)}</button>
        <button disabled={interactionLocked} onClick={controller.dispatch.bind(controller, { runId: entry.id, type: 'draft.from-run' })} type="button">Edit as new draft</button>
        <button disabled={interactionLocked} onClick={controller.dispatch.bind(controller, { mode: 'exact', runId: entry.id, type: 'replay.request' })} type="button">Replay exact</button>
        <button disabled={interactionLocked} onClick={controller.dispatch.bind(controller, { mode: 'latest', runId: entry.id, type: 'replay.request' })} type="button">Replay latest</button>
      </li>)}</ol></section>
      <div className="runtime-evidence">
        <React.Suspense fallback={<p>Loading runtime evidence…</p>}>
          <RuntimeStage
            lastGoodRun={lastGoodRun}
            profile={profile}
            profileId={model.selectedProfileId}
            registerAppPreviewLifecycle={registerAppPreviewLifecycle}
            renderAppPreview={renderAppPreview}
            run={run}
            status={model.status}
            surface={surface}
          />
          <RuntimeInspector onTabChange={(tab) => controller.dispatch({ tab, type: 'selection.tab' })} run={run} status={model.status} surface={evidenceSurface} tab={model.selectedTab} />
        </React.Suspense>
      </div>
    </div>
    </div>
  </section>;
};
