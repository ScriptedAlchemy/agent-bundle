import React, { type ReactNode } from 'react';

import type { ProjectConnectionPhase } from './project-client.ts';

export type WorkbenchPage = 'artifacts' | 'comparisons' | 'evals' | 'hooks' | 'hosts' | 'lifecycles' | 'logs' | 'mcp' | 'overview' | 'playground' | 'routes' | 'skills';

interface NavigationItem {
  readonly glyph: string;
  readonly label: string;
  readonly page: WorkbenchPage;
}

interface NavigationGroup {
  readonly items: readonly NavigationItem[];
  readonly label: string;
}

const navigationGroups: readonly NavigationGroup[] = [
  {
    items: [
      { glyph: '⊞', label: 'Overview', page: 'overview' },
      { glyph: '⌸', label: 'Routes', page: 'routes' },
    ],
    label: 'Build',
  },
  {
    items: [
      { glyph: '⌘', label: 'Skills', page: 'skills' },
      { glyph: '⌥', label: 'Hooks', page: 'hooks' },
      { glyph: '↻', label: 'Lifecycles', page: 'lifecycles' },
      { glyph: '⌂', label: 'Hosts', page: 'hosts' },
      { glyph: '◇', label: 'Playground', page: 'playground' },
      { glyph: '⌁', label: 'MCP playground', page: 'mcp' },
    ],
    label: 'Capabilities',
  },
  {
    items: [
      { glyph: '✓', label: 'Evals', page: 'evals' },
      { glyph: '⇄', label: 'Comparisons', page: 'comparisons' },
    ],
    label: 'Quality',
  },
  {
    items: [
      { glyph: '▤', label: 'Artifacts', page: 'artifacts' },
      { glyph: '≡', label: 'Logs', page: 'logs' },
    ],
    label: 'Inspect',
  },
];

const navigationItems = navigationGroups.flatMap((group) => group.items);

const workbenchPages: ReadonlySet<WorkbenchPage> = new Set(navigationItems.map((item) => item.page));

export const pageForHash = (
  hash = globalThis.window?.location.hash ?? '',
  pages: ReadonlySet<WorkbenchPage> = workbenchPages,
): WorkbenchPage => {
  const page = hash.slice(1);
  return workbenchPages.has(page as WorkbenchPage) && pages.has(page as WorkbenchPage) ? page as WorkbenchPage : 'overview';
};

export const Topbar = ({ connectionError }: { readonly connectionError?: string }) => <header className="topbar">
  <span className="menu-glyph" aria-hidden="true">☰</span>
  <span className="topbar-title">Project workbench</span>
  <span className={`connection${connectionError === undefined ? '' : ' connection--error'}`} role="status">
    <span aria-hidden="true" />{connectionError === undefined ? 'Foreground server connected' : `Foreground server unavailable: ${connectionError}`}
  </span>
</header>;

/** Overlays the Workbench while the foreground connection is not `connected`; `error` is the `connectionFailureText` line. */
export const ConnectionGate = ({ error, state }: {
  readonly error?: string;
  readonly state: Exclude<ProjectConnectionPhase, 'connected'>;
}) => <main aria-live="polite" className="connection-recovery loading-state">
  <h1>{state === 'unavailable' ? 'Foreground connection unavailable' : 'Foreground connection reconnecting'}</h1>
  <p>{state === 'unavailable' ? 'Waiting for the foreground server to recover.' : 'Connecting to the foreground server.'}</p>
  {error === undefined ? undefined : <p role="alert">{error}</p>}
</main>;

export const Navigation = ({ onNavigate, page, pages }: {
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
  readonly pages: ReadonlySet<WorkbenchPage>;
}) => <nav className="rail" aria-label="Workbench navigation">
  <div className="brand">Agent Bundle</div>
  {navigationGroups.map((group) => {
    const items = group.items.filter((item) => pages.has(item.page));
    return items.length === 0 ? undefined : <div className="nav-group" key={group.label}>
      <span className="nav-group-label">{group.label}</span>
      {items.map((item) => (
        <a
          key={item.page}
          aria-current={page === item.page ? 'page' : undefined}
          className={page === item.page ? 'nav-item nav-item--active' : 'nav-item'}
          href={`#${item.page}`}
          onClick={(event) => { event.preventDefault(); onNavigate(item.page); }}
        >
          <span aria-hidden="true" className="nav-glyph">{item.glyph}</span>
          {item.label}
        </a>
      ))}
    </div>;
  })}
</nav>;

export const WorkbenchScreen = ({ children, connectionError, onNavigate, page, pages }: {
  readonly children: ReactNode;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
  readonly pages: ReadonlySet<WorkbenchPage>;
}) => <div className="workbench-shell">
  <Navigation onNavigate={onNavigate} page={page} pages={pages} />
  <main className="canvas" id={page}>
    <Topbar connectionError={connectionError} />
    {children}
  </main>
</div>;
