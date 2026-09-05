import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, posix, relative, resolve, sep, win32 } from 'node:path';

import { digest } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';
import { deepFreeze } from '../core/freeze.ts';
import { isInside } from '../core/paths.ts';
import {
  defaultGeneratedRuntime,
  formatRuntimeVersion,
  parseRuntimeVersion,
  satisfiesGeneratedRuntimeFloor,
} from '../core/runtime.ts';
import { isRecord } from '../core/strict-json.ts';
import { conventionalEntryAt } from './conventional-entry.ts';
import { pluginIdentity } from './plugin-identity.ts';
import {
  canonicalHookEvents,
  isPrebuiltEntryInput,
  parseNativeHookToolSelector,
  pathTokens,
} from '../core/types.ts';
import type {
  AgentBundleBinEntry,
  AgentBundleConfig,
  AgentBundleHookEntry,
  AgentBundleHookInput,
  AgentBundleLibEntry,
  AgentBundleMcpApp,
  AgentBundleMcpServer,
  AgentBundleScriptInput,
  CanonicalHookEvent,
  CanonicalHookTool,
  NativeHookToolSelector,
  NormalizationHostPayloadSource,
  NormalizationTargetRegistry,
  NormalizedAsset,
  NormalizedBinEntry,
  NormalizedCommand,
  NormalizedConfigExtension,
  NormalizedHook,
  NormalizedHostBin,
  NormalizedHostBinFile,
  NormalizedHostPayloadDirectory,
  NormalizedLibEntry,
  NormalizedLspServer,
  NormalizedMcpApp,
  NormalizedMcpServer,
  NormalizedNativeHook,
  NormalizedHookEvent,
  NormalizedPackageBuild,
  NormalizedPayload,
  NormalizedPlugin,
  NormalizedPluginLogo,
  NormalizedRuntime,
  NormalizedRule,
  NormalizedScript,
  NormalizedSkill,
  NormalizedStateDefinition,
  SourceProvenance,
} from '../core/types.ts';
import { appRouteTemplatePath, resolveAppRouteTemplate } from '../routes/app-template.ts';
import { mcpRouteProtocolName } from '../routes/protocol-name.ts';
import type { CompiledCliSurface } from '../routes/types.ts';
import { type DiscoveredProject, payloadDeclarationSource } from './discover.ts';
import type { LoadedConfig } from './load.ts';
import type { CanonicalAgentEvent } from '../routes/public.ts';
import { decideSkillTreeLayout, lowerSkillIrForHosts } from '../skills/lower.ts';
import { parseSkillIr } from '../skills/parse-ir.ts';
import type { SkillHost } from '../skills/tokens.ts';
import { normalizeNoticeRetention } from './notice-retention.ts';
import { configuredScriptNames, judgeScriptRoute, scriptRouteName } from './script-routes.ts';

const isSkillHost = (name: string): name is SkillHost =>
  name === 'claude' || name === 'codex' || name === 'cursor' || name === 'portable';

const loweringHosts = (targetNames: readonly string[]): SkillHost[] =>
  [...new Set(targetNames.filter(isSkillHost))];

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const sortedUnique = (values: readonly string[]): string[] =>
  unique(values).sort((left, right) => left.localeCompare(right));

const hookEvents: readonly CanonicalHookEvent[] = canonicalHookEvents;

const hookEventForRoute: Readonly<Record<CanonicalAgentEvent, NormalizedHookEvent>> = Object.freeze({
  'agent/start': 'agentStart',
  'agent/stop': 'agentStop',
  'prompt/submit': 'promptSubmit',
  'session/end': 'sessionEnd',
  'session/start': 'sessionStart',
  'stop': 'stop',
  'tool/after': 'afterTool',
  'tool/before': 'beforeTool',
  'tool/failure': 'toolFailure',
  'compact/before': 'compactBefore',
  'compact/after': 'compactAfter',
  'permission/request': 'permissionRequest',
  'permission/denied': 'permissionDenied',
  'stop/failure': 'stopFailure',
  'file/change': 'fileChange',
  'config/change': 'configChange',
  'task/create': 'taskCreate',
  'task/complete': 'taskComplete',
  'agent/idle': 'agentIdle',
  'model-switch/before': 'modelSwitchBefore',
  'model-switch/after': 'modelSwitchAfter',
  'workspace/open': 'workspaceOpen',
});

const knownHookTools = new Set<CanonicalHookTool>([
  'shell',
  'file.read',
  'file.write',
  'mcp',
  'agent',
]);

const eventSlug = (event: CanonicalHookEvent): string =>
  event.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const slug = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length === 0 ? 'handler' : normalized;
};

const mcpEntryName = (name: string): string => {
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `mcp-${slug(name)}-${hash}.mjs`;
};

/** Anchored alias contract for generated target-local MCP entry modules. */
export const mcpEntryAliasPattern = /^mcp\/(mcp-[a-z0-9-]+-[a-f\d]{8}\.mjs)$/u;

/**
 * The `src/mcp/<server-id>.ts` convention: the stdio entry for a declared MCP
 * server that names no entry, command, or url. Config always wins — an
 * explicit `entry` suppresses the lookup entirely.
 */
export const conventionalMcpEntrySource = (root: string, serverName: string): string | undefined =>
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u.test(serverName)
    ? conventionalEntryAt(root, 'src', 'mcp', serverName)
    : undefined;

/** The `src/cli.ts` convention: the package bin entry when config is silent. */
export const conventionalCliEntrySource = (root: string): string | undefined =>
  conventionalEntryAt(root, 'src', 'cli');

/** The `src/index.ts` convention: the package library entry when config is silent. */
export const conventionalIndexEntrySource = (root: string): string | undefined =>
  conventionalEntryAt(root, 'src', 'index');

const safePackageOutputName = (name: string): boolean =>
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u.test(name);

