import { basename, dirname, resolve } from 'node:path';

import fastGlob from 'fast-glob';

import type { AgentBundleConfig } from '../core/types.ts';
import { isProjectPathIgnored, readProjectIgnoreRules } from './ignore.ts';
import { parseSkill, type SkillDocument } from './skill.ts';

export interface DiscoveredProject {
  skills: SkillDocument[];
}

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
      : configuredSkills.map((skill) => resolve(projectRoot, skill));
  const skillDirs = sources
    .filter((source) => !isProjectPathIgnored(rules, projectRoot, source))
    .map((source) => (basename(source) === 'SKILL.md' ? dirname(source) : source))
    .sort((left, right) => left.localeCompare(right));

  return {
    skills: await Promise.all(
      skillDirs.map((skillDir) => parseSkill(skillDir, projectRoot)),
    ),
  };
};
