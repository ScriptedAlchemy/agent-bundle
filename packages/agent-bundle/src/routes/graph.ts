import { readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

import fastGlob from 'fast-glob';

import { conventionalEntryAt } from '../config/conventional-entry.ts';
import { isProjectPathIgnored, readProjectIgnoreRules, toPosixPath } from '../config/ignore.ts';
import { isRenderedScriptRoute } from '../config/script-routes.ts';
import { resolveAppRouteTemplate } from './app-template.ts';
import {
  compileCliCommands,
  compileMcpCliCommands,
  type McpCommandSelection,
} from './cli-commands.ts';
import {
  type AppReferenceTarget,
  type ExtractedRouteConfig,
  extractRouteConfig,
  resolveRouteConfigAppReferences,
} from './config-extract.ts';
import {
  discoverEventRoutePreflight,
  type EventRoutePreflightDiscovery,
  validateEventRouteModuleContract,
  validateLayoutModuleContract,
  validateProviderModuleContract,
  validateRouteModuleContract,
} from './contract.ts';
import { validateRouteFrameworkImports } from './framework-imports.ts';
import { extractInputSchema, type ExtractedInputSchema, type ResolvedSchemaOrigin } from './input-schema.ts';
import { isLayoutRouteKind, layoutChainFor } from './layouts.ts';
import {
  requiredProviderKeyProblemMessage,
  validateRequiredProviderKeys,
} from './provider-execution.ts';
import { providerKeyFromName } from './providers.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { digest } from '../core/digest.ts';
import { deepFreeze } from '../core/freeze.ts';
import { isRecord } from '../core/strict-json.ts';
import type { AgentBundleConfig } from '../core/types.ts';
import { canonicalAgentEvents, type CanonicalAgentEvent } from './public.ts';
import { validateRouteRenderConfig } from './render-budget.ts';
import { validateRouteExecutionConfig } from './task-support.ts';
import {
  emptyRouteConfig,
  type CompiledAgentRoute,
  type CompiledCliMode,
  type CompiledCliSurface,
  type CompiledEventPreflight,
  type CompiledLayout,
  type CompiledProvider,
  type CompiledRouteGraph,
  type CompiledRouteKind,
  type CompiledServerMode,
  type CompiledServerSurface,
  type RouteContract,
  type RouteInputSchema,
} from './types.ts';

type ProjectIgnoreRules = Awaited<ReturnType<typeof readProjectIgnoreRules>>;

/**
 * The conventional route roots. MCP route kinds are direct children of their
 * kind directory; CLI and script routes nest freely (nesting is identity);
 * events pair one family directory with one route file; providers are one
 * flat collection.
 */
const routeGlobs = [
  'src/layout.{ts,tsx}',
  'src/mcp/*/layout.{ts,tsx}',
  'src/mcp/*/{tools,resources,prompts,apps}/*.{ts,tsx}',
  'src/events/*/*.{ts,tsx}',
  'src/events/stop.{ts,tsx}',
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

/** True when a `routes.servers.<name>` override keeps the server's own entry instead of compiling its routes. */
const isNonGeneratedServerOverride = (override: CompiledServerMode | undefined): boolean => {
  switch (override) {
    case 'custom':
    case 'command':
    case 'remote':
      return true;
    case 'generated':
    case 'conflict':
    case undefined:
      return false;
    default: {
      const unreachable: never = override;
      throw new TypeError(`Unhandled server mode override ${String(unreachable)}.`);
    }
  }
};

const routeError = (code: string, message: string, recovery: string, sourcePath?: string): Diagnostic => ({
  code,
  message,
  recovery,
  severity: 'error',
  ...(sourcePath === undefined ? {} : { sourcePath }),
});

const eventProviderDeclarationDiagnostics = (
  route: CompiledAgentRoute,
  providerKeys: Iterable<string>,
): readonly Diagnostic[] => {
  const declared = route.config['providers'];
  if (declared === undefined) return [];
  const recovery =
    'Declare config.providers as a distinct array of conventional provider keys, omit it to resolve every provider, or use [] to resolve none.';
  if (!Array.isArray(declared) || declared.some((key) => typeof key !== 'string')) {
    return [routeError(
      'AB4851',
      `Event route ${route.provenance.relativePath} config.providers must be an array of provider-key strings.`,
      recovery,
      route.source,
    )];
  }
  const problems = validateRequiredProviderKeys(declared, providerKeys);
  if (problems.length === 0) return [];
  return [routeError(
    'AB4851',
    `Event route ${route.provenance.relativePath} has invalid config.providers: ${problems
      .map(requiredProviderKeyProblemMessage)
      .join(' ')}`,
    recovery,
    route.source,
  )];
};

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

interface DiscoveredLayoutModule {
  readonly id: string;
  /** The path-derived name segments; each must satisfy the safe-identity rule. */
  readonly identitySegments: readonly string[];
  readonly relativePath: string;
  readonly scope: CompiledLayout['scope'];
  readonly serverName?: string;
  readonly source: string;
  readonly surface: 'layout';
}

interface DiscoveredRouteModule {
  readonly event?: CanonicalAgentEvent;
  readonly id: string;
  /** The path-derived name segments; each must satisfy the safe-identity rule. */
  readonly identitySegments: readonly string[];
  readonly kind: CompiledRouteKind;
  readonly relativePath: string;
  readonly serverName?: string;
  readonly source: string;
  readonly surface: 'route';
}

type DiscoveredModule = DiscoveredLayoutModule | DiscoveredProviderModule | DiscoveredRouteModule;

const stemOf = (fileName: string): string => fileName.slice(0, -extname(fileName).length);

const layoutStem = 'layout';

/** Derives kind and identity from one glob-matched route path; the globs guarantee segment shape. */
const classifyModule = (source: string, relativePath: string): DiscoveredModule => {
  const segments = relativePath.split('/');
  const collection = segments[1]!;
  const stem = stemOf(segments[segments.length - 1]!);
  if (segments.length === 2 && stem === layoutStem) {
    return {
      id: 'layout:root',
      identitySegments: [],
      relativePath,
      scope: 'root',
      source,
      surface: 'layout',
    };
  }
  if (collection === 'mcp' && segments.length === 4 && stem === layoutStem) {
    const serverName = segments[2]!;
    return {
      id: `layout:mcp:${serverName}`,
      identitySegments: [serverName],
      relativePath,
      scope: 'server',
      serverName,
      source,
      surface: 'layout',
    };
  }
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
    const event = segments.length === 3 ? stem : `${segments[2]!}/${stem}`;
    return {
      event: event as CanonicalAgentEvent,
      id: `event:${event}`,
      identitySegments: event.split('/'),
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

interface ConfigClaimedSources {
  /**
   * Modules an explicit `scripts`, `hooks`, `lib`, or `mcp` declaration
   * references. They belong to that declaration and never become
   * conventional routes.
   */
  readonly artifact: ReadonlySet<string>;
  /**
   * Modules explicit `bin` entries compile. They leave route discovery too,
   * except a direct `src/scripts/<name>` child: `dist/bin/<name>.js` and
   * the artifact's `scripts/<name>.mjs` are disjoint outputs and both envelopes
   * run the same `main`, so one entry ships as both an npm bin and an
   * artifact script instead of silently losing the script (#389).
   */
  readonly bin: ReadonlySet<string>;
}

/**
 * Absolute module paths explicit configuration already claims. Config always
 * wins — the rule the entry conventions established — so a module an explicit
 * `scripts`, `hooks`, `lib`, or `mcp` declaration references belongs to that
 * declaration and never becomes a conventional route. Two shipped examples
 * declare `scripts` entries under `src/scripts/`; this rule keeps their
 * layouts route-free without a migration. `bin` claims are reported
 * separately because a bin coexists with a conventional script.
 */
const configClaimedSources = (
  projectRoot: string,
  config: Readonly<AgentBundleConfig>,
): ConfigClaimedSources => {
  const artifact = new Set<string>();
  const bin = new Set<string>();
  const claimInto = (claimed: Set<string>, value: unknown): void => {
    const entry = claimedModuleEntry(value);
    if (entry !== undefined && entry.trim().length > 0) claimed.add(resolve(projectRoot, entry));
  };
  const claim = (value: unknown): void => claimInto(artifact, value);
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
  const bins = configValue(config, 'bin');
  if (isRecord(bins)) {
    for (const value of Object.values(bins)) claimInto(bin, value);
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
  return { artifact, bin };
};

/**
 * True for a direct child of the conventional scripts root whose stem is a
 * safe route identity — the only shape the flat scripts artifact can ship. A
 * nested or unsafely named module a `bin` entry names stays claimed: keeping
 * it discovered would only turn a valid bin-only configuration into an
 * AB4808 or AB4803 error.
 */
const isConventionalScriptPath = (relativePath: string): boolean => {
  const segments = relativePath.split('/');
  return segments.length === 3
    && segments[0] === 'src'
    && segments[1] === 'scripts'
    && safeIdentitySegment.test(stemOf(segments[2]!));
};

interface RouteModeOverrides {
  readonly cli?: 'generated' | 'conventional';
  readonly mcpCommands?: McpCommandSelection;
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
  const overrideRecovery = 'Set routes.servers.<id> to generated, custom, command, or remote; routes.cli to generated or conventional; and routes.mcpCommands to true or an object with string-array include/exclude fields.';
  const declared = configValue(config, 'routes');
  const servers = new Map<string, CompiledServerMode>();
  let cli: 'generated' | 'conventional' | undefined;
  let mcpCommands: McpCommandSelection | undefined;
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
  const declaredMcpCommands = declared.mcpCommands;
  if (declaredMcpCommands === true) {
    // G7 replaced the issue's MCPorter-branded sketch with this in-house
    // projection over the compiled route graph.
    mcpCommands = {};
  } else if (declaredMcpCommands !== undefined) {
    const keys = isRecord(declaredMcpCommands) ? Object.keys(declaredMcpCommands) : [];
    const include = isRecord(declaredMcpCommands) ? declaredMcpCommands.include : undefined;
    const exclude = isRecord(declaredMcpCommands) ? declaredMcpCommands.exclude : undefined;
    const validList = (value: unknown): value is readonly string[] =>
      Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string');
    if (
      !isRecord(declaredMcpCommands)
      || keys.some((key) => key !== 'include' && key !== 'exclude')
      || (include !== undefined && !validList(include))
      || (exclude !== undefined && !validList(exclude))
    ) {
      diagnostics.push(routeError(
        'AB4804',
        'Routes MCP command projection must be true or an object containing only string-array include/exclude fields.',
        overrideRecovery,
      ));
    } else {
      mcpCommands = {
        ...(exclude === undefined ? {} : { exclude }),
        ...(include === undefined ? {} : { include }),
      };
    }
  }
  return {
    ...(cli === undefined ? {} : { cli }),
    ...(mcpCommands === undefined ? {} : { mcpCommands }),
    servers,
  };
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

interface ServerModeDecision {
  /** The conventional `src/mcp/<name>.{ts,tsx}` entry module, when one exists. */
  readonly conventionalEntry?: string;
  readonly mode: CompiledServerMode;
}

/**
 * Decides how one MCP server that owns route modules is packaged: an
 * explicit `routes.servers.<name>` override wins; otherwise the routes
 * generate the server unless an existing entry claim (conventional entry
 * module, or declared `entry`/`command`/`url`) makes the choice a
 * `conflict` the caller reports as AB4800. Shared between App-reference
 * resolution and server assembly so both see the same mode.
 */
const decideServerMode = (
  projectRoot: string,
  config: Readonly<AgentBundleConfig>,
  overrides: RouteModeOverrides,
  name: string,
): ServerModeDecision => {
  const override = overrides.servers.get(name);
  const declared = declaredMcpServer(config, name);
  const declaredEntry = declared !== undefined &&
    (declared.entry !== undefined || declared.command !== undefined || declared.url !== undefined);
  const conventionalEntry = conventionalEntryAt(projectRoot, 'src', 'mcp', name);
  const withEntry = (mode: CompiledServerMode): ServerModeDecision =>
    conventionalEntry === undefined ? { mode } : { conventionalEntry, mode };
  if (override === 'custom' || override === 'command' || override === 'remote') return withEntry(override);
  if (override === 'generated' || (conventionalEntry === undefined && !declaredEntry)) return withEntry('generated');
  return withEntry('conflict');
};

/**
 * AB4837 (#558) for one route module a generated executable bundles: the
 * caller decides *whether* the route ships (a generated server or CLI, a
 * conventional script, an event route); this names the self-contained
 * executable the module is inlined into. App routes are browser builds and
 * never bundle into a Node executable, so they are exempt.
 */
const routeFrameworkImportDiagnostics = (
  route: CompiledAgentRoute,
  moduleText: string | undefined,
): readonly Diagnostic[] => {
  if (moduleText === undefined) return [];
  let executable: string;
  switch (route.kind) {
    case 'app':
      return [];
    case 'cli':
      executable = 'routed CLI executable';
      break;
    case 'script':
      executable = 'script executable';
      break;
    case 'tool':
    case 'resource':
    case 'prompt':
      executable = 'generated MCP server';
      break;
    case 'event-route':
      executable = 'hook wrapper';
      break;
    default: {
      const unreachable: never = route.kind;
      throw new TypeError(`Unhandled route kind ${String(unreachable)}.`);
    }
  }
  return validateRouteFrameworkImports(moduleText, route.provenance.relativePath, route.source, executable);
};

/** The contract a route binds: the id and the one normalized `input` object every bound route shares. */
interface ContractBinding {
  readonly id: string;
  readonly input: RouteInputSchema;
  readonly origin: ResolvedSchemaOrigin;
}

/** Contract identity is the declaration site: `contract:<module>#<binding>`. */
const contractIdOf = (origin: ResolvedSchemaOrigin): string => `contract:${origin.module}#${origin.binding}`;

/** The contract id a route-local `export const inputSchema = z.object({ ... })` literal declares. */
const inlineContractIdOf = (route: CompiledAgentRoute): string =>
  contractIdOf({ binding: 'inputSchema', module: route.provenance.relativePath });

const compiledRoute = (
  module: DiscoveredRouteModule,
  config: Readonly<Record<string, unknown>>,
  contract?: ContractBinding,
  preflight?: CompiledEventPreflight,
): CompiledAgentRoute => ({
  config,
  ...(contract === undefined ? {} : { contract: contract.id }),
  ...(module.event === undefined ? {} : { event: module.event }),
  id: module.id,
  ...(contract === undefined ? {} : { inputSchema: contract.input }),
  kind: module.kind,
  ...(preflight === undefined ? {} : { preflight }),
  provenance: { kind: 'conventional', relativePath: module.relativePath },
  ...(module.serverName === undefined ? {} : { serverId: `mcp:${module.serverName}` }),
  source: module.source,
});

/**
 * Reads one route module's source text. A racing deletion returns no text so
 * extract/validate skip the same way a later snapshot would.
 */
const readRouteModuleText = async (source: string): Promise<string | undefined> => {
  try {
    return await readFile(source, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Statically extracts one route module's `config` export from already-read
 * source text. A module a racing deletion removed simply has no config.
 * Extraction diagnostics (AB4805/AB4806) are reported once every module is
 * extracted, beside the App-reference resolution (AB4826) that needs the
 * whole discovered tree.
 */
interface ExtractedModuleMetadata {
  readonly extracted: ExtractedRouteConfig;
  readonly inputSchema?: ExtractedInputSchema;
  readonly preflight?: CompiledEventPreflight;
  readonly preflightDiagnostics: readonly Diagnostic[];
}

const emptyExtractedRouteConfig: ExtractedRouteConfig = deepFreeze({
  appReferences: [],
  config: emptyRouteConfig,
  diagnostics: [],
});

const extractedModuleMetadata = (
  module: DiscoveredRouteModule,
  moduleText: string | undefined,
  projectRoot: string,
  preflightDiscovery?: EventRoutePreflightDiscovery,
): ExtractedModuleMetadata => {
  if (moduleText === undefined) {
    return { extracted: emptyExtractedRouteConfig, preflightDiagnostics: [] };
  }
  const extracted = extractRouteConfig(moduleText, module.relativePath, module.source, { projectRoot });
  const inputSchema = extractInputSchema(moduleText, module.relativePath, { projectRoot, source: module.source });
  const discovery = module.kind === 'event-route'
    ? preflightDiscovery ?? discoverEventRoutePreflight(moduleText, module.relativePath, module.source)
    : undefined;
  const preflight = discovery?.source === undefined
    ? undefined
    : {
        provenance: {
          kind: 'conventional' as const,
          relativePath: toPosixPath(relative(projectRoot, discovery.source)),
        },
        source: discovery.source,
      };
  return {
    extracted,
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(preflight === undefined ? {} : { preflight }),
    preflightDiagnostics: discovery?.diagnostics ?? [],
  };
};

/**
 * Every App route of a generated server whose `resourceUri` extracted to a
 * non-empty literal string, so `appResourceUri()` references elsewhere in
 * the tree resolve to it. Apps of servers packaged as `custom`, `command`,
 * `remote`, or left in `conflict` are never built or registered, and Apps
 * whose own config was rejected (or whose `resourceUri` is itself an App
 * reference) have no literal URI: a reference to any of them is AB4826
 * rather than a silently unavailable resource.
 */
const appReferenceTargets = (
  pending: readonly { readonly metadata: ExtractedModuleMetadata; readonly module: DiscoveredRouteModule }[],
  serverModes: ReadonlyMap<string, ServerModeDecision>,
): readonly AppReferenceTarget[] => pending.flatMap(({ metadata, module }) => {
  if (module.kind !== 'app' || serverModes.get(module.serverName!)?.mode !== 'generated') return [];
  if (metadata.extracted.appReferences.some((reference) => reference.path[0] === 'resourceUri')) return [];
  const resourceUri = metadata.extracted.config['resourceUri'];
  return typeof resourceUri === 'string' && resourceUri.trim() !== ''
    ? [{ id: module.id, resourceUri, source: module.source }]
    : [];
});

/**
 * A route's project-relative identity. An imported contract joins it by id:
 * which shared declaration a route binds is part of what the route is. A
 * route-local literal's contract is the route's own `inputSchema`, already
 * covered, so inline-only graphs digest exactly as before #593.
 */
const routeIdentity = (route: CompiledAgentRoute): Readonly<Record<string, unknown>> => ({
  config: route.config,
  ...(route.contract === undefined || route.contract === inlineContractIdOf(route) ? {} : { contract: route.contract }),
  ...(route.event === undefined ? {} : { event: route.event }),
  id: route.id,
  ...(route.inputSchema === undefined ? {} : { inputSchema: route.inputSchema }),
  kind: route.kind,
  ...(route.preflight === undefined ? {} : { preflight: route.preflight.provenance.relativePath }),
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
  (graph.layouts?.length ?? 0) === 0 &&
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
  const moduleTextBySource = new Map<string, string>();
  const preflightDiscoveryBySource = new Map<string, EventRoutePreflightDiscovery>();
  const preflightSupportSources = new Set<string>();
  // Resolve preflight support modules before classifying every glob match:
  // a colocated `before.preflight.ts` is application code named by the
  // canonical `before.ts` route, not a second event route.
  for (const source of sources) {
    if (claimed.artifact.has(source)) continue;
    const relativePath = toPosixPath(relative(projectRoot, source));
    if (claimed.bin.has(source) && !isConventionalScriptPath(relativePath)) continue;
    if (isPrivateRoutePath(relativePath) || isProjectPathIgnored(rules, projectRoot, source)) continue;
    const module = classifyModule(source, relativePath);
    if (
      module.surface !== 'route'
      || module.kind !== 'event-route'
      || !canonicalAgentEvents.includes(module.event!)
    ) {
      continue;
    }
    const moduleText = await readRouteModuleText(source);
    if (moduleText === undefined) continue;
    moduleTextBySource.set(source, moduleText);
    const discovery = discoverEventRoutePreflight(moduleText, relativePath, source);
    preflightDiscoveryBySource.set(source, discovery);
  }
  for (const [source, discovery] of preflightDiscoveryBySource) {
    if (discovery.candidateSource === undefined) continue;
    if (!preflightDiscoveryBySource.has(discovery.candidateSource)) {
      preflightSupportSources.add(discovery.candidateSource);
      continue;
    }
    preflightDiscoveryBySource.set(source, Object.freeze({
      candidateSource: discovery.candidateSource,
      diagnostics: Object.freeze([
        ...discovery.diagnostics,
        routeError(
          'AB4850',
          `Event route ${toPosixPath(relative(projectRoot, source))} re-exports preflight from another conventional event route.`,
          'Move preflight to a separate support module that is not itself an event route.',
          source,
        ),
      ]),
    }));
  }
  const modules: DiscoveredModule[] = [];
  const modulesById = new Map<string, DiscoveredModule>();
  const providerModulesByKey = new Map<string, DiscoveredProviderModule>();
  for (const source of sources) {
    if (claimed.artifact.has(source)) continue;
    const relativePath = toPosixPath(relative(projectRoot, source));
    if (claimed.bin.has(source) && !isConventionalScriptPath(relativePath)) continue;
    if (isPrivateRoutePath(relativePath) || isProjectPathIgnored(rules, projectRoot, source)) continue;
    if (preflightSupportSources.has(source)) continue;
    const module = classifyModule(source, relativePath);
    // The documented opt-out: a server pinned to custom, command, or remote
    // keeps its own entry, so its layout never enters the graph — it is not
    // duplicate-checked, validated, or retained, because no generated worker
    // composes it.
    if (
      module.surface === 'layout' &&
      module.scope === 'server' &&
      isNonGeneratedServerOverride(overrides.servers.get(module.serverName!))
    ) {
      continue;
    }
    if (
      module.surface === 'route' &&
      module.kind === 'event-route' &&
      !canonicalAgentEvents.includes(module.event!)
    ) {
      diagnostics.push(routeError(
        'AB4823',
        `Event route ${relativePath} declares ${JSON.stringify(module.event)}, which is outside the #97 v1 event vocabulary.`,
        `Use one of: ${canonicalAgentEvents.join(', ')}.`,
        source,
      ));
      continue;
    }
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
    if (module.surface === 'provider') {
      const key = providerKeyFromName(module.name);
      if (key === 'processLifetime') {
        diagnostics.push(routeError(
          'AB4942',
          `Provider module ${relativePath} derives the reserved framework provider key "processLifetime".`,
          'Rename the provider file so its camel-cased key is not processLifetime.',
          source,
        ));
        continue;
      }
      const existingProvider = providerModulesByKey.get(key);
      if (existingProvider !== undefined) {
        diagnostics.push(routeError(
          'AB4941',
          `Provider key ${JSON.stringify(key)} is declared by both ${existingProvider.relativePath} and ${relativePath}.`,
          'Rename one provider file so every camel-cased provider key is unique.',
          source,
        ));
        continue;
      }
      providerModulesByKey.set(key, module);
    }
    const existing = modulesById.get(module.id);
    if (existing !== undefined) {
      if (module.surface === 'layout') {
        diagnostics.push(routeError(
          'AB4831',
          `Layout ${JSON.stringify(module.id)} is declared by both ${existing.relativePath} and ${relativePath}.`,
          'Keep exactly one layout module per scope (one of .ts or .tsx), then inspect again.',
          source,
        ));
        continue;
      }
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
  const layouts: CompiledLayout[] = [];
  // Config extraction runs over the whole tree before any route compiles:
  // an `appResourceUri()` reference resolves against every App route the
  // tree declares, wherever the App module sorts relative to its referrer.
  const pending: { readonly metadata: ExtractedModuleMetadata; readonly module: DiscoveredRouteModule }[] = [];
  for (const module of modules) {
    if (module.surface === 'layout') {
      layouts.push({
        id: module.id,
        provenance: { kind: 'conventional', relativePath: module.relativePath },
        scope: module.scope,
        ...(module.serverName === undefined ? {} : { serverId: `mcp:${module.serverName}` }),
        source: module.source,
      });
      const layoutText = await readRouteModuleText(module.source);
      if (layoutText !== undefined) {
        moduleTextBySource.set(module.source, layoutText);
        diagnostics.push(...validateLayoutModuleContract(
          layoutText,
          module.relativePath,
          module.source,
        ));
      }
      continue;
    }
    if (module.surface === 'provider') {
      providers.push({
        id: module.id,
        name: module.name,
        provenance: { kind: 'conventional', relativePath: module.relativePath },
        source: module.source,
      });
      const providerText = await readRouteModuleText(module.source);
      if (providerText !== undefined) {
        moduleTextBySource.set(module.source, providerText);
        diagnostics.push(...validateProviderModuleContract(
          providerText,
          module.relativePath,
          module.source,
        ));
      }
      continue;
    }
    const moduleText = moduleTextBySource.get(module.source) ?? await readRouteModuleText(module.source);
    if (moduleText !== undefined) {
      moduleTextBySource.set(module.source, moduleText);
    }
    pending.push({
      metadata: extractedModuleMetadata(
        module,
        moduleText,
        projectRoot,
        preflightDiscoveryBySource.get(module.source),
      ),
      module,
    });
  }
  const serverModes = new Map<string, ServerModeDecision>();
  for (const { module } of pending) {
    if (module.serverName !== undefined && !serverModes.has(module.serverName)) {
      serverModes.set(module.serverName, decideServerMode(projectRoot, config, overrides, module.serverName));
    }
  }
  const appTargets = appReferenceTargets(pending, serverModes);
  // Routes declaring one schema — the same module and binding at the end of
  // the alias chain — bind one contract and share its normalized `input`
  // object; the first route by id supplies it.
  const contractBindings = new Map<string, ContractBinding>();
  for (const { metadata } of [...pending].sort((left, right) => left.module.id.localeCompare(right.module.id))) {
    if (metadata.inputSchema === undefined) continue;
    const id = contractIdOf(metadata.inputSchema.origin);
    if (!contractBindings.has(id)) {
      contractBindings.set(id, { id, input: metadata.inputSchema.schema, origin: metadata.inputSchema.origin });
    }
  }
  for (const { metadata, module } of pending) {
    const moduleText = moduleTextBySource.get(module.source);
    // Routes of a server that is not generated never ship their config: the
    // mode diagnostic (AB4800) or explicit override is the actionable fact,
    // so their App references are left as authored rather than reported.
    const shipsConfig = module.serverName === undefined
      || serverModes.get(module.serverName)?.mode === 'generated';
    const resolved = shipsConfig
      ? resolveRouteConfigAppReferences(
        metadata.extracted,
        {
          relativePath: module.relativePath,
          ...(module.serverName === undefined ? {} : { serverName: module.serverName }),
          source: module.source,
        },
        appTargets,
      )
      : metadata.extracted;
    diagnostics.push(...resolved.diagnostics);
    diagnostics.push(...metadata.preflightDiagnostics);
    const route = compiledRoute(
      module,
      resolved.config,
      metadata.inputSchema === undefined ? undefined : contractBindings.get(contractIdOf(metadata.inputSchema.origin)),
      metadata.preflight,
    );
    if (route.kind === 'event-route' && moduleText !== undefined) {
      diagnostics.push(...validateEventRouteModuleContract(
        moduleText,
        route.provenance.relativePath,
        route.source,
      ));
    }
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
        diagnostics.push(...eventProviderDeclarationDiagnostics(route, providerModulesByKey.keys()));
        events.push(route);
        // Every event route ships as a hook wrapper of its own, so it is
        // judged here; MCP and CLI routes are judged once their server or
        // CLI surface is known to be generated, because a route of a
        // custom/command/remote server or a conventional CLI never bundles.
        diagnostics.push(...routeFrameworkImportDiagnostics(route, moduleText));
        break;
      case 'cli':
        cliRoutes.push(route);
        break;
      case 'script':
        scripts.push(route);
        // Conventional scripts compile into every selected target.
        diagnostics.push(...routeFrameworkImportDiagnostics(route, moduleText));
        break;
      default: {
        const unreachable: never = route.kind;
        throw new TypeError(`Unhandled route kind ${String(unreachable)}.`);
      }
    }
  }

  const servers: CompiledServerSurface[] = [];
  for (const [name, routes] of [...serverRoutes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    // Every server with routes was decided before App references resolved.
    const { conventionalEntry, mode } = serverModes.get(name)!;
    if (mode === 'conflict') {
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
      // A generated server registers each App under its resourceUri, so two
      // App routes of one server claiming the same URI would otherwise
      // resolve first-wins (AB4829). The same URI on another server is a
      // different registry and never collides here.
      const appRoutesByResourceUri = new Map<string, CompiledAgentRoute>();
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
          } else {
            const claimed = appRoutesByResourceUri.get(resourceUri);
            if (claimed === undefined) {
              appRoutesByResourceUri.set(resourceUri, route);
            } else {
              diagnostics.push(routeError(
                'AB4829',
                `MCP App routes ${claimed.provenance.relativePath} and ${route.provenance.relativePath} of MCP server ${JSON.stringify(name)} both declare config.resourceUri ${JSON.stringify(resourceUri)}; a generated server registers one App per resource URI and never chooses silently.`,
                'Give each App route of the server a distinct config.resourceUri, or remove the duplicate route module, then inspect again.',
                route.source,
              ));
            }
          }
          const template = route.config['template'];
          if (typeof template === 'string') {
            const resolution = resolveAppRouteTemplate(projectRoot, route.source, template);
            switch (resolution.kind) {
              case 'resolved':
                break;
              case 'ambiguous':
                diagnostics.push(routeError(
                  'AB4827',
                  `MCP App route ${route.provenance.relativePath} declares config.template ${JSON.stringify(template)}, which names two different existing files: ${resolution.routeRelative} (route-relative) and ${resolution.projectRelative} (project-root-relative).`,
                  'Templates resolve relative to the route module; rewrite the path so it names the route-relative file only (or remove the project-root-relative duplicate), then inspect again.',
                  route.source,
                ));
                break;
              case 'missing': {
                // An absolute template has one candidate; name it once.
                const candidates = resolution.routeRelative === resolution.projectRelative
                  ? `${resolution.routeRelative} does not exist`
                  : `neither ${resolution.routeRelative} (route-relative) nor ${resolution.projectRelative} (project-root-relative) exists`;
                diagnostics.push(routeError(
                  'AB4827',
                  `MCP App route ${route.provenance.relativePath} declares config.template ${JSON.stringify(template)}, but ${candidates}.`,
                  'Templates resolve relative to the route module; point config.template at an existing HTML file beside the route (for example \'./dashboard.html\'), then inspect again.',
                  route.source,
                ));
                break;
              }
              default: {
                const unreachable: never = resolution;
                throw new TypeError(`Unhandled template resolution ${String(unreachable)}.`);
              }
            }
          }
          continue;
        }
        const moduleText = moduleTextBySource.get(route.source);
        if (moduleText !== undefined) {
          diagnostics.push(...validateRouteModuleContract(
            moduleText,
            route.provenance.relativePath,
            route.source,
          ));
        }
        // The generated server inlines the route, so a compiler-carrying
        // framework import would break its bundle (AB4837, #558).
        diagnostics.push(...routeFrameworkImportDiagnostics(route, moduleText));
        // The route's render budget (#454) is read by the generated server
        // from this compiled config, so it is validated here, once.
        diagnostics.push(...validateRouteRenderConfig(route, 'MCP route').diagnostics);
        // Likewise the tool's task support (#369): advertised in tools/list and
        // gating the task lifecycle, both read from this compiled config.
        diagnostics.push(...validateRouteExecutionConfig(route, 'MCP route').diagnostics);
      }
    }
    servers.push({
      id: `mcp:${name}`,
      mode,
      name,
      routes: mode === 'custom' || mode === 'command' || mode === 'remote' ? [] : routes,
    });
  }

  for (const layout of layouts) {
    if (layout.scope !== 'server') continue;
    const server = servers.find((candidate) => candidate.id === layout.serverId);
    // App routes are browser builds and never take a layout, so a server that
    // declares only apps has nothing for its layout to wrap.
    if (server === undefined || !server.routes.some((route) => isLayoutRouteKind(route.kind))) {
      diagnostics.push(routeError(
        'AB4832',
        `Layout module ${layout.provenance.relativePath} names MCP server ${JSON.stringify(layout.serverId!.slice('mcp:'.length))}, which declares no tool, resource, or prompt route modules.`,
        'Add tools, resources, or prompts under that server directory, move the layout to the server that owns the routes, prefix the file with _ to opt out, or set routes.servers.<server> to custom, command, or remote.',
        layout.source,
      ));
    }
  }

  const projected = overrides.mcpCommands === undefined
    ? undefined
    : compileMcpCliCommands(servers, overrides.mcpCommands);
  let cli: CompiledCliSurface | undefined;
  if (cliRoutes.length > 0 || projected !== undefined) {
    const conventionalCli = conventionalEntryAt(projectRoot, 'src', 'cli');
    let mode: CompiledCliMode;
    if (overrides.cli !== undefined) {
      mode = overrides.cli;
    } else if (conventionalCli === undefined) {
      mode = 'generated';
    } else {
      mode = 'conflict';
      const generatedClaim = cliRoutes.length === 0
        ? 'the routes.mcpCommands projection'
        : projected === undefined
          ? 'src/cli/ command route modules'
          : 'src/cli/ command route modules plus the routes.mcpCommands projection';
      diagnostics.push(routeError(
        'AB4801',
        `The conventional src/cli entry module and ${generatedClaim} both exist; the compiler never chooses silently.`,
        'Set routes.cli to generated to compile the command routes, or to conventional to keep the src/cli entry.',
        conventionalCli,
      ));
    }
    if (mode === 'generated') {
      const compiled = await compileCliCommands(cliRoutes, async (route) =>
        moduleTextBySource.get(route.source), projected, { projectRoot });
      diagnostics.push(...compiled.diagnostics);
      // The routed CLI executable inlines every command route (AB4837, #558).
      for (const route of cliRoutes) {
        diagnostics.push(...routeFrameworkImportDiagnostics(route, moduleTextBySource.get(route.source)));
      }
      cli = {
        commands: compiled.commands,
        mode,
        routes: [...cliRoutes, ...(projected?.routes ?? [])]
          .sort((left, right) => left.id.localeCompare(right.id)),
      };
    } else {
      diagnostics.push(...(projected?.diagnostics ?? []));
      if (mode === 'conventional' && projected !== undefined) {
        diagnostics.push(routeError(
          'AB4804',
          'routes.mcpCommands requires a generated CLI surface, but routes.cli is conventional.',
          'Set routes.cli to generated, or remove routes.mcpCommands to keep the conventional src/cli entry.',
          conventionalCli,
        ));
      }
      cli = { mode, routes: mode === 'conventional' ? [] : cliRoutes };
    }
  }

  // AB4837 (#558) for layouts and providers, judged once the generated
  // surfaces are known, against what the build inlines (build/entry-shell.ts,
  // build/cli-bins.ts, build/entries.ts). A worker imports only the layouts
  // some route it renders composes through (`workerLayouts`): the non-App
  // routes of a generated server, the rendered commands of a generated CLI
  // (plain `.ts` commands run without a render session), and rendered
  // scripts. A layout none of them reaches — a root layout in a project of
  // Apps and event routes, a server layout of a custom server — is never
  // bundled and is not judged. Providers mount in every generated request
  // scope — a generated server, the routed CLI executable (plain commands
  // too), a rendered script's worker, a hook wrapper — but a plain script is
  // bundled from its own source and mounts none.
  const generatedServers = servers.filter((server) => server.mode === 'generated');
  const renderedCommandRouteIds = new Set(
    (cli?.mode === 'generated' ? cli.commands ?? [] : []).filter((command) => command.rendered).map((command) => command.routeId),
  );
  const renderedCliRoutes = cli?.mode === 'generated' ? cli.routes.filter((route) => renderedCommandRouteIds.has(route.id)) : [];
  const renderedScripts = scripts.filter(isRenderedScriptRoute);
  const layoutRoutes = [...generatedServers.flatMap((server) => server.routes), ...renderedCliRoutes, ...renderedScripts];
  for (const layout of layouts) {
    const layoutText = moduleTextBySource.get(layout.source);
    if (layoutText === undefined || !layoutRoutes.some((route) => layoutChainFor(route, [layout]).length > 0)) continue;
    diagnostics.push(...validateRouteFrameworkImports(
      layoutText,
      layout.provenance.relativePath,
      layout.source,
      'generated executable',
      'Layout module',
    ));
  }
  if (generatedServers.length > 0 || cli?.mode === 'generated' || renderedScripts.length > 0 || events.length > 0) {
    for (const provider of providers) {
      const providerText = moduleTextBySource.get(provider.source);
      if (providerText === undefined) continue;
      diagnostics.push(...validateRouteFrameworkImports(
        providerText,
        provider.provenance.relativePath,
        provider.source,
        'generated executable',
        'Provider module',
      ));
    }
  }

  // Contracts are read off the final route set: a route of a custom, command,
  // or remote server left the graph with its server and binds nothing here.
  const contractRoutes = new Map<string, string[]>();
  for (const route of new Map(
    [...servers.flatMap((server) => server.routes), ...events, ...scripts, ...(cli?.routes ?? [])]
      .map((route) => [route.id, route] as const),
  ).values()) {
    if (route.contract === undefined) continue;
    const bound = contractRoutes.get(route.contract) ?? [];
    bound.push(route.id);
    contractRoutes.set(route.contract, bound);
  }
  const contracts: RouteContract[] = [...contractRoutes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, routeIds]) => {
      const { input, origin } = contractBindings.get(id)!;
      return { id, input, origin, routes: [...routeIds].sort((left, right) => left.localeCompare(right)) };
    });

  const identity = {
    ...(cli === undefined
      ? {}
      : {
          cli: {
            ...(cli.commands === undefined ? {} : { commands: cli.commands }),
            mode: cli.mode,
            routes: cli.routes.map(routeIdentity),
          },
        }),
    events: events.map(routeIdentity),
    // Layouts join the identity only when declared, so pre-layout projects
    // keep their recorded graph digests.
    ...(layouts.length === 0
      ? {}
      : { layouts: layouts.map((layout) => ({ id: layout.id, relativePath: layout.provenance.relativePath })) }),
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
    ...(contracts.length === 0 ? {} : { contracts }),
    diagnostics,
    digest: digest(identity),
    events,
    ...(layouts.length === 0 ? {} : { layouts }),
    providers,
    scripts,
    servers,
  });
};
