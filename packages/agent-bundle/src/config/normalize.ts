import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';

import { digest } from '../core/digest.ts';
import { pathTokens } from '../core/types.ts';
import type {
  AgentBundleHookEntry,
  AgentBundleHookInput,
  AgentBundleMcpApp,
  AgentBundleMcpServer,
  AgentBundleScriptInput,
  CanonicalHookEvent,
  CanonicalHookTool,
  NormalizationTargetRegistry,
  NormalizedConfigExtension,
  NormalizedHook,
  NormalizedMcpApp,
  NormalizedMcpServer,
  NormalizedNativeHook,
  NormalizedPlugin,
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

const isHookEntryList = (
  input: AgentBundleHookInput,
): input is readonly (string | AgentBundleHookEntry)[] => Array.isArray(input);

const asEntries = (input: AgentBundleHookInput): readonly (string | AgentBundleHookEntry)[] =>
  isHookEntryList(input) ? input : [input];

const normalizeHook = (
  event: CanonicalHookEvent,
  input: string | AgentBundleHookEntry,
  root: string,
  defaultTargets: readonly string[],
  provenance: SourceProvenance,
): NormalizedHook => {
  const entry = typeof input === 'string' ? { handler: input } : input;
  const source = resolve(root, entry.handler);
  const handler = relative(root, source).replaceAll('\\', '/');
  const tools = sortedUnique(entry.tools ?? []).filter(
    (tool): tool is CanonicalHookTool => knownHookTools.has(tool as CanonicalHookTool),
  );
  const targets = sortedUnique(entry.targets ?? defaultTargets);
  const timeout = entry.timeout;
  const identity = {
    event,
    handler,
    targets,
    timeout: timeout ?? 'host-default',
    tools,
  };
  const hash = digest(identity).slice(0, 8);
  const eventName = eventSlug(event);
  const handlerName = slug(basename(source, extname(source)));
  const name = `${eventName}-${handlerName}-${hash}`;

  return {
    event,
    id: `hook:${eventName}:${handlerName}:${hash}`,
    name,
    provenance: { ...provenance },
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
      hooks.push(normalizeHook(event, entry, loaded.context.projectRoot, hookTargets, provenance));
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
  for (const { source: configured, target } of registry.nativeHookSources?.(loaded.config, targetNames) ?? []) {
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
): NormalizedMcpServer => {
  const targets = sortedUnique(server.targets ?? defaultTargets);
  const common = {
    id: `mcp:${name}`,
    name,
    provenance: { ...provenance },
    targets,
  };

  if (server.entry !== undefined) {
    const entryName = mcpEntryName(name);
    return {
      ...common,
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
      args: [`mcp/${entryName}`, ...(server.args ?? [])],
      command: 'node',
      cwd: pathTokens.pluginRoot,
      source: resolve(root, server.entry),
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
): readonly NormalizedMcpServer[] => {
  const servers = loaded.config.mcp?.servers;
  if (servers === undefined) return [];

  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };
  return Object.entries(servers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, server]) =>
      normalizeMcpServer(name, server, loaded.context.projectRoot, targetNames, provenance));
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
    if (server?.source === undefined || rawServer.apps === undefined) continue;
    for (const [name, app] of Object.entries(rawServer.apps).sort(([left], [right]) => left.localeCompare(right))) {
      const declaration = app as AgentBundleMcpApp;
      apps.push({
        ...(declaration._meta === undefined ? {} : { _meta: structuredClone(declaration._meta) }),
        id: `mcp-app:${serverName}:${name}`,
        name,
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

const invalidExtensionValue = (key: string): never => {
  throw new Error(`AB4500: Config extension "${key}" must contain strict finite JSON data.`);
};

const cloneExtensionValue = (
  key: string,
  value: unknown,
  ancestors = new Set<object>(),
): unknown => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : invalidExtensionValue(key);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return invalidExtensionValue(key);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const clone: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          return invalidExtensionValue(key);
        }
        clone.push(cloneExtensionValue(key, descriptor.value, ancestors));
      }
      for (const property of Reflect.ownKeys(value)) {
        if (property === 'length') continue;
        if (typeof property !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(property) || Number(property) >= value.length) {
          return invalidExtensionValue(key);
        }
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidExtensionValue(key);
    }
    const clone = Object.create(null) as Record<string, unknown>;
    for (const property of Reflect.ownKeys(value)) {
      if (typeof property !== 'string') return invalidExtensionValue(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return invalidExtensionValue(key);
      }
      clone[property] = cloneExtensionValue(key, descriptor.value, ancestors);
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
      value: cloneExtensionValue(descriptor.key, value),
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
      name,
      provenance: skillProvenance(loaded, skill.source),
      resources: skill.resources.map((resource) => ({ ...resource })),
      source: skill.source,
      targets: [...targetNames],
    };
  });
  const description = loaded.config.plugin.description;
  const nativeHooks = await normalizeNativeHooks(loaded, targetNames, registry);
  const mcpServers = normalizeMcpServers(loaded, targetNames);
  const scripts = normalizeScripts(loaded, targetNames);
  const model: NormalizedPlugin = {
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
    hooks: normalizeHooks(loaded, targetNames, registry),
    ...(nativeHooks.length === 0 ? {} : { nativeHooks }),
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
