import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

import fastGlob from 'fast-glob';

import { isProjectPathIgnored, readProjectIgnoreRules, toPosixPath } from '../config/ignore.ts';
import { extractRouteConfig } from './config-extract.ts';
import { validateRouteModuleContract } from './contract.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { digest } from '../core/digest.ts';
import { deepFreeze } from '../core/freeze.ts';
import { isRecord } from '../core/strict-json.ts';
import type { AgentBundleConfig } from '../core/types.ts';
import {
  emptyRouteConfig,
  type CompiledAgentRoute,
  type CompiledCliMode,
  type CompiledCliSurface,
  type CompiledProvider,
  type CompiledRouteGraph,
  type CompiledRouteKind,
  type CompiledServerMode,
  type CompiledServerSurface,
} from './types.ts';

type ProjectIgnoreRules = Awaited<ReturnType<typeof readProjectIgnoreRules>>;

/**
 * The conventional route roots. MCP route kinds are direct children of their
 * kind directory; CLI and script routes nest freely (nesting is identity);
 * events pair one family directory with one route file; providers are one
 * flat collection.
 */
const routeGlobs = [
  'src/mcp/*/{tools,resources,prompts,apps}/*.{ts,tsx}',
  'src/events/*/*.{ts,tsx}',
  'src/providers/*.{ts,tsx}',
  'src/cli/**/*.{ts,tsx}',
  // Scripts also discover .jsx: the stage-1 script gate judges rendered
  // modules (AB4807), so a .jsx script must surface there, never vanish.
  'src/scripts/**/*.{ts,tsx,jsx}',
];

const mcpRouteKinds: Readonly<Record<string, CompiledRouteKind>> = {
  apps: 'app',
  prompts: 'prompt',
  resources: 'resource',
  tools: 'tool',
};

/** Every identity segment a route path contributes must be a safe name. */
const safeIdentitySegment = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u;

const serverModeOverrides = new Set(['generated', 'custom', 'command', 'remote']);

const conventionalEntryExtensions = ['.ts', '.tsx'] as const;

/**
 * Local copy of the conventional-entry probe from config/normalize.ts.
 * Importing it would close the cycle discover.ts -> routes/graph.ts ->
 * normalize.ts -> discover.ts, so the probe is duplicated here with the
 * same .ts/.tsx rule.
 */
const conventionalEntryAt = (root: string, ...segments: string[]): string | undefined => {
  const stem = resolve(root, ...segments);
  for (const extension of conventionalEntryExtensions) {
    const candidate = `${stem}${extension}`;
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // A racing deletion means the convention does not apply.
    }
  }
  return undefined;
};

const routeError = (code: string, message: string, recovery: string, sourcePath?: string): Diagnostic => ({
  code,
  message,
  recovery,
  severity: 'error',
  ...(sourcePath === undefined ? {} : { sourcePath }),
});

const configValue = (
  config: Readonly<AgentBundleConfig>,
  key: keyof AgentBundleConfig | 'routes',
): unknown => {
  try {
    return Reflect.get(config, key);
  } catch {
    return undefined;
  }
};

interface DiscoveredProviderModule {
  readonly id: string;
  /** The path-derived name segments; each must satisfy the safe-identity rule. */
  readonly identitySegments: readonly string[];
  readonly name: string;
  readonly relativePath: string;
  readonly source: string;
  readonly surface: 'provider';
}

interface DiscoveredRouteModule {
  readonly id: string;
  /** The path-derived name segments; each must satisfy the safe-identity rule. */
  readonly identitySegments: readonly string[];
  readonly kind: CompiledRouteKind;
  readonly relativePath: string;
  readonly serverName?: string;
  readonly source: string;
  readonly surface: 'route';
}

type DiscoveredModule = DiscoveredProviderModule | DiscoveredRouteModule;

const stemOf = (fileName: string): string => fileName.slice(0, -extname(fileName).length);