/**
 * The framework-owned package build output directory, relative to the project
 * root. `dist` is one of the mandatory-ignored directory names, so package
 * outputs never enter project source snapshots or skill/asset discovery.
 */
export const packageBuildOutputDir = 'dist';

/** The default artifact output directory of `agent-bundle build`, relative to the project root. */
export const defaultArtifactDistPath = 'dist';

/** The non-overlapping artifact default used when package outputs are built in the same operation. */
export const defaultPackageArtifactDistPath = 'artifact';

export type ArtifactDistPathIssue = 'path' | 'reserved' | 'shape';

const reservedArtifactDistPathSegments = new Set([
  '.agent-bundle',
  '.git',
  'node_modules',
  'src',
]);

export const isArtifactOutputConfig = (
  value: unknown,
): value is Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

/** Classifies one configured artifact output path without consulting the filesystem. */
export const artifactDistPathIssue = (value: unknown): ArtifactDistPathIssue | undefined => {
  if (typeof value !== 'string' || value.length === 0) return 'shape';
  if (posix.isAbsolute(value) || win32.isAbsolute(value) || value.includes('\\')) return 'path';
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return 'path';
  }
  return reservedArtifactDistPathSegments.has(segments[0]!.toLowerCase()) ? 'reserved' : undefined;
};

/** Returns the validated config path, falling back so downstream path resolution cannot throw on malformed input. */
export const configuredArtifactDistPath = (
  config: AgentBundleConfig,
  fallback = defaultArtifactDistPath,
): string => {
  try {
    const output = config.output as unknown;
    if (!isArtifactOutputConfig(output)) return fallback;
    const distPath = output.distPath;
    return artifactDistPathIssue(distPath) === undefined
      ? distPath as string
      : fallback;
  } catch {
    return fallback;
  }
};

/**
 * The framework-generated routed-CLI bin (#102 stage 2): a generated-mode
 * `src/cli/**` surface with at least one compiled command becomes one
 * executable named after the plugin, exactly where the `src/cli.ts`
 * convention would have placed it. Rendered routes that compiled no command
 * are hard source-validation errors (AB4816), so omitting them here is
 * deterministic hygiene, never a silent choice.
 */
const generatedCliBinEntry = (
  config: Readonly<AgentBundleConfig>,
  routeCli: CompiledCliSurface | undefined,
): NormalizedBinEntry | undefined => {
  if (routeCli?.mode !== 'generated' || !safePackageOutputName(config.plugin.name)) return undefined;
  const commands = routeCli.commands ?? [];
  if (commands.length === 0) return undefined;
  const commandRouteIds = new Set(commands.map((command) => command.routeId));
  const routes = routeCli.routes.filter((route) => commandRouteIds.has(route.id));
  const source = routes[0]!.source;
  // A tool's projection module (#596) is a source of the bin like the route
  // it projects; the graph keeps the absolute paths off its digest, so they
  // travel here, not through `commands`.
  const projectionSources = Object.fromEntries(
    Object.entries(routeCli.projectionSources ?? {}).filter(([routeId]) => commandRouteIds.has(routeId)),
  );
  return {
    generatedCli: {
      commands,
      ...(Object.keys(projectionSources).length === 0 ? {} : { projectionSources }),
      routes,
    },
    id: `bin:${config.plugin.name}`,
    name: config.plugin.name,
    provenance: { kind: 'conventional', sourcePath: source },
    source,
  };
};

const normalizeBinEntries = (
  config: Readonly<AgentBundleConfig>,
  root: string,
  configPath: string,
  routeCli: CompiledCliSurface | undefined,
): readonly NormalizedBinEntry[] => {
  if (config.bin === false) return [];
  const generated = generatedCliBinEntry(config, routeCli);
  if (config.bin !== undefined) {
    const explicit = Object.entries(config.bin)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, input]) => {
        const declaration = input as string | AgentBundleBinEntry;
        const entry = typeof declaration === 'string' ? declaration : declaration.entry;
        return {
          id: `bin:${name}`,
          name,
          provenance: { kind: 'config' as const, sourcePath: configPath },
          source: resolve(root, entry),
        };
      });
    // Config always wins one name: an explicit bin claiming the plugin name
    // shadows the generated CLI, and source validation reports the collision.
    return generated === undefined || explicit.some((entry) => entry.name === generated.name)
      ? explicit
      : [...explicit, generated].sort((left, right) => left.name.localeCompare(right.name));
  }
  if (generated !== undefined) return [generated];
  const conventional = conventionalCliEntrySource(root);
  if (conventional === undefined || !safePackageOutputName(config.plugin.name)) return [];
  return [{
    id: `bin:${config.plugin.name}`,
    name: config.plugin.name,
    provenance: { kind: 'conventional' as const, sourcePath: conventional },
    source: conventional,
  }];
};

const normalizeLibEntry = (
  config: Readonly<AgentBundleConfig>,
  root: string,
  configPath: string,
): NormalizedLibEntry | undefined => {
  if (config.lib === false) return undefined;
  if (config.lib !== undefined) {
    const declaration = config.lib as string | AgentBundleLibEntry;
    const entry = typeof declaration === 'string' ? declaration : declaration.entry;
    const source = resolve(root, entry);
    const name = basename(source, extname(source));
    return {
      dts: typeof declaration === 'string' ? true : declaration.dts !== false,
      id: `lib:${name}`,
      name,
      provenance: { kind: 'config', sourcePath: configPath },
      source,
    };
  }
  const conventional = conventionalIndexEntrySource(root);
  if (conventional === undefined) return undefined;
  return {
    dts: true,
    id: 'lib:index',
    name: 'index',
    provenance: { kind: 'conventional', sourcePath: conventional },
    source: conventional,
  };
};

/**
 * The framework-owned npm package build: explicit `bin`/`lib` config wins,
 * the `src/cli.ts` and `src/index.ts` conventions fill the gaps (a
 * generated-mode `src/cli/**` command surface supersedes the `src/cli.ts`
 * bin convention), and `false` opts a project out of a convention entirely.
 */
