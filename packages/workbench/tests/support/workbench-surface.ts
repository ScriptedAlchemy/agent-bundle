/**
 * Workbench-surface adapter for the PR 1 IA.
 *
 * L10 replaces `workbenchPageLabel` / `WorkbenchPageName` / `pages` with
 * `inspectWorkbenchSurface(root).application` (`ApplicationTree`) and
 * `workbenchLeafPath(leaf)`. This module codes against those names. Until L10
 * lands it derives a tree from the current catalog so `inspectWorkbenchSurface`
 * dry-runs still compile and run. Drop this adapter on integration and import
 * the same names from `agent-bundle/src/test`.
 */
import { applicationNodePath, applicationNodeRefForRouteId } from '../../../agent-bundle/src/dev/routes/application-node.ts';
import {
  inspectWorkbenchSurface as inspectCurrentSurface,
  type WorkbenchRouteCatalog,
  type WorkbenchRouteCatalogEntry,
  type WorkbenchSurface,
} from '../../../agent-bundle/src/test/index.ts';
import type { RouteManifestKind, RouteManifestRoute } from '../../../agent-bundle/src/dev/routes/route-manifest.ts';
import type { AdvancedSection } from '../../src/shell/workbench-location.ts';
import { advancedSections } from '../../src/shell/workbench-location.ts';
import type {
  ApplicationGroup,
  ApplicationLeaf,
  ApplicationLeafExecution,
  ApplicationServerGroup,
  ApplicationSubgroup,
  ApplicationTree,
} from '../../src/application/application-tree-model.ts';

export type { AdvancedSection, ApplicationGroup, ApplicationLeaf, ApplicationTree };
export { advancedSections };

export const workbenchLeafPath = (leaf: ApplicationLeaf): string => applicationNodePath(leaf.ref);

export const applicationLeaves = (tree: ApplicationTree): readonly ApplicationLeaf[] =>
  tree.groups.flatMap((group) => {
    switch (group.kind) {
      case 'mcp':
        return group.servers.flatMap((server) => server.subgroups.flatMap((subgroup) => subgroup.leaves));
      case 'cli':
      case 'events':
      case 'rules':
      case 'scripts':
      case 'skills':
        return group.leaves;
      default: {
        const exhaustive: never = group;
        return exhaustive;
      }
    }
  });

export const findApplicationLeaf = (
  tree: ApplicationTree,
  match: (leaf: ApplicationLeaf) => boolean,
): ApplicationLeaf | undefined => applicationLeaves(tree).find(match);

export const applicationLeafForRouteId = (tree: ApplicationTree, routeId: string): ApplicationLeaf | undefined =>
  findApplicationLeaf(tree, (leaf) => leaf.routeId === routeId);

