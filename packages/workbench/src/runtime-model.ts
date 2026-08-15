import type {
  DevRuntimeFixture,
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
  DevRuntimeStatus,
  DevRuntimeSurface,
  RuntimeVector,
} from '../../agent-bundle/src/dev/runtime-protocol.ts';
import type { JsonValue, ProjectEventMessage, ProjectReplayGap } from '../../agent-bundle/src/dev/types.ts';
import type { RuntimeBootstrap } from './runtime-client.ts';

export type RuntimeInspectorTab = 'tree' | 'result' | 'flight' | 'protocol' | 'state' | 'diagnostics';

export interface RuntimePendingEffect {
  readonly id: string;
  readonly kind: 'bootstrap' | 'create-run' | 'read-run' | 'replay-run' | 'reset-state';
  readonly triggerSequence?: number;
}

export interface RuntimeProfileOption {
  readonly claimsRealHostParity: false;
  readonly evidence: 'simulated';
  readonly id: string;
  readonly label: string;
  readonly version: string;
}

export interface RuntimeDraft {
  readonly error?: string;
  readonly input: JsonValue;
  readonly raw: string;
}

export interface RuntimeStaleIdentity {
  readonly current: RuntimeVector;
  readonly selected: RuntimeVector;
}

export interface RuntimePreviousProviderLastGood {
  readonly label: 'Previous provider session';
  readonly run: DevRuntimeRun;
}

export type RuntimeModelEffect =
  | Readonly<{ readonly kind: 'bootstrap'; readonly triggerSequence?: number }>
  | Readonly<{ readonly cause: 'manual' | 'reset'; readonly kind: 'create-run'; readonly request: DevRuntimeInvocationRequest }>
  | Readonly<{ readonly kind: 'read-run'; readonly runId: string }>
  | Readonly<{ readonly kind: 'replay-run'; readonly request: DevRuntimeReplayRequest }>
  | Readonly<{ readonly kind: 'reset-state'; readonly request: DevRuntimeStateResetRequest }>;

type RuntimeQueuedEffect = RuntimePendingEffect & RuntimeModelEffect & Readonly<{
  readonly operation: RuntimeModelEffect;
}>;

export type RuntimeConfirmation =
  | Readonly<{ readonly kind: 'run'; readonly request: DevRuntimeInvocationRequest }>
  | Readonly<{ readonly kind: 'reset'; readonly request: DevRuntimeStateResetRequest }>;

export interface RuntimeModel {
  readonly activeEffect?: RuntimeQueuedEffect;
  readonly announcements: readonly string[];
  readonly confirmation?: RuntimeConfirmation;
  readonly draft: RuntimeDraft;
  readonly expandedTraceSpanIds: readonly string[];
  readonly history: readonly DevRuntimeRun[];
  readonly hmrClientCountBySurface: Readonly<Record<string, number>>;
  readonly hmrClientCountKnownSurfaces: readonly string[];
  readonly lastConsumedEventSequence: number;
  readonly lastGoodRunId?: string;
  readonly nextEffectId: number;
  readonly pendingEffect?: RuntimeQueuedEffect;
  readonly previousProviderLastGood?: RuntimePreviousProviderLastGood;
  readonly profiles: readonly RuntimeProfileOption[];
  readonly providerSessionId?: string;
  readonly replayGap?: ProjectReplayGap;
  readonly selectedFixtureId?: string;
  readonly selectedProfileId?: string;
  readonly selectedRunId?: string;
  readonly selectedSurfaceId?: string;
  readonly selectedTarget?: string;
  readonly selectedTab: RuntimeInspectorTab;
  readonly staleIdentity?: RuntimeStaleIdentity;
  readonly stateIdentity?: DevRuntimeStateIdentity;
  readonly status?: DevRuntimeStatus;
  readonly surfaces: readonly DevRuntimeSurface[];
}

export interface RuntimeModelOptions {
  readonly bootstrap: RuntimeBootstrap;
  readonly profiles: readonly RuntimeProfileOption[];
}

