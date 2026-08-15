import React, { useEffect, useRef, useState } from 'react';

import type {
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
} from '../../agent-bundle/src/dev/runtime-protocol.ts';
import type { ProjectEventMessage } from '../../agent-bundle/src/dev/types.ts';
import { RuntimeClientError, type RuntimeBootstrap } from './runtime-client.ts';
import {
  createRuntimeModel,
  effectFor,
  reduceRuntimeModel,
  type RuntimeModel,
  type RuntimeModelAction,
  type RuntimeProfileOption,
} from './runtime-model.ts';
import type { RuntimeLiveMcpPageAdapter } from './runtime-stage.tsx';

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

export interface RuntimePlaygroundControllerOptions {
  readonly bootstrap: RuntimeBootstrap;
  readonly client: RuntimePlaygroundClient;
  readonly profiles: readonly RuntimeProfileOption[];
}

export const runtimePlaygroundLiveMcpPageAdapter: RuntimeLiveMcpPageAdapter = Object.freeze({ kind: 'disabled' });

const errorMessage = (reason: unknown): string => reason instanceof Error
  ? reason.message
  : 'Runtime request could not be completed.';

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
    this.#model = reduceRuntimeModel(this.#model, action);
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

export interface RuntimePlaygroundProps {
  readonly controller: RuntimePlaygroundController;
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

export const RuntimePlayground = ({ controller }: RuntimePlaygroundProps): React.ReactNode => {
  const [model, setModel] = useState(controller.model);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const invokingRef = useRef<HTMLButtonElement>(null);
  const resetStatusRef = useRef<HTMLParagraphElement>(null);
  const priorConfirmation = useRef(model.confirmation);
  const surface = selectedSurface(model);
  const run = selectedRun(model);
  const lastGoodRun = selectedLastGoodRun(model);
  const profile = selectedProfile(model);
  const attributes = runtimeDataAttributesFor(model);
  const activeVector = model.status?.activeVector;
  const displayIdentity = runtimeDisplayIdentityFor(model);

  useEffect(() => {
    setModel(controller.model);
    return controller.subscribe(setModel);
  }, [controller]);
  useEffect(() => {
    if (model.confirmation !== undefined) cancelRef.current?.focus();
    if (priorConfirmation.current?.kind === 'run' && model.confirmation === undefined) invokingRef.current?.focus();
    if (priorConfirmation.current?.kind === 'reset' && model.confirmation === undefined) resetStatusRef.current?.focus();
    priorConfirmation.current = model.confirmation;
  }, [model.confirmation]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && model.confirmation !== undefined) controller.dispatch({ type: 'confirmation.cancel' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, model.confirmation]);

  if (model.status === undefined) return null;
  return <section aria-labelledby="runtime-playground-heading" className="runtime-playground" {...attributes}>
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
      <label>Surface<select aria-label="Runtime surface" onChange={(event) => controller.dispatch({ surfaceId: event.currentTarget.value, type: 'selection.surface' })} value={surface?.id ?? ''}>
        {model.surfaces.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select></label>
      <label>Fixture<select aria-label="Runtime fixture" onChange={(event) => controller.dispatch({ fixtureId: event.currentTarget.value, type: 'selection.fixture' })} value={model.selectedFixtureId ?? ''}>
        {(surface?.fixtures ?? []).map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.label}</option>)}
      </select></label>
      <label>Target<select aria-label="Runtime target" onChange={(event) => controller.dispatch({ target: event.currentTarget.value, type: 'selection.target' })} value={model.selectedTarget ?? ''}>
        {(surface?.targets ?? []).map((target) => <option key={target} value={target}>{target}</option>)}
      </select></label>
      <label>Profile<select aria-label="Runtime profile" onChange={(event) => controller.dispatch({ profileId: event.currentTarget.value, type: 'selection.profile' })} value={model.selectedProfileId ?? ''}>
        {model.profiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select></label>
      <p className="runtime-profile-disclaimer">Profile simulation is evidence-only and does not claim real host parity.</p>
    </div>
    <label className="runtime-input" htmlFor="runtime-input">Runtime input<textarea id="runtime-input" onChange={(event) => controller.dispatch({ raw: event.currentTarget.value, type: 'draft.raw' })} value={model.draft.raw} /></label>
    {model.draft.error === undefined ? undefined : <p className="runtime-input-error" role="alert">{model.draft.error}</p>}
    <div className="runtime-actions">
      <button disabled={model.draft.error !== undefined} onClick={controller.dispatch.bind(controller, { type: 'run.request' })} ref={invokingRef} type="button">Run</button>
      <button onClick={controller.dispatch.bind(controller, { type: 'reset.request' })} type="button">Reset fixture state</button>
    </div>
    {model.confirmation === undefined ? undefined : <div aria-describedby="runtime-confirmation-copy" aria-modal="true" className="runtime-confirmation" role="dialog">
      <h2>{model.confirmation.kind === 'reset' ? 'Reset fixture state?' : 'Run mutable runtime surface?'}</h2>
      <p id="runtime-confirmation-copy">This sends one provider-owned runtime request.</p>
      <button onClick={controller.dispatch.bind(controller, { type: 'confirmation.cancel' })} ref={cancelRef} type="button">Cancel</button>
      <button onClick={controller.dispatch.bind(controller, { type: 'confirmation.confirm' })} type="button">Confirm</button>
    </div>}
    {controller.error === undefined ? undefined : <p className="runtime-request-error" role="alert">{controller.error}</p>}
    <div className="runtime-layout">
      <section aria-label="Runtime run history" className="runtime-history"><h2>Run history</h2><ol>{model.history.map((entry) => <li key={entry.id}>
        <button aria-pressed={entry.id === model.selectedRunId} onClick={controller.dispatch.bind(controller, { runId: entry.id, type: 'selection.run' })} type="button">{historyLabel(entry)}</button>
        <button onClick={controller.dispatch.bind(controller, { runId: entry.id, type: 'draft.from-run' })} type="button">Edit as new draft</button>
        <button onClick={controller.dispatch.bind(controller, { mode: 'exact', runId: entry.id, type: 'replay.request' })} type="button">Replay exact</button>
        <button onClick={controller.dispatch.bind(controller, { mode: 'latest', runId: entry.id, type: 'replay.request' })} type="button">Replay latest</button>
      </li>)}</ol></section>
      <div className="runtime-evidence">
        <React.Suspense fallback={<p>Loading runtime evidence…</p>}>
          <RuntimeStage lastGoodRun={lastGoodRun} profile={profile} profileId={model.selectedProfileId} run={run} status={model.status} surface={surface} />
          <RuntimeInspector onTabChange={(tab) => controller.dispatch({ tab, type: 'selection.tab' })} run={run} status={model.status} surface={surface} tab={model.selectedTab} />
        </React.Suspense>
      </div>
    </div>
  </section>;
};
