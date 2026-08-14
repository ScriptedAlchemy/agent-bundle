import { basename } from 'node:path';

import type {
  NormalizationTargetRegistry,
  NormalizedPlugin,
  NormalizedSkill,
  SourceProvenance,
} from '../core/types.ts';
import type { DiscoveredProject } from './discover.ts';
import type { LoadedConfig } from './load.ts';

const unique = (values: readonly string[]): string[] => [...new Set(values)];

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
    metadata: {
      ...(typeof description === 'string' ? { description } : {}),
      id: `plugin:${loaded.config.plugin.name}`,
      name: loaded.config.plugin.name,
      provenance: configProvenance,
      version: loaded.config.plugin.version,
    },
    skills,
    targets: targetNames.map((name) => ({
      id: `target:${name}`,
      name,
      provenance: { ...configProvenance },
    })),
  };

  return deepFreeze(model);
};