export type RuntimeModelAction =
  | Readonly<{ readonly bootstrap: RuntimeBootstrap; readonly type: 'bootstrap.received' }>
  | Readonly<{ readonly event: ProjectEventMessage; readonly type: 'event.received' }>
  | Readonly<{ readonly id: string; readonly type: 'effect.settled' }>
  | Readonly<{ readonly id: string; readonly type: 'effect.conflict' }>
  | Readonly<{ readonly type: 'run.request' }>
  | Readonly<{ readonly mode: DevRuntimeReplayRequest['mode']; readonly runId: string; readonly type: 'replay.request' }>
  | Readonly<{ readonly run: DevRuntimeRun; readonly type: 'run.received' }>
  | Readonly<{ readonly type: 'reset.request' }>
  | Readonly<{ readonly id: string; readonly state: DevRuntimeStateIdentity; readonly type: 'reset.received' }>
  | Readonly<{ readonly type: 'confirmation.confirm' | 'confirmation.cancel' }>
  | Readonly<{ readonly input: JsonValue; readonly raw: string; readonly type: 'draft.replace' }>
  | Readonly<{ readonly raw: string; readonly type: 'draft.raw' }>
  | Readonly<{ readonly runId: string; readonly type: 'draft.from-run' | 'selection.run' }>
  | Readonly<{ readonly surfaceId: string; readonly type: 'selection.surface' }>
  | Readonly<{ readonly fixtureId: string; readonly type: 'selection.fixture' }>
  | Readonly<{ readonly target: string; readonly type: 'selection.target' }>
  | Readonly<{ readonly profileId: string; readonly type: 'selection.profile' }>
  | Readonly<{ readonly tab: RuntimeInspectorTab; readonly type: 'selection.tab' }>
  | Readonly<{ readonly spanId: string; readonly type: 'trace.toggle' }>;

const emptyStrings = Object.freeze([]) as readonly string[];
const emptyHistory = Object.freeze([]) as readonly DevRuntimeRun[];
const emptySurfaces = Object.freeze([]) as readonly DevRuntimeSurface[];
const emptyProfiles = Object.freeze([]) as readonly RuntimeProfileOption[];
const emptyCounts = Object.freeze(Object.create(null)) as Readonly<Record<string, number>>;
const runtimeTabs = new Set<RuntimeInspectorTab>(['tree', 'result', 'flight', 'protocol', 'state', 'diagnostics']);

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const snapshot = <Value>(value: Value, ancestors = new WeakSet<object>()): Value => {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError('Runtime model snapshots require finite JSON numbers.');
  }
  if (typeof value !== 'object') throw new TypeError('Runtime model snapshots require JSON-compatible values.');
  if (ancestors.has(value)) throw new TypeError('Runtime model snapshots must not contain cyclic or repeated references.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new TypeError('Runtime model snapshots must not contain sparse arrays or accessors.');
        }
        copy.push(snapshot(descriptor.value, ancestors));
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
          throw new TypeError('Runtime model snapshots must not contain array properties.');
        }
      }
      return Object.freeze(copy) as Value;
    }
    if (!isPlainRecord(value)) throw new TypeError('Runtime model snapshots require plain objects.');
    const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('Runtime model snapshots must not contain symbol keys.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) throw new TypeError('Runtime model snapshots must not contain accessors.');
      Object.defineProperty(copy, key, {
        configurable: false,
        enumerable: descriptor.enumerable,
        value: snapshot(descriptor.value, ancestors),
        writable: false,
      });
    }
    return Object.freeze(copy) as Value;
  } finally {
    ancestors.delete(value);
  }
};

const snapshotProfiles = (profiles: readonly RuntimeProfileOption[]): readonly RuntimeProfileOption[] => {
  const ids = new Set<string>();
  const copies = profiles.map((profile) => {
    if (profile.claimsRealHostParity !== false || profile.evidence !== 'simulated' || profile.id.length === 0 || profile.label.length === 0 || profile.version.length === 0 || ids.has(profile.id)) {
      throw new TypeError('Runtime profiles must be unique simulated profiles.');
    }
    ids.add(profile.id);
    return snapshot(profile);
  });
  return Object.freeze(copies);
};

