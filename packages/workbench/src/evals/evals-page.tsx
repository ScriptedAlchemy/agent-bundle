import React, { useEffect, useRef, useState } from 'react';

import type { EvalRunResult, EvalSuiteListing } from '../../../agent-bundle/src/dev/eval-service.ts';
import type { EvalRunRecord } from '../../../agent-bundle/src/eval/run-store.ts';
import type { EvalClient, EvalRunStart } from './eval-client.ts';
import {
  evalOutcomeLabel,
  evalRunSelectionFor,
  evalRunViewFor,
  type EvalCaseRow,
  type EvalRunView,
  type EvalTrialRow,
} from './evals-model.ts';
import './evals-page.css';

export interface EvalRunControlsProps {
  readonly busy: boolean;
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
  readonly view: EvalRunView;
}

export interface EvalsPageProps {
  readonly client: EvalClient;
}

const trialsError = 'Trials must be a whole number between 1 and 100.';

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'The eval request could not be completed.';

/** Starts one deterministic run over the selection the browser is allowed to make. */
export const startEvalRun = async (
  client: EvalClient,
  selection: EvalRunStart,
  signal?: AbortSignal,
): Promise<EvalRunResult> => client.start(selection, signal);

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
    : <table className="eval-cases">
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
    </table>}
</section>;

const TrialCard = ({ row }: { readonly row: EvalTrialRow }) => <li className="eval-trial">
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
  {row.failure === undefined
    ? (row.outcome === 'inconclusive'
      ? <p className="eval-trial-note">This trial recorded no defect; its evidence was insufficient to conclude.</p>
      : undefined)
    : <p className="eval-trial-failure">{row.failure}</p>}
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
}: EvalRunControlsProps) => <section aria-label="Deterministic eval run" className="eval-controls">
  <label htmlFor="eval-suite">Suite</label>
  <select
    disabled={busy || view.suites.length === 0}
    id="eval-suite"
    onChange={(event) => onSelectSuite(event.currentTarget.value)}
    value={view.selected?.key ?? ''}
  >
    {view.suites.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
  </select>
  <label htmlFor="eval-trials">Trials (authored count when empty)</label>
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
    <button disabled={busy || !runnable} onClick={onStartRun} type="button">Run deterministic suite</button>
    <button disabled={busy || openableRun === undefined} onClick={onOpenRun} type="button">Open recorded run</button>
  </div>
</section>;

/** The discovered cases of one suite and the per-trial evidence of the latest run. */
export const EvalRunReport = ({ view }: EvalRunReportProps) => <div className="eval-report">
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
    <ul className="eval-trials">
      {view.trials.map((row) => <TrialCard key={`${row.caseId}/${row.id}`} row={row} />)}
    </ul>
  </section>}
</div>;

/** Runs authored deterministic suites and shows the evidence every trial recorded. */
export const EvalsPage = ({ client }: EvalsPageProps) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [listing, setListing] = useState<EvalSuiteListing>();
  const [recorded, setRecorded] = useState<readonly EvalRunRecord[]>([]);
  const [result, setResult] = useState<EvalRunResult>();
  const [selectedRun, setSelectedRun] = useState<string>();
  const [selectedSuite, setSelectedSuite] = useState<string>();
  const [trials, setTrials] = useState('');
  const lifecycle = useRef<EvalsRequestLifecycle>(new EvalsRequestLifecycle()).current;
  const view = evalRunViewFor({ listing, result, selectedSuite });
  const selection = evalRunSelectionFor(view, trials);
  const openable = selectedRun ?? recorded[recorded.length - 1]?.id;

  useEffect(() => {
    lifecycle.invalidate();
    const suites = lifecycle.begin('suites');
    const runs = lifecycle.begin('runs');
    void client.suites(suites.signal).then(
      (next) => {
        if (!lifecycle.isCurrent(suites)) return;
        lifecycle.complete(suites);
        setListing(next);
      },
      (reason) => {
        if (!lifecycle.isCurrent(suites)) return;
        lifecycle.complete(suites);
        setListing({ diagnostics: [], suites: [] });
        setError(errorMessage(reason));
      },
    );
    void client.runs(runs.signal).then(
      (next) => {
        if (!lifecycle.isCurrent(runs)) return;
        lifecycle.complete(runs);
        setRecorded(next);
      },
      () => { if (lifecycle.isCurrent(runs)) lifecycle.complete(runs); },
    );
    return () => lifecycle.invalidate();
  }, [client, lifecycle]);

  const load = async (action: (signal: AbortSignal) => Promise<EvalRunResult>): Promise<void> => {
    const request = lifecycle.begin('action');
    setBusy(true);
    setError(undefined);
    try {
      const next = await action(request.signal);
      if (!lifecycle.isCurrent(request)) return;
      setResult(next);
      // A failed listing refresh must not discard the run the user just saw.
      const refresh = lifecycle.begin('runs');
      try {
        const recorded = await client.runs(refresh.signal);
        if (lifecycle.isCurrent(request) && lifecycle.isCurrent(refresh)) {
          lifecycle.complete(refresh);
          setRecorded(recorded);
        }
      } catch (reason) {
        if (lifecycle.isCurrent(request) && lifecycle.isCurrent(refresh)) {
          lifecycle.complete(refresh);
          setError(errorMessage(reason));
        }
      }
    } catch (reason) {
      if (lifecycle.isCurrent(request)) setError(errorMessage(reason));
    } finally {
      if (lifecycle.isCurrent(request)) {
        lifecycle.complete(request);
        setBusy(false);
      }
    }
  };

  return <div className="evals-content">
    <div className="page-heading evals-page-heading">
      <div>
        <h1>Evals</h1>
        <p>Authored deterministic suites, their cases, and the evidence every trial recorded.</p>
      </div>
    </div>
    {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
    {view.state === 'empty' || view.state === 'loading'
      ? <p className="empty-row" role="status">{view.summary}</p>
      : <>
        <EvalRunControls
          busy={busy}
          onOpenRun={() => { if (openable !== undefined) void load((signal) => openEvalRun(client, openable, signal)); }}
          onSelectRun={setSelectedRun}
          onSelectSuite={setSelectedSuite}
          onStartRun={() => { if (selection !== undefined) void load((signal) => startEvalRun(client, selection, signal)); }}
          onTrialsChange={setTrials}
          openableRun={openable}
          recorded={recorded}
          runnable={selection !== undefined}
          trials={trials}
          view={view}
        />
        <EvalRunReport view={view} />
      </>}
  </div>;
};
