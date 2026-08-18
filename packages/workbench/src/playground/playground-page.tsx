import React, { useEffect, useState } from 'react';

import type {
  DraftEvalCase,
  PlaygroundEpochIdentity,
  PlaygroundExport,
  PlaygroundJsonObject,
  PlaygroundSession,
  PlaygroundTarget,
  PlaygroundTraceEvent,
} from '../../../agent-bundle/src/services/playground-service.ts';
import type { PlaygroundOperationRequest, PlaygroundRun } from '../../../agent-bundle/src/dev/playground-contract.ts';

import { parseRawJsonRecord, serializeJsonRecord } from '../mcp/mcp-json-input.tsx';
import type { PlaygroundClient } from './playground-client.ts';
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
  readonly targets: readonly PlaygroundTarget[];
}

type PlaygroundOperation = Exclude<PlaygroundOperationRequest['operation'], 'script.run'>;

const jsonDraftError = 'This field must contain a JSON object.';

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'The playground request could not be completed.';

const asJsonObject = (value: Readonly<Record<string, unknown>>): PlaygroundJsonObject => value as PlaygroundJsonObject;

const terminal = (session: PlaygroundSession): boolean => session.state === 'closed' || session.state === 'finalized';

const delay = async (milliseconds: number): Promise<void> => new Promise((resolvePromise) => {
  setTimeout(resolvePromise, milliseconds);
});

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
export const PlaygroundPage = ({ client, epoch, onRunChange, run, targets }: PlaygroundPageProps) => {
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
  const [selectedRefs, setSelectedRefs] = useState<readonly string[]>([]);
  const [skillId, setSkillId] = useState('');
  const [targetName, setTargetName] = useState('');
  const session = run?.session;
  const sessionId = session?.id;
  const runId = run?.id;
  const hookInputObject = parseRawJsonRecord(hookInput);
  const mcpArgumentsObject = parseRawJsonRecord(mcpArguments);
  const view = playgroundViewFor({ epoch, events, exported, selectedRefs, session });

  useEffect(() => {
    if (runId === undefined || sessionId === undefined) return;
    let current = true;
    const merge = (incoming: readonly PlaygroundTraceEvent[]): void => {
      if (current) setEvents((previous) => mergePlaygroundEvents(previous, incoming));
    };
    const updateSession = (next: PlaygroundSession): void => {
      if (current) onRunChange({ id: runId, session: next });
    };
    const stream = client.stream(sessionId, {
      afterSequence: 0,
      onEvent: (event) => merge([event]),
    });
    const observe = async (): Promise<void> => {
      try {
        const replayed = await client.replay(sessionId, 0);
        if (!current) return;
        merge(replayed.events);
        updateSession(replayed.session);
        for (;;) {
          const refreshed = await client.session(sessionId);
          if (!current) return;
          updateSession(refreshed);
          if (terminal(refreshed)) {
            const finalReplay = await client.replay(sessionId, 0);
            if (!current) return;
            merge(finalReplay.events);
            updateSession(finalReplay.session);
            stream.close();
            await stream.done;
            return;
          }
          await delay(250);
          if (!current) return;
        }
      } catch (reason) {
        if (current) setError(errorMessage(reason));
      }
    };
    void observe();
    stream.done.catch((reason: unknown) => {
      if (current) setError(errorMessage(reason));
    });
    return () => {
      current = false;
      stream.close();
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
          <div className="playground-actions">
            <button disabled={startDisabled} onClick={() => void start()} type="button">Start run</button>
            <button disabled type="button">Run script (unavailable)</button>
          </div>
          <p className="playground-note">Script execution is unavailable because this foreground server has not advertised the contained execution capability.</p>
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
