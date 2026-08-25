import React, { useEffect, useRef, useState } from 'react';

import type {
  DraftEvalCase,
  PlaygroundEpochIdentity,
  PlaygroundExport,
  PlaygroundJsonObject,
  PlaygroundReplay,
  PlaygroundSession,
  PlaygroundTarget,
  PlaygroundTraceEvent,
} from '../../../agent-bundle/src/contracts/playground.ts';
import type { PlaygroundOperationRequest, PlaygroundRun } from '../../../agent-bundle/src/contracts/playground.ts';
import type { ArtifactInspectionScript } from '../../../agent-bundle/src/contracts/artifacts.ts';
import type { NativePlaygroundCatalog, NativePlaygroundHost } from '../../../agent-bundle/src/contracts/playground.ts';

import { parseRawJsonRecord, serializeJsonRecord } from '../mcp/mcp-json-input.tsx';
import { PlaygroundClientError, type PlaygroundClient } from './playground-client.ts';
import {
  formatPlaygroundJson,
  mergePlaygroundEvents,
  nativePlaygroundRequestFor,
  nativeSelectionFor,
  playgroundViewFor,
  type PlaygroundDetailRow,
  type PlaygroundView,
  type NativePlaygroundSelection,
} from './playground-model.ts';
import './playground-page.css';

export interface PlaygroundTraceViewProps {
  readonly onToggle?: (rawEventRef: string) => void;
  readonly view: PlaygroundView;
}

type PlaygroundScriptCatalogEntry = Pick<ArtifactInspectionScript, 'id' | 'name' | 'target'>;

export interface PlaygroundScriptCatalog {
  readonly epochId: string;
  readonly scripts: readonly PlaygroundScriptCatalogEntry[];
}

const noPlaygroundScripts: readonly PlaygroundScriptCatalogEntry[] = Object.freeze([]);

const emptyNativeSelection = (epochId = ''): NativePlaygroundSelection => Object.freeze({
  caseId: '', epochId, fixtureId: '', host: '', modelPinId: '',
});

/** An inspection catalog never outlives the immutable epoch that supplied it. */
export const playgroundScriptsForEpoch = (
  catalog: PlaygroundScriptCatalog | undefined,
  epochId: string | undefined,
): readonly PlaygroundScriptCatalogEntry[] => catalog !== undefined && catalog.epochId === epochId
  ? catalog.scripts
  : noPlaygroundScripts;

export interface PlaygroundPageProps {
  /** Immutable browser-safe opaque choices for the current admission epoch. */
  readonly catalog?: NativePlaygroundCatalog | undefined;
  readonly catalogError?: string;
  readonly catalogLoading?: boolean;
  readonly client: PlaygroundClient;
  /** The active epoch is only used for admitting a new run; persisted sessions pin their own epoch. */
  readonly epoch: PlaygroundEpochIdentity | undefined;
  /** The shell retains the run/session identity across navigation and project rebuilds. */
  readonly onRunChange: (run: PlaygroundRun | undefined) => void;
  readonly run: PlaygroundRun | undefined;
  readonly scripts: readonly PlaygroundScriptCatalogEntry[];
  readonly targets: readonly PlaygroundTarget[];
}

export type PlaygroundOperation = PlaygroundOperationRequest['operation'];

const jsonDraftError = 'This field must contain a JSON object.';

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'The playground request could not be completed.';

const asJsonObject = (value: Readonly<Record<string, unknown>>): PlaygroundJsonObject => value as PlaygroundJsonObject;

const terminal = (session: PlaygroundSession): boolean => session.state === 'closed' || session.state === 'finalized';

const abortError = (): Error => Object.assign(new Error('Playground observation was aborted.'), { name: 'AbortError' });

const delay = async (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolvePromise, rejectPromise) => {
  if (signal.aborted) {
    rejectPromise(abortError());
    return;
  }
  const timeout = setTimeout(() => {
    signal.removeEventListener('abort', abort);
    resolvePromise();
  }, milliseconds);
  const abort = (): void => {
    clearTimeout(timeout);
    rejectPromise(abortError());
  };
  signal.addEventListener('abort', abort, { once: true });
});

const maxStreamReconnects = 3;
const pollDelayMilliseconds = 250;
const reconnectDelayMilliseconds = 100;

/** The server catalog is authoritative; this only limits the desktop picker to the selected target. */
export const playgroundScriptsForTarget = (
  scripts: readonly PlaygroundScriptCatalogEntry[],
  target: string,
): readonly PlaygroundScriptCatalogEntry[] => Object.freeze(
  scripts.filter((script) => script.target === target),
);

/** A changed target or rebuilt catalog must never submit a stale server script id. */
export const playgroundSelectedScriptId = (
  scriptId: string,
  scripts: readonly PlaygroundScriptCatalogEntry[],
  target: string,
): string => scripts.some((script) => script.id === scriptId && script.target === target) ? scriptId : '';

export interface PlaygroundSelection {
  readonly operation: PlaygroundOperation;
  readonly scriptId: string;
  readonly target: string;
}

