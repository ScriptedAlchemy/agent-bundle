import { basename, dirname, resolve } from 'node:path';

import fastGlob from 'fast-glob';

import type { AgentBundleConfig } from '../core/types.ts';
import { isProjectPathIgnored, readProjectIgnoreRules } from './ignore.ts';
import { parseSkill, type SkillDocument } from './skill.ts';

export interface DiscoveredProject {
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
    skills: await Promise.all(
      skillDirs.map((skillDir) => parseSkill(skillDir, projectRoot)),
    ),
  };
};