/** Derives kind and identity from one glob-matched route path; the globs guarantee segment shape. */
const classifyModule = (source: string, relativePath: string): DiscoveredModule => {
  const segments = relativePath.split('/');
  const collection = segments[1]!;
  const stem = stemOf(segments[segments.length - 1]!);
  if (collection === 'mcp') {
    const serverName = segments[2]!;
    const kind = mcpRouteKinds[segments[3]!]!;
    return {
      id: `${kind}:${serverName}/${stem}`,
      identitySegments: [serverName, stem],
      kind,
      relativePath,
      serverName,
      source,
      surface: 'route',
    };
  }
  if (collection === 'events') {
    const family = segments[2]!;
    return {
      id: `event:${family}/${stem}`,
      identitySegments: [family, stem],
      kind: 'event-route',
      relativePath,
      source,
      surface: 'route',
    };
  }
  if (collection === 'providers') {
    return {
      id: `provider:${stem}`,
      identitySegments: [stem],
      name: stem,
      relativePath,
      source,
      surface: 'provider',
    };
  }
  const nested = [...segments.slice(2, -1), stem];
  const kind: CompiledRouteKind = collection === 'cli' ? 'cli' : 'script';
  return {
    id: `${kind}:${nested.join('/')}`,
    identitySegments: nested,
    kind,
    relativePath,
    source,
    surface: 'route',
  };
};

/** Any private (`_`/`.`) segment or declaration file opts the module out of discovery. */
const isPrivateRoutePath = (relativePath: string): boolean =>
  relativePath.endsWith('.d.ts') ||
  relativePath.split('/').some((segment) => segment.startsWith('_') || segment.startsWith('.'));

const claimedModuleEntry = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.entry === 'string') return value.entry;
  return undefined;
};

/**
 * Absolute module paths explicit configuration already claims. Config always
 * wins — the rule the entry conventions established — so a module an explicit
 * `scripts`, `hooks`, `bin`, `lib`, or `mcp` declaration references belongs
 * to that declaration and never becomes a conventional route. Two shipped
 * examples declare `scripts` entries under `src/scripts/`; this rule keeps
 * their layouts route-free without a migration.
 */
const configClaimedSources = (
  projectRoot: string,
  config: Readonly<AgentBundleConfig>,
): ReadonlySet<string> => {
  const claimed = new Set<string>();
  const claim = (value: unknown): void => {
    const entry = claimedModuleEntry(value);
    if (entry !== undefined && entry.trim().length > 0) claimed.add(resolve(projectRoot, entry));
  };
  const scripts = configValue(config, 'scripts');
  if (isRecord(scripts)) {
    for (const value of Object.values(scripts)) claim(value);
  }
  const hooks = configValue(config, 'hooks');
  if (isRecord(hooks)) {
    for (const input of Object.values(hooks)) {
      for (const rawEntry of Array.isArray(input) ? input : [input]) {
        claim(typeof rawEntry === 'string' ? rawEntry : isRecord(rawEntry) ? rawEntry.handler : undefined);
      }
    }
  }
  const bin = configValue(config, 'bin');
  if (isRecord(bin)) {
    for (const value of Object.values(bin)) claim(value);
  }
  claim(configValue(config, 'lib'));
  const mcp = configValue(config, 'mcp');
  const servers = isRecord(mcp) && isRecord(mcp.servers) ? mcp.servers : undefined;
  for (const server of Object.values(servers ?? {})) {
    if (!isRecord(server)) continue;
    claim(server.entry);
    if (!isRecord(server.apps)) continue;
    for (const app of Object.values(server.apps)) {
      if (!isRecord(app)) continue;
      claim(app.entry);
      claim(app.template);
    }
  }
  return claimed;
};

interface RouteModeOverrides {
  readonly cli?: 'generated' | 'conventional';
  readonly servers: ReadonlyMap<string, CompiledServerMode>;
}

