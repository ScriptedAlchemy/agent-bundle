import { errorMessage as messageFrom } from '../client-helpers.ts';
import React, { useEffect, useRef, useState } from 'react';

import type { EvalArtifact, EvalClient, EvalHarness, EvalRunAdmission, EvalRunStart } from './eval-client.ts';
import type { EvalRunEvent, EvalRunRecord, EvalRunResult, EvalSuiteListing } from '../../../agent-bundle/src/contracts/eval.ts';
import {
  admitEvalRunLifecycle,
  createEvalRunLifecycle,
  EvalRunEvidenceReadCoordinator,
  evalRunLifecycleToken,
  evalOutcomeLabel,
  mergeEvalEvents,
  replaceEvalRunLifecycle,
  evalRunSelectionFor,
  evalRunViewFor,
  updateEvalRunLifecycle,
  type EvalCaseRow,
  type EvalRunLifecycle,
  type EvalRunLifecycleToken,
  type EvalRunView,
  type EvalTrialRow,
} from './evals-model.ts';
import './evals-page.css';

export interface EvalRunControlsProps {
  readonly busy: boolean;
  readonly cancelling?: boolean;
  readonly harness: EvalHarness;
  readonly onCancelRun: () => void;
  readonly onHarnessChange: (harness: EvalHarness) => void;
  readonly onOpenRun: () => void;
  readonly onSelectRun: (runId: string) => void;
  readonly onSelectSuite: (suite: string) => void;
  readonly onStartRun: () => void;
  readonly onTrialsChange: (trials: string) => void;
  readonly openableRun: string | undefined;
  readonly recorded: readonly EvalRunRecord[];
  readonly runnable: boolean;
  readonly trials: string;
  readonly view: EvalRunView;
}

export interface EvalRunReportProps {
  readonly client?: Pick<EvalClient, 'artifact'>;
  readonly view: EvalRunView;
}

export interface EvalsPageProps {
  readonly client: EvalClient;
}

const trialsError = 'Trials must be a whole number between 1 and 100.';

const evalClientScopeKeys = new WeakMap<EvalClient, number>();

let nextEvalClientScopeKey = 0;

/** A weak, stable identity lets React discard all page state when the transport client changes. */
const evalClientScopeKeyFor = (client: EvalClient): number => {
  const existing = evalClientScopeKeys.get(client);
  if (existing !== undefined) return existing;
  const key = nextEvalClientScopeKey + 1;
  nextEvalClientScopeKey = key;
  evalClientScopeKeys.set(client, key);
  return key;
};

const errorMessage = (reason: unknown): string => messageFrom(reason, 'The eval request could not be completed.');

const noEvalEvents: readonly EvalRunEvent[] = Object.freeze([]);

/** A held replay may only paint for the run identity that opened it. */
export const eventsForActiveEvalRun = (
  activeRunId: string | undefined,
  sourceRunId: string | undefined,
  events: readonly EvalRunEvent[],
): readonly EvalRunEvent[] => activeRunId === sourceRunId ? events : noEvalEvents;

/** A bounded-history notice belongs to the same run identity as its events. */
export const discardedSequenceForActiveEvalRun = (
  activeRunId: string | undefined,
  sourceRunId: string | undefined,
  discardedThroughSequence: number | undefined,
): number | undefined => activeRunId === sourceRunId ? discardedThroughSequence : undefined;

/** Starts one authored run over the selection the browser is allowed to make. */
export const startEvalRun = async (
  client: EvalClient,
  selection: EvalRunStart,
  signal?: AbortSignal,
): Promise<EvalRunAdmission> => client.start(selection, signal);

/** Claims one cancellation flight synchronously, before React can schedule a disabled render. */
export const beginEvalCancellation = (
  active: EvalRunLifecycleToken | undefined,
  next: EvalRunLifecycleToken,
): EvalRunLifecycleToken | undefined =>
  active?.generation === next.generation && active.runId === next.runId ? undefined : next;

/** Reopens a recorded run exactly as it was persisted, without running anything again. */
export const openEvalRun = async (client: EvalClient, runId: string, signal?: AbortSignal): Promise<EvalRunResult> =>
  client.read(runId, signal);

type EvalsRequestKind = 'action' | 'runs' | 'suites';

export interface EvalsRequest {
  readonly generation: number;
  readonly kind: EvalsRequestKind;
  readonly signal: AbortSignal;
}

/** Owns every page request so navigation cannot publish stale listings or leave work behind. */
export class EvalsRequestLifecycle {
  readonly #active = new Map<EvalsRequestKind, { readonly controller: AbortController; readonly request: EvalsRequest }>();
  #generation = 0;

