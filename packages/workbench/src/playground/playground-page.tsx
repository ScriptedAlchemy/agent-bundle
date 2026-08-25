import { errorMessage as messageFrom } from '../client-helpers.ts';
import React, { useEffect, useRef, useState } from 'react';

import type { ArtifactInspectionScript } from '../../../agent-bundle/src/contracts/artifacts.ts';
import type {
  DraftEvalCase,
  NativePlaygroundCatalog,
  NativePlaygroundHost,
  PlaygroundEpochIdentity,
  PlaygroundExport,
  PlaygroundJsonObject,
  PlaygroundOperationRequest,
  PlaygroundReplay,
  PlaygroundRun,
  PlaygroundSession,
  PlaygroundTarget,
  PlaygroundTraceEvent,
} from '../../../agent-bundle/src/contracts/playground.ts';

import { wait } from '../foreground-session.ts';
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

const errorMessage = (reason: unknown): string => messageFrom(reason, 'The playground request could not be completed.');

const asJsonObject = (value: Readonly<Record<string, unknown>>): PlaygroundJsonObject => value as PlaygroundJsonObject;

const terminal = (session: PlaygroundSession): boolean => session.state === 'closed' || session.state === 'finalized';

const abortError = (): Error => Object.assign(new Error('Playground observation was aborted.'), { name: 'AbortError' });

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  wait(milliseconds, { abortError, onAbort: 'reject', signal });

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
  const actionControllers = useRef(new Set<AbortController>());
  const observationController = useRef<AbortController | undefined>(undefined);
  const session = run?.session;
  const sessionId = session?.id;
  const runId = run?.id;
  const hookInputObject = parseRawJsonRecord(hookInput);
  const mcpArgumentsObject = parseRawJsonRecord(mcpArguments);
  const view = playgroundViewFor({ epoch, events, exported, selectedRefs, session });
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
    const controllers = actionControllers.current;
    return () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    if (run === undefined || runId === undefined || sessionId === undefined) return;
    const observedRun = run;
    const controller = new AbortController();
    observationController.current = controller;
    const live = (): boolean => !controller.signal.aborted;
    void observePlaygroundRun({
      client,
      onEvents: (next) => {
        if (live()) setEvents(next);
      },
      onSession: (next) => {
        if (live()) onRunChange({ id: runId, session: next });
      },
      run: observedRun,
      signal: controller.signal,
    }).catch((reason: unknown) => {
      if (live()) setError(errorMessage(reason));
    });
    return () => {
      controller.abort();
      if (observationController.current === controller) observationController.current = undefined;
    };
  }, [client, onRunChange, runId, sessionId]);

  const runAction = async (action: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    const controller = new AbortController();
    actionControllers.current.add(controller);
    const live = (): boolean => !controller.signal.aborted;
    setBusy(true);
    setError(undefined);
    try {
      await action(controller.signal);
    } catch (reason) {
      if (live()) setError(errorMessage(reason));
    } finally {
      if (live()) setBusy(false);
      actionControllers.current.delete(controller);
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
    await runAction(async (signal) => {
      const started = await client.run(input, signal);
      if (signal.aborted) return;
      observationController.current?.abort();
      setDraftEvalCase(undefined);
      setEvents([]);
      setExported(undefined);
      setSelectedRefs([]);
      onRunChange(started);
    });
  };

  const cancel = async (): Promise<void> => {
    if (runId === undefined || sessionId === undefined) return;
    const controller = new AbortController();
    actionControllers.current.add(controller);
    const live = (): boolean => !controller.signal.aborted;
    setCancelling(true);
    setError(undefined);
    try {
      await client.cancel(runId, controller.signal);
      if (!live()) return;
      const replay = await client.replay(sessionId, 0, controller.signal);
      if (!live()) return;
      setEvents(replay.events);
      onRunChange({ id: runId, session: replay.session });
    } catch (reason) {
      if (live()) setError(errorMessage(reason));
    } finally {
      if (live()) setCancelling(false);
      actionControllers.current.delete(controller);
    }
  };

  const exportTrace = async (): Promise<void> => {
    if (sessionId === undefined) return;
    await runAction(async (signal) => {
      const next = await client.export(sessionId, signal);
      if (!signal.aborted) setExported(next);
    });
  };

  const promote = async (): Promise<void> => {
    if (sessionId === undefined || !view.canPromote) return;
    await runAction(async (signal) => {
      const next = await client.promoteToDraftEval(sessionId, view.rawEventRefs, signal);
      if (!signal.aborted) setDraftEvalCase(next);
    });
  };

  const toggle = (rawEventRef: string): void => {
    setSelectedRefs((previous) => previous.includes(rawEventRef)
      ? previous.filter((entry) => entry !== rawEventRef)
      : [...previous, rawEventRef]);
  };

  const controlsDisabled = busy || cancelling || (session !== undefined && !terminal(session));
  const startDisabled = controlsDisabled || epoch === undefined || operationInput() === undefined;

  return <div className="playground-content">
    <div className="page-heading playground-page-heading">
      <div>
        <h1>Playground</h1>
        <p>Run a typed operation against the current artifact epoch; the server owns identity, evidence, outcome, and durable trace.</p>
      </div>
    </div>
    {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
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
            <button disabled={busy || cancelling || terminal(session)} onClick={() => void cancel()} type="button">{cancelling ? 'Cancelling…' : 'Cancel run'}</button>
            <button disabled={busy || cancelling} onClick={() => void exportTrace()} type="button">Export trace</button>
            <button disabled={busy || cancelling || !view.canPromote} onClick={() => void promote()} type="button">Promote to draft eval case</button>
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