/**
 * Parses the power-tier `routes` override block. It rides the config index
 * signature deliberately: the route compiler is not yet a public authoring
 * surface, so the typed config stays unchanged until the renderer join.
 */
const parseRouteModeOverrides = (
  config: Readonly<AgentBundleConfig>,
  diagnostics: Diagnostic[],
): RouteModeOverrides => {
  const overrideRecovery = 'Set routes.servers.<id> to generated, custom, command, or remote, and routes.cli to generated or conventional.';
  const declared = configValue(config, 'routes');
  const servers = new Map<string, CompiledServerMode>();
  let cli: 'generated' | 'conventional' | undefined;
  if (declared === undefined) return { servers };
  if (!isRecord(declared)) {
    diagnostics.push(routeError('AB4804', 'Routes overrides must be an object.', overrideRecovery));
    return { servers };
  }
  const declaredServers = declared.servers;
  if (declaredServers !== undefined) {
    if (!isRecord(declaredServers)) {
      diagnostics.push(routeError('AB4804', 'Routes server overrides must be an object of server modes.', overrideRecovery));
    } else {
      for (const [name, mode] of Object.entries(declaredServers)) {
        if (typeof mode === 'string' && serverModeOverrides.has(mode)) {
          servers.set(name, mode as CompiledServerMode);
        } else {
          diagnostics.push(routeError(
            'AB4804',
            `Routes override for MCP server ${JSON.stringify(name)} must be generated, custom, command, or remote; got ${JSON.stringify(mode)}.`,
            overrideRecovery,
          ));
        }
      }
    }
  }
  const declaredCli = declared.cli;
  if (declaredCli !== undefined) {
    if (declaredCli === 'generated' || declaredCli === 'conventional') {
      cli = declaredCli;
    } else {
      diagnostics.push(routeError(
        'AB4804',
        `Routes CLI override must be generated or conventional; got ${JSON.stringify(declaredCli)}.`,
        overrideRecovery,
      ));
    }
  }
  return { ...(cli === undefined ? {} : { cli }), servers };
};

/** The declared config entry for one MCP server, tolerant of malformed config shapes. */
const declaredMcpServer = (
  config: Readonly<AgentBundleConfig>,
  name: string,
): Readonly<Record<string, unknown>> | undefined => {
  const mcp = configValue(config, 'mcp');
  if (!isRecord(mcp) || !isRecord(mcp.servers)) return undefined;
  const server = (mcp.servers as Readonly<Record<string, unknown>>)[name];
  return isRecord(server) ? server : undefined;
};

const compiledRoute = (
  module: DiscoveredRouteModule,
  config: Readonly<Record<string, unknown>>,
): CompiledAgentRoute => ({
  config,
  id: module.id,
  kind: module.kind,
  provenance: { kind: 'conventional', relativePath: module.relativePath },
  ...(module.serverName === undefined ? {} : { serverId: `mcp:${module.serverName}` }),
  source: module.source,
});

/**
 * Statically extracts one route module's `config` export from disk. A module
 * a racing deletion removed simply has no config; extraction diagnostics
 * (AB4805/AB4806) accumulate beside the discovery diagnostics.
 */
const extractedModuleConfig = async (
  module: DiscoveredRouteModule,
  diagnostics: Diagnostic[],
): Promise<Readonly<Record<string, unknown>>> => {
  let moduleText: string;
  try {
    moduleText = await readFile(module.source, 'utf8');
  } catch {
    return emptyRouteConfig;
  }
  const extracted = extractRouteConfig(moduleText, module.relativePath, module.source);
  diagnostics.push(...extracted.diagnostics);
  return extracted.config;
};

const routeIdentity = (route: CompiledAgentRoute): Readonly<Record<string, unknown>> => ({
  config: route.config,
  id: route.id,
  kind: route.kind,
  relativePath: route.provenance.relativePath,
  ...(route.serverId === undefined ? {} : { serverId: route.serverId }),
});

