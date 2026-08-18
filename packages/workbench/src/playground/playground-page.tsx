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
} from '../../../agent-bundle/src/services/playground-service.ts';
import type { PlaygroundOperationRequest, PlaygroundRun } from '../../../agent-bundle/src/dev/playground-contract.ts';
import type { ArtifactInspectionScript } from '../../../agent-bundle/src/dev/types.ts';

import { parseRawJsonRecord, serializeJsonRecord } from '../mcp/mcp-json-input.tsx';
import { PlaygroundClientError, type PlaygroundClient } from './playground-client.ts';
import {
  formatPlaygroundJson,
  mergePlaygroundEvents,
  playgroundViewFor,
  type PlaygroundDetailRow,
  type PlaygroundView,
} from './playground-model.ts';
import './playground-page.css';

export interface PlaygroundTraceViewProps {
  readonly onToggle?: (rawEventRef: string) => void;
  readonly view: PlaygroundView;
}

export interface PlaygroundPageProps {
  readonly client: PlaygroundClient;
  /** The active epoch is only used for admitting a new run; persisted sessions pin their own epoch. */
  readonly epoch: PlaygroundEpochIdentity | undefined;
  /** The shell retains the run/session identity across navigation and project rebuilds. */
  readonly onRunChange: (run: PlaygroundRun | undefined) => void;
  readonly run: PlaygroundRun | undefined;
  readonly scripts: readonly Pick<ArtifactInspectionScript, 'id' | 'name' | 'target'>[];
  readonly targets: readonly PlaygroundTarget[];
}

type PlaygroundOperation = PlaygroundOperationRequest['operation'];

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
  scripts: readonly Pick<ArtifactInspectionScript, 'id' | 'name' | 'target'>[],
  target: string,
): readonly Pick<ArtifactInspectionScript, 'id' | 'name' | 'target'>[] => Object.freeze(
  scripts.filter((script) => script.target === target).sort((left, right) => left.id.localeCompare(right.id)),
);

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

/** The page can retire a prior run synchronously before React commits its replacement state. */
export const createPlaygroundObservationLifecycle = (): PlaygroundObservationLifecycle => {
  let active: { readonly controller: AbortController; readonly generation: number } | undefined;
  let generation = 0;
  const invalidate = (): void => {
    const previous = active;
    active = undefined;
    generation += 1;
    previous?.controller.abort();
  };
  return Object.freeze({
    begin: (): PlaygroundObservationLease => {
      invalidate();
      const controller = new AbortController();
      const ownGeneration = generation + 1;
      generation = ownGeneration;
      active = { controller, generation: ownGeneration };
      return Object.freeze({
        abort: () => {
          if (active?.controller === controller) invalidate();
          else controller.abort();
        },
        current: () => active?.generation === ownGeneration && !controller.signal.aborted,
        signal: controller.signal,
      });
    },
    invalidate,
  });
};

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
      : <table className="playground-table">
        <thead>
          <tr>
            <th scope="col">Select</th>
            <th scope="col">Seq</th>
            <th scope="col">Timestamp</th>
            <th scope="col">Source</th>
            <th scope="col">Kind</th>
            <th scope="col">Summary</th>
            <th scope="col">Epoch</th>
            <th scope="col">Persisted event</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((entry) => <tr key={entry.key}>
            <td><input
              aria-label={`Select ${entry.rawEventRef} for the draft eval case`}
              checked={view.selectedRefs.includes(entry.rawEventRef)}
              onChange={() => onToggle?.(entry.rawEventRef)}
              type="checkbox"
            /></td>
            <td>{entry.sequence}</td>
            <td>{entry.timestamp}</td>
            <td>{entry.source}</td>
            <td>{entry.kind}</td>
            <td>{entry.summary}</td>
            <td className="identifier" title={entry.epochDigest}>{entry.epochId}</td>
            <td className="identifier">{entry.rawEventRef}</td>
          </tr>)}
        </tbody>
      </table>}
  </section>
</div>;