/** Defaults only missing or stale catalog choices, keeping a user's valid selection intact. */
export const playgroundSelectionFor = (
  input: Readonly<PlaygroundSelection & { readonly operationIsImplicit: boolean }> ,
  targets: readonly PlaygroundTarget[],
  scripts: readonly PlaygroundScriptCatalogEntry[],
): PlaygroundSelection => {
  const target = targets.some((entry) => entry.name === input.target)
    ? input.target
    : targets[0]?.name ?? '';
  const targetScripts = playgroundScriptsForTarget(scripts, target);
  const defaultScriptId = targetScripts[0]?.id ?? '';
  return Object.freeze({
    operation: input.operationIsImplicit ? targetScripts.length > 0 ? 'script.run' : 'skill.inspect' : input.operation,
    scriptId: playgroundSelectedScriptId(input.scriptId, scripts, target) || defaultScriptId,
    target,
  });
};

export interface PlaygroundRunObserverOptions {
  readonly client: Pick<PlaygroundClient, 'replay' | 'session' | 'stream'>;
  readonly onEvents: (events: readonly PlaygroundTraceEvent[]) => void;
  readonly onSession: (session: PlaygroundSession) => void;
  readonly run: PlaygroundRun;
  readonly signal: AbortSignal;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface PlaygroundObservationLease {
  abort(): void;
  current(): boolean;
  readonly signal: AbortSignal;
}

export interface PlaygroundObservationLifecycle {
  begin(): PlaygroundObservationLease;
  invalidate(): void;
}

export interface PlaygroundCancelLease {
  current(): boolean;
  readonly signal: AbortSignal;
}

export interface PlaygroundCancelFlight extends PlaygroundCancelLease {
  readonly done: Promise<void>;
  readonly started: boolean;
}

export interface PlaygroundCancelFlightLifecycle {
  start(operation: (lease: PlaygroundCancelLease) => Promise<void>): PlaygroundCancelFlight;
  invalidate(): void;
}

/** Guards the server-draining cancel/replay sequence before React re-renders the button disabled. */
export const createPlaygroundCancelFlight = (): PlaygroundCancelFlightLifecycle => {
  let active: { readonly controller: AbortController; done: Promise<void> } | undefined;
  const flight = (
    owner: NonNullable<typeof active>,
    started: boolean,
  ): PlaygroundCancelFlight => Object.freeze({
    current: () => active === owner && !owner.controller.signal.aborted,
    done: owner.done,
    signal: owner.controller.signal,
    started,
  });
  const invalidate = (): void => {
    const previous = active;
    active = undefined;
    previous?.controller.abort();
  };
  return Object.freeze({
    start: (operation: (lease: PlaygroundCancelLease) => Promise<void>): PlaygroundCancelFlight => {
      if (active !== undefined) return flight(active, false);
      const controller = new AbortController();
      const owner = { controller, done: Promise.resolve() };
      active = owner;
      const lease = Object.freeze({
        current: () => active === owner && !controller.signal.aborted,
        signal: controller.signal,
      });
      let done: Promise<void>;
      try { done = Promise.resolve(operation(lease)); }
      catch (reason) { done = Promise.reject(reason); }
      owner.done = done;
      void done.finally(() => {
        if (active === owner) active = undefined;
      }).catch(() => undefined);
      return flight(owner, true);
    },
    invalidate,
  });
};

export interface PlaygroundActionLease {
  abort(): void;
  current(): boolean;
  release(): void;
  readonly key: Readonly<{ readonly client: PlaygroundClient; readonly generation: number }>;
  readonly signal: AbortSignal;
}

export interface PlaygroundActionLifecycle {
  begin(client: PlaygroundClient): PlaygroundActionLease;
  invalidate(): void;
  replace(client: PlaygroundClient): void;
}

/** Client changes retire every action synchronously, before a late response can write page or shell state. */
export const createPlaygroundActionLifecycle = (initialClient: PlaygroundClient): PlaygroundActionLifecycle => {
  let client = initialClient;
  let generation = 0;
  const controllers = new Set<AbortController>();
  const invalidate = (): void => {
    generation += 1;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  };
  const replace = (nextClient: PlaygroundClient): void => {
    if (client === nextClient) return;
    client = nextClient;
    invalidate();
  };
  return Object.freeze({
    begin: (actionClient: PlaygroundClient): PlaygroundActionLease => {
      replace(actionClient);
      const controller = new AbortController();
      const key = Object.freeze({ client: actionClient, generation });
      controllers.add(controller);
      return Object.freeze({
        abort: () => controller.abort(),
        current: () => client === key.client && generation === key.generation && !controller.signal.aborted,
        key,
        release: () => controllers.delete(controller),
        signal: controller.signal,
      });
    },
    invalidate,
    replace,
  });
};

export interface PlaygroundCatalogKey {
  readonly client: PlaygroundClient;
  readonly epochId: string;
  readonly generation: number;
}

export interface PlaygroundCatalogLease {
  abort(): void;
  current(): boolean;
  readonly key: PlaygroundCatalogKey;
  readonly signal: AbortSignal;
}

export interface PlaygroundCatalogLifecycle {
  begin(key: Omit<PlaygroundCatalogKey, 'generation'>): PlaygroundCatalogLease;
  invalidate(): void;
}

interface GenerationLease {
  abort(): void;
  current(): boolean;
  readonly generation: number;
  readonly signal: AbortSignal;
}

/** One live request at a time: beginning a lease synchronously retires and aborts the previous one. */
const createGenerationLifecycle = (): { begin(): GenerationLease; invalidate(): void } => {
  let active: { readonly controller: AbortController; readonly generation: number } | undefined;
  let generation = 0;
  const invalidate = (): void => {
    const previous = active;
    active = undefined;
    generation += 1;
    previous?.controller.abort();
  };
  return Object.freeze({
    begin: (): GenerationLease => {
      const previous = active;
      active = undefined;
      previous?.controller.abort();
      generation += 1;
      const controller = new AbortController();
      const ownGeneration = generation;
      active = { controller, generation: ownGeneration };
      return Object.freeze({
        abort: () => {
          if (active?.controller === controller) invalidate();
          else controller.abort();
        },
        current: () => active?.generation === ownGeneration && !controller.signal.aborted,
        generation: ownGeneration,
        signal: controller.signal,
      });
    },
    invalidate,
  });
};

export interface PlaygroundCancelRunOptions {
  readonly client: Pick<PlaygroundClient, 'cancel' | 'replay'>;
  readonly lease: PlaygroundCancelLease;
  readonly observation: PlaygroundObservationLifecycle;
  readonly onEvents: (events: readonly PlaygroundTraceEvent[]) => void;
  readonly onObservationRestart: () => void;
  readonly onSession: (session: PlaygroundSession) => void;
  readonly runId: string;
  readonly sessionId: string;
}

/** Claims same-run evidence before cancellation so an older observer cannot overwrite the terminal replay. */
export const cancelPlaygroundRun = async ({
  client, lease, observation, onEvents, onObservationRestart, onSession, runId, sessionId,
}: PlaygroundCancelRunOptions): Promise<void> => {
  observation.invalidate();
  try {
    await client.cancel(runId, lease.signal);
    if (!lease.current()) return;
    const replay = await client.replay(sessionId, 0, lease.signal);
    if (!lease.current()) return;
    onEvents(replay.events);
    onSession(replay.session);
  } catch (reason) {
    if (lease.current()) onObservationRestart();
    throw reason;
  }
};

/** Every request owns a key, so a late catalog cannot repopulate a replacement client or artifact epoch. */
export const createPlaygroundCatalogLifecycle = (): PlaygroundCatalogLifecycle => {
  const lifecycle = createGenerationLifecycle();
  return Object.freeze({
    begin: (next: Omit<PlaygroundCatalogKey, 'generation'>): PlaygroundCatalogLease => {
      const lease = lifecycle.begin();
      return Object.freeze({
        abort: lease.abort,
        current: lease.current,
        key: Object.freeze({ ...next, generation: lease.generation }),
        signal: lease.signal,
      });
    },
    invalidate: lifecycle.invalidate,
  });
};

/** The page can retire a prior run synchronously before React commits its replacement state. */
export const createPlaygroundObservationLifecycle = (): PlaygroundObservationLifecycle =>
  createGenerationLifecycle();

/** Observes one immutable run identity; callers abort it before replacing the run or unmounting the page. */
export const observePlaygroundRun = async ({ client, onEvents, onSession, run, signal, wait = delay }: PlaygroundRunObserverOptions): Promise<void> => {
  const sessionId = run.session.id;
  let events: readonly PlaygroundTraceEvent[] = [];
  let lastSequence = 0;
  let reconnects = 0;
  let stream: ReturnType<PlaygroundClient['stream']> | undefined;
  let streamClosed = false;
  const current = (): boolean => !signal.aborted;
  const accept = (incoming: readonly PlaygroundTraceEvent[]): void => {
    if (!current()) return;
    const merged = mergePlaygroundEvents(events, incoming);
    if (!current()) return;
    events = merged;
    lastSequence = merged.at(-1)?.sequence ?? 0;
    onEvents(merged);
  };
  const updateSession = (next: PlaygroundSession): void => {
    if (current()) onSession(next);
  };
  const beginStream = (): ReturnType<PlaygroundClient['stream']> => {
    const next = client.stream(sessionId, {
      afterSequence: lastSequence,
      onEvent: (event) => accept([event]),
    });
    stream = next;
    streamClosed = false;
    return next;
  };
  const close = (): void => {
    if (stream === undefined || streamClosed) return;
    streamClosed = true;
    stream.close();
  };
  signal.addEventListener('abort', close, { once: true });
  const finalReplay = async (): Promise<void> => {
    const final = await client.replay(sessionId, lastSequence, signal);
    if (!current()) return;
    accept(final.events);
    updateSession(final.session);
    close();
    await stream?.done;
  };
  try {
    let activeStream = beginStream();
    const initial = await client.replay(sessionId, lastSequence, signal);
    if (!current()) return;
    accept(initial.events);
    let observed = initial.session;
    updateSession(observed);
    for (;;) {
      if (terminal(observed)) {
        await finalReplay();
        return;
      }
      const next = await Promise.race([
        activeStream.done.then(() => 'stream-ended' as const),
        wait(pollDelayMilliseconds, signal).then(() => 'poll' as const),
      ]);
      if (!current()) return;
      const refreshed = await client.session(sessionId, signal);
      if (!current()) return;
      observed = refreshed;
      updateSession(refreshed);
      if (terminal(refreshed)) {
        await finalReplay();
        return;
      }
      if (next === 'stream-ended') {
        if (reconnects >= maxStreamReconnects) {
          throw new PlaygroundClientError('AB8043', 'Playground stream ended before the run reached a terminal state.');
        }
        reconnects += 1;
        await wait(reconnectDelayMilliseconds * (2 ** (reconnects - 1)), signal);
        if (!current()) return;
        activeStream = beginStream();
      }
    }
  } catch (reason) {
    if (!signal.aborted) throw reason;
  } finally {
    signal.removeEventListener('abort', close);
    try {
      close();
      await stream?.done;
    } catch {
      // The original stream or route failure is the caller-visible result; cleanup must not replace it.
    }
  }
};

const nativeSelections = (catalog: NativePlaygroundCatalog | undefined) => catalog?.selections ?? [];

const availableNativeHosts = (catalog: NativePlaygroundCatalog | undefined): readonly NativePlaygroundHost[] =>
  Object.freeze([...new Set(nativeSelections(catalog).map((entry) => entry.host))].sort());

const availableNativeCases = (catalog: NativePlaygroundCatalog | undefined, host: '' | NativePlaygroundHost) => {
  if (catalog === undefined) return [];
  const ids = new Set(nativeSelections(catalog).filter((entry) => host === '' || entry.host === host).map((entry) => entry.caseId));
  return catalog.cases.filter((entry) => ids.has(entry.id));
};

const availableNativeFixtures = (catalog: NativePlaygroundCatalog | undefined, selection: NativePlaygroundSelection) => {
  if (catalog === undefined || selection.caseId === '' || selection.host === '') return [];
  const ids = new Set(nativeSelections(catalog).filter((entry) => entry.caseId === selection.caseId && entry.host === selection.host).map((entry) => entry.fixtureId));
  return catalog.fixtures.filter((entry) => ids.has(entry.id));
};

const availableNativeModelPins = (catalog: NativePlaygroundCatalog | undefined, selection: NativePlaygroundSelection) => {
  if (catalog === undefined || selection.caseId === '' || selection.fixtureId === '' || selection.host === '') return [];
  const ids = new Set(nativeSelections(catalog).filter((entry) =>
    entry.caseId === selection.caseId && entry.fixtureId === selection.fixtureId && entry.host === selection.host,
  ).map((entry) => entry.modelPinId));
  return catalog.modelPins.filter((entry) => entry.host === selection.host && ids.has(entry.id));
};

export interface PlaygroundNativePromptControlsProps {
  readonly catalog: NativePlaygroundCatalog | undefined;
  readonly catalogError: string | undefined;
  readonly catalogLoading: boolean;
  readonly disabled: boolean;
  readonly onCaseChange: (caseId: string) => void;
  readonly onFixtureChange: (fixtureId: string) => void;
  readonly onHostChange: (host: '' | NativePlaygroundHost) => void;
  readonly onModelPinChange: (modelPinId: string) => void;
  readonly onPromptChange: (prompt: string) => void;
  readonly onTargetChange: (target: string) => void;
  readonly prompt: string;
  readonly selection: NativePlaygroundSelection;
  readonly target: string;
  readonly targets: readonly PlaygroundTarget[];
}

/** Compact controls deliberately expose only opaque server catalog identities and authored prompt text. */
export const PlaygroundNativePromptControls = ({
  catalog, catalogError, catalogLoading, disabled, onCaseChange, onFixtureChange, onHostChange, onModelPinChange, onPromptChange,
  onTargetChange, prompt, selection, target, targets,
}: PlaygroundNativePromptControlsProps) => {
  const catalogDisabled = disabled || catalog === undefined;
  const hosts = availableNativeHosts(catalog);
  const cases = availableNativeCases(catalog, selection.host);
  const fixtures = availableNativeFixtures(catalog, selection);
  const modelPins = availableNativeModelPins(catalog, selection);
  const status = catalogLoading
    ? 'Loading native host choices…'
    : catalogError === undefined
      ? catalog === undefined
        ? 'Native host choices are unavailable for this artifact epoch.'
        : `Catalog epoch: ${catalog.epochId}`
      : `Native host choices could not be loaded: ${catalogError}`;
  return <div className="playground-native-workbench">
    <p className="playground-native-status" role="status">{status}</p>
    <div className="playground-native-grid">
      <label htmlFor="playground-native-target">Target
        <select disabled={disabled || targets.length === 0} id="playground-native-target" onChange={(event) => onTargetChange(event.currentTarget.value)} value={target}>
          <option value="">Select a built target</option>
          {targets.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
        </select>
      </label>
      <label htmlFor="playground-native-host">Host
        <select disabled={catalogDisabled || hosts.length === 0} id="playground-native-host" onChange={(event) => onHostChange(event.currentTarget.value as '' | NativePlaygroundHost)} value={selection.host}>
          <option value="">Select a native host</option>
          {hosts.map((host) => <option key={host} value={host}>{host === 'claude' ? 'Claude' : 'Codex'}</option>)}
        </select>
      </label>
      <label htmlFor="playground-native-case">Case
        <select disabled={catalogDisabled || cases.length === 0} id="playground-native-case" onChange={(event) => onCaseChange(event.currentTarget.value)} value={selection.caseId}>
          <option value="">Select an authored case</option>
          {cases.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <label htmlFor="playground-native-fixture">Fixture
        <select disabled={catalogDisabled || fixtures.length === 0} id="playground-native-fixture" onChange={(event) => onFixtureChange(event.currentTarget.value)} value={selection.fixtureId}>
          <option value="">Select a fixture</option>
          {fixtures.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <label htmlFor="playground-native-model-pin">Authored model pin
        <select disabled={catalogDisabled || modelPins.length === 0} id="playground-native-model-pin" onChange={(event) => onModelPinChange(event.currentTarget.value)} value={selection.modelPinId}>
          <option value="">Select an authored model pin</option>
          {modelPins.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <label className="playground-native-prompt" htmlFor="playground-native-prompt">Prompt
        <textarea disabled={disabled} id="playground-native-prompt" onChange={(event) => onPromptChange(event.currentTarget.value)} placeholder="Describe the work for the selected native host." value={prompt} />
      </label>
    </div>
  </div>;
};

const DetailRows = ({ label, rows }: {
  readonly label: string;
  readonly rows: readonly PlaygroundDetailRow[];
}) => <section className="playground-detail">
  <h2>{label}</h2>
  <dl className="playground-detail-rows">
    {rows.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}
  </dl>
</section>;

/** The ordered server trace, where every selected assertion remains a persisted raw event reference. */
export const PlaygroundTraceView = ({ onToggle, view }: PlaygroundTraceViewProps) => <div className="playground-trace">
  <p className="playground-summary" role="status">{view.summary}</p>
  {view.promotionBlocker === undefined
    ? undefined
    : <p className="playground-blocker" role="status">{view.promotionBlocker}</p>}
  {view.identity.length === 0 ? undefined : <DetailRows label="Server-owned session identity" rows={view.identity} />}
  {view.outcome.length === 0 ? undefined : <DetailRows label="Server-owned outcome" rows={view.outcome} />}
  {view.workspace === undefined ? undefined : <section className="playground-detail">
    <h2>Recorded workspace</h2>
    <pre className="playground-json"><code>{formatPlaygroundJson(view.workspace)}</code></pre>
  </section>}
  <section aria-label="Ordered trace" className="playground-detail">
    <h2>Ordered trace</h2>
    {view.rows.length === 0
      ? <p className="empty-row">This session has recorded no trace events yet.</p>
      : <div className="playground-event-cards">
        {view.rows.map((entry) => <details className="playground-event-card" key={entry.key} open>
          <summary><span className="playground-event-sequence">#{entry.sequence}</span><strong>{entry.kind}</strong><span>{entry.summary}</span></summary>
          <div className="playground-event-meta">
            <span>{entry.timestamp}</span><span>{entry.source}</span><span className="identifier" title={entry.epochDigest}>Epoch {entry.epochId}</span><span className="identifier">{entry.rawEventRef}</span>
            <label><input
              aria-label={`Select ${entry.rawEventRef} for the draft eval case`}
              checked={view.selectedRefs.includes(entry.rawEventRef)}
              onChange={() => onToggle?.(entry.rawEventRef)}
              type="checkbox"
            /> Select for draft</label>
          </div>
          <pre className="playground-json"><code>{formatPlaygroundJson(entry.raw)}</code></pre>
        </details>)}
      </div>}
  </section>
</div>;

/**
 * Starts typed server-owned operations, then observes their durable session by
 * replay, live NDJSON stream, polling, and a final replay before stream close.
 */
export const PlaygroundPage = ({ catalog, catalogError, catalogLoading = false, client, epoch, onRunChange, run, scripts, targets }: PlaygroundPageProps) => {
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [observationRevision, setObservationRevision] = useState(0);
  const [draftEvalCase, setDraftEvalCase] = useState<DraftEvalCase>();
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState<readonly PlaygroundTraceEvent[]>([]);
  const [exported, setExported] = useState<PlaygroundExport>();
  const [hook, setHook] = useState('');
  const [hookInput, setHookInput] = useState(() => serializeJsonRecord({}));
  const [mcpArguments, setMcpArguments] = useState(() => serializeJsonRecord({}));
  const [mcpServerName, setMcpServerName] = useState('');
  const [mcpTool, setMcpTool] = useState('');
  const [operation, setOperation] = useState<PlaygroundOperation>('skill.inspect');
  const [scriptId, setScriptId] = useState('');
  const [selectedRefs, setSelectedRefs] = useState<readonly string[]>([]);
  const [skillId, setSkillId] = useState('');
  const [nativePrompt, setNativePrompt] = useState('');
  const [nativeSelection, setNativeSelection] = useState<NativePlaygroundSelection>(emptyNativeSelection);
  const [targetName, setTargetName] = useState('');
  const operationIsImplicit = useRef(true);
  const cancelFlight = useRef(createPlaygroundCancelFlight());
  const cancelPresentation = useRef<Promise<void> | undefined>(undefined);
  const clientOwner = useRef(client);
  const clientResetPending = useRef(false);
  const actionLifecycle = useRef(createPlaygroundActionLifecycle(client));
  const observationLifecycle = useRef(createPlaygroundObservationLifecycle());
  const clientReplaced = clientOwner.current !== client;
  if (clientReplaced) {
    clientOwner.current = client;
    clientResetPending.current = true;
    actionLifecycle.current.replace(client);
    cancelFlight.current.invalidate();
    observationLifecycle.current.invalidate();
  }
  const activeRun = clientReplaced ? undefined : run;
  const session = activeRun?.session;
  const sessionId = session?.id;
  const runId = activeRun?.id;
  const cancelOwner = useRef({ client, runId, sessionId });
  if (cancelOwner.current.client !== client || cancelOwner.current.runId !== runId || cancelOwner.current.sessionId !== sessionId) {
    cancelOwner.current = { client, runId, sessionId };
    cancelFlight.current.invalidate();
  }
  const hookInputObject = parseRawJsonRecord(hookInput);
  const mcpArgumentsObject = parseRawJsonRecord(mcpArguments);
  const view = playgroundViewFor({
    epoch,
    events: clientReplaced ? [] : events,
    exported: clientReplaced ? undefined : exported,
    selectedRefs: clientReplaced ? [] : selectedRefs,
    session,
  });
  const selectedTargetName = targets.some((target) => target.name === targetName) ? targetName : '';
  const currentNativeSelection = nativeSelectionFor(catalog, nativeSelection);
  const targetScripts = playgroundScriptsForTarget(scripts, selectedTargetName);
  const selectedScriptId = playgroundSelectedScriptId(scriptId, scripts, selectedTargetName);

  useEffect(() => {
    const next = playgroundSelectionFor({ operation, operationIsImplicit: operationIsImplicit.current, scriptId, target: targetName }, targets, scripts);
    if (next.operation !== operation) setOperation(next.operation);
    if (next.scriptId !== scriptId) setScriptId(next.scriptId);
    if (next.target !== targetName) setTargetName(next.target);
  }, [operation, scriptId, scripts, targetName, targets]);

  useEffect(() => {
    if (!clientResetPending.current) return;
    clientResetPending.current = false;
    setDraftEvalCase(undefined);
    setError(undefined);
    setEvents([]);
    setExported(undefined);
    setSelectedRefs([]);
    setBusy(false);
    setCancelling(false);
    onRunChange(undefined);
  }, [client, onRunChange]);

  useEffect(() => () => actionLifecycle.current.invalidate(), []);

  useEffect(() => {
    if (selectedTargetName !== targetName) setTargetName(selectedTargetName);
  }, [selectedTargetName, targetName]);

  useEffect(() => {
    if (currentNativeSelection.caseId !== nativeSelection.caseId || currentNativeSelection.epochId !== nativeSelection.epochId ||
      currentNativeSelection.fixtureId !== nativeSelection.fixtureId || currentNativeSelection.host !== nativeSelection.host ||
      currentNativeSelection.modelPinId !== nativeSelection.modelPinId) setNativeSelection(currentNativeSelection);
  }, [currentNativeSelection, nativeSelection]);

  useEffect(() => {
    if (activeRun === undefined || runId === undefined || sessionId === undefined) return;
    const observedRun = activeRun;
    const observation = observationLifecycle.current.begin();
    void observePlaygroundRun({
      client,
      onEvents: (next) => {
        if (observation.current()) setEvents(next);
      },
      onSession: (next) => {
        if (observation.current()) onRunChange({ id: runId, session: next });
      },
      run: observedRun,
      signal: observation.signal,
    }).catch((reason: unknown) => {
      if (observation.current()) setError(errorMessage(reason));
    });
    return () => {
      observation.abort();
    };
  }, [client, observationRevision, onRunChange, runId, sessionId]);

  useEffect(() => () => {
    cancelPresentation.current = undefined;
    cancelFlight.current.invalidate();
  }, []);

  const runAction = async (action: (lease: PlaygroundActionLease) => Promise<void>): Promise<void> => {
    const lease = actionLifecycle.current.begin(client);
    if (!lease.current()) {
      lease.release();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await action(lease);
    } catch (reason) {
      if (lease.current()) setError(errorMessage(reason));
    } finally {
      if (lease.current()) setBusy(false);
      lease.release();
    }
  };

  const operationInput = (): PlaygroundOperationRequest | undefined => {
    if (operation === 'native.prompt') {
      return nativePlaygroundRequestFor({
        catalog,
        prompt: nativePrompt,
        selection: currentNativeSelection,
        target: selectedTargetName,
        targets,
      });
    }
    if (selectedTargetName.length === 0) return undefined;
    if (operation === 'skill.inspect') {
      return skillId.length === 0 ? undefined : { operation, skillId, target: selectedTargetName };
    }
    if (operation === 'hook.simulate') {
      return hook.length === 0 || hookInputObject === null
        ? undefined
        : { hook, input: asJsonObject(hookInputObject), operation, target: selectedTargetName };
    }
    if (operation === 'script.run') {
      return selectedScriptId.length === 0 ? undefined : { operation, scriptId: selectedScriptId, target: selectedTargetName };
    }
    if (operation !== 'mcp.call-tool') return undefined;
    return mcpServerName.length === 0 || mcpTool.length === 0 || mcpArgumentsObject === null
      ? undefined
      : {
          arguments: asJsonObject(mcpArgumentsObject), operation, serverName: mcpServerName,
          target: selectedTargetName, tool: mcpTool,
        };
  };

  const start = async (): Promise<void> => {
    const input = operationInput();
    if (input === undefined) return;
    await runAction(async (lease) => {
      const started = await client.run(input, lease.signal);
      if (!lease.current()) return;
      observationLifecycle.current.invalidate();
      setDraftEvalCase(undefined);
      setEvents([]);
      setExported(undefined);
      setSelectedRefs([]);
      onRunChange(started);
    });
  };

  const cancel = (): Promise<void> => {
    if (runId === undefined || sessionId === undefined) return Promise.resolve();
    const flight = cancelFlight.current.start(async (lease) => {
      try {
        setError(undefined);
        await cancelPlaygroundRun({
          client,
          lease,
          observation: observationLifecycle.current,
          onEvents: setEvents,
          onObservationRestart: () => setObservationRevision((previous) => previous + 1),
          onSession: (next) => onRunChange({ id: runId, session: next }),
          runId,
          sessionId,
        });
      } catch (reason) {
        if (lease.current()) {
          setError(errorMessage(reason));
        }
      }
    });
    if (flight.started) {
      cancelPresentation.current = flight.done;
      setCancelling(true);
      void flight.done.finally(() => {
        if (cancelPresentation.current === flight.done) {
          cancelPresentation.current = undefined;
          setCancelling(false);
        }
      }).catch(() => undefined);
    }
    return flight.done;
  };

  const exportTrace = async (): Promise<void> => {
    if (sessionId === undefined) return;
    await runAction(async (lease) => {
      const next = await client.export(sessionId, lease.signal);
      if (lease.current()) setExported(next);
    });
  };

  const promote = async (): Promise<void> => {
    if (sessionId === undefined || !view.canPromote) return;
    await runAction(async (lease) => {
      const next = await client.promoteToDraftEval(sessionId, view.rawEventRefs, lease.signal);
      if (lease.current()) setDraftEvalCase(next);
    });
  };

  const toggle = (rawEventRef: string): void => {
    setSelectedRefs((previous) => previous.includes(rawEventRef)
      ? previous.filter((entry) => entry !== rawEventRef)
      : [...previous, rawEventRef]);
  };

  const actionBusy = clientReplaced ? false : busy;
  const actionCancelling = clientReplaced ? false : cancelling;
  const controlsDisabled = actionBusy || actionCancelling || (session !== undefined && !terminal(session));
  const startDisabled = controlsDisabled || epoch === undefined || operationInput() === undefined;

  return <div className="playground-content">
    <div className="page-heading playground-page-heading">
      <div>
        <h1>Playground</h1>
        <p>Run a typed operation against the current artifact epoch; the server owns identity, evidence, outcome, and durable trace.</p>
      </div>
    </div>
    {clientReplaced || error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
    {epoch === undefined && session === undefined
      ? <p className="empty-row" role="status">{view.summary}</p>
      : <>
        <section aria-label="Server-owned operation" className="playground-controls">
          <p className="playground-note">A new run binds the current server epoch. An admitted run stays pinned to the epoch in its persisted session identity.</p>
          <label htmlFor="playground-operation">Operation</label>
          <select disabled={controlsDisabled} id="playground-operation" onChange={(event) => {
            operationIsImplicit.current = false;
            setOperation(event.currentTarget.value as PlaygroundOperation);
          }} value={operation}>
            <option value="skill.inspect">Skill inspection</option>
            <option value="hook.simulate">Hook simulation</option>
            <option value="mcp.call-tool">MCP tool call</option>
            <option value="script.run">Script execution</option>
            <option value="native.prompt">Native host prompt</option>
          </select>
          {operation === 'native.prompt'
            ? <PlaygroundNativePromptControls
              catalog={catalog}
              catalogError={catalogError}
              catalogLoading={catalogLoading}
              disabled={controlsDisabled}
              onCaseChange={(caseId) => setNativeSelection((previous) => {
                const base = nativeSelectionFor(catalog, previous);
                return nativeSelectionFor(catalog, { ...base, caseId, epochId: catalog?.epochId ?? '', fixtureId: '', modelPinId: '' });
              })}
              onFixtureChange={(fixtureId) => setNativeSelection((previous) => {
                const base = nativeSelectionFor(catalog, previous);
                return nativeSelectionFor(catalog, { ...base, epochId: catalog?.epochId ?? '', fixtureId, modelPinId: '' });
              })}
              onHostChange={(host) => setNativeSelection((previous) => {
                const base = nativeSelectionFor(catalog, previous);
                return nativeSelectionFor(catalog, { ...base, epochId: catalog?.epochId ?? '', host, modelPinId: '' });
              })}
              onModelPinChange={(modelPinId) => setNativeSelection((previous) => {
                const base = nativeSelectionFor(catalog, previous);
                return nativeSelectionFor(catalog, { ...base, epochId: catalog?.epochId ?? '', modelPinId });
              })}
              onPromptChange={setNativePrompt}
              onTargetChange={(target) => {
                setTargetName(target);
                setNativeSelection(emptyNativeSelection(catalog?.epochId ?? ''));
              }}
              prompt={nativePrompt}
              selection={currentNativeSelection}
              target={selectedTargetName}
              targets={targets}
            />
            : <>
              <label htmlFor="playground-target">Target</label>
              <select disabled={controlsDisabled || targets.length === 0} id="playground-target" onChange={(event) => setTargetName(event.currentTarget.value)} value={selectedTargetName}>
                <option value="">Select a built target</option>
                {targets.map((target) => <option key={target.name} value={target.name}>{target.name}</option>)}
              </select>
              {operation !== 'skill.inspect' ? undefined : <>
                <label htmlFor="playground-skill-id">Skill id</label>
                <input disabled={controlsDisabled} id="playground-skill-id" onChange={(event) => setSkillId(event.currentTarget.value)} value={skillId} />
              </>}
              {operation !== 'hook.simulate' ? undefined : <>
                <label htmlFor="playground-hook">Hook</label>
                <input disabled={controlsDisabled} id="playground-hook" onChange={(event) => setHook(event.currentTarget.value)} value={hook} />
                <label htmlFor="playground-hook-input">Hook input (JSON)</label>
                <textarea aria-describedby={hookInputObject === null ? 'playground-hook-input-error' : undefined} aria-invalid={hookInputObject === null ? true : undefined} disabled={controlsDisabled} id="playground-hook-input" onChange={(event) => setHookInput(event.currentTarget.value)} spellCheck={false} value={hookInput} />
                {hookInputObject === null ? <p id="playground-hook-input-error" role="alert">{jsonDraftError}</p> : undefined}
              </>}
              {operation !== 'mcp.call-tool' ? undefined : <>
                <label htmlFor="playground-mcp-server">MCP server</label>
                <input disabled={controlsDisabled} id="playground-mcp-server" onChange={(event) => setMcpServerName(event.currentTarget.value)} value={mcpServerName} />
                <label htmlFor="playground-mcp-tool">MCP tool</label>
                <input disabled={controlsDisabled} id="playground-mcp-tool" onChange={(event) => setMcpTool(event.currentTarget.value)} value={mcpTool} />
                <label htmlFor="playground-mcp-arguments">MCP arguments (JSON)</label>
                <textarea aria-describedby={mcpArgumentsObject === null ? 'playground-mcp-arguments-error' : undefined} aria-invalid={mcpArgumentsObject === null ? true : undefined} disabled={controlsDisabled} id="playground-mcp-arguments" onChange={(event) => setMcpArguments(event.currentTarget.value)} spellCheck={false} value={mcpArguments} />
                {mcpArgumentsObject === null ? <p id="playground-mcp-arguments-error" role="alert">{jsonDraftError}</p> : undefined}
              </>}
              {operation !== 'script.run' ? undefined : <>
                <label htmlFor="playground-script-id">Emitted script</label>
                <select
                  disabled={controlsDisabled || targetScripts.length === 0}
                  id="playground-script-id"
                  onChange={(event) => setScriptId(event.currentTarget.value)}
                  value={selectedScriptId}
                >
                  <option value="">Select a script</option>
                  {targetScripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}
                </select>
              </>}
            </>}
          <div className="playground-actions">
            <button disabled={startDisabled} onClick={() => void start()} type="button">{operation === 'script.run' ? 'Run script' : operation === 'native.prompt' ? 'Start native prompt' : 'Start run'}</button>
          </div>
        </section>
        {session === undefined ? undefined : <section aria-label="Server-owned run controls" className="playground-controls">
          <div className="playground-actions">
            <button disabled={actionBusy || actionCancelling || terminal(session)} onClick={() => void cancel()} type="button">{actionCancelling ? 'Cancelling…' : 'Cancel run'}</button>
            <button disabled={actionBusy || actionCancelling} onClick={() => void exportTrace()} type="button">Export trace</button>
            <button disabled={actionBusy || actionCancelling || !view.canPromote} onClick={() => void promote()} type="button">Promote to draft eval case</button>
          </div>
        </section>}
        <PlaygroundTraceView onToggle={toggle} view={view} />
        {view.exported === undefined ? undefined : <section className="playground-detail">
          <h2>Exported trace</h2>
          <pre className="playground-json"><code>{JSON.stringify(view.exported, undefined, 2)}</code></pre>
        </section>}
        {draftEvalCase === undefined ? undefined : <section className="playground-detail">
          <h2>Draft eval case</h2>
          <pre className="playground-json"><code>{JSON.stringify(draftEvalCase, undefined, 2)}</code></pre>
        </section>}
      </>}
  </div>;
};
