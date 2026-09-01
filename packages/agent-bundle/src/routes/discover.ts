import { relative, resolve } from 'node:path';

import fastGlob from 'fast-glob';

import { isProjectPathIgnored, type readProjectIgnoreRules } from '../config/ignore.ts';
import { conventionalCliEntrySource, conventionalMcpEntrySource } from '../config/normalize.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import { isSafePathSegment } from '../core/paths.ts';
import { isRecord } from '../core/strict-json.ts';
import type { AgentBundleConfig } from '../core/types.ts';
import { describeRouteKind, type AgentRouteGraph, type AgentRouteKind, type CompiledAgentRoute } from './types.ts';

type ProjectIgnoreRules = Awaited<ReturnType<typeof readProjectIgnoreRules>>;

/**
 * The conventional route roots (#93). A recognized module beneath one of
 * these roots is an application declaration: its path supplies route kind,
 * owning server, and identity. MCP category directories and the flat
 * provider/cli/scripts roots match exactly one level; event routes nest.
 */
const routeModulePatterns = [
  'src/cli/*.{ts,tsx}',
  'src/events/**/*.{ts,tsx}',
  'src/mcp/*/apps/*.{ts,tsx}',
  'src/mcp/*/prompts/*.{ts,tsx}',
  'src/mcp/*/resources/*.{ts,tsx}',
  'src/mcp/*/tools/*.{ts,tsx}',
  'src/providers/*.{ts,tsx}',
  'src/scripts/*.{ts,tsx}',
] as const;

const mcpCategoryKinds: Readonly<Record<string, AgentRouteKind>> = Object.freeze({
  apps: 'app',
  prompts: 'prompt',
  resources: 'resource',
  tools: 'tool',
});

interface ClassifiedRoutePath {
  readonly conventionalRoot: string;
  readonly kind: AgentRouteKind;
  readonly serverId?: string;
}

/** Derives kind, owning server, and conventional root from one project-relative POSIX path. */
const classifyRoutePath = (relativePath: string): ClassifiedRoutePath | undefined => {
  const segments = relativePath.split('/');
  if (segments[0] !== 'src' || segments.length < 3) return undefined;
  const root = segments[1];
  if (root === 'mcp' && segments.length === 5) {
    const kind = mcpCategoryKinds[segments[3]!];
    if (kind === undefined) return undefined;
    return {
      conventionalRoot: segments.slice(0, 4).join('/'),
      kind,
      serverId: segments[2]!,
    };
  }
  if (root === 'events') return { conventionalRoot: 'src/events', kind: 'event-route' };
  if (segments.length !== 3) return undefined;
  if (root === 'providers') return { conventionalRoot: 'src/providers', kind: 'provider' };
  if (root === 'cli') return { conventionalRoot: 'src/cli', kind: 'cli' };
  if (root === 'scripts') return { conventionalRoot: 'src/scripts', kind: 'script' };
  return undefined;
};

const routeModuleExtensionPattern = /\.(?:ts|tsx)$/u;

/** `_`-prefixed files and directories are private by convention and never routes. */
const hasPrivateSegment = (relativePath: string): boolean =>
  relativePath.split('/').some((segment) => segment.startsWith('_'));

const claimedModuleEntry = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.entry === 'string') return value.entry;
  return undefined;
};

/**
 * Absolute module paths that explicit configuration already claims. Config
 * always wins — the rule the entry conventions established — so a source an
 * explicit `scripts`, `hooks`, `bin`, `lib`, or `mcp` declaration references
 * is that declaration's module, never a conventional route. Two shipped
 * examples declare `scripts` entries under `src/scripts/`; this rule keeps
 * their layouts valid without a migration.
 */