export const normalizePackageBuild = (
  config: Readonly<AgentBundleConfig>,
  root: string,
  configPath: string,
  routeCli?: CompiledCliSurface,
): NormalizedPackageBuild | undefined => {
  const bins = normalizeBinEntries(config, root, configPath, routeCli);
  const lib = normalizeLibEntry(config, root, configPath);
  if (bins.length === 0 && lib === undefined) return undefined;
  return {
    bins,
    ...(lib === undefined ? {} : { lib }),
    outputDir: packageBuildOutputDir,
  };
};

/** The compiler-owned artifact namespaces and documents a payload destination must not shadow. */
export const reservedPayloadDestinations = Object.freeze(new Set([
  'AGENTS.md',
  'assets',
  'bin',
  'commands',
  'hooks',
  'mcp',
  'mcp-apps',
  'mcp.json',
  'output-styles',
  'plugin.json',
  'rules',
  'scripts',
  'skills',
  'workflows',
]));

const normalizePayloads = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  targetNames: readonly string[],
): readonly NormalizedPayload[] => {
  const configured = loaded.config.payload;
  if (configured === undefined || !isRecord(configured)) return [];
  const discoveredByName = new Map((discovered.payloads ?? []).map((payload) => [payload.name, payload]));
  const payloads: NormalizedPayload[] = [];
  for (const [name, declaration] of Object.entries(configured).sort(([left], [right]) => left.localeCompare(right))) {
    const source = payloadDeclarationSource(loaded.context.projectRoot, declaration);
    if (source === undefined) continue;
    payloads.push({
      files: (discoveredByName.get(name)?.files ?? []).map((file) => ({ ...file })),
      id: `payload:${name}`,
      name,
      provenance: { kind: 'prebuilt', sourcePath: loaded.configPath },
      source,
      targets: sortedUnique(typeof declaration === 'string' ? targetNames : (declaration.targets ?? targetNames)),
    });
  }
  return payloads;
};

/** The innermost declared payload whose source directory contains the file. */
export const owningPayload = <Payload extends { readonly source: string }>(
  payloads: readonly Payload[],
  source: string,
): Payload | undefined => {
  let best: Payload | undefined;
  for (const payload of payloads) {
    if (!isInside(payload.source, source)) continue;
    if (best === undefined || payload.source.length > best.source.length) best = payload;
  }
  return best;
};

/**
 * The artifact-relative stable path of a prebuilt file: its declaring payload
 * destination plus the file's payload-relative path. Falls back to the
 * project-relative path when no declared payload contains the file — source
 * validation (AB4744) reports that state before any build consumes it.
 */
export const prebuiltArtifactPath = (
  payloads: readonly NormalizedPayload[],
  root: string,
  source: string,
): string => {
  const payload = owningPayload(payloads, source);
  return payload === undefined
    ? relative(root, source).replaceAll('\\', '/')
    : `${payload.name}/${relative(payload.source, source).replaceAll('\\', '/')}`;
};

const isHookEntryList = (
  input: AgentBundleHookInput,
): input is readonly (string | AgentBundleHookEntry)[] => Array.isArray(input);

const asEntries = (input: AgentBundleHookInput): readonly (string | AgentBundleHookEntry)[] =>
  isHookEntryList(input) ? input : [input];

