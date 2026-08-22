import { isAbortError, errorMessage as messageFrom } from '../client-helpers.ts';
import React, { useEffect, useRef, useState } from 'react';

import type { EvalComparison } from '../../../agent-bundle/src/eval/compare.ts';
import type { EvalRunRecord } from '../../../agent-bundle/src/eval/run-store.ts';
import type { ComparisonClient } from './comparison-client.ts';
import {
  comparisonsViewFor,
  type ComparisonMatrixRow,
  type ComparisonMetricCell,
  type ComparisonsView,
} from './comparisons-model.ts';
import type { EvalClient } from '../evals/eval-client.ts';
import './comparisons-page.css';

export interface ComparisonControlsProps {
  readonly busy: boolean;
  readonly onCompare: () => void;
  readonly onSelectBase: (runId: string) => void;
  readonly onSelectCandidate: (runId: string) => void;
  readonly view: ComparisonsView;
}

export interface ComparisonMatrixProps {
  readonly view: ComparisonsView;
}

export interface ComparisonsPageProps {
  readonly comparisonClient: ComparisonClient;
  readonly evalClient: EvalClient;
}

const errorMessage = (reason: unknown): string => messageFrom(reason, 'The eval comparison request could not be completed.');

export const loadComparisonRuns = async (
  client: EvalClient,
): Promise<readonly EvalRunRecord[]> => client.runs();

/** The route aligns the two runs, so a mismatch can never be folded into a delta by the page. */
export const runComparison = async (
  client: ComparisonClient,
  base: string,
  candidate: string,
  signal?: AbortSignal,
): Promise<EvalComparison> => client.compare({ base, candidate }, signal);

interface ComparisonRequest {
  readonly comparisonClient: ComparisonClient;
  readonly evalClient: EvalClient;
  readonly generation: number;
  readonly signal: AbortSignal;
}

/** Cancels a replaced comparison immediately and makes every late completion inert. */
export class ComparisonRequestLifecycle {
  #active: { readonly controller: AbortController; readonly request: ComparisonRequest } | undefined;
  #generation = 0;

