import { basename, dirname, relative, resolve, sep } from 'node:path';

import fastGlob from 'fast-glob';
import ignore, { type Ignore } from 'ignore';

import type { AgentBundleConfig } from '../core/types.ts';
import { parseSkill, type SkillDocument } from './skill.ts';

const builtInIgnorePatterns = [
  '.git',
  '.git/**',
  'node_modules',
  'node_modules/**',
  'dist',
  'dist/**',
  '.agent-bundle',
  '.agent-bundle/**',
];

export interface DiscoveredProject {
  skills: SkillDocument[];
}

const toPosixPath = (path: string): string => path.split(sep).join('/');

const readIgnoreRules = async (root: string): Promise<Ignore> => {
  const rules = ignore().add(builtInIgnorePatterns);

  try {
    const { readFile } = await import('node:fs/promises');
    rules.add(await readFile(resolve(root, '.gitignore'), 'utf8'));
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  return rules;
};

const isIgnored = (rules: Ignore, root: string, source: string): boolean => {
  const relativePath = toPosixPath(relative(root, source));
  return relativePath.length > 0 && !relativePath.startsWith('../') && rules.ignores(relativePath);
};

export const discoverProject = async (
  root: string,
  config: AgentBundleConfig,
): Promise<DiscoveredProject> => {
  const projectRoot = resolve(root);
  const rules = await readIgnoreRules(projectRoot);
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
      : configuredSkills.map((skill) => resolve(projectRoot, skill));
  const skillDirs = sources
    .filter((source) => !isIgnored(rules, projectRoot, source))
    .map((source) => (basename(source) === 'SKILL.md' ? dirname(source) : source))
    .sort((left, right) => left.localeCompare(right));

  return {
    skills: await Promise.all(
      skillDirs.map((skillDir) => parseSkill(skillDir, projectRoot)),
    ),
  };
};
