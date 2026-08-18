import React, { useEffect, useRef, useState } from 'react';

import type {
  DraftEvalCase,
  PlaygroundDurableOutcome,
  PlaygroundEpochIdentity,
  PlaygroundExport,
  PlaygroundJsonObject,
  PlaygroundReplay,
  PlaygroundSelectedAssertion,
  PlaygroundSession,
  PlaygroundSessionInput,
  PlaygroundTarget,
  PlaygroundTraceEvent,
} from '../../../agent-bundle/src/services/playground-service.ts';

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
  readonly epoch: PlaygroundEpochIdentity | undefined;
  /**
   * The shell owns the session so one ordered trace survives navigation and other
   * pages can record into it. The page never keeps a private copy.
   */
  readonly onSessionChange: (session: PlaygroundSession | undefined) => void;
  readonly session: PlaygroundSession | undefined;
  readonly targets: readonly PlaygroundTarget[];
}

const jsonDraftError = 'This field must contain a JSON object.';

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'The playground request could not be completed.';

/** JSON.parse only ever yields JSON values, so the parsed record is a playground JSON object. */
const asJsonObject = (value: Readonly<Record<string, unknown>>): PlaygroundJsonObject => value as PlaygroundJsonObject;

export const openPlaygroundSession = async (
  client: PlaygroundClient,
  input: PlaygroundSessionInput,
): Promise<PlaygroundSession> => client.openSession(input);

/** Replaying from the recorded cursor keeps the ordering and the epoch binding of the stored trace. */
export const replayPlaygroundTrace = async (
  client: PlaygroundClient,
  sessionId: string,
  afterSequence?: number,
): Promise<PlaygroundReplay> => client.replay(sessionId, afterSequence);

export const finalizePlaygroundOutcome = async (
  client: PlaygroundClient,
  sessionId: string,
  outcome: PlaygroundDurableOutcome,
): Promise<PlaygroundSession> => client.finalize(sessionId, outcome);

export const exportPlaygroundTrace = async (
  client: PlaygroundClient,
  sessionId: string,
): Promise<PlaygroundExport> => client.export(sessionId);

export const promotePlaygroundDraftEval = async (
  client: PlaygroundClient,
  sessionId: string,
  assertions: readonly PlaygroundSelectedAssertion[],
): Promise<DraftEvalCase> => client.promoteToDraftEval(sessionId, assertions);

const DetailRows = ({ label, rows }: {
  readonly label: string;
  readonly rows: readonly PlaygroundDetailRow[];
}) => <section className="playground-detail">
  <h2>{label}</h2>
  <dl className="playground-detail-rows">
    {rows.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}
  </dl>
</section>;