const mcpSubgroupLabel = (kind: RouteManifestKind): string | undefined => {
  switch (kind) {
    case 'tool':
      return 'Tools';
    case 'resource':
      return 'Resources';
    case 'prompt':
      return 'Prompts';
    case 'app':
      return 'Apps';
    case 'cli':
    case 'event-route':
    case 'script':
      return undefined;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

const leafLabel = (route: RouteManifestRoute): string => {
  const rest = route.id.slice(route.id.indexOf(':') + 1);
  const slash = rest.lastIndexOf('/');
  return slash === -1 ? rest : rest.slice(slash + 1);
};

const leafExecution = (kind: RouteManifestKind): ApplicationLeafExecution => {
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

const leafFromEntry = (entry: WorkbenchRouteCatalogEntry): ApplicationLeaf | undefined => {
  const ref = applicationNodeRefForRouteId(entry.route.id);
  if (ref === undefined) return undefined;
  return {
    config: entry.route.config,
    execution: leafExecution(entry.route.kind),
    key: applicationNodePath(ref),
    label: leafLabel(entry.route),
    ref,
    routeId: entry.route.id,
    source: entry.route.source,
    ...(entry.command === undefined ? {} : { command: entry.command }),
    ...(entry.route.description === undefined ? {} : { description: entry.route.description }),
    ...(entry.route.event === undefined ? {} : { event: entry.route.event }),
    ...(entry.route.inputSchema === undefined ? {} : { inputSchema: entry.route.inputSchema }),
  };
};

const leavesOf = (entries: readonly WorkbenchRouteCatalogEntry[]): readonly ApplicationLeaf[] =>
  entries.flatMap((entry) => {
    const leaf = leafFromEntry(entry);
    return leaf === undefined ? [] : [leaf];
  });

const groupKindForCatalog = (kind: RouteManifestKind): ApplicationGroup['kind'] | undefined => {
  switch (kind) {
    case 'cli':
      return 'cli';
    case 'event-route':
      return 'events';
    case 'script':
      return 'scripts';
    case 'app':
    case 'prompt':
    case 'resource':
    case 'tool':
      return 'mcp';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

const applicationTreeFromCatalog = (catalog: WorkbenchRouteCatalog): ApplicationTree => {
  const servers = new Map<string, ApplicationServerGroup>();
  const projectGroups = new Map<Exclude<ApplicationGroup['kind'], 'mcp'>, ApplicationLeaf[]>();
  for (const group of catalog.groups) {
    const kind = groupKindForCatalog(group.kind);
    if (kind === undefined) continue;
    const leaves = leavesOf(group.entries);
    if (leaves.length === 0) continue;
    if (kind === 'mcp') {
      const serverName = group.server ?? 'mcp';
      const subgroupLabel = mcpSubgroupLabel(group.kind);
      if (subgroupLabel === undefined) continue;
      const existing = servers.get(serverName);
      const subgroup: ApplicationSubgroup = {
        key: `${serverName}/${subgroupLabel}`,
        label: subgroupLabel,
        leaves,
      };
      if (existing === undefined) {
        servers.set(serverName, {
          key: `mcp/${serverName}`,
          label: serverName,
          mode: group.mode ?? 'generated',
          server: serverName,
          subgroups: [subgroup],
        });
        continue;
      }
      servers.set(serverName, { ...existing, subgroups: [...existing.subgroups, subgroup] });
      continue;
    }
    const collected = projectGroups.get(kind) ?? [];
    collected.push(...leaves);
    projectGroups.set(kind, collected);
  }
  const groups: ApplicationGroup[] = [];
  if (servers.size > 0) {
    groups.push({
      key: 'mcp',
      kind: 'mcp',
      label: 'MCP',
      servers: [...servers.values()],
    });
  }
  const projectOrder = [
    ['events', 'Events / Hooks'],
    ['cli', 'CLI'],
    ['scripts', 'Scripts'],
    ['skills', 'Skills'],
    ['rules', 'Rules / Commands'],
  ] as const;
  for (const [kind, label] of projectOrder) {
    const leaves = projectGroups.get(kind);
    if (leaves === undefined || leaves.length === 0) continue;
    groups.push({ key: kind, kind, label, leaves });
  }
  return {
    diagnostics: catalog.diagnostics,
    groups,
    leafCount: groups.reduce((total, group) => {
      switch (group.kind) {
        case 'mcp':
          return total + group.servers.reduce(
            (serverTotal, server) => serverTotal + server.subgroups.reduce((sub, subgroup) => sub + subgroup.leaves.length, 0),
            0,
          );
        case 'cli':
        case 'events':
        case 'rules':
        case 'scripts':
        case 'skills':
          return total + group.leaves.length;
        default: {
          const exhaustive: never = group;
          return exhaustive;
        }
      }
    }, 0),
    state: 'current',
  };
};

/** L10's return shape. Extra catalog fields stay until the integrator drops them. */
export interface WorkbenchIaSurface {
  readonly advanced: readonly AdvancedSection[];
  readonly application: ApplicationTree;
  readonly counts: WorkbenchSurface['counts'];
  readonly lifecycles: WorkbenchSurface['lifecycles'];
  readonly routes: WorkbenchRouteCatalog;
}

interface NextWorkbenchSurface extends WorkbenchSurface {
  readonly advanced?: readonly AdvancedSection[];
  readonly application?: ApplicationTree;
}

export const inspectWorkbenchSurface = async (
  root: string | { readonly root: string },
): Promise<WorkbenchIaSurface> => {
  const options = typeof root === 'string' ? { root } : root;
  const current = await inspectCurrentSurface(options) as NextWorkbenchSurface;
  return {
    advanced: current.advanced ?? advancedSections,
    application: current.application ?? applicationTreeFromCatalog(current.catalog),
    counts: current.counts,
    lifecycles: current.lifecycles,
    routes: current.catalog,
  };
};
