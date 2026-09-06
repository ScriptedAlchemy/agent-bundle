import type { Diagnostic } from '../../core/diagnostics.ts';
import type { RouteInputSchema } from '../../routes/types.ts';
import type { ServedStaticDocument } from '../skill-document-service.ts';
import type {
  RouteManifest,
  RouteManifestCliCommand,
  RouteManifestConfigEntry,
  RouteManifestKind,
  RouteManifestRoute,
} from './route-manifest.ts';
import {
  applicationNodeKey,
  applicationNodeRefForRouteId,
  sameApplicationNodeRef,
  type ApplicationNodeRef,
} from './application-node.ts';

export type ApplicationGroupKind = 'cli' | 'events' | 'mcp' | 'rules' | 'scripts' | 'skills';

export type ApplicationLeafExecution = 'invoke' | 'preview' | 'document';

export interface ApplicationLeaf {
  readonly command?: RouteManifestCliCommand;
  readonly config: readonly RouteManifestConfigEntry[];
  readonly description?: string;
  readonly document?: ServedStaticDocument;
  readonly event?: string;
  readonly execution: ApplicationLeafExecution;
  readonly inputSchema?: RouteInputSchema;
  readonly key: string;
  readonly label: string;
  readonly ref: ApplicationNodeRef;
  readonly routeId?: string;
  readonly source?: string;
}

export interface ApplicationSubgroup {
  readonly key: string;
  readonly label: string;
  readonly leaves: readonly ApplicationLeaf[];
}

export interface ApplicationServerGroup {
  readonly key: string;
  readonly label: string;
  readonly mode: string;
  readonly server: string;
  readonly subgroups: readonly ApplicationSubgroup[];
}

export type ApplicationGroup =
  | Readonly<{
      readonly key: string;
      readonly kind: 'mcp';
      readonly label: 'MCP';
      readonly servers: readonly ApplicationServerGroup[];
    }>
  | Readonly<{
      readonly key: string;
      readonly kind: Exclude<ApplicationGroupKind, 'mcp'>;
      readonly label: string;
      readonly leaves: readonly ApplicationLeaf[];
    }>;

export type ApplicationTreeState = 'fresh' | 'stale' | 'unavailable';

export interface ApplicationTree {
  readonly diagnostics: readonly Diagnostic[];
  readonly groups: readonly ApplicationGroup[];
  readonly leafCount: number;
  readonly message?: string;
  readonly state: ApplicationTreeState;
}

export interface ApplicationTreeSkill {
  readonly id: string;
  readonly label: string;
  readonly source?: string;
}

export interface ApplicationTreeInspectionHook {
  readonly event: string;
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly target: string;
}

export interface ApplicationTreeInspectionMcpServer {
  readonly kind: string;
  readonly name: string;
  readonly target: string;
}

export interface ApplicationTreeInspectionScript {
  readonly file?: Readonly<{ readonly path: string }>;
  readonly id: string;
  readonly name: string;
  readonly target: string;
}

export interface ApplicationTreeManifestSources {
  readonly inspection?: Readonly<{
    readonly hooks: readonly ApplicationTreeInspectionHook[];
    readonly mcpServers: readonly ApplicationTreeInspectionMcpServer[];
    readonly scripts: readonly ApplicationTreeInspectionScript[];
  }>;
  readonly manifest?: RouteManifest;
  readonly message?: string;
  readonly skills?: readonly ApplicationTreeSkill[];
  readonly staticDocuments?: readonly ServedStaticDocument[];
  readonly state: ApplicationTreeState;
}

const configuredOnlyDescription = 'configured in agent-bundle.config, no route module';

const byLabel = (left: ApplicationLeaf, right: ApplicationLeaf): number =>
  left.label.localeCompare(right.label) || left.key.localeCompare(right.key);

const routeLabel = (ref: ApplicationNodeRef): string => {
  switch (ref.kind) {
    case 'app':
    case 'prompt':
    case 'resource':
    case 'tool':
      return ref.name;
    case 'event':
      return ref.event;
    case 'cli':
      return ref.path.join(' ');
    case 'script':
      return ref.name;
    case 'skill':
    case 'command':
    case 'rule':
      return ref.id;
    default: {
      const exhaustive: never = ref;
      return exhaustive;
    }
  }
};

