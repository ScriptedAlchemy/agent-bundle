import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { digest } from '../core/digest.ts';
import {
  defaultGeneratedRuntime,
  formatRuntimeVersion,
  parseRuntimeVersion,
  satisfiesGeneratedRuntimeFloor,
} from '../core/runtime.ts';
import { isPrebuiltEntryInput, parseNativeHookToolSelector, pathTokens } from '../core/types.ts';
import type {
  AgentBundleBinEntry,
  AgentBundleConfig,
  AgentBundleHookEntry,
  AgentBundleHookInput,
  AgentBundleLibEntry,
  AgentBundleMcpApp,
  AgentBundleMcpServer,
  AgentBundlePayloadEntry,
  AgentBundleScriptInput,
  CanonicalHookEvent,
  CanonicalHookTool,
  NativeHookToolSelector,
  NormalizationTargetRegistry,
  NormalizedAsset,
  NormalizedBinEntry,
  NormalizedConfigExtension,
  NormalizedHook,
  NormalizedLibEntry,
  NormalizedMcpApp,
  NormalizedMcpServer,
  NormalizedNativeHook,
  NormalizedPackageBuild,
  NormalizedPayload,
  NormalizedPlugin,
  NormalizedRuntime,
  NormalizedScript,
  NormalizedSkill,
  SourceProvenance,
} from '../core/types.ts';
import type { DiscoveredProject } from './discover.ts';
import type { LoadedConfig } from './load.ts';

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const sortedUnique = (values: readonly string[]): string[] =>
  unique(values).sort((left, right) => left.localeCompare(right));

const hookEvents: readonly CanonicalHookEvent[] = [
  'sessionStart',
  'beforeTool',
  'afterTool',
  'stop',
];

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

const conventionalEntryExtensions = ['.ts', '.tsx'] as const;

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

const normalizeBinEntries = (
  config: Readonly<AgentBundleConfig>,
  root: string,
  configPath: string,
): readonly NormalizedBinEntry[] => {
  if (config.bin === false) return [];
  if (config.bin !== undefined) {
    return Object.entries(config.bin)
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
  }
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
 * the `src/cli.ts` and `src/index.ts` conventions fill the gaps, and `false`
 * opts a project out of a convention entirely.
 */
export const normalizePackageBuild = (
  config: Readonly<AgentBundleConfig>,
  root: string,
  configPath: string,
): NormalizedPackageBuild | undefined => {
  const bins = normalizeBinEntries(config, root, configPath);
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
  'hooks',
  'mcp',
  'mcp-apps',
  'mcp.json',
  'plugin.json',
  'scripts',
  'skills',
]));

const normalizePayloads = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  targetNames: readonly string[],
): readonly NormalizedPayload[] => {
  const configured = loaded.config.payload;
  if (configured === undefined || typeof configured !== 'object' || Array.isArray(configured)) return [];
  const discoveredByName = new Map((discovered.payloads ?? []).map((payload) => [payload.name, payload]));
  const payloads: NormalizedPayload[] = [];
  for (const [name, rawDeclaration] of Object.entries(configured).sort(([left], [right]) => left.localeCompare(right))) {
    const declaration = rawDeclaration as string | AgentBundlePayloadEntry | undefined;
    if (declaration === undefined) continue;
    const entry = typeof declaration === 'string' ? declaration : declaration.source;
    if (typeof entry !== 'string' || entry.trim().length === 0) continue;
    payloads.push({
      files: (discoveredByName.get(name)?.files ?? []).map((file) => ({ ...file })),
      id: `payload:${name}`,
      name,
      provenance: { kind: 'prebuilt', sourcePath: loaded.configPath },
      source: resolve(loaded.context.projectRoot, entry),
      targets: sortedUnique(typeof declaration === 'string' ? targetNames : (declaration.targets ?? targetNames)),
    });
  }
  return payloads;
};

const isInsidePath = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);
  return relativePath.length > 0 && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
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
  let best: NormalizedPayload | undefined;
  for (const payload of payloads) {
    if (!isInsidePath(payload.source, source)) continue;
    if (best === undefined || payload.source.length > best.source.length) best = payload;
  }
  return best === undefined
    ? relative(root, source).replaceAll('\\', '/')
    : `${best.name}/${relative(best.source, source).replaceAll('\\', '/')}`;
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
  const prebuilt = isPrebuiltEntryInput(entry.handler);
  const source = resolve(root, prebuilt ? (entry.handler as { prebuilt: string }).prebuilt : entry.handler as string);
  const handler = relative(root, source).replaceAll('\\', '/');
  const prebuiltPath = prebuilt ? prebuiltArtifactPath(payloads, root, source) : undefined;
  const args = prebuilt && entry.args !== undefined
    ? entry.args.filter((argument): argument is string => typeof argument === 'string')
    : undefined;
  const tools = sortedUnique(entry.tools ?? []).filter(
    (tool): tool is CanonicalHookTool => knownHookTools.has(tool as CanonicalHookTool),
  );
  const targets = sortedUnique(entry.targets ?? defaultTargets);
  const nativeTools = normalizeNativeHookTools(entry.tools ?? [], registry);
  const timeout = entry.timeout;
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
    ...(timeout === undefined ? {} : { timeout }),
    tools,
  };
};