  begin(comparisonClient: ComparisonClient, evalClient: EvalClient): ComparisonRequest {
    this.#active?.controller.abort();
    const controller = new AbortController();
    const request = Object.freeze({ comparisonClient, evalClient, generation: this.#generation, signal: controller.signal });
    this.#active = { controller, request };
    return request;
  }

  complete(request: ComparisonRequest): void {
    if (this.#active?.request === request) this.#active = undefined;
  }

  invalidate(): void {
    this.#generation += 1;
    this.#active?.controller.abort();
    this.#active = undefined;
  }

  isCurrent(request: ComparisonRequest, comparisonClient: ComparisonClient, evalClient: EvalClient): boolean {
    return request.comparisonClient === comparisonClient && request.evalClient === evalClient &&
      request.generation === this.#generation && !request.signal.aborted && this.#active?.request === request;
  }
}

const MetricCell = ({ cell }: { readonly cell: ComparisonMetricCell | undefined }) => cell === undefined
  ? <td className="comparison-cell"><p className="empty-row">Not recorded in this run.</p></td>
  : <td className="comparison-cell">
    <p className="comparison-cell-head">
      <span className={`comparison-outcome comparison-outcome--${cell.outcome}`}>{cell.outcomeLabel}</span>
      <span className="comparison-k-over-n">{cell.kOverN}</span>
      <span className="comparison-pass-rate">{cell.passRate}</span>
    </p>
    <dl className="comparison-cell-rows">
      <div><dt>pass@k</dt><dd>{cell.passAtK}</dd></div>
      <div><dt>pass^k</dt><dd>{cell.passPowerK}</dd></div>
      <div><dt>Mean duration</dt><dd>{cell.meanDuration}</dd></div>
      <div><dt>Recorded usage</dt><dd>{cell.usage}</dd></div>
      <div><dt>Recorded provenance</dt><dd>{cell.provenance}</dd></div>
    </dl>
    <p className={`comparison-evidence comparison-evidence--${cell.evidence}`}>{cell.evidenceLabel}</p>
  </td>;

const DeltaCell = ({ row }: { readonly row: ComparisonMatrixRow }) => row.delta === undefined
  ? <td className="comparison-cell comparison-cell--non-comparable">
    <p className="comparison-not-comparable">Not comparable</p>
    <dl className="comparison-cell-rows">
      {row.reasons.map((reason) => <div key={reason.code}><dt>{reason.label}</dt><dd>{reason.detail}</dd></div>)}
    </dl>
  </td>
  : <td className="comparison-cell">
    <dl className="comparison-cell-rows">
      <div><dt>Pass rate</dt><dd>{row.delta.passRate}</dd></div>
      <div><dt>Passes</dt><dd>{row.delta.passes}</dd></div>
      <div><dt>pass@k</dt><dd>{row.delta.passAtK}</dd></div>
      <div><dt>pass^k</dt><dd>{row.delta.passPowerK}</dd></div>
      <div><dt>Mean duration</dt><dd>{row.delta.meanDuration}</dd></div>
      <div><dt>Recorded usage</dt><dd>{row.delta.usage}</dd></div>
    </dl>
  </td>;

const rowClassName = (row: ComparisonMatrixRow): string => {
  if (!row.comparable) return 'comparison-row comparison-row--non-comparable';
  return row.evidenceNote === undefined ? 'comparison-row' : 'comparison-row comparison-row--smoke';
};

/** Baseline and candidate run selection for one aligned comparison. */
export const ComparisonControls = ({ busy, onCompare, onSelectBase, onSelectCandidate, view }: ComparisonControlsProps) =>
  <section aria-label="Run comparison" className="comparison-controls">
    <label htmlFor="comparison-base">Baseline run</label>
    <select
      disabled={busy}
      id="comparison-base"
      onChange={(event) => onSelectBase(event.currentTarget.value)}
      value={view.base?.key ?? ''}
    >
      {view.runs.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
    </select>
    <label htmlFor="comparison-candidate">Candidate run</label>
    <select
      disabled={busy}
      id="comparison-candidate"
      onChange={(event) => onSelectCandidate(event.currentTarget.value)}
      value={view.candidate?.key ?? ''}
    >
      {view.runs.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
    </select>
    <div className="comparison-actions">
      <button disabled={busy || view.base === undefined || view.candidate === undefined} onClick={onCompare} type="button">
        Compare runs
      </button>
    </div>
  </section>;

/** One row per condition, with the actual k/n beside pass@k and pass^k, or the reason it is not comparable. */
export const ComparisonMatrix = ({ view }: ComparisonMatrixProps) => <div className="comparison-matrix">
  <p className="comparison-summary" role="status">{view.summary}</p>
  {view.rows.length === 0 ? undefined : <table>
    <thead>
      <tr>
        <th scope="col">Condition</th>
        <th scope="col">Baseline</th>
        <th scope="col">Candidate</th>
        <th scope="col">Delta</th>
      </tr>
    </thead>
    <tbody>
      {view.rows.map((row) => <tr className={rowClassName(row)} key={row.key}>
        <th scope="row">
          <span className="comparison-case">{row.caseId}</span>
          <span className="comparison-condition">{row.host} · {row.model}</span>
          {row.evidenceNote === undefined ? undefined : <span className="comparison-note">{row.evidenceNote}</span>}
        </th>
        <MetricCell cell={row.baseline} />
        <MetricCell cell={row.candidate} />
        <DeltaCell row={row} />
      </tr>)}
    </tbody>
  </table>}
</div>;

/** Aligns two recorded eval runs and shows the reliability matrix of every shared condition. */
export const ComparisonsPage = ({ comparisonClient, evalClient }: ComparisonsPageProps) => {
  const [baseRunId, setBaseRunId] = useState<string>();
  const [busy, setBusy] = useState<ComparisonRequest>();
  const [candidateRunId, setCandidateRunId] = useState<string>();
  const [comparison, setComparison] = useState<{ readonly comparisonClient: ComparisonClient; readonly evalClient: EvalClient; readonly result: EvalComparison }>();
  const [error, setError] = useState<{ readonly comparisonClient: ComparisonClient; readonly evalClient: EvalClient; readonly message: string }>();
  const [runs, setRuns] = useState<readonly EvalRunRecord[]>([]);
  const lifecycle = useRef<ComparisonRequestLifecycle>(new ComparisonRequestLifecycle()).current;
  const currentClients = useRef({ comparisonClient, evalClient });
  if (currentClients.current.comparisonClient !== comparisonClient || currentClients.current.evalClient !== evalClient) {
    currentClients.current = { comparisonClient, evalClient };
    lifecycle.invalidate();
  }
  const currentComparison = comparison?.comparisonClient === comparisonClient && comparison.evalClient === evalClient ? comparison.result : undefined;
  const currentError = error?.comparisonClient === comparisonClient && error.evalClient === evalClient ? error.message : undefined;
  const busyForClient = busy !== undefined && lifecycle.isCurrent(busy, comparisonClient, evalClient);
  const view = comparisonsViewFor({ baseRunId, candidateRunId, comparison: currentComparison, runs });

  useEffect(() => () => lifecycle.invalidate(), [lifecycle]);

  useEffect(() => {
    setBusy(undefined);
    setComparison(undefined);
    setError(undefined);
  }, [comparisonClient, evalClient]);

  useEffect(() => {
    let current = true;
    setError(undefined);
    void loadComparisonRuns(evalClient).then(
      (next) => { if (current) setRuns(next); },
      (reason) => {
        if (!current) return;
        setRuns([]);
        setError({ comparisonClient, evalClient, message: errorMessage(reason) });
      },
    );
    return () => { current = false; };
  }, [evalClient]);

  const compare = async (): Promise<void> => {
    const base = view.base?.key;
    const candidate = view.candidate?.key;
    if (base === undefined || candidate === undefined) return;
    const request = lifecycle.begin(comparisonClient, evalClient);
    setBusy(request);
    setError(undefined);
    setComparison(undefined);
    try {
      const result = await runComparison(comparisonClient, base, candidate, request.signal);
      if (!lifecycle.isCurrent(request, comparisonClient, evalClient)) return;
      setComparison({ comparisonClient, evalClient, result });
    } catch (reason) {
      if (lifecycle.isCurrent(request, comparisonClient, evalClient) && !isAbortError(reason)) {
        setError({ comparisonClient, evalClient, message: errorMessage(reason) });
      }
    } finally {
      if (lifecycle.isCurrent(request, comparisonClient, evalClient)) {
        lifecycle.complete(request);
        setBusy(undefined);
      }
    }
  };

  return <div className="comparisons-content">
    <div className="page-heading comparisons-page-heading">
      <div>
        <h1>Comparisons</h1>
        <p>Aligned baseline and candidate runs, with the actual k/n beside pass@k and pass^k.</p>
      </div>
    </div>
    {currentError === undefined ? undefined : <p className="request-error" role="alert">{currentError}</p>}
    {view.state === 'insufficient-runs'
      ? <p className="empty-row" role="status">{view.summary}</p>
      : <>
        <ComparisonControls
          busy={busyForClient}
          onCompare={() => void compare()}
          onSelectBase={setBaseRunId}
          onSelectCandidate={setCandidateRunId}
          view={view}
        />
        <ComparisonMatrix view={view} />
      </>}
  </div>;
};