const executionFor = (kind: RouteManifestKind): ApplicationLeafExecution => {
  switch (kind) {
    case 'app':
      return 'preview';
    case 'cli':
    case 'event-route':
    case 'prompt':
    case 'resource':
    case 'script':
    case 'tool':
      return 'invoke';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

const leafForRoute = (
  route: RouteManifestRoute,
  command?: RouteManifestCliCommand,
): ApplicationLeaf | undefined => {
  const ref = applicationNodeRefForRouteId(route.id);
  if (ref === undefined) return undefined;
  return Object.freeze({
    ...(command === undefined ? {} : { command }),
    config: route.config,
    ...(route.description === undefined ? {} : { description: route.description }),
    ...(route.event === undefined ? {} : { event: route.event }),
    execution: executionFor(route.kind),
    ...(route.inputSchema === undefined ? {} : { inputSchema: route.inputSchema }),
    key: applicationNodeKey(ref),
    label: routeLabel(ref),
    ref,
    routeId: route.id,
    source: route.source,
  });
};

const leavesForRoutes = (
  routes: readonly RouteManifestRoute[],
  commands: ReadonlyMap<string, RouteManifestCliCommand> = new Map(),
): readonly ApplicationLeaf[] => Object.freeze(routes
  .flatMap((route) => {
    const leaf = leafForRoute(route, commands.get(route.id));
    return leaf === undefined ? [] : [leaf];
  })
  .sort(byLabel));

const subgroupLabels = {
  app: 'Apps',
  prompt: 'Prompts',
  resource: 'Resources',
  tool: 'Tools',
} as const;

const mcpKinds = ['tool', 'resource', 'prompt', 'app'] as const;

const mcpServers = (
  manifest: RouteManifest | undefined,
  inspection: ApplicationTreeManifestSources['inspection'],
): readonly ApplicationServerGroup[] => {
  const servers = new Map<string, ApplicationServerGroup>();
  for (const server of manifest?.servers ?? []) {
    const subgroups = mcpKinds.flatMap((kind) => {
      const leaves = leavesForRoutes(server.routes.filter((route) => route.kind === kind));
      return leaves.length === 0
        ? []
        : [Object.freeze({
            key: `mcp:${server.name}:${kind}`,
            label: subgroupLabels[kind],
            leaves,
          })];
    });
    servers.set(server.name, Object.freeze({
      key: `mcp:${server.name}`,
      label: server.name,
      mode: server.mode,
      server: server.name,
      subgroups: Object.freeze(subgroups),
    }));
  }
  for (const server of inspection?.mcpServers ?? []) {
    if (servers.has(server.name)) continue;
    servers.set(server.name, Object.freeze({
      key: `mcp:${server.name}`,
      label: server.name,
      mode: server.kind,
      server: server.name,
      subgroups: Object.freeze([]),
    }));
  }
  return Object.freeze([...servers.values()].sort((left, right) => left.label.localeCompare(right.label)));
};

const projectGroup = (
  kind: Exclude<ApplicationGroupKind, 'mcp'>,
  label: string,
  leaves: readonly ApplicationLeaf[],
): ApplicationGroup | undefined => leaves.length === 0
  ? undefined
  : Object.freeze({ key: kind, kind, label, leaves: Object.freeze([...leaves].sort(byLabel)) });

const configuredHookLeaves = (
  inspection: ApplicationTreeManifestSources['inspection'],
  existing: ReadonlySet<string>,
): readonly ApplicationLeaf[] => {
  const leaves = new Map<string, ApplicationLeaf>();
  for (const hook of inspection?.hooks ?? []) {
    const ref = Object.freeze({ event: hook.event, kind: 'event' as const });
    const key = applicationNodeKey(ref);
    if (existing.has(key) || leaves.has(key)) continue;
    leaves.set(key, Object.freeze({
      config: Object.freeze([]),
      description: configuredOnlyDescription,
      event: hook.event,
      execution: 'document',
      key,
      label: hook.event,
      ref,
      source: hook.path,
    }));
  }
  return Object.freeze([...leaves.values()]);
};

const configuredScriptLeaves = (
  inspection: ApplicationTreeManifestSources['inspection'],
  existing: ReadonlySet<string>,
): readonly ApplicationLeaf[] => {
  const leaves = new Map<string, ApplicationLeaf>();
  for (const script of inspection?.scripts ?? []) {
    const ref = Object.freeze({ kind: 'script' as const, name: script.name });
    const key = applicationNodeKey(ref);
    if (existing.has(key) || leaves.has(key)) continue;
    leaves.set(key, Object.freeze({
      config: Object.freeze([]),
      description: configuredOnlyDescription,
      execution: 'document',
      key,
      label: script.name,
      ref,
      ...(script.file === undefined ? {} : { source: script.file.path }),
    }));
  }
  return Object.freeze([...leaves.values()]);
};

const skillLeaves = (skills: readonly ApplicationTreeSkill[]): readonly ApplicationLeaf[] =>
  Object.freeze(skills.map((skill) => {
    const ref = Object.freeze({ id: skill.id, kind: 'skill' as const });
    return Object.freeze({
      config: Object.freeze([]),
      execution: 'document' as const,
      key: applicationNodeKey(ref),
      label: skill.label,
      ref,
      ...(skill.source === undefined ? {} : { source: skill.source }),
    });
  }));

const staticDocumentLeaves = (
  documents: readonly ServedStaticDocument[],
): readonly ApplicationLeaf[] => Object.freeze(documents.map((document) => {
  const ref = Object.freeze({ id: document.id, kind: document.kind });
  return Object.freeze({
    config: Object.freeze([]),
    document,
    execution: 'document' as const,
    key: applicationNodeKey(ref),
    label: document.name,
    ref,
    source: document.provenance.sourcePath,
  });
}));

export const applicationLeaves = (tree: ApplicationTree): readonly ApplicationLeaf[] => Object.freeze(
  tree.groups.flatMap((group) => group.kind === 'mcp'
    ? group.servers.flatMap((server) => server.subgroups.flatMap((subgroup) => subgroup.leaves))
    : group.leaves),
);

export const applicationTreeForManifest = (
  sources: ApplicationTreeManifestSources,
): ApplicationTree => {
  const manifest = sources.manifest;
  const routeEvents = leavesForRoutes(manifest?.events ?? []);
  const routeScripts = leavesForRoutes(manifest?.scripts ?? []);
  const commands = new Map((manifest?.cli?.commands ?? []).map((command) => [command.routeId, command]));
  const routeCli = leavesForRoutes(manifest?.cli?.routes ?? [], commands);
  const existing = new Set([
    ...routeEvents.map((leaf) => leaf.key),
    ...routeScripts.map((leaf) => leaf.key),
  ]);
  const servers = mcpServers(manifest, sources.inspection);
  const groups = [
    ...(servers.length === 0
      ? []
      : [Object.freeze({ key: 'mcp', kind: 'mcp' as const, label: 'MCP' as const, servers })]),
    projectGroup('events', 'Events / Hooks', [...routeEvents, ...configuredHookLeaves(sources.inspection, existing)]),
    projectGroup('cli', 'CLI', routeCli),
    projectGroup('scripts', 'Scripts', [...routeScripts, ...configuredScriptLeaves(sources.inspection, existing)]),
    projectGroup('skills', 'Skills', skillLeaves(sources.skills ?? [])),
    projectGroup('rules', 'Rules / Commands', staticDocumentLeaves(sources.staticDocuments ?? [])),
  ].filter((group): group is ApplicationGroup => group !== undefined);
  const provisional: ApplicationTree = Object.freeze({
    diagnostics: Object.freeze([...(manifest?.diagnostics ?? [])]),
    groups: Object.freeze(groups),
    leafCount: 0,
    ...(sources.message === undefined ? {} : { message: sources.message }),
    state: sources.state,
  });
  return Object.freeze({ ...provisional, leafCount: applicationLeaves(provisional).length });
};

export const findApplicationLeaf = (
  tree: ApplicationTree,
  ref: ApplicationNodeRef,
): ApplicationLeaf | undefined =>
  applicationLeaves(tree).find((leaf) => sameApplicationNodeRef(leaf.ref, ref));

export const applicationLeafForRouteId = (
  tree: ApplicationTree,
  routeId: string,
): ApplicationLeaf | undefined => {
  const ref = applicationNodeRefForRouteId(routeId);
  return ref === undefined ? undefined : findApplicationLeaf(tree, ref);
};

export const firstApplicationLeaf = (tree: ApplicationTree): ApplicationLeaf | undefined =>
  applicationLeaves(tree)[0];

const matchesQuery = (leaf: ApplicationLeaf, query: string): boolean =>
  [leaf.label, leaf.description, leaf.routeId, leaf.source]
    .some((value) => value?.toLocaleLowerCase().includes(query));

export const filterApplicationTree = (
  tree: ApplicationTree,
  query: string,
): ApplicationTree => {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return tree;
  const groups = tree.groups.flatMap((group): readonly ApplicationGroup[] => {
    if (group.kind !== 'mcp') {
      const leaves = group.leaves.filter((leaf) => matchesQuery(leaf, normalized));
      return leaves.length === 0 ? [] : [Object.freeze({ ...group, leaves: Object.freeze(leaves) })];
    }
    const servers = group.servers.flatMap((server) => {
      const subgroups = server.subgroups.flatMap((subgroup) => {
        const leaves = subgroup.leaves.filter((leaf) => matchesQuery(leaf, normalized));
        return leaves.length === 0 ? [] : [Object.freeze({ ...subgroup, leaves: Object.freeze(leaves) })];
      });
      return subgroups.length === 0 ? [] : [Object.freeze({ ...server, subgroups: Object.freeze(subgroups) })];
    });
    return servers.length === 0 ? [] : [Object.freeze({ ...group, servers: Object.freeze(servers) })];
  });
  return Object.freeze({
    ...tree,
    groups: Object.freeze(groups),
    leafCount: groups.reduce((total, group) => total + (
      group.kind === 'mcp'
        ? group.servers.reduce((serverTotal, server) =>
            serverTotal + server.subgroups.reduce((subgroupTotal, subgroup) => subgroupTotal + subgroup.leaves.length, 0), 0)
        : group.leaves.length
    ), 0),
  });
};
