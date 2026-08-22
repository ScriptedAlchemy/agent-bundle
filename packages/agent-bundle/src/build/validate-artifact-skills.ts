import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import { parseSkillMarkdown, referencedResources } from '../config/skill-references.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { validateAgentSkillsFrontmatter } from '../schemas/agent-skills/contract.ts';
import {
  artifactDiagnostic as diagnostic,
  artifactDiagnosticRecoveries,
} from './artifact-diagnostics.ts';
import type { ArtifactFile } from './emit.ts';
import type { ArtifactManifest } from './manifest.ts';

export const targetNamespaces = (manifest: ArtifactManifest): ReadonlySet<string> =>
  new Set(manifest.targets.map((target) => target.name));

export const pathTarget = (path: string, targets: ReadonlySet<string>): string | undefined => {
  const [target] = path.split('/');
  return target !== undefined && targets.has(target) ? target : undefined;
};

interface EmittedSkill {
  readonly name: string;
  readonly path: string;
  readonly root: string;
  readonly target: string;
}

const emittedSkillFor = (
  file: ArtifactFile,
  targets: ReadonlySet<string>,
  registry: TargetRegistry,
): EmittedSkill | undefined => {
  const segments = file.path.split('/');
  const [target, layout, name, document] = segments;
  if (target === undefined || !targets.has(target) || !registry.has(target)) return undefined;
  const skillLayout = registry.artifactLayout(target).skills;
  if (
    layout !== skillLayout ||
    name === undefined ||
    document !== 'SKILL.md' ||
    segments.length !== 4
  ) {
    return undefined;
  }
  if (skillLayout === undefined) return undefined;
  return {
    name,
    path: file.path,
    root: `${target}/${skillLayout}/${name}`,
    target,
  };
};

const isSkillRootEscape = (reference: string): boolean =>
  reference === '..' || reference.startsWith('../') || reference.startsWith('/');

const skillRecovery = artifactDiagnosticRecoveries.AB6015;

export const validateEmittedSkills = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifest;
  readonly registry: TargetRegistry;
}): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const targets = targetNamespaces(options.manifest);
  const skills = options.files
    .map((file) => emittedSkillFor(file, targets, options.registry))
    .filter((skill): skill is EmittedSkill => skill !== undefined);
  const skillsByRoot = new Map(skills.map((skill) => [skill.root, skill]));

  for (const file of options.files) {
    if (!file.path.endsWith('/SKILL.md') || emittedSkillFor(file, targets, options.registry) !== undefined) continue;
    const target = pathTarget(file.path, targets);
    diagnostics.push(diagnostic(
      'AB6015',
      `Emitted Skill document ${JSON.stringify(file.path)} does not use the canonical skills/<name>/SKILL.md layout.`,
      file.path,
      target,
      skillRecovery,
    ));
  }

  const resourceFilesBySkill = new Map<string, readonly ArtifactFile[]>();
  for (const file of options.files) {
    const [target, layout, name] = file.path.split('/');
    if (target === undefined || name === undefined || !targets.has(target) || !options.registry.has(target)) continue;
    if (layout !== options.registry.artifactLayout(target).skills) continue;
    const root = `${target}/${layout}/${name}`;
    const existing = resourceFilesBySkill.get(root) ?? [];
    resourceFilesBySkill.set(root, [...existing, file]);
  }

  for (const [root, files] of resourceFilesBySkill) {
    if (skillsByRoot.has(root)) continue;
    const [target] = root.split('/');
    diagnostics.push(diagnostic(
      'AB6015',
      `Emitted Skill resource directory ${JSON.stringify(root)} is missing its SKILL.md document.`,
      files[0]?.path,
      target,
      skillRecovery,
    ));
  }

  for (const skill of skills) {
    let markdown: string;
    try {
      markdown = await readFile(resolve(options.artifactRoot, skill.path), 'utf8');
    } catch {
      diagnostics.push(diagnostic(
        'AB6015',
        'Emitted Skill Markdown cannot be read.',
        skill.path,
        skill.target,
        skillRecovery,
      ));
      continue;
    }

    const parsed = parseSkillMarkdown(markdown);
    if (parsed.status === 'missing-frontmatter') {
      diagnostics.push(diagnostic(
        'AB6015',
        'Emitted Skill Markdown must start with YAML frontmatter.',
        skill.path,
        skill.target,
        skillRecovery,
      ));
      continue;
    }
    if (parsed.status === 'malformed-frontmatter') {
      diagnostics.push(diagnostic(
        'AB6015',
        `Emitted Skill YAML frontmatter is invalid: ${parsed.message}`,
        skill.path,
        skill.target,
        skillRecovery,
      ));
      continue;
    }

    for (const issue of validateAgentSkillsFrontmatter(parsed.frontmatter)) {
      const location = issue.field ?? (issue.instancePath === '' ? 'root' : issue.instancePath);
      diagnostics.push(diagnostic(
        'AB6015',
        `Emitted Skill frontmatter ${location} ${issue.message}.`,
        skill.path,
        skill.target,
        skillRecovery,
      ));
    }
    if (typeof parsed.frontmatter.name === 'string' && parsed.frontmatter.name !== skill.name) {
      diagnostics.push(diagnostic(
        'AB6015',
        `Emitted Skill name ${JSON.stringify(parsed.frontmatter.name)} must match directory ${JSON.stringify(skill.name)}.`,
        skill.path,
        skill.target,
        skillRecovery,
      ));
    }

    const resources = new Set(
      (resourceFilesBySkill.get(skill.root) ?? []).map((file) => file.path.slice(skill.root.length + 1)),
    );
    for (const reference of referencedResources(parsed.body)) {
      if (isSkillRootEscape(reference)) {
        diagnostics.push(diagnostic(
          'AB6016',
          `Emitted Skill reference ${JSON.stringify(reference)} escapes its Skill root.`,
          skill.path,
          skill.target,
          artifactDiagnosticRecoveries.AB6016,
        ));
      } else if (!resources.has(reference)) {
        diagnostics.push(diagnostic(
          'AB6016',
          `Emitted Skill references missing regular resource ${JSON.stringify(reference)}.`,
          skill.path,
          skill.target,
          artifactDiagnosticRecoveries.AB6016,
        ));
      }
    }
  }

  return Object.freeze(diagnostics);
};
