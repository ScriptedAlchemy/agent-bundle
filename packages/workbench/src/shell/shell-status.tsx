/**
 * The shell header's status cluster (#600): project name · build state and
 * epoch · failure count badge linking to Problems · foreground connection.
 * Also the connection gate that overlays the shell while the foreground is
 * not connected. Presentation only; the models live in build-status-model.ts.
 */
import React from 'react';

import type { ProjectStatus } from '../../../agent-bundle/src/contracts/project.ts';
import type { ProjectConnectionPhase, ProjectConnectionState } from '../project-client.ts';
import { activeEpochFor, buildStatusFor } from './build-status-model.ts';
import { formatWorkbenchLocation, type WorkbenchLocation } from './workbench-location.ts';

const problemsLocation: WorkbenchLocation = Object.freeze({ area: 'problems' });

/** The header's project name: the package name when the project declares one. */
export const projectNameFor = (status: ProjectStatus | undefined): string =>
  status?.source.packageName ?? (status === undefined ? undefined : activeEpochFor(status)?.packageName) ?? 'Agent Bundle project';

export interface BuildStatusText {
  readonly detail?: string;
  readonly label: string;
  readonly tone: 'building' | 'failed' | 'missing' | 'ready' | 'stale';
}

/** One line for the header: what the build is doing, and which epoch hosts see. */
export const buildStatusTextFor = (status: ProjectStatus): BuildStatusText => {
  const model = buildStatusFor(status);
  const epoch = model.epoch.id === undefined ? undefined : `epoch ${model.epoch.id.slice(0, 12)}`;
  switch (model.build) {
    case 'building':
      return Object.freeze({ ...(epoch === undefined ? {} : { detail: epoch }), label: 'Building…', tone: 'building' });
    case 'failed':
      return Object.freeze({ ...(epoch === undefined ? {} : { detail: `${model.epoch.summary.toLowerCase()} · ${epoch}` }), label: 'Build failed', tone: 'failed' });
    case 'idle':
      switch (model.epoch.state) {
        case 'missing':
          return Object.freeze({ label: 'No build yet', tone: 'missing' });
        case 'stale':
          return Object.freeze({ detail: epoch ?? '', label: 'Last good build', tone: 'stale' });
        case 'active':
          return Object.freeze({ detail: epoch ?? '', label: 'Current build', tone: 'ready' });
        default: {
          const exhaustive: never = model.epoch.state;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = model.build;
      return exhaustive;
    }
  }
};

const connectionLabel = (state: ProjectConnectionPhase, error: string | undefined): string => {
  switch (state) {
    case 'connected':
      return 'Foreground server connected';
    case 'connecting':
      return 'Connecting to the foreground server…';
    case 'unavailable':
      return error === undefined ? 'Foreground server unavailable' : `Foreground server unavailable: ${error}`;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

export interface ShellStatusProps {
  readonly connection: ProjectConnectionState;
  readonly connectionError?: string;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  /** Error-severity problems; the badge links to Problems and reads zero as "No problems". */
  readonly problemCount: number;
  readonly status?: ProjectStatus;
}

export const ShellStatus = ({ connection, connectionError, onNavigate, problemCount, status }: ShellStatusProps) => {
  const build = status === undefined ? undefined : buildStatusTextFor(status);
  const connected = connection.state === 'connected';
  return <>
    <span className="shell-project" data-testid="shell-project-name">{projectNameFor(status)}</span>
    <span className={`shell-build shell-build--${build?.tone ?? 'missing'}`} data-testid="shell-build-status" role="status">
      <span aria-hidden="true" className="shell-build-mark" />
      <strong>{build?.label ?? 'Loading project state…'}</strong>
      {build?.detail === undefined || build.detail.length === 0 ? undefined : <span className="shell-build-detail identifier">{build.detail}</span>}
    </span>
    <a
      aria-label={problemCount === 0 ? 'No problems' : `${String(problemCount)} ${problemCount === 1 ? 'problem' : 'problems'}`}
      className={`shell-problems${problemCount === 0 ? '' : ' shell-problems--failing'}`}
      data-testid="problems-badge"
      href={formatWorkbenchLocation(problemsLocation)}
      onClick={(event) => { event.preventDefault(); onNavigate(problemsLocation); }}
    >
      <span className="shell-problems-count">{String(problemCount)}</span>
      {problemCount === 1 ? 'failure' : 'failures'}
    </a>
    <span className={`shell-connection shell-connection--${connection.state}`} data-testid="shell-connection" role="status">
      <span aria-hidden="true" />
      {connectionLabel(connection.state, connected ? undefined : connectionError)}
    </span>
  </>;
};

/** Overlays the Workbench while the foreground connection is not `connected`; `error` is the `projectFailureText` line. */
export const ConnectionGate = ({ error, state }: {
  readonly error?: string;
  readonly state: Exclude<ProjectConnectionPhase, 'connected'>;
}) => <main aria-live="polite" className="connection-recovery loading-state">
  <h1>{state === 'unavailable' ? 'Foreground connection unavailable' : 'Foreground connection reconnecting'}</h1>
  <p>{state === 'unavailable' ? 'Waiting for the foreground server to recover.' : 'Connecting to the foreground server.'}</p>
  {error === undefined ? undefined : <p role="alert">{error}</p>}
</main>;
