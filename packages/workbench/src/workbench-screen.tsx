import type { ReactNode } from 'react';

export type WorkbenchPage = 'artifacts' | 'comparisons' | 'evals' | 'hooks' | 'logs' | 'mcp' | 'overview' | 'playground' | 'skills';

const navigationItems: readonly Readonly<{ glyph: string; label: string; page: WorkbenchPage }>[] = [
  { glyph: '⊞', label: 'Overview', page: 'overview' },
  { glyph: '⌘', label: 'Skills', page: 'skills' },
  { glyph: '⌥', label: 'Hooks', page: 'hooks' },
  { glyph: '⌁', label: 'MCP playground', page: 'mcp' },
  { glyph: '▤', label: 'Artifacts', page: 'artifacts' },
  { glyph: '◇', label: 'Playground', page: 'playground' },
  { glyph: '≡', label: 'Logs', page: 'logs' },
  { glyph: '✓', label: 'Evals', page: 'evals' },
  { glyph: '⇄', label: 'Comparisons', page: 'comparisons' },
];

const workbenchPages: ReadonlySet<string> = new Set(navigationItems.map((item) => item.page));

export const pageForHash = (): WorkbenchPage => {
  const page = window.location.hash.slice(1);
  return workbenchPages.has(page) ? page as WorkbenchPage : 'overview';
};

export const Topbar = ({ connectionError }: { readonly connectionError?: string }) => <header className="topbar">
  <span className="menu-glyph" aria-hidden="true">☰</span>
  <span className="topbar-title">Project workbench</span>
  <span className={`connection${connectionError === undefined ? '' : ' connection--error'}`} role="status">
    <span aria-hidden="true" />{connectionError === undefined ? 'Foreground server connected' : `Foreground server unavailable: ${connectionError}`}
  </span>
</header>;

export const Navigation = ({ onNavigate, page }: {
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
}) => <nav className="rail" aria-label="Workbench navigation">
  <div className="brand">Agent Bundle</div>
  {navigationItems.map((item) => (
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
</nav>;

export const WorkbenchScreen = ({ children, connectionError, onNavigate, page }: {
  readonly children: ReactNode;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly page: WorkbenchPage;
}) => <div className="workbench-shell">
  <Navigation onNavigate={onNavigate} page={page} />
  <main className="canvas" id={page}>
    <Topbar connectionError={connectionError} />
    {children}
  </main>
</div>;