const normalizeNativeHookTools = (
  selectors: readonly string[],
  registry: NormalizationTargetRegistry,
): NativeHookToolSelector[] => {
  const seen = new Set<string>();
  const nativeTools: NativeHookToolSelector[] = [];
  for (const selector of selectors) {
    if (knownHookTools.has(selector as CanonicalHookTool)) continue;
    const parsed = parseNativeHookToolSelector(selector);
    if (parsed === undefined || !registry.supports(parsed.target, 'hooks')) continue;
    const key = `${parsed.target}:${parsed.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nativeTools.push(parsed);
  }
  return nativeTools.sort((left, right) =>
    left.target.localeCompare(right.target) || left.name.localeCompare(right.name));
};

const normalizeHook = (
  event: CanonicalHookEvent,
  input: string | AgentBundleHookEntry,
  root: string,
  defaultTargets: readonly string[],
  provenance: SourceProvenance,
  registry: NormalizationTargetRegistry,
  payloads: readonly NormalizedPayload[],
): NormalizedHook => {
  const entry = typeof input === 'string' ? { handler: input } : input;
  const handlerInput = entry.handler;
  const prebuilt = isPrebuiltEntryInput(handlerInput);
  const source = resolve(root, prebuilt ? handlerInput.prebuilt : handlerInput);
  const handler = relative(root, source).replaceAll('\\', '/');
  const prebuiltPath = prebuilt ? prebuiltArtifactPath(payloads, root, source) : undefined;
  // Non-string arguments are a validation error (AB4746); normalization trusts the declared type.
  const args = prebuilt ? entry.args : undefined;
  const tools = sortedUnique(entry.tools ?? []).filter(
    (tool): tool is CanonicalHookTool => knownHookTools.has(tool as CanonicalHookTool),
  );
  const targets = sortedUnique(entry.targets ?? defaultTargets);
  const nativeTools = normalizeNativeHookTools(entry.tools ?? [], registry);
  const timeout = entry.timeout;
  const timeoutMs = timeout === undefined ? undefined : timeout * 1_000;
  const identity = {
    ...(args === undefined || args.length === 0 ? {} : { args }),
    event,
    handler,
    ...(nativeTools.length === 0 ? {} : { nativeTools }),
    ...(prebuiltPath === undefined ? {} : { prebuiltPath }),
    targets,
    timeout: timeout ?? 'host-default',
    tools,
  };
  const hash = digest(identity).slice(0, 8);
  const eventName = eventSlug(event);
  const handlerName = slug(basename(source, extname(source)));
  const name = `${eventName}-${handlerName}-${hash}`;

  return {
    ...(args === undefined || args.length === 0 ? {} : { args: [...args] }),
    event,
    id: `hook:${eventName}:${handlerName}:${hash}`,
    name,
    ...(nativeTools.length === 0 ? {} : { nativeTools }),
    ...(prebuiltPath === undefined ? {} : { prebuiltPath }),
    provenance: prebuilt ? { kind: 'prebuilt', sourcePath: provenance.sourcePath } : { ...provenance },
    source,
    targets,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    tools,
  };
};

const normalizeHooks = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  targetNames: readonly string[],
  registry: NormalizationTargetRegistry,
  payloads: readonly NormalizedPayload[],
): readonly NormalizedHook[] => {
  const hooks: NormalizedHook[] = [];
  const config = loaded.config.hooks;
  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };

  if (config !== undefined) {
    for (const event of hookEvents) {
      const input = config[event];
      if (input === undefined) continue;
      for (const entry of asEntries(input)) {
        const inherited = typeof entry === 'string' || entry.targets === undefined;
        const hookTargets = inherited
          ? targetNames.filter((target) => registry.supports(target, 'hooks'))
          : targetNames;
        hooks.push(normalizeHook(event, entry, loaded.context.projectRoot, hookTargets, provenance, registry, payloads));
      }
    }
  }

  for (const route of discovered.routeGraph?.events ?? []) {
    const event = route.event!;
    const selected = route.config['targets'];
    const targets = sortedUnique(
      (Array.isArray(selected) ? selected.filter((target): target is string => typeof target === 'string') : targetNames)
        .filter((target) => targetNames.includes(target)),
    );
    const tools = (Array.isArray(route.config['tools']) ? route.config['tools'] : [])
      .filter((tool): tool is CanonicalHookTool =>
        typeof tool === 'string' && knownHookTools.has(tool as CanonicalHookTool))
      .sort((left, right) => left.localeCompare(right));
    const configuredTimeoutMs = route.config['timeoutMs'];
    const timeoutMs = typeof configuredTimeoutMs === 'number' && Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : undefined;
    const fallback = route.config['fallback'] === 'standalone' ? 'standalone' as const : 'none' as const;
    const runtime = route.config['runtime'] === 'standalone' ? 'standalone' as const : 'shared' as const;
    const configuredProviders = route.config['providers'];
    const providers = Array.isArray(configuredProviders)
      && configuredProviders.every((provider): provider is string => typeof provider === 'string')
      ? [...configuredProviders]
      : undefined;
    const eventName = event.replace('/', '-');
    hooks.push({
      event: hookEventForRoute[event],
      eventRoute: Object.freeze({
        event,
        fallback,
        ...(route.preflight === undefined
          ? {}
          : {
            preflight: {
              provenance: { ...route.preflight.provenance },
              source: route.preflight.source,
            },
          }),
        ...(providers === undefined ? {} : { providers }),
        runtime,
      }),
      id: `hook:event-route:${eventName}`,
      name: `event-route-${eventName}`,
      provenance: { kind: 'conventional', sourcePath: route.source },
      source: route.source,
      targets,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      tools,
    });
  }

  return hooks.sort((left, right) => left.id.localeCompare(right.id));
};

const normalizeNativeHooks = async (
  loaded: LoadedConfig,
  targetNames: readonly string[],
  registry: NormalizationTargetRegistry,
): Promise<readonly NormalizedNativeHook[]> => {
  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };
  const nativeHooks: NormalizedNativeHook[] = [];
  for (const nativeHookSource of registry.nativeHookSources?.(loaded.config, targetNames) ?? []) {
    if ('issue' in nativeHookSource) {
      nativeHooks.push({
        issue: `source-${nativeHookSource.issue}`,
        provenance: { ...provenance },
        source: loaded.configPath,
        target: nativeHookSource.target,
      });
      continue;
    }
    const { source: configured, target } = nativeHookSource;
    const source = resolve(loaded.context.projectRoot, configured);
    try {
      nativeHooks.push({
        document: JSON.parse(await readFile(source, 'utf8')),
        provenance: { ...provenance },
        source,
        target,
      });
    } catch (error) {
      nativeHooks.push({
        issue: isErrno(error, 'ENOENT') ? 'missing' : 'parse',
        provenance: { ...provenance },
        source,
        target,
      });
    }
  }
  return nativeHooks;
};

const enumerateHostPayloadFiles = async (source: string): Promise<readonly NormalizedHostBinFile[]> => {
  const files: NormalizedHostBinFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await stat(path);
      files.push({
        bytes: metadata.size,
        executable: (metadata.mode & 0o111) !== 0,
        relativePath: relative(source, path).replaceAll('\\', '/'),
        source: path,
      });
    }
  };
  await visit(source);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};

const normalizeHostBins = async (
  loaded: LoadedConfig,
  targetNames: readonly string[],
  registry: NormalizationTargetRegistry,
): Promise<readonly NormalizedHostBin[]> =>
  normalizeHostPayloadDirectories(loaded, registry.binSources?.(loaded.config, targetNames) ?? []);

const normalizeHostPayloadDirectories = async (
  loaded: LoadedConfig,
  sources: readonly NormalizationHostPayloadSource[],
): Promise<readonly NormalizedHostPayloadDirectory[]> => {
  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };
  const directories: NormalizedHostPayloadDirectory[] = [];
  for (const declaredSource of sources) {
    if ('issue' in declaredSource) {
      directories.push({
        files: [],
        issue: `source-${declaredSource.issue}`,
        provenance: { ...provenance },
        source: loaded.configPath,
        target: declaredSource.target,
      });
      continue;
    }
    const source = resolve(dirname(loaded.configPath), declaredSource.source);
    if (!isInside(loaded.context.projectRoot, source)) {
      directories.push({
        files: [],
        issue: 'outside',
        provenance: { ...provenance },
        source,
        target: declaredSource.target,
      });
      continue;
    }
    let metadata;
    try {
      metadata = await stat(source);
    } catch {
      directories.push({
        files: [],
        issue: 'missing',
        provenance: { ...provenance },
        source,
        target: declaredSource.target,
      });
      continue;
    }
    if (!metadata.isDirectory()) {
      directories.push({
        files: [],
        issue: 'not-directory',
        provenance: { ...provenance },
        source,
        target: declaredSource.target,
      });
      continue;
    }
    const [projectRealPath, sourceRealPath] = await Promise.all([
      realpath(loaded.context.projectRoot),
      realpath(source),
    ]);
    if (!isInside(projectRealPath, sourceRealPath)) {
      directories.push({
        files: [],
        issue: 'outside',
        provenance: { ...provenance },
        source,
        target: declaredSource.target,
      });
      continue;
    }
    const files = await enumerateHostPayloadFiles(source);
    directories.push({
      files,
      ...(files.length === 0 ? { issue: 'empty' as const } : {}),
      provenance: { ...provenance },
      source,
      target: declaredSource.target,
    });
  }
  return directories;
};

const normalizeMcpServer = (
  name: string,
  server: AgentBundleMcpServer,
  root: string,
  defaultTargets: readonly string[],
  provenance: SourceProvenance,
  payloads: readonly NormalizedPayload[],
): NormalizedMcpServer => {
  const targets = sortedUnique(server.targets ?? defaultTargets);
  const conventionalEntry =
    server.entry === undefined && server.command === undefined && server.url === undefined
      ? conventionalMcpEntrySource(root, name)
      : undefined;
  const common = {
    id: `mcp:${name}`,
    name,
    provenance: conventionalEntry === undefined
      ? { ...provenance }
      : { kind: 'conventional' as const, sourcePath: conventionalEntry },
    targets,
  };

  if (isPrebuiltEntryInput(server.entry)) {
    // A prebuilt stdio entry lowers to a command-shaped server whose first
    // argument is the payload-stable path anchored on the plugin-root token,
    // so every adapter's existing token expansion, env-anchor injection, and
    // artifact-reference validation applies unchanged.
    const prebuiltSource = resolve(root, server.entry.prebuilt);
    return {
      ...common,
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
      args: [
        `${pathTokens.pluginRoot}/${prebuiltArtifactPath(payloads, root, prebuiltSource)}`,
        ...(server.args ?? []),
      ],
      command: 'node',
      cwd: pathTokens.pluginRoot,
      provenance: { kind: 'prebuilt', sourcePath: provenance.sourcePath },
      transport: 'stdio',
    };
  }

  if (server.entry !== undefined || conventionalEntry !== undefined) {
    const entryName = mcpEntryName(name);
    return {
      ...common,
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
      args: [`mcp/${entryName}`, ...(server.args ?? [])],
      command: 'node',
      cwd: pathTokens.pluginRoot,
      source: server.entry === undefined ? conventionalEntry! : resolve(root, server.entry),
      transport: 'stdio',
    };
  }

  if (server.command !== undefined) {
    return {
      ...common,
      ...(server.args === undefined ? {} : { args: [...server.args] }),
      command: server.command,
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
      transport: 'stdio',
    };
  }

  return {
    ...common,
    ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
    transport: server.transport!,
    url: server.url!,
  };
};

const normalizeMcpServers = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  targetNames: readonly string[],
  payloads: readonly NormalizedPayload[],
): readonly NormalizedMcpServer[] => {
  const configured = loaded.config.mcp?.servers ?? {};
  const generated = new Map((discovered.routeGraph?.servers ?? [])
    .filter((server) => server.mode === 'generated' && server.routes.length > 0)
    .map((server) => [server.name, server]));
  const names = sortedUnique([...Object.keys(configured), ...generated.keys()]);
  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };

  return names.map((name) => {
    const routeServer = generated.get(name);
    if (routeServer === undefined) {
      return normalizeMcpServer(name, configured[name]!, loaded.context.projectRoot, targetNames, provenance, payloads);
    }
    const declaration = configured[name] ?? {};
    const source = routeServer.routes[0]!.source;
    return {
      ...(declaration.env === undefined ? {} : { env: { ...declaration.env } }),
      args: [`mcp/${mcpEntryName(name)}`, ...(declaration.args ?? [])],
      command: 'node',
      cwd: pathTokens.pluginRoot,
      generatedRoutes: routeServer.routes,
      id: routeServer.id,
      name,
      provenance: { kind: 'conventional', sourcePath: source },
      source,
      targets: sortedUnique(declaration.targets ?? targetNames),
      transport: 'stdio',
    };
  });
};

const normalizeMcpApps = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  servers: readonly NormalizedMcpServer[],
): readonly NormalizedMcpApp[] => {
  const configured = loaded.config.mcp?.servers ?? {};
  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };
  const serverByName = new Map(servers.map((server) => [server.name, server]));
  const apps: NormalizedMcpApp[] = [];

  for (const [serverName, rawServer] of Object.entries(configured).sort(([left], [right]) => left.localeCompare(right))) {
    const server = serverByName.get(serverName);
    if (server === undefined || rawServer.apps === undefined) continue;
    // Apps require a local server entry: a compiled source entry, or a prebuilt one.
    const prebuilt = server.provenance.kind === 'prebuilt';
    if (server.source === undefined && !prebuilt) continue;
    for (const [name, app] of Object.entries(rawServer.apps).sort(([left], [right]) => left.localeCompare(right))) {
      const declaration = app as AgentBundleMcpApp;
      apps.push({
        ...(declaration._meta === undefined ? {} : { _meta: structuredClone(declaration._meta) }),
        id: `mcp-app:${serverName}:${name}`,
        name,
        ...(prebuilt ? { prebuilt: true as const } : {}),
        provenance: { ...provenance },
        resourceUri: declaration.resourceUri,
        serverId: server.id,
        serverName,
        source: resolve(loaded.context.projectRoot, declaration.entry),
        targets: sortedUnique(declaration.targets ?? server.targets),
        ...(declaration.template === undefined ? {} : { template: resolve(loaded.context.projectRoot, declaration.template) }),
      });
    }
  }

  for (const surface of discovered.routeGraph?.servers ?? []) {
    if (surface.mode !== 'generated') continue;
    const server = serverByName.get(surface.name);
    if (server === undefined) continue;
    for (const route of surface.routes) {
      if (route.kind !== 'app') continue;
      const resourceUri = route.config['resourceUri'];
      if (typeof resourceUri !== 'string' || resourceUri.trim() === '') continue;
      const name = mcpRouteProtocolName(route.id);
      const declaredTargets = route.config['targets'];
      const targets = Array.isArray(declaredTargets) && declaredTargets.every((target) => typeof target === 'string')
        ? declaredTargets
        : server.targets;
      const metadata = route.config['_meta'];
      const template = route.config['template'];
      // Route-relative first, legacy project-root-relative when unambiguous;
      // the route-graph compiler already reported AB4827 for the other cases.
      const templatePath = typeof template === 'string'
        ? appRouteTemplatePath(resolveAppRouteTemplate(loaded.context.projectRoot, route.source, template))
        : undefined;
      apps.push({
        ...(isRecord(metadata) ? { _meta: structuredClone(metadata) } : {}),
        id: `mcp-app:${surface.name}:${name}`,
        name,
        provenance: { kind: 'conventional', sourcePath: route.source },
        resourceUri,
        serverId: surface.id,
        serverName: surface.name,
        source: route.source,
        targets: sortedUnique(targets),
        ...(templatePath === undefined ? {} : { template: templatePath }),
      });
    }
  }

  return apps.sort((left, right) => left.id.localeCompare(right.id));
};

const bundleExtensions = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);

const scriptMode = (source: string): 'bundle' | 'copy' =>
  bundleExtensions.has(extname(source).toLowerCase()) ? 'bundle' : 'copy';

const normalizeScripts = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  targetNames: readonly string[],
): readonly NormalizedScript[] => {
  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };
  const explicit = Object.entries(loaded.config.scripts ?? {}).map(([name, input]): NormalizedScript => {
    const declaration = input as AgentBundleScriptInput;
    const entry = typeof declaration === 'string' ? declaration : declaration.entry;
    const source = resolve(loaded.context.projectRoot, entry);
    return {
      id: `script:${name}`,
      mode: scriptMode(source),
      name,
      provenance: { ...provenance },
      source,
      targets: sortedUnique(typeof declaration === 'string' ? targetNames : (declaration.targets ?? targetNames)),
    };
  });
  // Conventional `src/scripts/` routes ship through the same pipeline as
  // explicit entries (#102 stage 1); rendered (`.tsx`/`.jsx`) routes ship
  // through the Agent renderer pipeline (#102 stage 3). The judgment is
  // shared with source validation: routes neither pipeline can ship (nested,
  // or conflicting with a configured name) are AB4808/AB4809 errors there,
  // so omitting them here is deterministic hygiene, never a silent choice.
  const configured = configuredScriptNames(loaded.config);
  const conventional = (discovered.routeGraph?.scripts ?? [])
    .flatMap((route): NormalizedScript[] => {
      const judgment = judgeScriptRoute(route, configured);
      if (judgment !== 'shippable' && judgment !== 'rendered') return [];
      return [{
        id: route.id,
        mode: scriptMode(route.source),
        name: scriptRouteName(route),
        provenance: { kind: 'conventional', sourcePath: route.source },
        ...(judgment === 'rendered' ? { rendered: true as const } : {}),
        source: route.source,
        targets: sortedUnique(targetNames),
      }];
    });
  return [...explicit, ...conventional].sort((left, right) => left.name.localeCompare(right.name));
};

export const configExtensionFiniteJsonDiagnosticMessage = 'A registered config extension must contain strict finite JSON data.';

const finiteJsonExtensionErrors = new WeakSet<object>();

class ConfigExtensionFiniteJsonError extends Error {
  constructor() {
    super(`AB4500: ${configExtensionFiniteJsonDiagnosticMessage}`);
    this.name = 'ConfigExtensionFiniteJsonError';
    finiteJsonExtensionErrors.add(this);
  }
}

/** Identifies only finite-JSON failures constructed by this module. */
export const isConfigExtensionFiniteJsonError = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && finiteJsonExtensionErrors.has(value);

const invalidExtensionValue = (): never => {
  throw new ConfigExtensionFiniteJsonError();
};

const cloneExtensionValue = (
  value: unknown,
  ancestors = new Set<object>(),
): unknown => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : invalidExtensionValue();
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return invalidExtensionValue();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const clone: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          return invalidExtensionValue();
        }
        clone.push(cloneExtensionValue(descriptor.value, ancestors));
      }
      for (const property of Reflect.ownKeys(value)) {
        if (property === 'length') continue;
        if (typeof property !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(property) || Number(property) >= value.length) {
          return invalidExtensionValue();
        }
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidExtensionValue();
    }
    const clone = Object.create(null) as Record<string, unknown>;
    for (const property of Reflect.ownKeys(value)) {
      if (typeof property !== 'string') return invalidExtensionValue();
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return invalidExtensionValue();
      }
      clone[property] = cloneExtensionValue(descriptor.value, ancestors);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
};

const normalizeExtensions = (
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
  provenance: SourceProvenance,
): Readonly<Record<string, NormalizedConfigExtension>> => {
  const extensions = Object.create(null) as Record<string, NormalizedConfigExtension>;
  const descriptors = registry.configExtensions();

  for (const descriptor of [...descriptors].sort((left, right) => left.key.localeCompare(right.key))) {
    if (!Object.hasOwn(loaded.config, descriptor.key)) continue;
    const value = loaded.config[descriptor.key];
    extensions[descriptor.key] = {
      id: `extension:${descriptor.key}`,
      key: descriptor.key,
      provenance: { ...provenance },
      target: descriptor.target,
      value: cloneExtensionValue(value),
    };
  }

  return deepFreeze(extensions);
};

/**
 * Total, injective escape for one `lsp:` id segment: `%` first, then the `:`
 * separator. Unlike `encodeURIComponent` it accepts every JavaScript string
 * (lone surrogates included), so a computed key can never abort normalization.
 */
const lspIdSegment = (segment: string): string => segment.replaceAll('%', '%25').replaceAll(':', '%3A');

/**
 * Enumerates `lsp` components (#100) from every selected host extension's
 * `lspServers` record. Server configuration stays opaque here — the declaring
 * adapter validates and lowers it — so a malformed record yields no component
 * and the adapter's own diagnostics explain it. The declaration is host-scoped:
 * a component targets only the selected adapter that owns its extension key,
 * so every other host is excluded by the declaration and its pinned `lsp` row
 * still explains the omission in inspection.
 */
const normalizeLspServers = (
  extensions: Readonly<Record<string, NormalizedConfigExtension>>,
  targetNames: readonly string[],
): readonly NormalizedLspServer[] => {
  const servers: NormalizedLspServer[] = [];
  for (const extension of Object.values(extensions)) {
    if (!isRecord(extension.value)) continue;
    const declared = extension.value['lspServers'];
    if (!isRecord(declared)) continue;
    // A host-scoped `<key>.lspServers` declaration is emitted only by the
    // declaring host; no other projection reads that extension.
    const targets = targetNames.filter((target) => target === extension.target);
    for (const name of Object.keys(declared).sort((left, right) => left.localeCompare(right))) {
      servers.push({
        declaredBy: extension.key,
        // Extension keys and server names are unrestricted on advanced
        // adapters, so each segment escapes the separator to keep the tuple
        // unambiguous (`a` + `b:c` never collides with `a:b` + `c`); the
        // common `lsp:claude:typescript` shape is unchanged.
        id: `lsp:${lspIdSegment(extension.key)}:${lspIdSegment(name)}`,
        name,
        provenance: { ...extension.provenance },
        targets,
      });
    }
  }
  return servers.sort((left, right) => left.id.localeCompare(right.id));
};

/**
 * The selected projections, by precedence: `--target` flags, then the config
 * `targets`, then the registry default (`portable`). The selection is a set —
 * sorted by name so reordering `targets` cannot change one byte of the
 * composite root (#555).
 */
const selectedTargetNames = (
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
): string[] => {
  if (loaded.context.selectedTargets.length > 0) {
    return sortedUnique(loaded.context.selectedTargets);
  }

  if (loaded.config.targets !== undefined) {
    return sortedUnique(loaded.config.targets);
  }

  return sortedUnique(registry.defaultTargetNames());
};

const skillProvenance = (
  loaded: LoadedConfig,
  sourcePath: string,
): SourceProvenance => ({
  kind: loaded.config.skills === undefined ? 'conventional' : 'explicit',
  sourcePath,
});

const normalizePluginLogo = (loaded: LoadedConfig): NormalizedPluginLogo | undefined => {
  const declared = loaded.config.plugin.logo;
  if (typeof declared !== 'string' || declared.trim().length === 0) return undefined;
  const projectRoot = loaded.context.projectRoot;
  const source = resolve(projectRoot, declared);
  if (!isInside(projectRoot, source) || !existsSync(source)) return undefined;
  const stats = statSync(source);
  if (!stats.isFile()) return undefined;
  return {
    bytes: stats.size,
    path: posix.join('assets', relative(projectRoot, source).split(sep).join(posix.sep)),
    source,
  };
};

const normalizeAssets = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  targetNames: readonly string[],
): NormalizedAsset[] => (discovered.assets ?? []).map((asset) => ({
  bytes: asset.bytes,
  id: `asset:${asset.relativePath}`,
  name: asset.relativePath,
  provenance: {
    kind: loaded.config.assets === undefined ? 'conventional' as const : 'explicit' as const,
    sourcePath: loaded.configPath,
  },
  relativePath: asset.relativePath,
  source: asset.source,
  targets: [...targetNames],
}));

const normalizeCommands = (
  discovered: DiscoveredProject,
  targetNames: readonly string[],
): readonly NormalizedCommand[] => (discovered.commands ?? []).map((command) => {
  const name = basename(command.source, extname(command.source));
  const targets = command.authoredTargets === undefined
    ? [...targetNames]
    : sortedUnique(command.authoredTargets.filter((target) => targetNames.includes(target)));
  return {
    body: command.body,
    frontmatter: structuredClone(command.frontmatter),
    id: `command:${name}`,
    markdown: command.markdown,
    name,
    provenance: { kind: 'conventional', sourcePath: command.source },
    source: command.source,
    targets,
  };
});

const normalizeRules = (
  discovered: DiscoveredProject,
  targetNames: readonly string[],
): readonly NormalizedRule[] => (discovered.rules ?? []).map((rule) => {
  const name = basename(rule.source, extname(rule.source));
  const targets = rule.authoredTargets === undefined
    ? [...targetNames]
    : sortedUnique(rule.authoredTargets.filter((target) => targetNames.includes(target)));
  return {
    body: rule.body,
    emittedMarkdown: rule.emittedMarkdown,
    frontmatter: structuredClone(rule.frontmatter),
    id: `rule:${name}`,
    markdown: rule.markdown,
    name,
    provenance: { kind: 'conventional', sourcePath: rule.source },
    source: rule.source,
    targets,
  };
});

/** Selects the generated-executable floor; invalid raises fall back to the default the validator rejected. */
const normalizeRuntime = (loaded: LoadedConfig): NormalizedRuntime => {
  const node = loaded.config.runtime?.node;
  const version = typeof node === 'string' ? parseRuntimeVersion(node) : undefined;
  return version !== undefined && satisfiesGeneratedRuntimeFloor(version)
    ? { node: formatRuntimeVersion(version) }
    : defaultGeneratedRuntime;
};

export const normalizeProject = async (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  registry: NormalizationTargetRegistry,
): Promise<NormalizedPlugin> => {
  const targetNames = selectedTargetNames(loaded, registry);
  const configProvenance: SourceProvenance = {
    kind: 'config',
    sourcePath: loaded.configPath,
  };
  const skillHosts = loweringHosts(targetNames);
  const skills: NormalizedSkill[] = discovered.skills.map((skill) => {
    const frontmatter = structuredClone(skill.frontmatter);
    const declaredName = frontmatter.name;
    const name =
      typeof declaredName === 'string' && declaredName.length > 0
        ? declaredName
        : basename(skill.dir);
    const description = frontmatter.description;
    const skillIr = parseSkillIr(skill);
    const hostDocuments = lowerSkillIrForHosts(skillIr, skillHosts);

    return {
      body: skill.body,
      ...(typeof description === 'string' ? { description } : {}),
      dir: skill.dir,
      frontmatter,
      hostDocuments,
      id: `skill:${name}`,
      ...(skill.rendered === true ? { markdown: skill.markdown } : {}),
      name,
      provenance: skillProvenance(loaded, skill.source),
      resources: skill.resources.map((resource) => ({ ...resource })),
      skillIr,
      skillTreeLayout: decideSkillTreeLayout(hostDocuments),
      source: skill.source,
      targets: [...targetNames],
    };
  });
  const description = loaded.config.plugin.description;
  const logo = normalizePluginLogo(loaded);
  // The npm package axes are derived, never authored in config: package.json
  // is authoritative for release identity (issue #94), while plugin.version
  // remains the host-facing declared version during the migration. The same
  // derivation serves `agent-bundle/meta` to rendered skills at discovery.
  const identity = pluginIdentity(loaded.context.projectRoot, loaded.config);
  const hostBins = await normalizeHostBins(loaded, targetNames, registry);
  const hostOutputStyles = await normalizeHostPayloadDirectories(
    loaded,
    registry.outputStyleSources?.(loaded.config, targetNames) ?? [],
  );
  const hostWorkflows = await normalizeHostPayloadDirectories(
    loaded,
    registry.workflowSources?.(loaded.config, targetNames) ?? [],
  );
  const nativeHooks = await normalizeNativeHooks(loaded, targetNames, registry);
  const payloads = normalizePayloads(loaded, discovered, targetNames);
  const mcpServers = normalizeMcpServers(loaded, discovered, targetNames, payloads);
  const scripts = normalizeScripts(loaded, discovered, targetNames);
  const assets = normalizeAssets(loaded, discovered, targetNames);
  const commands = normalizeCommands(discovered, targetNames);
  const providers = discovered.routeGraph?.providers ?? [];
  const layouts = discovered.routeGraph?.layouts ?? [];
  const rules = normalizeRules(discovered, targetNames);
  const state: NormalizedStateDefinition | undefined = discovered.state?.definition === undefined
    ? undefined
    : {
      ...discovered.state.definition,
      provenance: { kind: 'conventional', sourcePath: discovered.state.source },
      source: discovered.state.source,
    };
  const notices = normalizeNoticeRetention(loaded.config, loaded.configPath, state !== undefined).retention;
  const packageBuild = normalizePackageBuild(
    loaded.config,
    loaded.context.projectRoot,
    loaded.configPath,
    discovered.routeGraph?.cli,
  );
  const extensions = normalizeExtensions(loaded, registry, configProvenance);
  const lspServers = normalizeLspServers(extensions, targetNames);
  const model: NormalizedPlugin = {
    ...(assets.length === 0 ? {} : { assets }),
    ...(commands.length === 0 ? {} : { commands }),
    ...(loaded.config.marketplace === true ? { marketplace: true as const } : {}),
    extensions,
    ...(hostBins.length === 0 ? {} : { hostBins }),
    ...(hostOutputStyles.length === 0 ? {} : { hostOutputStyles }),
    ...(hostWorkflows.length === 0 ? {} : { hostWorkflows }),
    ...(layouts.length === 0 ? {} : { layouts }),
    ...(lspServers.length === 0 ? {} : { lspServers }),
    metadata: {
      ...(typeof description === 'string' ? { description } : {}),
      id: `plugin:${loaded.config.plugin.name}`,
      ...(logo === undefined ? {} : { logo }),
      name: identity.name,
      ...(identity.packageName === undefined ? {} : { packageName: identity.packageName }),
      ...(identity.packageVersion === undefined ? {} : { packageVersion: identity.packageVersion }),
      provenance: configProvenance,
      version: identity.version,
    },
    mcpApps: normalizeMcpApps(loaded, discovered, mcpServers),
    mcpServers,
    hooks: normalizeHooks(loaded, discovered, targetNames, registry, payloads),
    ...(nativeHooks.length === 0 ? {} : { nativeHooks }),
    ...(notices === undefined ? {} : { notices: { retention: notices } }),
    ...(packageBuild === undefined ? {} : { packageBuild }),
    ...(payloads.length === 0 ? {} : { payloads }),
    ...(providers.length === 0 ? {} : { providers }),
    ...(rules.length === 0 ? {} : { rules }),
    runtime: normalizeRuntime(loaded),
    scripts,
    skills,
    ...(state === undefined ? {} : { state }),
    targets: targetNames.map((name) => ({
      id: `target:${name}`,
      name,
      provenance: { ...configProvenance },
    })),
  };

  return deepFreeze(model);
};
