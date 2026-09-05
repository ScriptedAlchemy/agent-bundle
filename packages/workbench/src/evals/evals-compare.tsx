import { isAbortError, errorMessage as messageFrom } from '../client-helpers.ts';
import React, { useEffect, useRef, useState } from 'react';

import type { EvalComparison, EvalRunRecord } from '../../../agent-bundle/src/contracts/eval.ts';
import type { ComparisonClient } from './comparison-client.ts';
import {
  comparisonsViewFor,
  type ComparisonMatrixRow,
  type ComparisonMetricCell,
  type ComparisonsView,
} from './evals-compare-model.ts';
import type { EvalClient } from './eval-client.ts';
import './evals-compare.css';

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

export interface EvalsCompareProps {
  readonly comparisonClient: ComparisonClient;
  readonly evalClient: EvalClient;
}

const errorMessage = (reason: unknown): string => messageFrom(reason, 'The eval comparison request could not be completed.');

export const loadComparisonRuns = async (
  client: EvalClient,
  signal?: AbortSignal,
): Promise<readonly EvalRunRecord[]> => client.runs(signal);

/** The route aligns the two runs, so a mismatch can never be folded into a delta by the page. */
export const runComparison = async (
  client: ComparisonClient,
  base: string,
  candidate: string,
  signal?: AbortSignal,
): Promise<EvalComparison> => client.compare({ base, candidate }, signal);

type ComparisonsRequestKind = 'comparison' | 'runs';

interface ComparisonsRequestOwner {
  readonly comparisonClient: ComparisonClient;
  readonly evalClient: EvalClient;
}

export interface ComparisonsRequest {
  readonly generation: number;
  readonly kind: ComparisonsRequestKind;
  readonly owner?: ComparisonsRequestOwner;
  readonly signal: AbortSignal;
}

/** Owns request cancellation so a departed comparison cannot publish stale evidence. */
export class ComparisonsRequestLifecycle {
  readonly #active = new Map<ComparisonsRequestKind, { readonly controller: AbortController; readonly request: ComparisonsRequest }>();
  #generation = 0;

  begin(kind: ComparisonsRequestKind, owner?: ComparisonsRequestOwner): ComparisonsRequest {
    this.#active.get(kind)?.controller.abort();
    const controller = new AbortController();
    const request = Object.freeze({ generation: this.#generation, kind, owner, signal: controller.signal });
    this.#active.set(kind, { controller, request });
    return request;
  }

  complete(request: ComparisonsRequest): void {
    if (this.#active.get(request.kind)?.request === request) this.#active.delete(request.kind);
  }

  invalidate(): void {
    this.#generation += 1;
    for (const { controller } of this.#active.values()) controller.abort();
    this.#active.clear();
  }

  isCurrent(request: ComparisonsRequest, owner?: ComparisonsRequestOwner): boolean {
    return request.generation === this.#generation &&
      !request.signal.aborted &&
      this.#active.get(request.kind)?.request === request &&
      (owner === undefined || request.owner?.comparisonClient === owner.comparisonClient && request.owner.evalClient === owner.evalClient);
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
export const EvalsCompare = ({ comparisonClient, evalClient }: EvalsCompareProps) => {
  const [baseRunId, setBaseRunId] = useState<string>();
  const [busy, setBusy] = useState<ComparisonsRequest>();
  const [candidateRunId, setCandidateRunId] = useState<string>();
  const [comparison, setComparison] = useState<{ readonly comparisonClient: ComparisonClient; readonly evalClient: EvalClient; readonly result: EvalComparison }>();
  const [error, setError] = useState<{ readonly comparisonClient: ComparisonClient; readonly evalClient: EvalClient; readonly message: string }>();
  const [runs, setRuns] = useState<{ readonly evalClient: EvalClient; readonly records: readonly EvalRunRecord[] }>();
  const lifecycle = useRef<ComparisonsRequestLifecycle>(new ComparisonsRequestLifecycle()).current;
  const currentClients = useRef({ comparisonClient, evalClient });
  if (currentClients.current.comparisonClient !== comparisonClient || currentClients.current.evalClient !== evalClient) {
    currentClients.current = { comparisonClient, evalClient };
    lifecycle.invalidate();
  }
  const currentComparison = comparison?.comparisonClient === comparisonClient && comparison.evalClient === evalClient ? comparison.result : undefined;
  const currentError = error?.comparisonClient === comparisonClient && error.evalClient === evalClient ? error.message : undefined;
  const currentRuns = runs?.evalClient === evalClient ? runs.records : [];
  const currentOwner = { comparisonClient, evalClient };
  const busyForClient = busy !== undefined && lifecycle.isCurrent(busy, currentOwner);
  const view = comparisonsViewFor({ baseRunId, candidateRunId, comparison: currentComparison, runs: currentRuns });

  useEffect(() => () => lifecycle.invalidate(), [lifecycle]);

  useEffect(() => {
    setBusy(undefined);
    setComparison(undefined);
    setError(undefined);
  }, [comparisonClient, evalClient]);

  useEffect(() => {
    lifecycle.invalidate();
    const owner = { comparisonClient, evalClient };
    const request = lifecycle.begin('runs', owner);
    setError(undefined);
    void loadComparisonRuns(evalClient, request.signal).then(
      (next) => {
        if (!lifecycle.isCurrent(request, owner)) return;
        lifecycle.complete(request);
        setRuns({ evalClient, records: next });
      },
      (reason) => {
        if (!lifecycle.isCurrent(request, owner)) return;
        lifecycle.complete(request);
        setRuns(undefined);
        setError({ comparisonClient, evalClient, message: errorMessage(reason) });
      },
    );
    return () => lifecycle.invalidate();
  }, [comparisonClient, evalClient, lifecycle]);

  const compare = async (): Promise<void> => {
    const base = view.base?.key;
    const candidate = view.candidate?.key;
    if (base === undefined || candidate === undefined) return;
    const owner = { comparisonClient, evalClient };
    const request = lifecycle.begin('comparison', owner);
    setBusy(request);
    setError(undefined);
    setComparison(undefined);
    try {
      const result = await runComparison(comparisonClient, base, candidate, request.signal);
      if (!lifecycle.isCurrent(request, owner)) return;
      setComparison({ comparisonClient, evalClient, result });
    } catch (reason) {
      if (lifecycle.isCurrent(request, owner) && !isAbortError(reason)) {
        setError({ comparisonClient, evalClient, message: errorMessage(reason) });
      }
    } finally {
      if (lifecycle.isCurrent(request, owner)) {
        lifecycle.complete(request);
        setBusy(undefined);
      }
    }
  };

  return <div className="comparisons-content">
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
