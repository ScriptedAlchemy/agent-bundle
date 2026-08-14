import { basename, extname, relative, resolve } from 'node:path';

import { digest } from '../core/digest.ts';
import type {
  AgentBundleHookEntry,
  AgentBundleHookInput,
  CanonicalHookEvent,
  CanonicalHookTool,
  NormalizationTargetRegistry,
  NormalizedHook,
  NormalizedPlugin,
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
): readonly NormalizedHook[] => {
  const hooks: NormalizedHook[] = [];
  const config = loaded.config.hooks;
  if (config === undefined) return hooks;
  const provenance: SourceProvenance = { kind: 'config', sourcePath: loaded.configPath };

  for (const event of hookEvents) {
    const input = config[event];
    if (input === undefined) continue;
    for (const entry of asEntries(input)) {
      hooks.push(normalizeHook(event, entry, loaded.context.projectRoot, targetNames, provenance));
    }
  }

  return hooks;
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
  const model: NormalizedPlugin = {
    ...(loaded.config.marketplace === true ? { marketplace: true as const } : {}),
    metadata: {
      ...(typeof description === 'string' ? { description } : {}),
      id: `plugin:${loaded.config.plugin.name}`,
      name: loaded.config.plugin.name,
      provenance: configProvenance,
      version: loaded.config.plugin.version,
    },
    mcpServers: [],
    hooks: normalizeHooks(loaded, targetNames),
    scripts: [],
    skills,
    targets: targetNames.map((name) => ({
      id: `target:${name}`,
      name,
      provenance: { ...configProvenance },
    })),
  };

  return deepFreeze(model);
};
