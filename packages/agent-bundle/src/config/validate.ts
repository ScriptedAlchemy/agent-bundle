import { basename, posix } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import type {
  NormalizationTargetRegistry,
  NormalizedPlugin,
} from '../core/types.ts';
import type { DiscoveredProject } from './discover.ts';
import type { LoadedConfig } from './load.ts';
import type { SkillDocument } from './skill.ts';

const sourceDiagnostic = (
  code: string,
  message: string,
  sourcePath: string,
): Diagnostic => ({ code, message, severity: 'error', sourcePath });

const referencedResources = (body: string): string[] => {
  const references: string[] = [];
  const linkPattern = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;

  for (const match of body.matchAll(linkPattern)) {
    const rawReference = match[1] ?? match[2];
    if (
      rawReference === undefined ||
      rawReference.startsWith('#') ||
      rawReference.startsWith('/') ||
      /^[a-z][a-z\d+.-]*:/i.test(rawReference)
    ) {
      continue;
    }

    const pathOnly = rawReference.split(/[?#]/, 1)[0];
    if (pathOnly === undefined || pathOnly.length === 0) {
      continue;
    }

    try {
      references.push(posix.normalize(decodeURIComponent(pathOnly)));
    } catch {
      references.push(posix.normalize(pathOnly));
    }
  }

  return references;
};

const validateSkill = (skill: SkillDocument): Diagnostic[] => {
  const diagnostics = [...skill.diagnostics];
  const name = skill.frontmatter.name;
  const description = skill.frontmatter.description;

  if (typeof name !== 'string' || name.trim().length === 0) {
    diagnostics.push(
      sourceDiagnostic('AB4002', 'Skill frontmatter must define a nonempty name.', skill.source),
    );
  }

  if (typeof description !== 'string' || description.trim().length === 0) {
    diagnostics.push(
      sourceDiagnostic(
        'AB4003',
        'Skill frontmatter must define a nonempty description.',
        skill.source,
      ),
    );
  }

  if (typeof name === 'string' && name !== basename(skill.dir)) {
    diagnostics.push(
      sourceDiagnostic(
        'AB4004',
        `Skill name ${JSON.stringify(name)} must match directory ${JSON.stringify(basename(skill.dir))}.`,
        skill.source,
      ),
    );
  }

  const resources = new Set(skill.resources.map(({ relativePath }) => relativePath));
  for (const reference of referencedResources(skill.body)) {
    if (!resources.has(reference)) {
      diagnostics.push(
        sourceDiagnostic(
          'AB4005',
          `Skill references missing resource ${JSON.stringify(reference)}.`,
          skill.source,
        ),
      );
    }
  }

  return diagnostics;
};

export const validateSource = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const plugin = loaded.config.plugin;

  if (typeof plugin.name !== 'string' || plugin.name.trim().length === 0) {
    diagnostics.push(
      sourceDiagnostic('AB4000', 'Plugin metadata must define a nonempty name.', loaded.configPath),
    );
  }
  if (typeof plugin.version !== 'string' || plugin.version.trim().length === 0) {
    diagnostics.push(
      sourceDiagnostic(
        'AB4001',
        'Plugin metadata must define a nonempty version.',
        loaded.configPath,
      ),
    );
  }

  const skillNames = new Map<string, string>();
  for (const skill of discovered.skills) {
    diagnostics.push(...validateSkill(skill));

    const name = skill.frontmatter.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      continue;
    }

    const firstSource = skillNames.get(name);
    if (firstSource === undefined) {
      skillNames.set(name, skill.source);
    } else {
      diagnostics.push(
        sourceDiagnostic(
          'AB4006',
          `Skill name ${JSON.stringify(name)} duplicates ${firstSource}.`,
          skill.source,
        ),
      );
    }
  }

  return diagnostics;
};

export const validateModel = (
  model: NormalizedPlugin,
  registry: NormalizationTargetRegistry,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];

  for (const target of model.targets) {
    if (!registry.has(target.name)) {
      diagnostics.push({
        code: 'AB4100',
        message: `Unknown target ${JSON.stringify(target.name)}.`,
        severity: 'error',
        sourcePath: target.provenance.sourcePath,
        target: target.name,
      });
    }
  }

  const ids = new Map<string, string>();
  const components = [model.metadata, ...model.targets, ...model.skills];
  for (const component of components) {
    const firstSource = ids.get(component.id);
    if (firstSource === undefined) {
      ids.set(component.id, component.provenance.sourcePath);
    } else {
      diagnostics.push({
        code: 'AB4101',
        message: `Normalized component ID ${JSON.stringify(component.id)} is duplicated.`,
        severity: 'error',
        sourcePath: component.provenance.sourcePath,
      });
    }
  }

  const outputs = new Map<string, string>();
  for (const target of model.targets) {
    for (const skill of model.skills) {
      for (const resource of skill.resources) {
        const generatedPath = posix.join(
          target.name,
          'skills',
          skill.name,
          resource.relativePath,
        );
        const firstSource = outputs.get(generatedPath);
        if (firstSource === undefined) {
          outputs.set(generatedPath, resource.source);
        } else {
          diagnostics.push({
            code: 'AB4102',
            generatedPath,
            message: `Multiple inputs produce ${JSON.stringify(generatedPath)}; first source is ${firstSource}.`,
            severity: 'error',
            sourcePath: resource.source,
            target: target.name,
          });
        }
      }
    }
  }

  return diagnostics;
};