const stateIdentityFor = (vector: RuntimeVector | undefined): DevRuntimeStateIdentity | undefined => vector === undefined
  ? undefined
  : Object.freeze({ stateStoreId: vector.stateStoreId, stateVersion: vector.stateVersion });

const runOrder = (left: DevRuntimeRun, right: DevRuntimeRun): number => {
  const started = right.startedAt.localeCompare(left.startedAt);
  return started === 0 ? left.id.localeCompare(right.id) : started;
};

const historyFor = (runs: readonly DevRuntimeRun[], providerSessionId: string): readonly DevRuntimeRun[] => {
  const byId = new Map<string, DevRuntimeRun>();
  for (const source of runs) {
    const entry = snapshot(source);
    if (entry.vector.providerSessionId !== providerSessionId) {
      throw new TypeError('Runtime history must belong to the active provider session.');
    }
    const previous = byId.get(entry.id);
    if (previous === undefined || runOrder(entry, previous) < 0) byId.set(entry.id, entry);
  }
  return Object.freeze([...byId.values()].sort(runOrder).slice(0, 50));
};

const selectedSurface = (surfaces: readonly DevRuntimeSurface[], id: string | undefined): DevRuntimeSurface | undefined =>
  surfaces.find((surface) => surface.id === id) ?? surfaces[0];

const selectedFixture = (surface: DevRuntimeSurface | undefined, id: string | undefined): DevRuntimeFixture | undefined =>
  surface?.fixtures.find((fixture) => fixture.id === id) ?? surface?.fixtures[0];

const selectedTarget = (surface: DevRuntimeSurface | undefined, target: string | undefined): string | undefined => {
  if (surface === undefined) return undefined;
  if (target !== undefined && surface.targets.includes(target)) return target;
  if (surface.defaultTarget !== undefined && surface.targets.includes(surface.defaultTarget)) return surface.defaultTarget;
  return surface.targets[0];
};

const draftFor = (input: JsonValue, raw = JSON.stringify(input, null, 2)): RuntimeDraft => Object.freeze({ input: snapshot(input), raw });

const runtimeDraftFor = (fixture: DevRuntimeFixture | undefined): RuntimeDraft => draftFor(fixture?.seed ?? {});

const staleIdentityFor = (history: readonly DevRuntimeRun[], selectedRunId: string | undefined, status: DevRuntimeStatus | undefined): RuntimeStaleIdentity | undefined => {
  const selected = history.find((entry) => entry.id === selectedRunId);
  const current = status?.activeVector;
  if (selected === undefined || current === undefined || (
    selected.vector.providerSessionId === current.providerSessionId &&
    selected.vector.runtimeGenerationId === current.runtimeGenerationId &&
    selected.vector.stateStoreId === current.stateStoreId &&
    selected.vector.stateVersion === current.stateVersion
  )) return undefined;
  return snapshot({ current, selected: selected.vector });
};

const lastGoodRunIdFor = (history: readonly DevRuntimeRun[]): string | undefined =>
  history.find((entry) => entry.status === 'succeeded')?.id;

const update = (model: RuntimeModel, change: Partial<RuntimeModel>): RuntimeModel => Object.freeze({ ...model, ...change });

const announced = (model: RuntimeModel, message: string): RuntimeModel => update(model, {
  announcements: Object.freeze([...model.announcements, message]),
});

const currentSurface = (model: RuntimeModel): DevRuntimeSurface | undefined =>
  model.surfaces.find((surface) => surface.id === model.selectedSurfaceId);

const currentFixture = (model: RuntimeModel): DevRuntimeFixture | undefined =>
  currentSurface(model)?.fixtures.find((fixture) => fixture.id === model.selectedFixtureId);

const createQueuedEffect = (model: RuntimeModel, operation: RuntimeModelEffect): readonly [RuntimeModel, RuntimeQueuedEffect] => {
  const queued = Object.freeze({
    id: `runtime-effect-${model.nextEffectId}`,
    ...snapshot(operation),
    operation: snapshot(operation),
  }) as RuntimeQueuedEffect;
  return [update(model, { nextEffectId: model.nextEffectId + 1 }), queued];
};

