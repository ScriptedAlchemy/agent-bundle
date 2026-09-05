/**
 * One addressable application leaf (#600): the identity the Workbench URL, the
 * application tree, and the `agent-bundle/test` Workbench-surface proof all
 * share. Pure and browser-safe; the route manifest and the Workbench both
 * import it so neither can drift.
 *
 *   /routes/mcp/<server>/tool/<name>    MCP tool  — also resource | prompt | app
 *   /routes/events/<event…>             Event route, e.g. /routes/events/tool/before
 *   /routes/cli/<path…>                 CLI route, e.g. /routes/cli/audible/search
 *   /routes/scripts/<name…>             Script
 *   /routes/skills/<id…>                Skill
 *   /routes/commands/<id…>              Host command (Rules / Commands group)
 *   /routes/rules/<id…>                 Host rule
 */

export type ApplicationMcpNodeKind = 'app' | 'prompt' | 'resource' | 'tool';

export type ApplicationNodeRef =
  | Readonly<{ readonly kind: ApplicationMcpNodeKind; readonly name: string; readonly server: string }>
  | Readonly<{ readonly event: string; readonly kind: 'event' }>
  | Readonly<{ readonly kind: 'cli'; readonly path: readonly string[] }>
  | Readonly<{ readonly kind: 'script'; readonly name: string }>
  | Readonly<{ readonly id: string; readonly kind: 'skill' }>
  | Readonly<{ readonly id: string; readonly kind: 'command' }>
  | Readonly<{ readonly id: string; readonly kind: 'rule' }>;

export type ApplicationNodeKind = ApplicationNodeRef['kind'];

const mcpKinds: ReadonlySet<string> = new Set<ApplicationMcpNodeKind>(['app', 'prompt', 'resource', 'tool']);

export const isApplicationMcpNodeKind = (value: string): value is ApplicationMcpNodeKind => mcpKinds.has(value);

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
  if (isApplicationMcpNodeKind(kind)) {
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return undefined;
    return Object.freeze({ kind, name: rest.slice(slash + 1), server: rest.slice(0, slash) });
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

/** The Workbench URL path of a node. */
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

/** Parses the segments after `/routes/` back into a node reference; `undefined` for an unknown or malformed path. */
export const applicationNodeRefForPathSegments = (segments: readonly string[]): ApplicationNodeRef | undefined => {
  const [group, ...rest] = segments;
  switch (group) {
    case 'mcp': {
      const [server, kind, ...name] = rest;
      if (server === undefined || kind === undefined || !isApplicationMcpNodeKind(kind) || name.length !== 1) return undefined;
      const decodedServer = decode(server);
      const decodedName = decode(name[0]!);
      return decodedServer === undefined || decodedName === undefined
        ? undefined
        : Object.freeze({ kind, name: decodedName, server: decodedServer });
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
