/**
 * The Workbench's URL model (#600 §10). Every primary destination and every
 * application leaf is addressable: refresh preserves context, diagnostics and
 * trace entries deep-link, browser history works, and tests address a route
 * deterministically. Hash-only page routing (`#hooks`, `#mcp`) is gone.
 *
 *   /                                   Application (no selection)
 *   /routes/mcp/<server>/tool/<name>    MCP tool  — also resource | prompt | app
 *   /routes/events/<event…>             Event route, e.g. /routes/events/tool/before
 *   /routes/cli/<path…>                 CLI route, e.g. /routes/cli/audible/search
 *   /routes/scripts/<name…>             Script
 *   /routes/skills/<id…>                Skill
 *   /routes/commands/<id…>              Host command (Rules / Commands group)
 *   /routes/rules/<id…>                 Host rule
 *   /trace  ·  /trace/<invocationId>    Live trace, one entry
 *   /problems                           Diagnostics
 *   /sessions  ·  /sessions/<host>      Embedded host sessions (PR 3)
 *   /advanced/<section>                 evals | artifact | protocol | hosts | logs
 *
 * `?invocation=<id>` on a route path opens that route with the named
 * invocation snapshot loaded; `?tab=<tab>` selects a workspace tab.
 */
import { isWorkbenchShellPath } from '../../../agent-bundle/src/dev/workbench-shell-paths.ts';

export type ApplicationMcpNodeKind = 'app' | 'prompt' | 'resource' | 'tool';

/** One addressable application leaf, as the URL and the tree both name it. */
export type ApplicationNodeRef =
  | Readonly<{ readonly kind: ApplicationMcpNodeKind; readonly name: string; readonly server: string }>
  | Readonly<{ readonly event: string; readonly kind: 'event' }>
  | Readonly<{ readonly kind: 'cli'; readonly path: readonly string[] }>
  | Readonly<{ readonly kind: 'script'; readonly name: string }>
  | Readonly<{ readonly id: string; readonly kind: 'skill' }>
  | Readonly<{ readonly id: string; readonly kind: 'command' }>
  | Readonly<{ readonly id: string; readonly kind: 'rule' }>;

export type AdvancedSection = 'artifact' | 'evals' | 'hosts' | 'logs' | 'protocol';

export const advancedSections: readonly AdvancedSection[] = Object.freeze(['evals', 'artifact', 'protocol', 'hosts', 'logs']);

export type WorkbenchArea = 'advanced' | 'application' | 'problems' | 'sessions' | 'trace';

export type WorkbenchLocation =
  | Readonly<{ readonly area: 'application'; readonly invocationId?: string; readonly node?: ApplicationNodeRef; readonly tab?: string }>
  | Readonly<{ readonly area: 'trace'; readonly invocationId?: string }>
  | Readonly<{ readonly area: 'problems' }>
  | Readonly<{ readonly area: 'sessions'; readonly host?: string }>
  | Readonly<{ readonly area: 'advanced'; readonly section: AdvancedSection }>;

const mcpKinds: ReadonlySet<string> = new Set<ApplicationMcpNodeKind>(['app', 'prompt', 'resource', 'tool']);

const segment = (value: string): string => encodeURIComponent(value);

const decode = (value: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length === 0 || decoded.includes('\0') ? undefined : decoded;
  } catch {
    return undefined;
  }
};

const decodeAll = (values: readonly string[]): readonly string[] | undefined => {
  const decoded = values.map(decode);
  return decoded.length === 0 || decoded.some((value) => value === undefined)
    ? undefined
    : Object.freeze(decoded as string[]);
};

/** Compiled route id (`tool:curator/search_audible`, `event:tool/before`, `cli:audible/search`, `script:sync`) → node reference. */
export const applicationNodeRefForRouteId = (routeId: string): ApplicationNodeRef | undefined => {
  const colon = routeId.indexOf(':');
  if (colon <= 0 || colon === routeId.length - 1) return undefined;
  const kind = routeId.slice(0, colon);
  const rest = routeId.slice(colon + 1);
  if (mcpKinds.has(kind)) {
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return undefined;
    return Object.freeze({ kind: kind as ApplicationMcpNodeKind, name: rest.slice(slash + 1), server: rest.slice(0, slash) });
  }
  switch (kind) {
    case 'event':
      return Object.freeze({ event: rest, kind: 'event' });
    case 'cli':
      return Object.freeze({ kind: 'cli', path: Object.freeze(rest.split('/')) });
    case 'script':
      return Object.freeze({ kind: 'script', name: rest });
    default:
      return undefined;
  }
};