/** The ordered trace, where every row cites the epoch it is bound to and its raw event reference. */
export const PlaygroundTraceView = ({ onToggle, view }: PlaygroundTraceViewProps) => <div className="playground-trace">
  <p className="playground-summary" role="status">{view.summary}</p>
  {view.promotionBlocker === undefined
    ? undefined
    : <p className="playground-blocker" role="status">{view.promotionBlocker}</p>}
  {view.identity.length === 0 ? undefined : <DetailRows label="Session identity" rows={view.identity} />}
  {view.outcome.length === 0 ? undefined : <DetailRows label="Durable outcome" rows={view.outcome} />}
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
            <th scope="col">Assert</th>
            <th scope="col">Seq</th>
            <th scope="col">Timestamp</th>
            <th scope="col">Source</th>
            <th scope="col">Kind</th>
            <th scope="col">Summary</th>
            <th scope="col">Epoch</th>
            <th scope="col">Raw event</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((entry) => <tr key={entry.key}>
            <td>
              <input
                aria-label={`Select ${entry.rawEventRef} as an assertion`}
                checked={view.selectedRefs.includes(entry.rawEventRef)}
                onChange={() => onToggle?.(entry.rawEventRef)}
                type="checkbox"
              />
            </td>
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
 * Records and replays the durable trace of one epoch-bound playground session.
 * The page never dispatches a natural-language action to a host: until the
 * native harness exists, every trace event arrives from an executed operation.
 */
export const PlaygroundPage = ({ client, epoch, onSessionChange, session, targets }: PlaygroundPageProps) => {
  const openedEpochId = useRef(epoch?.id);
  const [busy, setBusy] = useState(false);
  const [draftEvalCase, setDraftEvalCase] = useState<DraftEvalCase>();
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState<readonly PlaygroundTraceEvent[]>([]);
  const [exported, setExported] = useState<PlaygroundExport>();
  const [fixtureDigest, setFixtureDigest] = useState('');
  const [fixtureId, setFixtureId] = useState('');
  const [intentDraft, setIntentDraft] = useState(() => serializeJsonRecord({}));
  const [invocationKind, setInvocationKind] = useState('whole-plugin');
  const [outcomeResponse, setOutcomeResponse] = useState('');
  const [outcomeStatus, setOutcomeStatus] = useState('succeeded');
  const [selectedRefs, setSelectedRefs] = useState<readonly string[]>([]);
  const [targetName, setTargetName] = useState('');
  const [taskId, setTaskId] = useState('');
  const [taskText, setTaskText] = useState('');
  const view = playgroundViewFor({ epoch, events, exported, selectedRefs, session });
  const intent = parseRawJsonRecord(intentDraft);
  const sessionId = session?.id;

  // A session belongs to the epoch it was opened against, so only a genuine epoch
  // change starts over. Resetting on mount would discard the shell's session every
  // time the user navigates back to this page.
  useEffect(() => {
    if (openedEpochId.current === epoch?.id) return;
    openedEpochId.current = epoch?.id;
    setDraftEvalCase(undefined);
    setError(undefined);
    setEvents([]);
    setExported(undefined);
    setSelectedRefs([]);
    onSessionChange(undefined);
  }, [epoch?.id, onSessionChange]);

  useEffect(() => {
    if (sessionId === undefined) return;
    let current = true;
    const stream = client.stream(sessionId, {
      onEvent: (event) => {
        if (current) setEvents((previous) => mergePlaygroundEvents(previous, [event]));
      },
    });
    stream.done.catch((reason: unknown) => {
      if (current) setError(errorMessage(reason));
    });
    return () => {
      current = false;
      stream.close();
    };
  }, [client, sessionId]);

  const run = async (action: () => Promise<void>): Promise<void> => {
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

  const open = async (): Promise<void> => {
    if (epoch === undefined || intent === null) return;
    await run(async () => {
      const opened = await openPlaygroundSession(client, {
        epoch,
        fixture: { digest: fixtureDigest, id: fixtureId },
        invocation: { intent: asJsonObject(intent), kind: invocationKind },
        target: targets.find((entry) => entry.name === targetName) ?? { name: targetName },
        task: { id: taskId, text: taskText },
      });
      setDraftEvalCase(undefined);
      setEvents([]);
      setExported(undefined);
      setSelectedRefs([]);
      onSessionChange(opened);
    });
  };

  const replay = async (): Promise<void> => {
    if (sessionId === undefined) return;
    await run(async () => {
      const replayed = await replayPlaygroundTrace(client, sessionId, view.cursor);
      setEvents((previous) => mergePlaygroundEvents(previous, replayed.events));
      onSessionChange(replayed.session);
    });
  };

  const finalize = async (): Promise<void> => {
    if (sessionId === undefined) return;
    await run(async () => {
      onSessionChange(await finalizePlaygroundOutcome(client, sessionId, {
        ...(outcomeResponse.length === 0 ? {} : { response: outcomeResponse }),
        status: outcomeStatus,
      }));
    });
  };

  const exportTrace = async (): Promise<void> => {
    if (sessionId === undefined) return;
    await run(async () => {
      setExported(await exportPlaygroundTrace(client, sessionId));
    });
  };

  const promote = async (): Promise<void> => {
    if (sessionId === undefined || !view.canPromote) return;
    await run(async () => {
      setDraftEvalCase(await promotePlaygroundDraftEval(client, sessionId, view.assertions));
    });
  };

  const toggle = (rawEventRef: string): void => {
    setSelectedRefs((previous) => previous.includes(rawEventRef)
      ? previous.filter((entry) => entry !== rawEventRef)
      : [...previous, rawEventRef]);
  };

  return <div className="playground-content">
    <div className="page-heading playground-page-heading">
      <div>
        <h1>Playground</h1>
        <p>One durable, ordered trace per epoch-bound session, replayable and promotable to a draft eval case.</p>
      </div>
    </div>
    {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
    {view.state === 'no-epoch'
      ? <p className="empty-row" role="status">{view.summary}</p>
      : <>
        <section aria-label="Session identity" className="playground-controls">
          <p className="playground-note">
            Identity recorded with the trace. The workbench executes no host action here; a native harness lands later.
          </p>
          <label htmlFor="playground-epoch">Epoch</label>
          <input disabled id="playground-epoch" readOnly value={epoch === undefined ? '' : epoch.id} />
          <label htmlFor="playground-fixture-id">Fixture id</label>
          <input
            disabled={busy || session !== undefined}
            id="playground-fixture-id"
            onChange={(event) => setFixtureId(event.currentTarget.value)}
            value={fixtureId}
          />
          <label htmlFor="playground-fixture-digest">Fixture digest</label>
          <input
            disabled={busy || session !== undefined}
            id="playground-fixture-digest"
            onChange={(event) => setFixtureDigest(event.currentTarget.value)}
            value={fixtureDigest}
          />
          <label htmlFor="playground-target">Target</label>
          <select
            disabled={busy || session !== undefined || targets.length === 0}
            id="playground-target"
            onChange={(event) => setTargetName(event.currentTarget.value)}
            value={targetName}
          >
            <option value="">Select a built target</option>
            {targets.map((target) => <option key={target.name} value={target.name}>{target.name}</option>)}
          </select>
          <label htmlFor="playground-task-id">Task id</label>
          <input
            disabled={busy || session !== undefined}
            id="playground-task-id"
            onChange={(event) => setTaskId(event.currentTarget.value)}
            value={taskId}
          />
          <label htmlFor="playground-task-text">Task description</label>
          <textarea
            disabled={busy || session !== undefined}
            id="playground-task-text"
            onChange={(event) => setTaskText(event.currentTarget.value)}
            value={taskText}
          />
          <label htmlFor="playground-invocation-kind">Invocation kind</label>
          <input
            disabled={busy || session !== undefined}
            id="playground-invocation-kind"
            onChange={(event) => setInvocationKind(event.currentTarget.value)}
            value={invocationKind}
          />
          <label htmlFor="playground-invocation-intent">Invocation intent (JSON)</label>
          <textarea
            aria-describedby={intent === null ? 'playground-invocation-intent-error' : undefined}
            aria-invalid={intent === null ? true : undefined}
            disabled={busy || session !== undefined}
            id="playground-invocation-intent"
            onChange={(event) => setIntentDraft(event.currentTarget.value)}
            spellCheck={false}
            value={intentDraft}
          />
          {intent === null
            ? <p id="playground-invocation-intent-error" role="alert">{jsonDraftError}</p>
            : undefined}
          <div className="playground-actions">
            <button
              disabled={busy || intent === null || session !== undefined ||
                fixtureDigest.length === 0 || fixtureId.length === 0 ||
                targetName.length === 0 || taskId.length === 0 || taskText.length === 0}
              onClick={() => void open()}
              type="button"
            >
              Open session
            </button>
            <button disabled={busy || sessionId === undefined} onClick={() => void replay()} type="button">
              Replay from cursor {view.cursor}
            </button>
            <button disabled={busy || sessionId === undefined} onClick={() => void exportTrace()} type="button">
              Export trace
            </button>
          </div>
        </section>
        {sessionId === undefined ? undefined : <section aria-label="Durable outcome" className="playground-controls">
          <label htmlFor="playground-outcome-status">Outcome status</label>
          <input
            disabled={busy}
            id="playground-outcome-status"
            onChange={(event) => setOutcomeStatus(event.currentTarget.value)}
            value={outcomeStatus}
          />
          <label htmlFor="playground-outcome-response">Recorded response</label>
          <textarea
            disabled={busy}
            id="playground-outcome-response"
            onChange={(event) => setOutcomeResponse(event.currentTarget.value)}
            value={outcomeResponse}
          />
          <div className="playground-actions">
            <button disabled={busy || outcomeStatus.length === 0} onClick={() => void finalize()} type="button">
              Finalize outcome
            </button>
            <button disabled={busy || !view.canPromote} onClick={() => void promote()} type="button">
              Promote to draft eval case
            </button>
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
