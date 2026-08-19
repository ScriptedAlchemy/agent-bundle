import { stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';

import fastGlob from 'fast-glob';

import type { AgentBundleConfig } from '../core/types.ts';
import { isProjectPathIgnored, readProjectIgnoreRules } from './ignore.ts';
import { parseSkill, type SkillDocument } from './skill.ts';

/** One discovered project-level asset file with its artifact destination under `assets/`. */
export interface DiscoveredAsset {
  readonly bytes: number;
  readonly relativePath: string;
  readonly source: string;
}

export interface DiscoveredProject {
  assets?: DiscoveredAsset[];
  skills: SkillDocument[];
}

/** Expands one configured skills entry: literal paths stay literal, globs match skill directories or SKILL.md files. */
const expandConfiguredSkill = async (projectRoot: string, skill: string): Promise<string[]> => {
  if (!fastGlob.isDynamicPattern(skill)) return [resolve(projectRoot, skill)];
  const matches = await fastGlob(skill, {
    absolute: true,
    cwd: projectRoot,
    dot: true,
    followSymbolicLinks: false,
    objectMode: true,
    onlyFiles: false,
  });
  return matches
    .filter((match) => match.dirent.isDirectory() || match.name === 'SKILL.md')
    .map((match) => match.path);
};

const assetGlobOptions = {
  absolute: true,
  dot: true,
  followSymbolicLinks: false,
  onlyFiles: true,
} as const;

/** Expands one configured assets entry: globs match files, literals name a file or a whole directory. */
const expandConfiguredAsset = async (projectRoot: string, entry: string): Promise<string[]> => {
  if (fastGlob.isDynamicPattern(entry)) return fastGlob(entry, { ...assetGlobOptions, cwd: projectRoot });
  const source = resolve(projectRoot, entry);
  let stats;
  try {
    stats = await stat(source);
  } catch {
    // Missing configured assets are omitted rather than failing discovery.
    return [];
  }
  if (stats.isFile()) return [source];
  if (!stats.isDirectory()) return [];
  return fastGlob('**', { ...assetGlobOptions, cwd: source });
};

/** The artifact destination strips a conventional leading `assets/` so `assets/logo.svg` stays `logo.svg`. */
const assetRelativePath = (projectRoot: string, source: string): string => {
  const projectRelative = relative(projectRoot, source).replaceAll('\\', '/');
  return projectRelative.startsWith('assets/') ? projectRelative.slice('assets/'.length) : projectRelative;
};

const discoverAssets = async (
  projectRoot: string,
  configured: readonly string[] | undefined,
  rules: Awaited<ReturnType<typeof readProjectIgnoreRules>>,
): Promise<DiscoveredAsset[]> => {
  const sources = configured === undefined
    ? await fastGlob('assets/**', { ...assetGlobOptions, cwd: projectRoot })
    : (await Promise.all(configured.map((entry) => expandConfiguredAsset(projectRoot, entry)))).flat();
  const selected = [...new Set(sources)]
    .filter((source) => !isProjectPathIgnored(rules, projectRoot, source))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(selected.map(async (source) => ({
    bytes: (await stat(source)).size,
    relativePath: assetRelativePath(projectRoot, source),
    source,
  })));
};

export const discoverProject = async (
  root: string,
  config: AgentBundleConfig,
): Promise<DiscoveredProject> => {
  const projectRoot = resolve(root);
  const rules = await readProjectIgnoreRules(projectRoot);
  const configuredSkills = config.skills;
  const sources =
    configuredSkills === undefined
      ? await fastGlob('skills/*/SKILL.md', {
          absolute: true,
          cwd: projectRoot,
          dot: true,
          followSymbolicLinks: false,
          onlyFiles: true,
        })
      : (await Promise.all(configuredSkills.map((skill) => expandConfiguredSkill(projectRoot, skill)))).flat();
  const skillDirs = [...new Set(sources
    .filter((source) => !isProjectPathIgnored(rules, projectRoot, source))
    .map((source) => (basename(source) === 'SKILL.md' ? dirname(source) : source)))]
    .sort((left, right) => left.localeCompare(right));

  return {
    assets: await discoverAssets(projectRoot, config.assets, rules),
    skills: await Promise.all(
      skillDirs.map((skillDir) => parseSkill(skillDir, projectRoot)),
    ),
  };
};