/**
 * Starts typed server-owned operations, then observes their durable session by
 * replay, live NDJSON stream, polling, and a final replay before stream close.
 */
export const PlaygroundPage = ({ client, epoch, onRunChange, run, scripts, targets }: PlaygroundPageProps) => {
  const [busy, setBusy] = useState(false);
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
  const [targetName, setTargetName] = useState('');
  const observationLifecycle = useRef(createPlaygroundObservationLifecycle());
  const session = run?.session;
  const sessionId = session?.id;
  const runId = run?.id;
  const hookInputObject = parseRawJsonRecord(hookInput);
  const mcpArgumentsObject = parseRawJsonRecord(mcpArguments);
  const view = playgroundViewFor({ epoch, events, exported, selectedRefs, session });
  const targetScripts = playgroundScriptsForTarget(scripts, targetName);

  useEffect(() => {
    if (run === undefined || runId === undefined || sessionId === undefined) return;
    const observedRun = run;
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
  }, [client, onRunChange, runId, sessionId]);

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const operationInput = (): PlaygroundOperationRequest | undefined => {
    if (targetName.length === 0) return undefined;
    if (operation === 'skill.inspect') {
      return skillId.length === 0 ? undefined : { operation, skillId, target: targetName };
    }
    if (operation === 'hook.simulate') {
      return hook.length === 0 || hookInputObject === null
        ? undefined
        : { hook, input: asJsonObject(hookInputObject), operation, target: targetName };
    }
    if (operation === 'script.run') {
      return scriptId.length === 0 ? undefined : { operation, scriptId, target: targetName };
    }
    return mcpServerName.length === 0 || mcpTool.length === 0 || mcpArgumentsObject === null
      ? undefined
      : {
          arguments: asJsonObject(mcpArgumentsObject), operation, serverName: mcpServerName,
          target: targetName, tool: mcpTool,
        };
  };

  const start = async (): Promise<void> => {
    const input = operationInput();
    if (input === undefined) return;
    await runAction(async () => {
      const started = await client.run(input);
      observationLifecycle.current.invalidate();
      setDraftEvalCase(undefined);
      setEvents([]);
      setExported(undefined);
      setSelectedRefs([]);
      onRunChange(started);
    });
  };

  const cancel = async (): Promise<void> => {
    if (runId === undefined || sessionId === undefined) return;
    await runAction(async () => {
      await client.cancel(runId);
      onRunChange({ id: runId, session: await client.session(sessionId) });
    });
  };

  const exportTrace = async (): Promise<void> => {
    if (sessionId === undefined) return;
    await runAction(async () => { setExported(await client.export(sessionId)); });
  };

  const promote = async (): Promise<void> => {
    if (sessionId === undefined || !view.canPromote) return;
    await runAction(async () => { setDraftEvalCase(await client.promoteToDraftEval(sessionId, view.rawEventRefs)); });
  };

  const toggle = (rawEventRef: string): void => {
    setSelectedRefs((previous) => previous.includes(rawEventRef)
      ? previous.filter((entry) => entry !== rawEventRef)
      : [...previous, rawEventRef]);
  };

  const startDisabled = busy || epoch === undefined || (session !== undefined && !terminal(session)) || operationInput() === undefined;

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
          <select disabled={busy || (session !== undefined && !terminal(session))} id="playground-operation" onChange={(event) => setOperation(event.currentTarget.value as PlaygroundOperation)} value={operation}>
            <option value="skill.inspect">Skill inspection</option>
            <option value="hook.simulate">Hook simulation</option>
            <option value="mcp.call-tool">MCP tool call</option>
            <option value="script.run">Script execution</option>
          </select>
          <label htmlFor="playground-target">Target</label>
          <select disabled={busy || (session !== undefined && !terminal(session)) || targets.length === 0} id="playground-target" onChange={(event) => setTargetName(event.currentTarget.value)} value={targetName}>
            <option value="">Select a built target</option>
            {targets.map((target) => <option key={target.name} value={target.name}>{target.name}</option>)}
          </select>
          {operation !== 'skill.inspect' ? undefined : <>
            <label htmlFor="playground-skill-id">Skill id</label>
            <input disabled={busy || (session !== undefined && !terminal(session))} id="playground-skill-id" onChange={(event) => setSkillId(event.currentTarget.value)} value={skillId} />
          </>}
          {operation !== 'hook.simulate' ? undefined : <>
            <label htmlFor="playground-hook">Hook</label>
            <input disabled={busy || (session !== undefined && !terminal(session))} id="playground-hook" onChange={(event) => setHook(event.currentTarget.value)} value={hook} />
            <label htmlFor="playground-hook-input">Hook input (JSON)</label>
            <textarea aria-describedby={hookInputObject === null ? 'playground-hook-input-error' : undefined} aria-invalid={hookInputObject === null ? true : undefined} disabled={busy || (session !== undefined && !terminal(session))} id="playground-hook-input" onChange={(event) => setHookInput(event.currentTarget.value)} spellCheck={false} value={hookInput} />
            {hookInputObject === null ? <p id="playground-hook-input-error" role="alert">{jsonDraftError}</p> : undefined}
          </>}
          {operation !== 'mcp.call-tool' ? undefined : <>
            <label htmlFor="playground-mcp-server">MCP server</label>
            <input disabled={busy || (session !== undefined && !terminal(session))} id="playground-mcp-server" onChange={(event) => setMcpServerName(event.currentTarget.value)} value={mcpServerName} />
            <label htmlFor="playground-mcp-tool">MCP tool</label>
            <input disabled={busy || (session !== undefined && !terminal(session))} id="playground-mcp-tool" onChange={(event) => setMcpTool(event.currentTarget.value)} value={mcpTool} />
            <label htmlFor="playground-mcp-arguments">MCP arguments (JSON)</label>
            <textarea aria-describedby={mcpArgumentsObject === null ? 'playground-mcp-arguments-error' : undefined} aria-invalid={mcpArgumentsObject === null ? true : undefined} disabled={busy || (session !== undefined && !terminal(session))} id="playground-mcp-arguments" onChange={(event) => setMcpArguments(event.currentTarget.value)} spellCheck={false} value={mcpArguments} />
            {mcpArgumentsObject === null ? <p id="playground-mcp-arguments-error" role="alert">{jsonDraftError}</p> : undefined}
          </>}
          {operation !== 'script.run' ? undefined : <>
            <label htmlFor="playground-script-id">Emitted script</label>
            <select
              disabled={busy || (session !== undefined && !terminal(session)) || targetScripts.length === 0}
              id="playground-script-id"
              onChange={(event) => setScriptId(event.currentTarget.value)}
              value={scriptId}
            >
              <option value="">Select a script</option>
              {targetScripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}
            </select>
          </>}
          <div className="playground-actions">
            <button disabled={startDisabled} onClick={() => void start()} type="button">{operation === 'script.run' ? 'Run script' : 'Start run'}</button>
          </div>
        </section>
        {session === undefined ? undefined : <section aria-label="Server-owned run controls" className="playground-controls">
          <div className="playground-actions">
            <button disabled={busy || terminal(session)} onClick={() => void cancel()} type="button">Cancel run</button>
            <button disabled={busy} onClick={() => void exportTrace()} type="button">Export trace</button>
            <button disabled={busy || !view.canPromote} onClick={() => void promote()} type="button">Promote to draft eval case</button>
          </div>
        </section>}
        <PlaygroundTraceView onToggle={toggle} view={view} />
        {view.exported === undefined ? undefined : <section className="playground-detail">
          <h2>Exported trace (schema version {view.exported.schemaVersion})</h2>
          <pre className="playground-json"><code>{JSON.stringify(view.exported, undefined, 2)}</code></pre>
        </section>}
        {draftEvalCase === undefined ? undefined : <section className="playground-detail">
          <h2>Draft eval case (schema version {draftEvalCase.schemaVersion})</h2>
          <pre className="playground-json"><code>{JSON.stringify(draftEvalCase, undefined, 2)}</code></pre>
        </section>}
      </>}
  </div>;
};