const queueOperation = (model: RuntimeModel, operation: RuntimeModelEffect): RuntimeModel => {
  if (model.activeEffect !== undefined && model.pendingEffect !== undefined) return model;
  const [advanced, queued] = createQueuedEffect(model, operation);
  return advanced.activeEffect === undefined
    ? update(advanced, { activeEffect: queued })
    : update(advanced, { pendingEffect: queued });
};

const queueBootstrap = (model: RuntimeModel, triggerSequence?: number): RuntimeModel => {
  const existing = model.pendingEffect?.operation.kind === 'bootstrap' ? model.pendingEffect : undefined;
  if (model.activeEffect === undefined && existing === undefined) return queueOperation(model, Object.freeze({ kind: 'bootstrap', ...(triggerSequence === undefined ? {} : { triggerSequence }) }));
  if (existing !== undefined && (triggerSequence === undefined || existing.triggerSequence === undefined || triggerSequence <= existing.triggerSequence)) return model;
  if (model.activeEffect?.operation.kind === 'bootstrap' && model.pendingEffect === undefined && triggerSequence === undefined) return model;
  const [advanced, queued] = createQueuedEffect(model, Object.freeze({ kind: 'bootstrap', ...(triggerSequence === undefined ? {} : { triggerSequence }) }));
  return advanced.activeEffect === undefined ? update(advanced, { activeEffect: queued }) : update(advanced, { pendingEffect: queued });
};

const settleEffect = (model: RuntimeModel, id: string): RuntimeModel => {
  if (model.activeEffect?.id !== id) return model;
  if (model.pendingEffect === undefined) return update(model, { activeEffect: undefined });
  return update(model, { activeEffect: model.pendingEffect, pendingEffect: undefined });
};

const settleEffectKind = (model: RuntimeModel, kind: RuntimePendingEffect['kind']): RuntimeModel =>
  model.activeEffect?.kind === kind ? settleEffect(model, model.activeEffect.id) : model;

const invocationFor = (model: RuntimeModel): DevRuntimeInvocationRequest | undefined => {
  const surface = currentSurface(model);
  const target = model.selectedTarget;
  if (surface === undefined || target === undefined) return undefined;
  return snapshot({
    ...(model.status?.activeVector === undefined ? {} : { expectedGenerationId: model.status.activeVector.runtimeGenerationId }),
    ...(model.selectedFixtureId === undefined ? {} : { fixtureId: model.selectedFixtureId }),
    input: model.draft.input,
    surfaceId: surface.id,
    target,
  });
};

const resetFor = (model: RuntimeModel): DevRuntimeStateResetRequest | undefined => {
  const state = model.stateIdentity;
  if (state === undefined) return undefined;
  const seed = currentFixture(model)?.seed;
  return snapshot({
    ...(model.status?.activeVector === undefined ? {} : { expectedGenerationId: model.status.activeVector.runtimeGenerationId }),
    ...(seed === undefined ? {} : { seed }),
    stateStoreId: state.stateStoreId,
  });
};

const replaceHmrCount = (model: RuntimeModel, surfaceId: string, count: number): RuntimeModel => {
  const counts = Object.create(null) as Record<string, number>;
  for (const [currentId, currentCount] of Object.entries(model.hmrClientCountBySurface)) counts[currentId] = currentCount;
  counts[surfaceId] = count;
  const frozen = Object.freeze(counts) as Readonly<Record<string, number>>;
  return update(model, {
    hmrClientCountBySurface: frozen,
    hmrClientCountKnownSurfaces: Object.freeze(Object.keys(frozen).sort()),
  });
};

const hmrCount = (details: Record<string, JsonValue> | undefined): Readonly<{ readonly count: number; readonly surfaceId: string }> | undefined => {
  if (details === undefined || typeof details.surfaceId !== 'string' || details.surfaceId.length === 0 ||
    typeof details.connectionCount !== 'number' || !Number.isSafeInteger(details.connectionCount) || details.connectionCount < 0) return undefined;
  return Object.freeze({ count: details.connectionCount, surfaceId: details.surfaceId });
};

