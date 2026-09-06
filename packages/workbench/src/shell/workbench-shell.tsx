import React, { type ReactNode } from 'react';

import type { ProjectStatus } from '../../../agent-bundle/src/contracts/project.ts';
import type { ApplicationTree } from '../application/application-tree-model.ts';
import type { ProjectConnectionState } from '../project-client.ts';
import type { Problem } from './build-status-model.ts';
import { ShellStatus } from './shell-status.tsx';
import { formatWorkbenchLocation, type WorkbenchArea, type WorkbenchLocation } from './workbench-location.ts';

import './shell.css';

export interface WorkbenchNavItem {
  readonly area: WorkbenchArea;
  readonly glyph: string;
  readonly label: string;
  readonly location: WorkbenchLocation;
}

/** Primary destinations in rail order. */
export const workbenchNavItems: readonly WorkbenchNavItem[] = Object.freeze([
  Object.freeze({ area: 'application' as const, glyph: '⌸', label: 'Application', location: Object.freeze({ area: 'application' as const }) }),
  Object.freeze({ area: 'trace' as const, glyph: '≡', label: 'Trace', location: Object.freeze({ area: 'trace' as const }) }),
  Object.freeze({ area: 'sessions' as const, glyph: '▣', label: 'Host sessions', location: Object.freeze({ area: 'sessions' as const }) }),
  Object.freeze({ area: 'problems' as const, glyph: '!', label: 'Problems', location: Object.freeze({ area: 'problems' as const }) }),
  Object.freeze({ area: 'advanced' as const, glyph: '⚙', label: 'Advanced', location: Object.freeze({ area: 'advanced' as const, section: 'evals' as const }) }),
]);

export interface WorkbenchShellProps {
  readonly children: ReactNode;
  readonly connection: ProjectConnectionState;
  readonly connectionError?: string;
  /** Extra header content after the status cluster (for example a runtime capability notice). */
  readonly header?: ReactNode;
  readonly location: WorkbenchLocation;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  /** The aggregated problems; the header badge counts the error-severity ones. */
  readonly problems: readonly Problem[];
  readonly status?: ProjectStatus;
  /** The application tree, for the Application item's leaf count. */
  readonly tree?: ApplicationTree;
}

export const WorkbenchShell = ({ children, connection, connectionError, header, location, onNavigate, problems, status, tree }: WorkbenchShellProps) => {
  const failures = problems.filter((problem) => problem.severity === 'error').length;
  return <div className="workbench-shell" data-workbench-area={location.area}>
    <nav aria-label="Workbench navigation" className="rail" data-testid="workbench-nav">
      <div className="brand">Agent Bundle</div>
      {workbenchNavItems.map((item) => {
        const active = item.area === location.area;
        const count = item.area === 'application' ? tree?.leafCount : item.area === 'problems' && failures > 0 ? failures : undefined;
        return <a
          key={item.area}
          aria-current={active ? 'page' : undefined}
          className={active ? 'nav-item nav-item--active' : 'nav-item'}
          data-area={item.area}
          href={formatWorkbenchLocation(item.location)}
          onClick={(event) => { event.preventDefault(); onNavigate(item.location); }}
        >
          <span aria-hidden="true" className="nav-glyph">{item.glyph}</span>
          <span className="nav-label">{item.label}</span>
          {count === undefined ? undefined : <span className={`nav-count${item.area === 'problems' ? ' nav-count--failing' : ''}`}>{String(count)}</span>}
        </a>;
      })}
    </nav>
    <div className="canvas">
      <header className="topbar">
        <ShellStatus connection={connection} connectionError={connectionError} onNavigate={onNavigate} problemCount={failures} status={status} />
        {header}
      </header>
      <div className="area" data-testid={`workbench-area-${location.area}`}>{children}</div>
    </div>
  </div>;
};

/** The Application area: the tree column beside the workspace. */
export const ApplicationArea = ({ children, tree }: { readonly children: ReactNode; readonly tree: ReactNode }) =>
  <div className="application-area">
    <aside aria-label="Application tree" className="application-tree-column">{tree}</aside>
    <section aria-label="Route workspace" className="application-workspace">{children}</section>
  </div>;

/** The workspace before a leaf is selected. */
export const SelectRouteState = ({ tree }: { readonly tree?: ApplicationTree }) =>
  <main className="workspace-empty" data-testid="workspace-empty">
    <h1>Select a route</h1>
    <p>
      {tree === undefined || tree.leafCount === 0
        ? 'The compiled application graph declares no routes yet. Add a route module and the tree fills in as the dev server rebuilds.'
        : `Choose one of the ${String(tree.leafCount)} application routes on the left to edit its input, run it, and see the rendered Agent Document.`}
    </p>
  </main>;

/** A deep link whose node the compiled catalog does not contain. */
export const UnknownRouteState = ({ onNavigate, path }: { readonly onNavigate: (location: WorkbenchLocation) => void; readonly path: string }) => {
  const root: WorkbenchLocation = Object.freeze({ area: 'application' });
  return <main className="workspace-empty" data-testid="unknown-route">
    <h1>This route is not in the compiled catalog</h1>
    <p><code className="identifier">{path}</code> names no route of the published build. It may have been renamed or removed, or the build that declares it has not published yet.</p>
    <a href={formatWorkbenchLocation(root)} onClick={(event) => { event.preventDefault(); onNavigate(root); }}>Back to the application tree</a>
  </main>;
};
