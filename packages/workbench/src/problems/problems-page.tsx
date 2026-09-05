/**
 * Problems (#600): every diagnostic the shell knows about — source
 * normalization, the latest build, the contract gate, route-catalog
 * freshness, host attach, the runtime provider — as one list. Rows that name
 * a compiled route deep-link to its workspace. The documented
 * stale-diagnostic → Repair flow (a rebuild through `POST /api/project/rebuild`)
 * lives here and is reachable from the header badge.
 */
import React, { useState } from 'react';

import type { ProjectStatus } from '../../../agent-bundle/src/contracts/project.ts';
import { projectFailureText } from '../project-client.ts';
import { buildStatusFor, type BuildStatusModel, type Problem, type ProblemSource, staleCatalogMessage } from '../shell/build-status-model.ts';
import { applicationNodePath, formatWorkbenchLocation, type WorkbenchLocation } from '../shell/workbench-location.ts';

export interface ProblemsPageProps {
  readonly onNavigate: (location: WorkbenchLocation) => void;
  /** Runs the repair (a rebuild) and resolves once the project status reflects it; rejections are shown inline. */
  readonly onRepair: () => Promise<void>;
  readonly problems: readonly Problem[];
  readonly status: ProjectStatus;
}

const sourceLabels: Readonly<Record<ProblemSource, string>> = Object.freeze({
  build: 'Build',
  'contract-gate': 'Contract gate',
  'host-attach': 'Host attach',
  'route-catalog': 'Route catalog',
  runtime: 'Runtime',
  source: 'Source',
});

const problemKey = (problem: Problem, index: number): string =>
  `${problem.source}-${problem.code ?? ''}-${String(index)}`;

const staleBannerFor = (model: BuildStatusModel, problems: readonly Problem[]): string | undefined => {
  if (model.build === 'failed') {
    return 'The latest build failed and published no new epoch; Application keeps the last good build until a rebuild succeeds.';
  }
  if (model.epoch.state === 'stale' || problems.some((problem) => problem.source === 'route-catalog' && problem.repairable)) {
    return staleCatalogMessage;
  }
  return undefined;
};

export const ProblemsPage = ({ onNavigate, onRepair, problems, status }: ProblemsPageProps) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const model = buildStatusFor(status);
  const repairable = problems.some((problem) => problem.repairable);
  const staleBanner = staleBannerFor(model, problems);

  const repair = async (): Promise<void> => {
    setError(undefined);
    setBusy(true);
    try {
      await onRepair();
    } catch (reason) {
      setError(projectFailureText(reason, 'Rebuild request could not be completed.'));
    } finally {
      setBusy(false);
    }
  };

  return <main className="shell-page problems-page">
    <div className="shell-page-heading">
      <div>
        <h1>Problems ({problems.length})</h1>
        <p data-testid="problems-summary">{model.nextAction.summary}</p>
      </div>
      <div className="shell-actions">
        <button data-testid="problems-repair" disabled={busy} onClick={() => void repair()} type="button">
          {busy ? 'Repairing…' : repairable ? 'Repair' : 'Rebuild'}
        </button>
      </div>
    </div>
    {staleBanner === undefined ? undefined : <p className="problems-banner" data-testid="problems-banner" role="status">{staleBanner}</p>}
    {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
    {problems.length === 0
      ? <p className="empty-row" data-testid="problems-empty">No source, build, contract-gate, route-catalog, or host problems.</p>
      : <div className="table-wrap problem-list"><table>
        <thead><tr><th>Severity</th><th>Code</th><th>Message</th><th>Source</th><th>Route</th></tr></thead>
        <tbody>{problems.map((problem, index) => {
          const location: WorkbenchLocation | undefined = problem.node === undefined ? undefined : Object.freeze({ area: 'application', node: problem.node });
          return <tr data-problem-source={problem.source} key={problemKey(problem, index)}>
            <td><span className={`severity severity--${problem.severity}`}>{problem.severity}</span></td>
            <td className="identifier">{problem.code ?? '—'}</td>
            <td>
              {problem.message}
              {problem.recovery === undefined ? undefined : <span className="problem-recovery">{problem.recovery}</span>}
            </td>
            <td>
              <span className="problem-source">{sourceLabels[problem.source]}</span>
              {problem.location === undefined ? undefined : <span className="identifier problem-location"> {problem.location}</span>}
            </td>
            <td>
              {location === undefined || problem.node === undefined ? '—' : <a
                className="problem-link identifier"
                href={formatWorkbenchLocation(location)}
                onClick={(event) => { event.preventDefault(); onNavigate(location); }}
              >{applicationNodePath(problem.node)}</a>}
            </td>
          </tr>;
        })}</tbody>
      </table></div>}
  </main>;
};