const bootstrapModel = (model: RuntimeModel, bootstrap: RuntimeBootstrap): RuntimeModel => {
  if (bootstrap.kind === 'unavailable') {
    return update(model, {
      history: emptyHistory,
      hmrClientCountBySurface: emptyCounts,
      hmrClientCountKnownSurfaces: emptyStrings,
      lastGoodRunId: undefined,
      providerSessionId: undefined,
      selectedFixtureId: undefined,
      selectedRunId: undefined,
      selectedSurfaceId: undefined,
      selectedTarget: undefined,
      staleIdentity: undefined,
      stateIdentity: undefined,
      status: undefined,
      surfaces: emptySurfaces,
    });
  }

  const nextSurfaces = snapshot(bootstrap.surfaces);
  const nextHistory = historyFor(bootstrap.history, bootstrap.providerSessionId);
  const nextStatus = snapshot(bootstrap.status);
  const providerRestarted = model.providerSessionId !== undefined && model.providerSessionId !== bootstrap.providerSessionId;
  const surface = selectedSurface(nextSurfaces, providerRestarted ? undefined : model.selectedSurfaceId);
  const target = selectedTarget(surface, providerRestarted ? undefined : model.selectedTarget);
  const fixture = selectedFixture(surface, providerRestarted ? undefined : model.selectedFixtureId);
  const selectedRunId = nextHistory.some((entry) => entry.id === model.selectedRunId)
    ? model.selectedRunId
    : nextHistory[0]?.id;
  const priorLastGood = model.history.find((entry) => entry.id === model.lastGoodRunId);
  const nextLastGoodRunId = lastGoodRunIdFor(nextHistory);
  let next = update(model, {
    history: nextHistory,
    ...(providerRestarted && priorLastGood !== undefined ? { previousProviderLastGood: snapshot({ label: 'Previous provider session' as const, run: priorLastGood }) } : {}),
    ...(providerRestarted ? { hmrClientCountBySurface: emptyCounts, hmrClientCountKnownSurfaces: emptyStrings } : {}),
    ...(nextLastGoodRunId === undefined ? { lastGoodRunId: undefined } : { lastGoodRunId: nextLastGoodRunId }),
    ...(nextLastGoodRunId !== undefined ? { previousProviderLastGood: undefined } : {}),
    providerSessionId: bootstrap.providerSessionId,
    selectedFixtureId: fixture?.id,
    selectedRunId,
    selectedSurfaceId: surface?.id,
    selectedTarget: target,
    staleIdentity: staleIdentityFor(nextHistory, selectedRunId, nextStatus),
    stateIdentity: stateIdentityFor(nextStatus.activeVector),
    status: nextStatus,
    surfaces: nextSurfaces,
  });
  if (model.selectedSurfaceId !== undefined && model.selectedSurfaceId !== surface?.id) next = announced(next, 'Selected runtime surface is no longer available; provider defaults were selected.');
  else if (model.selectedTarget !== undefined && model.selectedTarget !== target) next = announced(next, 'Selected runtime target is no longer available; provider defaults were selected.');
  return next;
};

export const createRuntimeModel = ({ bootstrap, profiles }: RuntimeModelOptions): RuntimeModel => {
  const snapshots = snapshotProfiles(profiles);
  const base: RuntimeModel = Object.freeze({
    announcements: emptyStrings,
    draft: runtimeDraftFor(undefined),
    expandedTraceSpanIds: emptyStrings,
    history: emptyHistory,
    hmrClientCountBySurface: emptyCounts,
    hmrClientCountKnownSurfaces: emptyStrings,
    lastConsumedEventSequence: 0,
    nextEffectId: 1,
    profiles: snapshots.length === 0 ? emptyProfiles : snapshots,
    selectedProfileId: snapshots[0]?.id,
    selectedTab: 'result',
    surfaces: emptySurfaces,
  });
  const initialized = bootstrapModel(base, bootstrap);
  return update(initialized, {
    draft: runtimeDraftFor(selectedFixture(currentSurface(initialized), initialized.selectedFixtureId)),
  });
};