export const configClaimedSources = (
  projectRoot: string,
  config: AgentBundleConfig,
): ReadonlySet<string> => {
  const claimed = new Set<string>();
  const claim = (value: unknown): void => {
    const entry = claimedModuleEntry(value);
    if (entry !== undefined && entry.trim().length > 0) claimed.add(resolve(projectRoot, entry));
  };
  if (isRecord(config.scripts)) {
    for (const value of Object.values(config.scripts)) claim(value);
  }
  if (isRecord(config.hooks)) {
    for (const input of Object.values(config.hooks)) {
      for (const rawEntry of Array.isArray(input) ? input : [input]) {
        claim(typeof rawEntry === 'string' ? rawEntry : isRecord(rawEntry) ? rawEntry.handler : undefined);
      }
    }
  }
  if (isRecord(config.bin)) {
    for (const value of Object.values(config.bin)) claim(value);
  }
  claim(config.lib);
  const servers = isRecord(config.mcp) && isRecord(config.mcp.servers) ? config.mcp.servers : undefined;
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

/** Server names explicit `mcp.servers` configuration declares, whatever their mode. */
const configDeclaredServers = (config: AgentBundleConfig): ReadonlySet<string> => {
  const servers = isRecord(config.mcp) && isRecord(config.mcp.servers) ? config.mcp.servers : undefined;
  return new Set(Object.keys(servers ?? {}));
};

const routeDiagnostic = (
  code: string,
  message: string,
  sourcePath: string,
  recovery: string,
): Diagnostic => ({ code, message, recovery, severity: 'error', sourcePath });

/**
 * Discovers the conventional route modules and compiles the immutable route
 * graph (#93 substrate). Discovery rides the repository's deterministic
 * machinery: sorted globbing, project ignore rules, safe path segments, and
 * provenance on every route. Mode conflicts are hard errors — a server (and
 * the package CLI) is in exactly one mode, and the compiler never silently
 * chooses one (issue rule 10).
 */
export const discoverRouteGraph = async (
  projectRoot: string,
  config: AgentBundleConfig,
  rules: ProjectIgnoreRules,
): Promise<AgentRouteGraph> => {
  const matches = await fastGlob([...routeModulePatterns], {
    absolute: true,
    cwd: projectRoot,
    followSymbolicLinks: false,
    onlyFiles: true,
  });
  const claimed = configClaimedSources(projectRoot, config);
  const sources = [...new Set(matches)]
    .filter((source) =>
      !source.endsWith('.d.ts') &&
      !claimed.has(source) &&
      !isProjectPathIgnored(rules, projectRoot, source))
    .sort((left, right) => left.localeCompare(right));

  const diagnostics: Diagnostic[] = [];
  const routes: CompiledAgentRoute[] = [];
  const sourcesById = new Map<string, string>();
  for (const source of sources) {
    const relativePath = relative(projectRoot, source).replaceAll('\\', '/');
    if (hasPrivateSegment(relativePath)) continue;
    const classified = classifyRoutePath(relativePath);
    if (classified === undefined) continue;
    const stem = relativePath.replace(routeModuleExtensionPattern, '');
    const segments = stem.split('/').slice(1);
    if (!segments.every(isSafePathSegment)) {
      diagnostics.push(routeDiagnostic(
        'AB4804',
        `Route module ${relativePath} has an unsafe path segment; route names use alphanumeric-leading segments of letters, digits, ".", "_", and "-".`,
        source,
        'Rename the route module (and any unsafe parent directories) to safe path segments, then inspect again.',
      ));
      continue;
    }
    const id = segments.join('/');
    const existing = sourcesById.get(id);
    if (existing !== undefined) {
      diagnostics.push(routeDiagnostic(
        'AB4803',
        `Route id ${JSON.stringify(id)} of ${relativePath} duplicates ${relative(projectRoot, existing).replaceAll('\\', '/')}.`,
        source,
        'Keep exactly one module per route id; remove or rename the duplicate, then inspect again.',
      ));
      continue;
    }
    sourcesById.set(id, source);
    routes.push({
      config: {},
      id,
      kind: classified.kind,
      provenance: {
        conventionalRoot: classified.conventionalRoot,
        kind: 'conventional',
        relativePath,
      },
      ...(classified.serverId === undefined ? {} : { serverId: classified.serverId }),
      source,
    });
  }

  const servers = [...new Set(routes.flatMap((route) => (route.serverId === undefined ? [] : [route.serverId])))]
    .sort((left, right) => left.localeCompare(right));
  const declaredServers = configDeclaredServers(config);
  for (const serverId of servers) {
    const fileEntry = conventionalMcpEntrySource(projectRoot, serverId);
    if (fileEntry !== undefined) {
      diagnostics.push(routeDiagnostic(
        'AB4800',
        `MCP server ${JSON.stringify(serverId)} has route modules under src/mcp/${serverId}/ and the conventional entry ${relative(projectRoot, fileEntry).replaceAll('\\', '/')}; a server is in exactly one mode.`,
        fileEntry,
        `Choose one mode explicitly: remove the src/mcp/${serverId}/ route modules to keep the entry file, or remove the entry file to adopt generated routes.`,
      ));
    }
    if (declaredServers.has(serverId)) {
      diagnostics.push(routeDiagnostic(
        'AB4801',
        `MCP server ${JSON.stringify(serverId)} has route modules under src/mcp/${serverId}/ but mcp.servers.${serverId} is also declared in configuration; a server is in exactly one mode.`,
        resolve(projectRoot, 'src', 'mcp', serverId),
        `Choose one mode explicitly: remove the mcp.servers.${serverId} declaration to adopt generated routes, or remove the src/mcp/${serverId}/ route modules to keep the declared server.`,
      ));
    }
  }
  if (routes.some((route) => route.kind === 'cli')) {
    const cliEntry = conventionalCliEntrySource(projectRoot);
    if (cliEntry !== undefined) {
      diagnostics.push(routeDiagnostic(
        'AB4802',
        `${describeRouteKind('cli')} modules live under src/cli/ but the conventional package bin entry ${relative(projectRoot, cliEntry).replaceAll('\\', '/')} also exists; the package CLI is in exactly one mode.`,
        cliEntry,
        'Choose one mode explicitly: remove the src/cli/ route modules to keep the entry file, or remove the entry file to adopt routed CLI commands.',
      ));
    }
  }

  routes.sort((left, right) => left.id.localeCompare(right.id));
  return deepFreeze({ diagnostics, routes, servers });
};