/** Node reference → compiled route id, for the kinds the route manifest compiles; skills, commands, and rules have no route id. */
export const routeIdForApplicationNodeRef = (node: ApplicationNodeRef): string | undefined => {
  switch (node.kind) {
    case 'app':
    case 'prompt':
    case 'resource':
    case 'tool':
      return `${node.kind}:${node.server}/${node.name}`;
    case 'event':
      return `event:${node.event}`;
    case 'cli':
      return `cli:${node.path.join('/')}`;
    case 'script':
      return `script:${node.name}`;
    case 'skill':
    case 'command':
    case 'rule':
      return undefined;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

export const applicationNodePath = (node: ApplicationNodeRef): string => {
  switch (node.kind) {
    case 'app':
    case 'prompt':
    case 'resource':
    case 'tool':
      return `/routes/mcp/${segment(node.server)}/${node.kind}/${segment(node.name)}`;
    case 'event':
      return `/routes/events/${node.event.split('/').map(segment).join('/')}`;
    case 'cli':
      return `/routes/cli/${node.path.map(segment).join('/')}`;
    case 'script':
      return `/routes/scripts/${node.name.split('/').map(segment).join('/')}`;
    case 'skill':
      return `/routes/skills/${node.id.split('/').map(segment).join('/')}`;
    case 'command':
      return `/routes/commands/${node.id.split('/').map(segment).join('/')}`;
    case 'rule':
      return `/routes/rules/${node.id.split('/').map(segment).join('/')}`;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

/** A stable key for selection state and React keys: the URL path of the node. */
export const applicationNodeKey = (node: ApplicationNodeRef): string => applicationNodePath(node);

export const sameApplicationNodeRef = (left: ApplicationNodeRef | undefined, right: ApplicationNodeRef | undefined): boolean =>
  left === right || (left !== undefined && right !== undefined && applicationNodeKey(left) === applicationNodeKey(right));

const applicationNodeFromSegments = (segments: readonly string[]): ApplicationNodeRef | undefined => {
  const [group, ...rest] = segments;
  switch (group) {
    case 'mcp': {
      const [server, kind, ...name] = rest;
      if (server === undefined || kind === undefined || !mcpKinds.has(kind) || name.length !== 1) return undefined;
      const decodedServer = decode(server);
      const decodedName = decode(name[0]!);
      return decodedServer === undefined || decodedName === undefined
        ? undefined
        : Object.freeze({ kind: kind as ApplicationMcpNodeKind, name: decodedName, server: decodedServer });
    }
    case 'events': {
      const event = decodeAll(rest);
      return event === undefined ? undefined : Object.freeze({ event: event.join('/'), kind: 'event' });
    }
    case 'cli': {
      const path = decodeAll(rest);
      return path === undefined ? undefined : Object.freeze({ kind: 'cli', path });
    }
    case 'scripts': {
      const name = decodeAll(rest);
      return name === undefined ? undefined : Object.freeze({ kind: 'script', name: name.join('/') });
    }
    case 'skills': {
      const id = decodeAll(rest);
      return id === undefined ? undefined : Object.freeze({ id: id.join('/'), kind: 'skill' });
    }
    case 'commands': {
      const id = decodeAll(rest);
      return id === undefined ? undefined : Object.freeze({ id: id.join('/'), kind: 'command' });
    }
    case 'rules': {
      const id = decodeAll(rest);
      return id === undefined ? undefined : Object.freeze({ id: id.join('/'), kind: 'rule' });
    }
    default:
      return undefined;
  }
};

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
  const [area, ...rest] = segments;
  switch (area) {
    case undefined:
      return applicationRoot;
    case 'routes': {
      const node = applicationNodeFromSegments(rest);
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
      return Object.freeze({ area: 'trace', ...(id === undefined ? {} : { invocationId: id }) });
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
    case 'trace':
      return location.invocationId === undefined ? '/trace' : `/trace/${segment(location.invocationId)}`;
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

export { isWorkbenchShellPath };
