import React, { type ReactNode } from 'react';
import { NavLink } from 'react-router';

export type WorkbenchPage = 'artifacts' | 'comparisons' | 'evals' | 'hooks' | 'logs' | 'mcp' | 'overview' | 'playground' | 'skills';

interface NavigationItem {
  readonly glyph: string;
  readonly label: string;
  readonly page: WorkbenchPage;
  readonly path: string;
}

interface NavigationGroup {
  readonly items: readonly NavigationItem[];
  readonly label: string;
}

export const workbenchRoutes: Readonly<Record<WorkbenchPage, NavigationItem>> = Object.freeze({
  artifacts: Object.freeze({ glyph: '▤', label: 'Artifacts', page: 'artifacts', path: '/artifacts' }),
  comparisons: Object.freeze({ glyph: '⇄', label: 'Comparisons', page: 'comparisons', path: '/comparisons' }),
  evals: Object.freeze({ glyph: '✓', label: 'Evals', page: 'evals', path: '/evals' }),
  hooks: Object.freeze({ glyph: '⌥', label: 'Hooks', page: 'hooks', path: '/hooks' }),
  logs: Object.freeze({ glyph: '≡', label: 'Logs', page: 'logs', path: '/logs' }),
  mcp: Object.freeze({ glyph: '⌁', label: 'MCP playground', page: 'mcp', path: '/mcp' }),
  overview: Object.freeze({ glyph: '⊞', label: 'Overview', page: 'overview', path: '/overview' }),
  playground: Object.freeze({ glyph: '◇', label: 'Playground', page: 'playground', path: '/playground' }),
  skills: Object.freeze({ glyph: '⌘', label: 'Skills', page: 'skills', path: '/skills' }),
});

const navigationGroups: readonly NavigationGroup[] = [
  { items: [workbenchRoutes.overview], label: 'Build' },
  {
    items: [
      workbenchRoutes.skills,
      workbenchRoutes.hooks,
      workbenchRoutes.playground,
      workbenchRoutes.mcp,
    ],
    label: 'Capabilities',
  },
  {
    items: [
      workbenchRoutes.evals,
      workbenchRoutes.comparisons,
    ],
    label: 'Quality',
  },
  {
    items: [
      workbenchRoutes.artifacts,
      workbenchRoutes.logs,
    ],
    label: 'Inspect',
  },
];

export const workbenchRouteEntries = Object.freeze(Object.values(workbenchRoutes));
export const workbenchPages: ReadonlySet<WorkbenchPage> = new Set(workbenchRouteEntries.map((route) => route.page));

export const workbenchPathFor = (page: WorkbenchPage): string => workbenchRoutes[page].path;

export const legacyPathForHash = (hash: string): string | undefined => {
  if (hash.length <= 1 || hash.startsWith('#/')) return undefined;
  const page = hash.slice(1);
  return Object.hasOwn(workbenchRoutes, page) ? workbenchPathFor(page as WorkbenchPage) : workbenchPathFor('overview');
};

export const Topbar = ({ connectionError }: { readonly connectionError?: string }) => <header className="topbar">
  <span className="menu-glyph" aria-hidden="true">☰</span>
  <span className="topbar-title">Project workbench</span>
  <span className={`connection${connectionError === undefined ? '' : ' connection--error'}`} role="status">
    <span aria-hidden="true" />{connectionError === undefined ? 'Foreground server connected' : `Foreground server unavailable: ${connectionError}`}
  </span>
</header>;

export const Navigation = ({ pages }: {
  readonly pages: ReadonlySet<WorkbenchPage>;
}) => <nav className="rail" aria-label="Workbench navigation">
  <div className="brand">Agent Bundle</div>
  {navigationGroups.map((group) => {
    const items = group.items.filter((item) => pages.has(item.page));
    return items.length === 0 ? undefined : <div className="nav-group" key={group.label}>
      <span className="nav-group-label">{group.label}</span>
      {items.map((item) => (
        <NavLink
          key={item.page}
          className={({ isActive }) => isActive ? 'nav-item nav-item--active' : 'nav-item'}
          to={item.path}
        >
          <span aria-hidden="true" className="nav-glyph">{item.glyph}</span>
          {item.label}
        </NavLink>
      ))}
    </div>;
  })}
</nav>;

export const WorkbenchScreen = ({ children, connectionError, page, pages }: {
  readonly children: ReactNode;
  readonly connectionError?: string;
  readonly page: WorkbenchPage;
  readonly pages: ReadonlySet<WorkbenchPage>;
}) => <div className="workbench-shell">
    <Navigation pages={pages} />
    <main className="canvas" id={page}>
      <Topbar connectionError={connectionError} />
      {children}
    </main>
  </div>;