/**
 * The graph of a route-free project: what {@link compileRouteGraph} returns
 * when no conventional route module exists and no diagnostic fires. The
 * inspect focus serves this constant when discovery attached no graph.
 */
export const emptyCompiledRouteGraph: CompiledRouteGraph = deepFreeze({
  diagnostics: [],
  digest: digest({ events: [], providers: [], scripts: [], servers: [] }),
  events: [],
  providers: [],
  scripts: [],
  servers: [],
});

/** True when discovery found nothing and produced no diagnostics, so callers can omit the graph. */
export const isEmptyRouteGraph = (graph: CompiledRouteGraph): boolean =>
  graph.cli === undefined &&
  graph.diagnostics.length === 0 &&
  graph.events.length === 0 &&
  graph.providers.length === 0 &&
  graph.scripts.length === 0 &&
  graph.servers.length === 0;

/**
 * Compiles the conventional route tree into the immutable route graph IR.
 * Discovery is not a packaging choice: conflicts with existing entry
 * conventions or declared servers keep their discovered routes visible and
 * surface hard errors instead of silently choosing a side.
 */
export const compileRouteGraph = async (
  root: string,
  config: Readonly<AgentBundleConfig>,
  ignoreRules?: ProjectIgnoreRules,
): Promise<CompiledRouteGraph> => {
  const projectRoot = resolve(root);
  const rules = ignoreRules ?? await readProjectIgnoreRules(projectRoot);
  const diagnostics: Diagnostic[] = [];
  const overrides = parseRouteModeOverrides(config, diagnostics);

  const sources = (await fastGlob(routeGlobs, {
    absolute: true,
    cwd: projectRoot,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
  })).sort((left, right) => left.localeCompare(right));

  const claimed = configClaimedSources(projectRoot, config);
  const modules: DiscoveredModule[] = [];
  const modulesById = new Map<string, DiscoveredModule>();
  for (const source of sources) {
    if (claimed.has(source)) continue;
    const relativePath = toPosixPath(relative(projectRoot, source));
    if (isPrivateRoutePath(relativePath) || isProjectPathIgnored(rules, projectRoot, source)) continue;
    const module = classifyModule(source, relativePath);
    const unsafeSegment = module.identitySegments.find((segment) => !safeIdentitySegment.test(segment));
    if (unsafeSegment !== undefined) {
      diagnostics.push(routeError(
        'AB4803',
        `Route module ${relativePath} derives the unsafe identity segment ${JSON.stringify(unsafeSegment)}; use letters, digits, and inner ".", "_", "-" only.`,
        'Rename the route file or directory to a safe identity segment, then inspect again.',
        source,
      ));
      continue;
    }
    const existing = modulesById.get(module.id);
    if (existing !== undefined) {
      diagnostics.push(routeError(
        'AB4802',
        `Route id ${JSON.stringify(module.id)} is declared by both ${existing.relativePath} and ${relativePath}.`,
        'Keep exactly one route module per identity, then inspect again.',
        source,
      ));
      continue;
    }
    modulesById.set(module.id, module);
    modules.push(module);
  }

  const serverRoutes = new Map<string, CompiledAgentRoute[]>();
  const events: CompiledAgentRoute[] = [];
  const scripts: CompiledAgentRoute[] = [];
  const cliRoutes: CompiledAgentRoute[] = [];
  const providers: CompiledProvider[] = [];
  for (const module of modules) {
    if (module.surface === 'provider') {
      providers.push({
        id: module.id,
        name: module.name,
        provenance: { kind: 'conventional', relativePath: module.relativePath },
        source: module.source,
      });
      continue;
    }
    const route = compiledRoute(module, await extractedModuleConfig(module, diagnostics));
    switch (route.kind) {
      case 'tool':
      case 'resource':
      case 'prompt':
      case 'app': {
        const routes = serverRoutes.get(module.serverName!) ?? [];
        routes.push(route);
        serverRoutes.set(module.serverName!, routes);
        break;
      }
      case 'event-route':
        events.push(route);
        break;
      case 'cli':
        cliRoutes.push(route);
        break;
      case 'script':
        scripts.push(route);
        break;
      default: {
        const unreachable: never = route.kind;
        throw new TypeError(`Unhandled route kind ${String(unreachable)}.`);
      }
    }
  }

  const servers: CompiledServerSurface[] = [];
  for (const [name, routes] of [...serverRoutes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const override = overrides.servers.get(name);
    const declared = declaredMcpServer(config, name);
    const declaredEntry = declared !== undefined &&
      (declared.entry !== undefined || declared.command !== undefined || declared.url !== undefined);
    const conventionalEntry = conventionalEntryAt(projectRoot, 'src', 'mcp', name);
    let mode: CompiledServerMode;
    if (override === 'custom' || override === 'command' || override === 'remote') {
      mode = override;
    } else if (override === 'generated' || (conventionalEntry === undefined && !declaredEntry)) {
      mode = 'generated';
    } else {
      mode = 'conflict';
      const claim = conventionalEntry === undefined
        ? 'an explicit entry, command, or url in config'
        : `the conventional src/mcp/${name} entry module`;
      diagnostics.push(routeError(
        'AB4800',
        `MCP server ${JSON.stringify(name)} has both ${claim} and src/mcp/${name}/ route modules; the compiler never chooses silently.`,
        `Set routes.servers.${name} to generated to compile the routes, or to custom, command, or remote to keep the existing entry.`,
        conventionalEntry ?? routes[0]!.source,
      ));
    }
    if (mode === 'generated') {
      for (const route of routes) {
        if (route.kind === 'app') {
          const resourceUri = route.config['resourceUri'];
          if (typeof resourceUri !== 'string' || resourceUri.trim() === '') {
            diagnostics.push(routeError(
              'AB4812',
              `MCP App route ${route.provenance.relativePath} requires a non-empty static config.resourceUri.`,
              'Export const config with the App resourceUri, then inspect again.',
              route.source,
            ));
          }
          continue;
        }
        try {
          diagnostics.push(...validateRouteModuleContract(
            await readFile(route.source, 'utf8'),
            route.provenance.relativePath,
            route.source,
          ));
        } catch {
          // Racing deletion is handled by the next source snapshot.
        }
      }
    }
    servers.push({
      id: `mcp:${name}`,
      mode,
      name,
      routes: mode === 'custom' || mode === 'command' || mode === 'remote' ? [] : routes,
    });
  }

  let cli: CompiledCliSurface | undefined;
  if (cliRoutes.length > 0) {
    const conventionalCli = conventionalEntryAt(projectRoot, 'src', 'cli');
    let mode: CompiledCliMode;
    if (overrides.cli !== undefined) {
      mode = overrides.cli;
    } else if (conventionalCli === undefined) {
      mode = 'generated';
    } else {
      mode = 'conflict';
      diagnostics.push(routeError(
        'AB4801',
        'The conventional src/cli entry module and src/cli/ command route modules both exist; the compiler never chooses silently.',
        'Set routes.cli to generated to compile the command routes, or to conventional to keep the src/cli entry.',
        conventionalCli,
      ));
    }
    cli = { mode, routes: mode === 'conventional' ? [] : cliRoutes };
  }

  const identity = {
    ...(cli === undefined ? {} : { cli: { mode: cli.mode, routes: cli.routes.map(routeIdentity) } }),
    events: events.map(routeIdentity),
    providers: providers.map((provider) => ({ id: provider.id, relativePath: provider.provenance.relativePath })),
    scripts: scripts.map(routeIdentity),
    servers: servers.map((server) => ({
      id: server.id,
      mode: server.mode,
      routes: server.routes.map(routeIdentity),
    })),
  };

  return deepFreeze({
    ...(cli === undefined ? {} : { cli }),
    diagnostics,
    digest: digest(identity),
    events,
    providers,
    scripts,
    servers,
  });
};