  begin(kind: EvalsRequestKind): EvalsRequest {
    this.#active.get(kind)?.controller.abort();
    const controller = new AbortController();
    const request = Object.freeze({ generation: this.#generation, kind, signal: controller.signal });
    this.#active.set(kind, { controller, request });
    return request;
  }

  complete(request: EvalsRequest): void {
    if (this.#active.get(request.kind)?.request === request) this.#active.delete(request.kind);
  }

  invalidate(): void {
    this.#generation += 1;
    for (const { controller } of this.#active.values()) controller.abort();
    this.#active.clear();
  }

  isCurrent(request: EvalsRequest): boolean {
    return request.generation === this.#generation && !request.signal.aborted && this.#active.get(request.kind)?.request === request;
  }
}

const CaseTable = ({ rows }: { readonly rows: readonly EvalCaseRow[] }) => <section className="eval-detail">
  <h2>Cases</h2>
  {rows.length === 0
    ? <p className="empty-row">This suite declares no cases.</p>
    : <div aria-label="Cases table scroll region" className="eval-cases-wrap" tabIndex={0}><table className="eval-cases">
      <thead>
        <tr><th>Case</th><th>Invocation</th><th>Hosts</th><th>Assertions</th><th>Trials</th><th>Prompt</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => <tr key={row.id}>
          <td>{row.id}</td>
          <td>{row.invocation}</td>
          <td>{row.hosts}</td>
          <td>{row.assertions}</td>
          <td>{row.trials}</td>
          <td>{row.prompt}</td>
        </tr>)}
      </tbody>
    </table></div>}
</section>;

const maximumPreviewBytes = 256 * 1024;

const evidenceLevel = (value: string): string => `${value} evidence`;

const invocationProvenance = (row: EvalTrialRow): string => {
  const invocation = row.provenance.invocation;
  return invocation.mode === 'explicit' ? `explicit · ${invocation.skill}` : invocation.mode;
};

const semanticGraderProvenance = (row: EvalTrialRow): string => {
  const semanticGrader = row.provenance.semanticGrader;
  if (semanticGrader === null) return 'None';
  if ('state' in semanticGrader) return 'Unrecorded';
  return `${semanticGrader.id} · ${semanticGrader.model} · ${semanticGrader.contractRevision}`;
};

const usageProvenance = (row: EvalTrialRow): string => row.usage === undefined
  ? 'Not recorded'
  : `${row.usage.inputTokens} input tokens · ${row.usage.outputTokens} output tokens`;

const EvidenceChannels = ({ row }: { readonly row: EvalTrialRow }) => <section className="eval-evidence-channels">
  <h3>Evidence channels</h3>
  <dl>
    <div><dt>MCP</dt><dd>{evidenceLevel(row.evidence.mcp.level)}{row.evidence.mcp.calls.length === 0 ? '' : ` · ${row.evidence.mcp.calls.map((call) => `${call.server}/${call.tool}`).join(', ')}`}</dd></div>
    <div><dt>Process</dt><dd>{evidenceLevel(row.evidence.process.level)}{row.evidence.process.exitCode === undefined ? '' : ` · exit ${row.evidence.process.exitCode}`}{row.evidence.process.timedOut ? ' · timed out' : ''}</dd></div>
    <div><dt>Scripts</dt><dd>{evidenceLevel(row.evidence.scripts.level)}{Object.keys(row.evidence.scripts.results).length === 0 ? '' : ` · ${Object.entries(row.evidence.scripts.results).map(([name, result]) => `${name}: ${result.outcome} — ${result.detail}`).join(', ')}`}</dd></div>
    <div><dt>Skills</dt><dd>{evidenceLevel(row.evidence.skillActivation.level)}{row.evidence.skillActivation.activated.length === 0 ? '' : ` · ${row.evidence.skillActivation.activated.join(', ')}`}</dd></div>
  </dl>
</section>;

const previewable = (mediaType: string): boolean =>
  mediaType === 'application/json' || mediaType === 'application/x-ndjson' || mediaType === 'text/plain';

const artifactName = (reference: string): string => reference.split('/').at(-1) ?? 'evidence';

interface ArtifactDisplay {
  readonly filename: string;
  readonly message?: string;
  readonly preview?: string;
  readonly url: string;
}

export const evalArtifactPresentationKey = (runId: string | undefined, reference: string): string =>
  JSON.stringify([runId, reference]);

export const prepareEvalArtifactDisplay = async (
  artifact: EvalArtifact,
  withPreview: boolean,
  createObjectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): Promise<ArtifactDisplay> => {
  let message: string | undefined;
  let preview: string | undefined;
  if (withPreview) {
    if (!previewable(artifact.mediaType)) message = 'This artifact is download-only.';
    else if (artifact.blob.size > maximumPreviewBytes) message = 'This text artifact is too large to preview; download it instead.';
    else preview = new TextDecoder('utf-8', { fatal: true }).decode(await artifact.blob.arrayBuffer());
  }
  return Object.freeze({
    filename: artifact.filename,
    ...(message === undefined ? {} : { message }),
    ...(preview === undefined ? {} : { preview }),
    url: createObjectUrl(artifact.blob),
  });
};

const RawArtifact = ({ client, reference, runId }: {
  readonly client: Pick<EvalClient, 'artifact'> | undefined;
  readonly reference: string;
  readonly runId: string | undefined;
}) => {
  const active = useRef<AbortController | undefined>(undefined);
  const displayRef = useRef<ArtifactDisplay | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [display, setDisplay] = useState<ArtifactDisplay>();
  const [failure, setFailure] = useState<string>();
  const replaceDisplay = (next: ArtifactDisplay | undefined): void => {
    const previous = displayRef.current;
    if (previous !== undefined && previous.url !== next?.url) URL.revokeObjectURL(previous.url);
    displayRef.current = next;
    setDisplay(next);
  };
  useEffect(() => {
    active.current?.abort();
    active.current = undefined;
    const previous = displayRef.current;
    displayRef.current = undefined;
    if (previous !== undefined) URL.revokeObjectURL(previous.url);
    setDisplay(undefined);
    setFailure(undefined);
    setBusy(false);
    return () => {
      active.current?.abort();
      active.current = undefined;
      const current = displayRef.current;
      displayRef.current = undefined;
      if (current !== undefined) URL.revokeObjectURL(current.url);
    };
  }, [client, reference, runId]);
  const prepare = async (withPreview: boolean): Promise<void> => {
    if (client === undefined || runId === undefined) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setFailure(undefined);
    setBusy(true);
    try {
      const artifact = await client.artifact(runId, reference, controller.signal);
      if (controller.signal.aborted) return;
      const next = await prepareEvalArtifactDisplay(artifact, withPreview);
      if (controller.signal.aborted) {
        URL.revokeObjectURL(next.url);
        return;
      }
      replaceDisplay(next);
    } catch {
      if (!controller.signal.aborted) {
        replaceDisplay(undefined);
        setFailure('Recorded raw evidence could not be prepared.');
      }
    } finally {
      if (active.current === controller) active.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return <li className="eval-raw-artifact">
    <span>{artifactName(reference)}</span>
    {client === undefined || runId === undefined
      ? <span className="eval-raw-unavailable">Foreground download unavailable.</span>
      : <span className="eval-raw-actions">
        <button disabled={busy} onClick={() => void prepare(true)} type="button">Preview safe text</button>
        <button disabled={busy} onClick={() => void prepare(false)} type="button">Prepare download</button>
      </span>}
    {display === undefined ? undefined : <div className="eval-raw-result">
      <a download={display.filename} href={display.url}>Download {display.filename}</a>
      {display.message === undefined ? undefined : <p>{display.message}</p>}
      {display.preview === undefined ? undefined : <pre><code>{display.preview}</code></pre>}
    </div>}
    {failure === undefined ? undefined : <p className="eval-raw-unavailable" role="alert">{failure}</p>}
  </li>;
};

const TrialCard = ({ client, row, runId }: {
  readonly client: Pick<EvalClient, 'artifact'> | undefined;
  readonly row: EvalTrialRow;
  readonly runId: string | undefined;
}) => <li className="eval-trial">
  <div className="eval-trial-heading">
    <span className={`eval-outcome eval-outcome-${row.outcome}`}>{evalOutcomeLabel(row.outcome)}</span>
    <strong>{row.caseId}</strong>
    <span className="eval-trial-id">{row.id}</span>
  </div>
  <dl className="eval-trial-rows">
    <div><dt>Host</dt><dd>{row.host}</dd></div>
    <div><dt>Model</dt><dd>{row.model}</dd></div>
    <div><dt>Duration</dt><dd>{row.durationMs} ms</dd></div>
    <div><dt>Target digest</dt><dd className="eval-digest">{row.targetDigest}</dd></div>
  </dl>
  <section className="eval-trial-provenance">
    <h3>Recorded provenance</h3>
    <dl>
      <div><dt>Host CLI version</dt><dd>{row.provenance.hostCliVersion ?? 'Not recorded'}</dd></div>
      <div><dt>Invocation</dt><dd>{invocationProvenance(row)}</dd></div>
      <div><dt>Semantic grader</dt><dd>{semanticGraderProvenance(row)}</dd></div>
      <div><dt>Recorded usage</dt><dd>{usageProvenance(row)}</dd></div>
    </dl>
  </section>
  {row.failure === undefined
    ? (row.outcome === 'inconclusive'
      ? <p className="eval-trial-note">This trial recorded no defect; its evidence was insufficient to conclude.</p>
      : undefined)
    : <p className="eval-trial-failure">{row.failure}</p>}
  <EvidenceChannels row={row} />
  {row.rawArtifacts.length === 0 ? undefined : <section className="eval-raw-evidence">
    <h3>Raw evidence</h3>
    <ul>{row.rawArtifacts.map((reference) => <RawArtifact client={client} key={evalArtifactPresentationKey(runId, reference)} reference={reference} runId={runId} />)}</ul>
  </section>}
  <h3>Grader results</h3>
  <ul className="eval-assertions">
    {row.assertions.map((assertion) => <li key={assertion.id}>
      <span className={`eval-outcome eval-outcome-${assertion.outcome}`}>{evalOutcomeLabel(assertion.outcome)}</span>
      <span className="eval-assertion-kind">{assertion.kind}</span>
      <span className="eval-assertion-evidence">{assertion.evidence} evidence</span>
      <span className="eval-assertion-detail">{assertion.detail}</span>
    </li>)}
  </ul>
</li>;

/** Everything a browser may choose: an authored suite, a trial count, and a recorded run to reopen. */
export const EvalRunControls = ({
  busy,
  cancelling = false,
  harness,
  onCancelRun,
  onHarnessChange,
  onOpenRun,
  onSelectRun,
  onSelectSuite,
  onStartRun,
  onTrialsChange,
  openableRun,
  recorded,
  runnable,
  trials,
  view,
}: EvalRunControlsProps) => {
  const active = view.runStatus === 'queued' || view.runStatus === 'running' || view.runStatus === 'cancelling';
  return <section aria-label="Eval run" className="eval-controls">
  <label htmlFor="eval-suite">Suite</label>
  <select
    disabled={busy || view.suites.length === 0}
    id="eval-suite"
    onChange={(event) => onSelectSuite(event.currentTarget.value)}
    value={view.selected?.key ?? ''}
  >
    {view.suites.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
  </select>
  <label htmlFor="eval-harness">Harness</label>
  <select
    disabled={busy}
    id="eval-harness"
    onChange={(event) => onHarnessChange(event.currentTarget.value as EvalHarness)}
    value={harness}
  >
    <option value="deterministic">Deterministic</option>
    <option value="claude">Claude</option>
    <option value="codex">Codex</option>
  </select>
  <p className="eval-model-pin">Authored model pins are read-only and shown with recorded trials.</p>
  <label htmlFor="eval-trials">Trial override (leave blank to use authored count)</label>
  <input
    aria-describedby={runnable ? undefined : 'eval-trials-error'}
    aria-invalid={runnable ? undefined : true}
    disabled={busy}
    id="eval-trials"
    inputMode="numeric"
    onChange={(event) => onTrialsChange(event.currentTarget.value)}
    value={trials}
  />
  {runnable ? undefined : <p id="eval-trials-error" role="alert">{trialsError}</p>}
  {recorded.length === 0 ? undefined : <>
    <label htmlFor="eval-run">Recorded run</label>
    <select
      disabled={busy}
      id="eval-run"
      onChange={(event) => onSelectRun(event.currentTarget.value)}
      value={openableRun ?? ''}
    >
      {recorded.map((record) => <option key={record.id} value={record.id}>{record.id}</option>)}
    </select>
  </>}
  <div className="eval-actions">
    <button disabled={busy || !runnable} onClick={onStartRun} type="button">Run {harness} suite</button>
    <button disabled={busy || openableRun === undefined} onClick={onOpenRun} type="button">Open recorded run</button>
    {active ? <button disabled={busy || cancelling || view.runStatus === 'cancelling'} onClick={onCancelRun} type="button">
      {cancelling || view.runStatus === 'cancelling' ? 'Cancelling…' : 'Cancel run'}
    </button> : undefined}
  </div>
</section>;
};

const EventTimeline = ({ discardedThroughSequence, events }: {
  readonly discardedThroughSequence: number | undefined;
  readonly events: readonly EvalRunEvent[];
}) => <section className="eval-detail eval-timeline">
  <h2>Durable event timeline</h2>
  {discardedThroughSequence === undefined ? undefined : <p className="eval-timeline-notice" role="status">
    Earlier durable events through #{discardedThroughSequence} are not shown because this view is bounded.
  </p>}
  {events.length === 0
    ? discardedThroughSequence === undefined ? <p className="empty-row">No persisted event is available for this run.</p> : undefined
    : <ol>
    {events.map((event) => <li key={event.sequence}>
      <span className="eval-event-sequence">#{event.sequence}</span><time dateTime={event.timestamp}>{event.timestamp}</time><strong>{event.kind}</strong>
      <pre><code>{JSON.stringify(event.payload, undefined, 2)}</code></pre>
    </li>)}
  </ol>}
</section>;

const HostModelMatrix = ({ view }: { readonly view: EvalRunView }) => <section className="eval-detail eval-host-models">
  <h2>Host / model matrix</h2>
  <table>
    <thead><tr><th>Host</th><th>Model</th><th>Trial</th><th>Server outcome</th></tr></thead>
    <tbody>{view.hostModels.map((row) => <tr key={`${row.host}/${row.model}/${row.trialId}`}>
      <td>{row.host}</td><td>{row.model}</td><td>{row.trialId}</td><td>{evalOutcomeLabel(row.outcome)}</td>
    </tr>)}</tbody>
  </table>
</section>;

/** The discovered cases of one suite and the persisted evidence of the latest run. */
export const EvalRunReport = ({ client, view }: EvalRunReportProps) => <div className="eval-report">
  <p className="eval-summary" role="status">{view.summary}</p>
  {view.diagnostics.length === 0 ? undefined : <div className="eval-diagnostics" role="alert">
    <h2>Eval configuration diagnostics</h2>
    {view.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}>
      <strong>{diagnostic.code}</strong> {diagnostic.message}
    </p>)}
  </div>}
  <CaseTable rows={view.cases} />
  {view.state !== 'ran' ? undefined : <section className="eval-detail">
    <h2>Trials</h2>
    <p className="eval-counts">
      {view.outcomes.pass} passed · {view.outcomes.fail} failed · {view.outcomes.inconclusive} inconclusive
    </p>
    <HostModelMatrix view={view} />
    <ul className="eval-trials">
      {view.trials.map((row) => <TrialCard client={client} key={`${row.caseId}/${row.id}`} row={row} runId={view.runId} />)}
    </ul>
  </section>}
  {view.runId === undefined ? undefined : <EventTimeline discardedThroughSequence={view.discardedThroughSequence} events={view.events} />}
</div>;

const terminalEvent = (event: EvalRunEvent): boolean =>
  event.kind === 'run.cancelled' || event.kind === 'run.completed' || event.kind === 'run.failed';

const reconnectDelayMilliseconds = 250;

const maximumTerminalResultReads = 8;

const sleepUntilReconnect = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }
  const timer = setTimeout(done, milliseconds);
  function done(): void {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  }
  signal.addEventListener('abort', done, { once: true });
});

