/**
 * The Workbench's URL model (#600 §10). Every primary destination and every
 * application leaf is addressable: refresh preserves context, diagnostics and
 * trace entries deep-link, browser history works, and tests address a route
 * deterministically. Hash-only page routing (`#hooks`, `#mcp`) is gone.
 *
 *   /                                   Application (no selection)
 *   /routes/…                           One application leaf (see application-node.ts)
 *   /trace  ·  /trace/<entryId>         Live trace, one selected entry
 *   /problems                           Diagnostics
 *   /sessions  ·  /sessions/<host>      Embedded host sessions (PR 3)
 *   /advanced/<section>                 evals | artifact | protocol | hosts | logs
 *
 * `?invocation=<id>` on a route path opens that route with the named
 * invocation snapshot loaded; `?tab=<tab>` selects a workspace tab.
 * `?correlation=<id>` on `/trace` selects the correlated group holding any
 * entry that carries that id.
 */
import {
  type ApplicationNodeRef,
  applicationNodePath,
  applicationNodeRefForPathSegments,
  isWorkbenchShellPath,
} from '../../../agent-bundle/src/contracts/workbench-shell.ts';

export type {
  ApplicationMcpNodeKind,
  ApplicationNodeKind,
  ApplicationNodeRef,
} from '../../../agent-bundle/src/contracts/workbench-shell.ts';
export {
  applicationNodeKey,
  applicationNodePath,
  applicationNodeRefForRouteId,
  routeIdForApplicationNodeRef,
  sameApplicationNodeRef,
} from '../../../agent-bundle/src/contracts/workbench-shell.ts';
export { isWorkbenchShellPath };

export type AdvancedSection = 'artifact' | 'evals' | 'hosts' | 'logs' | 'protocol';

export const advancedSections: readonly AdvancedSection[] = Object.freeze(['evals', 'artifact', 'protocol', 'hosts', 'logs']);

export type WorkbenchArea = 'advanced' | 'application' | 'problems' | 'sessions' | 'trace';

export type WorkbenchLocation =
  | Readonly<{ readonly area: 'application'; readonly invocationId?: string; readonly node?: ApplicationNodeRef; readonly tab?: string }>
  /** `invocationId` is the selected trace entry id (`/trace/<id>`); the name predates the unified trace and still accepts an `inv_…` id. */
  | Readonly<{ readonly area: 'trace'; readonly correlation?: string; readonly invocationId?: string }>
  | Readonly<{ readonly area: 'problems' }>
  | Readonly<{ readonly area: 'sessions'; readonly host?: string }>
  | Readonly<{ readonly area: 'advanced'; readonly section: AdvancedSection }>;

const segment = (value: string): string => encodeURIComponent(value);

const decode = (value: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length === 0 || decoded.includes('\0') ? undefined : decoded;
  } catch {
    return undefined;
  }
};

const nonempty = (value: string | null): string | undefined =>
  value === null || value.length === 0 || value.includes('\0') ? undefined : value;

const isAdvancedSection = (value: string): value is AdvancedSection => (advancedSections as readonly string[]).includes(value);

const applicationRoot: WorkbenchLocation = Object.freeze({ area: 'application' });

/**
 * Parses a pathname plus search into a location. Unknown paths resolve to the
 * Application root rather than throwing: a stale deep link must land the user
 * somewhere useful, and the shell reports the unknown path separately.
 */
export const parseWorkbenchLocation = (pathname: string, search = ''): WorkbenchLocation => {
  const segments = pathname.split('/').filter((part) => part.length > 0);
  const query = new URLSearchParams(search);
  const invocationId = query.get('invocation') ?? undefined;
  const tab = query.get('tab') ?? undefined;
  const correlation = nonempty(query.get('correlation'));
  const [area, ...rest] = segments;
  switch (area) {
    case undefined:
      return applicationRoot;
    case 'routes': {
      const node = applicationNodeRefForPathSegments(rest);
      if (node === undefined) return applicationRoot;
      return Object.freeze({
        area: 'application',
        ...(invocationId === undefined ? {} : { invocationId }),
        node,
        ...(tab === undefined ? {} : { tab }),
      });
    }
    case 'trace': {
      const id = rest.length === 1 ? decode(rest[0]!) : undefined;
      return Object.freeze({
        area: 'trace',
        ...(correlation === undefined ? {} : { correlation }),
        ...(id === undefined ? {} : { invocationId: id }),
      });
    }
    case 'problems':
      return Object.freeze({ area: 'problems' });
    case 'sessions': {
      const host = rest.length === 1 ? decode(rest[0]!) : undefined;
      return Object.freeze({ area: 'sessions', ...(host === undefined ? {} : { host }) });
    }
    case 'advanced': {
      const section = rest[0];
      return Object.freeze({ area: 'advanced', section: section !== undefined && rest.length === 1 && isAdvancedSection(section) ? section : 'evals' });
    }
    default:
      return applicationRoot;
  }
};

/** Formats a location as `pathname` + `search`; the inverse of {@link parseWorkbenchLocation}. */
export const formatWorkbenchLocation = (location: WorkbenchLocation): string => {
  switch (location.area) {
    case 'application': {
      if (location.node === undefined) return '/';
      const query = new URLSearchParams();
      if (location.invocationId !== undefined) query.set('invocation', location.invocationId);
      if (location.tab !== undefined) query.set('tab', location.tab);
      const search = query.toString();
      return `${applicationNodePath(location.node)}${search.length === 0 ? '' : `?${search}`}`;
    }
    case 'trace': {
      const path = location.invocationId === undefined ? '/trace' : `/trace/${segment(location.invocationId)}`;
      return location.correlation === undefined ? path : `${path}?correlation=${segment(location.correlation)}`;
    }
    case 'problems':
      return '/problems';
    case 'sessions':
      return location.host === undefined ? '/sessions' : `/sessions/${segment(location.host)}`;
    case 'advanced':
      return `/advanced/${location.section}`;
    default: {
      const exhaustive: never = location;
      return exhaustive;
    }
  }
};

export const sameWorkbenchLocation = (left: WorkbenchLocation, right: WorkbenchLocation): boolean =>
  formatWorkbenchLocation(left) === formatWorkbenchLocation(right);