const normalizeHooks = (
  loaded: LoadedConfig,
  targetNames: readonly string[],
  registry: NormalizationTargetRegistry,
  payloads: readonly NormalizedPayload[],
): readonly NormalizedHook[] => {
  const hooks: NormalizedHook[] = [];
  const config = loaded.config.hooks;
  if (config === undefined) return hooks;
  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };

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

  return hooks;
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
        issue: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'parse',
        provenance: { ...provenance },
        source,
        target,
      });
    }
  }
  return nativeHooks;
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
  targetNames: readonly string[],
  payloads: readonly NormalizedPayload[],
): readonly NormalizedMcpServer[] => {
  const servers = loaded.config.mcp?.servers;
  if (servers === undefined) return [];

  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };
  return Object.entries(servers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, server]) =>
      normalizeMcpServer(name, server, loaded.context.projectRoot, targetNames, provenance, payloads));
};

const normalizeMcpApps = (
  loaded: LoadedConfig,
  servers: readonly NormalizedMcpServer[],
): readonly NormalizedMcpApp[] => {
  const configured = loaded.config.mcp?.servers;
  if (configured === undefined) return [];
  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };
  const serverByName = new Map(servers.map((server) => [server.name, server]));
  const apps: NormalizedMcpApp[] = [];

  for (const [serverName, rawServer] of Object.entries(configured).sort(([left], [right]) => left.localeCompare(right))) {
    const server = serverByName.get(serverName);
    // Apps require a local server entry: a compiled source entry, or a
    // prebuilt one — whose payload already carries the served resource, so
    // the app stays a development surface the compiler never re-emits.
    const prebuilt = isPrebuiltEntryInput(rawServer.entry);
    if (server === undefined || (server.source === undefined && !prebuilt) || rawServer.apps === undefined) continue;
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

  return apps;
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
  targetNames: readonly string[],
): readonly NormalizedScript[] => {
  const configured = loaded.config.scripts;
  if (configured === undefined) return [];

  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };
  return Object.entries(configured)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, input]) => {
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
};

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
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

const selectedTargetNames = (
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
): string[] => {
  if (loaded.context.selectedTargets.length > 0) {
    return unique(loaded.context.selectedTargets);
  }

  if (loaded.config.targets !== undefined) {
    return unique(loaded.config.targets);
  }

  return unique(registry.defaultTargetNames());
};

const skillProvenance = (
  loaded: LoadedConfig,
  sourcePath: string,
): SourceProvenance => ({
  kind: loaded.config.skills === undefined ? 'conventional' : 'explicit',
  sourcePath,
});

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
  const skills: NormalizedSkill[] = discovered.skills.map((skill) => {
    const frontmatter = structuredClone(skill.frontmatter);
    const declaredName = frontmatter.name;
    const name =
      typeof declaredName === 'string' && declaredName.length > 0
        ? declaredName
        : basename(skill.dir);
    const description = frontmatter.description;

    return {
      body: skill.body,
      ...(typeof description === 'string' ? { description } : {}),
      dir: skill.dir,
      frontmatter,
      id: `skill:${name}`,
      ...(skill.rendered === true ? { markdown: skill.markdown } : {}),
      name,
      provenance: skillProvenance(loaded, skill.source),
      resources: skill.resources.map((resource) => ({ ...resource })),
      source: skill.source,
      targets: [...targetNames],
    };
  });
  const description = loaded.config.plugin.description;
  const nativeHooks = await normalizeNativeHooks(loaded, targetNames, registry);
  const payloads = normalizePayloads(loaded, discovered, targetNames);
  const mcpServers = normalizeMcpServers(loaded, targetNames, payloads);
  const scripts = normalizeScripts(loaded, targetNames);
  const assets = normalizeAssets(loaded, discovered, targetNames);
  const packageBuild = normalizePackageBuild(loaded.config, loaded.context.projectRoot, loaded.configPath);
  const model: NormalizedPlugin = {
    ...(assets.length === 0 ? {} : { assets }),
    ...(loaded.config.marketplace === true ? { marketplace: true as const } : {}),
    extensions: normalizeExtensions(loaded, registry, configProvenance),
    metadata: {
      ...(typeof description === 'string' ? { description } : {}),
      id: `plugin:${loaded.config.plugin.name}`,
      name: loaded.config.plugin.name,
      provenance: configProvenance,
      version: loaded.config.plugin.version,
    },
    mcpApps: normalizeMcpApps(loaded, mcpServers),
    mcpServers,
    hooks: normalizeHooks(loaded, targetNames, registry, payloads),
    ...(nativeHooks.length === 0 ? {} : { nativeHooks }),
    ...(packageBuild === undefined ? {} : { packageBuild }),
    ...(payloads.length === 0 ? {} : { payloads }),
    runtime: normalizeRuntime(loaded),
    scripts,
    skills,
    targets: targetNames.map((name) => ({
      id: `target:${name}`,
      name,
      provenance: { ...configProvenance },
    })),
  };

  return deepFreeze(model);
};