const waitForReconnect = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  sleepUntilReconnect(milliseconds, signal);

export interface EvalFinalizedRunReadOptions {
  readonly client: Pick<EvalClient, 'read'>;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** A terminal event may arrive just before its writer finalizes the canonical run record. */
export const readFinalizedEvalRun = async ({
  client,
  runId,
  signal,
  wait = waitForReconnect,
}: EvalFinalizedRunReadOptions): Promise<EvalRunResult> => {
  for (let attempt = 0; attempt < maximumTerminalResultReads; attempt += 1) {
    const result = await client.read(runId, signal);
    if (result.run.completedAt !== undefined || signal.aborted) return result;
    if (attempt + 1 < maximumTerminalResultReads) await wait(reconnectDelayMilliseconds, signal);
  }
  throw new Error('Recorded eval results were not finalized in time.');
};

interface EvalObservationClient {
  events(runId: string, afterSequence: number, signal?: AbortSignal): ReturnType<EvalClient['events']>;
  stream(options: Parameters<EvalClient['stream']>[0]): ReturnType<EvalClient['stream']>;
}

export interface EvalRunObserverOptions {
  readonly client: EvalObservationClient;
  readonly onEvents: (events: readonly EvalRunEvent[], discardedThroughSequence: number | undefined) => void;
  readonly onRefresh?: () => Promise<void>;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** Replays then follows one durable run; only a clean, non-terminal EOF is reconnectable. */
export const observeEvalRunEvents = async ({
  client,
  onEvents,
  onRefresh,
  runId,
  signal,
  wait = waitForReconnect,
}: EvalRunObserverOptions): Promise<void> => {
  let discardedThroughSequence: number | undefined;
  let events: readonly EvalRunEvent[] = [];
  let latestSequence = 0;
  let refreshRequested = false;
  let refreshRunning = false;
  const requestRefresh = (): void => {
    if (onRefresh === undefined || signal.aborted) return;
    refreshRequested = true;
    if (refreshRunning) return;
    refreshRunning = true;
    void (async () => {
      try {
        while (refreshRequested && !signal.aborted) {
          refreshRequested = false;
          await onRefresh();
        }
      } finally {
        refreshRunning = false;
        if (refreshRequested && !signal.aborted) requestRefresh();
      }
    })().catch(() => undefined);
  };
  const accept = (incoming: readonly EvalRunEvent[]): boolean => {
    if (signal.aborted) return false;
    const knownSequences = new Set(events.map((event) => event.sequence));
    const merged = mergeEvalEvents(events, incoming);
    if (merged.conflictSequence !== undefined || merged.discontinuitySequence !== undefined) {
      throw new Error('Persisted eval events could not be read.');
    }
    const accepted = incoming.filter((event) => !knownSequences.has(event.sequence));
    events = merged.events;
    latestSequence = Math.max(latestSequence, merged.cursor);
    if (merged.discardedThroughSequence !== undefined) {
      discardedThroughSequence = Math.max(discardedThroughSequence ?? 0, merged.discardedThroughSequence);
    }
    onEvents(events, discardedThroughSequence);
    if (accepted.some((event) => event.kind === 'trial.completed' || terminalEvent(event))) requestRefresh();
    return accepted.some(terminalEvent);
  };
  while (!signal.aborted) {
    const replay = await client.events(runId, latestSequence, signal);
    if (signal.aborted) return;
    if (replay.incompleteTrailingRecord === true) throw new Error('Persisted eval events could not be read.');
    latestSequence = replay.cursor.afterSequence;
    if (accept(replay.events)) return;
    let terminal = false;
    const stream = client.stream({
      afterSequence: latestSequence,
      onEvent: (event) => { terminal = accept([event]) || terminal; },
      runId,
      signal,
    });
    try {
      await stream.done;
    } finally {
      stream.close();
    }
    if (signal.aborted || terminal) return;
    await wait(reconnectDelayMilliseconds, signal);
  }
};

/** All mutable Eval state is scoped to exactly one foreground client identity. */
const EvalsClientPage = ({ client }: EvalsPageProps) => {
  const [runLifecycle, setRunLifecycle] = useState<EvalRunLifecycle>(createEvalRunLifecycle);
  const [admittingGeneration, setAdmittingGeneration] = useState<number>();
  const [cancellingGeneration, setCancellingGeneration] = useState<number>();
  const [cancellationNote, setCancellationNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [harness, setHarness] = useState<EvalHarness>('deterministic');
  const [listing, setListing] = useState<EvalSuiteListing>();
  const [recorded, setRecorded] = useState<readonly EvalRunRecord[]>([]);
  const [selectedRun, setSelectedRun] = useState<string>();
  const [selectedSuite, setSelectedSuite] = useState<string>();
  const [trials, setTrials] = useState('');
  const clientRef = useRef(client);
  const lifecycleRef = useRef(runLifecycle);
  const observer = useRef<AbortController | undefined>(undefined);
  const cancellationFlight = useRef<EvalRunLifecycleToken | undefined>(undefined);
  const requests = useRef<EvalsRequestLifecycle>(new EvalsRequestLifecycle()).current;
  const evidenceReads = useRef<EvalRunEvidenceReadCoordinator>(new EvalRunEvidenceReadCoordinator()).current;
  clientRef.current = client;
  const commitLifecycle = (next: EvalRunLifecycle): EvalRunLifecycle => {
    lifecycleRef.current = next;
    setRunLifecycle(next);
    return next;
  };
  const isCurrent = (source: EvalClient, token: EvalRunLifecycleToken): boolean => {
    const current = lifecycleRef.current;
    return source === clientRef.current && current.generation === token.generation && current.runId === token.runId;
  };
  const updateCurrent = (
    source: EvalClient,
    token: EvalRunLifecycleToken,
    update: Parameters<typeof updateEvalRunLifecycle>[2],
  ): boolean => {
    if (!isCurrent(source, token)) return false;
    const next = updateEvalRunLifecycle(lifecycleRef.current, token, update);
    if (next === lifecycleRef.current) return false;
    commitLifecycle(next);
    return true;
  };
  const replaceRun = (runId?: string, admittedRun?: EvalRunRecord): EvalRunLifecycleToken => {
    observer.current?.abort();
    evidenceReads.invalidate();
    cancellationFlight.current = undefined;
    setAdmittingGeneration(undefined);
    setCancellingGeneration(undefined);
    return evalRunLifecycleToken(commitLifecycle(replaceEvalRunLifecycle(lifecycleRef.current, runId, admittedRun)));
  };
  const refreshRecorded = async (
    source: EvalClient,
    action?: EvalsRequest,
    token?: EvalRunLifecycleToken,
  ): Promise<void> => {
    const refresh = requests.begin('runs');
    try {
      const next = await source.runs(refresh.signal);
      if (source !== clientRef.current || !requests.isCurrent(refresh) ||
        action !== undefined && !requests.isCurrent(action) || token !== undefined && !isCurrent(source, token)) return;
      setRecorded(next);
    } catch (reason) {
      if (action !== undefined && requests.isCurrent(action) && requests.isCurrent(refresh)) setError(errorMessage(reason));
    } finally {
      if (requests.isCurrent(refresh)) requests.complete(refresh);
    }
  };
  const view = evalRunViewFor({
    admittedRun: runLifecycle.admittedRun,
    admitting: admittingGeneration === runLifecycle.generation,
    cancelling: cancellingGeneration === runLifecycle.generation,
    currentRunId: runLifecycle.runId,
    discardedThroughSequence: runLifecycle.discardedThroughSequence,
    events: runLifecycle.events,
    eventsRunId: runLifecycle.runId,
    listing,
    result: runLifecycle.result,
    selectedSuite,
  });
  const selection = evalRunSelectionFor(view, trials);
  const openable = selectedRun ?? recorded[recorded.length - 1]?.id;

  useEffect(() => {
    requests.invalidate();
    const suites = requests.begin('suites');
    const runs = requests.begin('runs');
    void client.suites(suites.signal).then(
      (next) => {
        if (!requests.isCurrent(suites)) return;
        requests.complete(suites);
        setListing(next);
      },
      (reason) => {
        if (!requests.isCurrent(suites)) return;
        requests.complete(suites);
        setListing({ diagnostics: [], suites: [] });
        setError(errorMessage(reason));
      },
    );
    void client.runs(runs.signal).then(
      (next) => {
        if (!requests.isCurrent(runs)) return;
        requests.complete(runs);
        setRecorded(next);
      },
      () => { if (requests.isCurrent(runs)) requests.complete(runs); },
    );
    return () => {
      requests.invalidate();
      evidenceReads.invalidate();
      observer.current?.abort();
      cancellationFlight.current = undefined;
    };
  }, [client, evidenceReads, requests]);

  useEffect(() => {
    const token = evalRunLifecycleToken(runLifecycle);
    if (token.runId === undefined) return undefined;
    const runId = token.runId;
    const controller = new AbortController();
    observer.current = controller;
    void observeEvalRunEvents({
      client,
      onEvents: (next, discarded) => {
        if (!controller.signal.aborted) {
          updateCurrent(client, token, { discardedThroughSequence: discarded, events: next });
        }
      },
      onRefresh: async () => {
        const claim = evidenceReads.claim(token, controller.signal);
        try {
          const terminal = lifecycleRef.current.events.some(terminalEvent);
          const nextResult = terminal
            ? await readFinalizedEvalRun({ client, runId, signal: claim.signal })
            : await client.read(runId, claim.signal);
          if (claim.signal.aborted || !evidenceReads.isCurrent(claim) || controller.signal.aborted || !isCurrent(client, token)) return;
          if (nextResult.run.id !== runId) {
            setError('Recorded eval results did not match the active run.');
            return;
          }
          if (!updateCurrent(client, token, { admittedRun: nextResult.run, result: nextResult })) return;
          if (lifecycleRef.current.events.some(terminalEvent)) await refreshRecorded(client, undefined, token);
        } catch {
          if (!claim.signal.aborted && !controller.signal.aborted && evidenceReads.isCurrent(claim) && isCurrent(client, token)) {
            setError('Recorded eval results could not be refreshed.');
          }
        } finally {
          evidenceReads.complete(claim);
        }
      },
      runId,
      signal: controller.signal,
    }).catch(() => {
      if (!controller.signal.aborted && isCurrent(client, token)) {
        setError('Live eval observation stopped because persisted events could not be read.');
      }
    });
    return () => {
      controller.abort();
      if (observer.current === controller) observer.current = undefined;
    };
  }, [client, evidenceReads, runLifecycle.generation, runLifecycle.runId]);

  const start = async (): Promise<void> => {
    if (selection === undefined) return;
    const token = replaceRun();
    const action = requests.begin('action');
    setAdmittingGeneration(token.generation);
    setError(undefined);
    setCancellationNote(undefined);
    try {
      const admission = await startEvalRun(client, { ...selection, harness }, action.signal);
      if (!requests.isCurrent(action) || !isCurrent(client, token)) return;
      const admitted = commitLifecycle(admitEvalRunLifecycle(lifecycleRef.current, admission.run));
      setSelectedRun(admission.run.id);
      await refreshRecorded(client, action, evalRunLifecycleToken(admitted));
    } catch (reason) {
      if (requests.isCurrent(action) && isCurrent(client, token)) setError(errorMessage(reason));
    } finally {
      if (requests.isCurrent(action)) requests.complete(action);
      if (lifecycleRef.current.generation === token.generation) setAdmittingGeneration((current) => current === token.generation ? undefined : current);
    }
  };

  const open = async (): Promise<void> => {
    if (openable === undefined) return;
    const recordedRun = recorded.find((entry) => entry.id === openable);
    const token = replaceRun(openable, recordedRun);
    const action = requests.begin('action');
    setError(undefined);
    setCancellationNote(undefined);
    const claim = evidenceReads.claim(token, action.signal);
    try {
      const next = await openEvalRun(client, openable, claim.signal);
      if (claim.signal.aborted || !evidenceReads.isCurrent(claim) || !requests.isCurrent(action) || !isCurrent(client, token)) return;
      if (next.run.id !== openable) throw new Error('Recorded eval results did not match the selected run.');
      if (updateCurrent(client, token, { admittedRun: next.run, result: next })) {
        await refreshRecorded(client, action, token);
      }
    } catch (reason) {
      if (!claim.signal.aborted && evidenceReads.isCurrent(claim) && requests.isCurrent(action) && isCurrent(client, token)) {
        setError(errorMessage(reason));
      }
    } finally {
      evidenceReads.complete(claim);
      if (requests.isCurrent(action)) requests.complete(action);
    }
  };

  const cancel = async (): Promise<void> => {
    const token = evalRunLifecycleToken(lifecycleRef.current);
    if (token.runId === undefined || view.runStatus !== 'queued' && view.runStatus !== 'running') return;
    const flight = beginEvalCancellation(cancellationFlight.current, token);
    if (flight === undefined) return;
    cancellationFlight.current = flight;
    const action = requests.begin('action');
    setCancellingGeneration(token.generation);
    setCancellationNote(undefined);
    setError(undefined);
    let evidenceReadAborted = false;
    try {
      const response = await client.cancel(token.runId, action.signal);
      if (!requests.isCurrent(action) || cancellationFlight.current !== flight || !isCurrent(client, token)) return;
      setCancellationNote(response.cancelled
        ? 'Cancellation was recorded for this run.'
        : 'This run had already reached a terminal state; no cancellation was made.');
      const claim = evidenceReads.claim(token, action.signal);
      let next: EvalRunResult;
      let claimCurrent = false;
      try {
        next = await client.read(token.runId, claim.signal);
        claimCurrent = !claim.signal.aborted && evidenceReads.isCurrent(claim);
      } finally {
        evidenceReadAborted = claim.signal.aborted;
        evidenceReads.complete(claim);
      }
      if (!claimCurrent || !requests.isCurrent(action) || cancellationFlight.current !== flight || !isCurrent(client, token)) return;
      if (next.run.id !== token.runId) throw new Error('Recorded eval results did not match the cancelled run.');
      if (updateCurrent(client, token, { admittedRun: next.run, result: next })) {
        await refreshRecorded(client, action, token);
      }
    } catch (reason) {
      if (!evidenceReadAborted && requests.isCurrent(action) && cancellationFlight.current === flight && isCurrent(client, token)) {
        setError(errorMessage(reason));
      }
    } finally {
      if (requests.isCurrent(action)) requests.complete(action);
      if (cancellationFlight.current === flight) {
        cancellationFlight.current = undefined;
        if (isCurrent(client, token)) setCancellingGeneration((current) => current === token.generation ? undefined : current);
      }
    }
  };

  return <div className="evals-content">
    <div className="page-heading evals-page-heading">
      <div>
        <h1>Evals</h1>
        <p>Authored suites, their cases, and the evidence every trial recorded.</p>
      </div>
    </div>
    {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
    {cancellationNote === undefined ? undefined : <p className="eval-cancel-note" role="status">{cancellationNote}</p>}
    {view.state === 'empty' || view.state === 'loading'
        ? <p className="empty-row" role="status">{view.summary}</p>
        : <>
        <EvalRunControls
          busy={admittingGeneration === runLifecycle.generation || cancellingGeneration === runLifecycle.generation}
          cancelling={cancellingGeneration === runLifecycle.generation}
          harness={harness}
          onCancelRun={() => { void cancel(); }}
          onHarnessChange={setHarness}
          onOpenRun={() => { void open(); }}
          onSelectRun={setSelectedRun}
          onSelectSuite={setSelectedSuite}
          onStartRun={() => { void start(); }}
          onTrialsChange={setTrials}
          openableRun={openable}
          recorded={recorded}
          runnable={selection !== undefined}
          trials={trials}
          view={view}
        />
        <EvalRunReport client={client} view={view} />
      </>}
  </div>;
};

/** Runs authored suites and shows the evidence every trial recorded. */
export const EvalsPage = ({ client }: EvalsPageProps) =>
  <EvalsClientPage client={client} key={evalClientScopeKeyFor(client)} />;