/** The active browser request, including its reducer correlation ID. */
export const effectFor = (model: RuntimeModel): RuntimeQueuedEffect | undefined => model.activeEffect;

const mergeRun = (model: RuntimeModel, run: DevRuntimeRun): RuntimeModel => {
  if (model.providerSessionId === undefined || run.vector.providerSessionId !== model.providerSessionId) {
    throw new TypeError('Runtime run must belong to the active provider session.');
  }
  const history = historyFor([...model.history, run], model.providerSessionId);
  const lastGoodRunId = lastGoodRunIdFor(history);
  return update(model, {
    history,
    ...(lastGoodRunId === undefined ? { lastGoodRunId: undefined } : { lastGoodRunId }),
    ...(lastGoodRunId === undefined ? {} : { previousProviderLastGood: undefined }),
    staleIdentity: staleIdentityFor(history, model.selectedRunId, model.status),
  });
};

const receivedEvent = (model: RuntimeModel, message: ProjectEventMessage): RuntimeModel => {
  if (message.type === 'replay.gap') {
    if (model.replayGap !== undefined) return model;
    return queueBootstrap(update(model, {
      hmrClientCountBySurface: emptyCounts,
      hmrClientCountKnownSurfaces: emptyStrings,
      replayGap: snapshot(message),
    }), message.latestDroppedSequence);
  }
  if (message.type !== 'runtime.event' || message.sequence <= model.lastConsumedEventSequence) return model;
  const advanced = update(model, { lastConsumedEventSequence: message.sequence });
  const event = message.payload;
  if (advanced.providerSessionId !== undefined && event.providerSessionId !== advanced.providerSessionId) {
    return queueBootstrap(update(advanced, { hmrClientCountBySurface: emptyCounts, hmrClientCountKnownSurfaces: emptyStrings }), message.sequence);
  }
  if (event.type === 'runtime.hmr.client-connected' || event.type === 'runtime.hmr.client-disconnected') {
    const count = hmrCount(event.details);
    return count === undefined ? advanced : replaceHmrCount(advanced, count.surfaceId, count.count);
  }
  if ((event.type === 'runtime.run.started' || event.type === 'runtime.run.completed' || event.type === 'runtime.run.failed') && event.runId !== undefined) {
    return queueOperation(advanced, Object.freeze({ kind: 'read-run', runId: event.runId }));
  }
  return queueBootstrap(advanced, message.sequence);
};

export const reduceRuntimeModel = (model: RuntimeModel, action: RuntimeModelAction): RuntimeModel => {
  switch (action.type) {
    case 'bootstrap.received':
      return settleEffectKind(bootstrapModel(model, action.bootstrap), 'bootstrap');
    case 'event.received':
      return receivedEvent(model, action.event);
    case 'effect.settled':
      return settleEffect(model, action.id);
    case 'effect.conflict': {
      if (model.activeEffect?.id !== action.id) return model;
      const cleared = update(model, { activeEffect: undefined, confirmation: undefined, pendingEffect: undefined });
      return queueBootstrap(cleared);
    }
    case 'draft.replace':
      return update(model, { draft: draftFor(action.input, action.raw) });
    case 'draft.raw': {
      try {
        const input = snapshot(JSON.parse(action.raw)) as JsonValue;
        return update(model, { draft: draftFor(input, action.raw) });
      } catch {
        return update(model, { draft: Object.freeze({ error: 'Draft JSON is invalid. Repair the raw input before running.', input: model.draft.input, raw: action.raw }) });
      }
    }
    case 'draft.from-run': {
      const run = model.history.find((entry) => entry.id === action.runId);
      return run === undefined ? model : update(model, { draft: draftFor(run.input) });
    }
    case 'selection.run':
      return model.history.some((entry) => entry.id === action.runId)
        ? update(model, { selectedRunId: action.runId, staleIdentity: staleIdentityFor(model.history, action.runId, model.status) })
        : model;
    case 'selection.surface': {
      const surface = model.surfaces.find((entry) => entry.id === action.surfaceId);
      if (surface === undefined) return model;
      const fixture = selectedFixture(surface, undefined);
      return update(model, {
        draft: runtimeDraftFor(fixture),
        selectedFixtureId: fixture?.id,
        selectedSurfaceId: surface.id,
        selectedTarget: selectedTarget(surface, undefined),
      });
    }
    case 'selection.fixture': {
      const fixture = currentSurface(model)?.fixtures.find((entry) => entry.id === action.fixtureId);
      return fixture === undefined ? model : update(model, { draft: runtimeDraftFor(fixture), selectedFixtureId: fixture.id });
    }
    case 'selection.target':
      return currentSurface(model)?.targets.includes(action.target) ? update(model, { selectedTarget: action.target }) : model;
    case 'selection.profile':
      return model.profiles.some((profile) => profile.id === action.profileId) ? update(model, { selectedProfileId: action.profileId }) : model;
    case 'selection.tab':
      return runtimeTabs.has(action.tab) ? update(model, { selectedTab: action.tab }) : model;
    case 'trace.toggle': {
      const expanded = new Set(model.expandedTraceSpanIds);
      if (expanded.has(action.spanId)) expanded.delete(action.spanId);
      else expanded.add(action.spanId);
      return update(model, { expandedTraceSpanIds: Object.freeze([...expanded].sort()) });
    }
    case 'run.request': {
      const request = invocationFor(model);
      if (request === undefined) return model;
      return currentSurface(model)?.readOnly === true
        ? queueOperation(model, Object.freeze({ cause: 'manual' as const, kind: 'create-run' as const, request }))
        : update(model, { confirmation: Object.freeze({ kind: 'run' as const, request }) });
    }
    case 'replay.request': {
      const run = model.history.find((entry) => entry.id === action.runId);
      if (run === undefined) return model;
      const expectedGenerationId = action.mode === 'exact'
        ? run.vector.runtimeGenerationId
        : model.status?.activeVector?.runtimeGenerationId;
      return queueOperation(model, Object.freeze({
        kind: 'replay-run',
        request: {
          ...(expectedGenerationId === undefined ? {} : { expectedGenerationId }),
          mode: action.mode,
          runId: run.id,
        },
      }));
    }
    case 'run.received': {
      const merged = mergeRun(model, action.run);
      const active = merged.activeEffect;
      if (active === undefined || (active.kind !== 'create-run' && active.kind !== 'read-run' && active.kind !== 'replay-run')) return merged;
      return settleEffect(merged, active.id);
    }
    case 'reset.request': {
      const request = resetFor(model);
      return request === undefined ? model : update(model, { confirmation: Object.freeze({ kind: 'reset' as const, request }) });
    }
    case 'confirmation.cancel':
      return model.confirmation === undefined ? model : update(model, { confirmation: undefined });
    case 'confirmation.confirm': {
      if (model.confirmation?.kind === 'run') {
        const request = model.confirmation.request;
        const next = update(model, { confirmation: undefined });
        return queueOperation(next, Object.freeze({ cause: 'manual' as const, kind: 'create-run' as const, request }));
      }
      if (model.confirmation?.kind === 'reset') {
        const request = model.confirmation.request;
        return queueOperation(update(model, { confirmation: undefined }), Object.freeze({ kind: 'reset-state', request }));
      }
      return model;
    }
    case 'reset.received': {
      if (model.activeEffect?.id !== action.id || model.activeEffect.kind !== 'reset-state') return model;
      const cleared = settleEffect(update(model, { confirmation: undefined, staleIdentity: undefined, stateIdentity: snapshot(action.state) }), action.id);
      const request = invocationFor(cleared);
      return request === undefined ? cleared : queueOperation(cleared, Object.freeze({ cause: 'reset' as const, kind: 'create-run' as const, request }));
    }
  }
};
