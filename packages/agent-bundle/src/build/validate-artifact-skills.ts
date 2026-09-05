import { resolve } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import { parseSkillMarkdown, referencedResources } from '../config/skill-references.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readFileString, runWithPlatform } from '../effect/platform.ts';
import { validateAgentSkillsFrontmatter } from '../schemas/agent-skills/contract.ts';
import {
  validateClaudeSkillFrontmatter,
  validateCursorSkillFrontmatter,
} from '../schemas/skill-hosts/contract.ts';
import {
  artifactDiagnostic as diagnostic,
  artifactDiagnosticRecoveries,
} from './artifact-diagnostics.ts';
import type { ArtifactFile } from './emit.ts';
import type { ArtifactManifest } from './manifest.ts';

/** The host projections of the root, as the manifest names them. */
export const manifestTargetNames = (manifest: ArtifactManifest): readonly string[] =>
  Object.freeze(manifest.targets.map((target) => target.name));

interface EmittedSkill {
  readonly name: string;
  readonly path: string;
  readonly root: string;
  /** The hosts reading this document: every root host, or the one host whose namespaced view holds it. */
  readonly targets: readonly string[];
}

/** A host whose projection is a namespaced view (`portable/`) of a composite root, with its own skills/. */
interface SkillView {
  readonly host: string;
  readonly prefix: string;
  readonly skillLayout: string | undefined;
}

/**
 * One plugin root holds one `skills/<name>/SKILL.md` per skill (#555), read by
 * every projected host, plus one per skill in each host's namespaced view;
 * the layouts come from the root's contracts.
 */
const emittedSkillFor = (
  file: ArtifactFile,
  skillLayout: string | undefined,
  rootTargets: readonly string[],
  views: readonly SkillView[],
): EmittedSkill | undefined => {
  const view = views.find((candidate) => file.path.startsWith(candidate.prefix));
  const layoutName = view === undefined ? skillLayout : view.skillLayout;
  if (layoutName === undefined) return undefined;
  const relativePath = view === undefined ? file.path : file.path.slice(view.prefix.length);
  const segments = relativePath.split('/');
  const [layout, name, document] = segments;
  if (layout !== layoutName || name === undefined || document !== 'SKILL.md' || segments.length !== 3) {
    return undefined;
  }
  return {
    name,
    path: file.path,
    root: `${view?.prefix ?? ''}${layoutName}/${name}`,
    targets: view === undefined ? rootTargets : [view.host],
  };
};

/** The frontmatter contract a host applies to a shared skill document. */
const frontmatterIssuesFor = (target: string, frontmatter: Readonly<Record<string, unknown>>) => target === 'claude'
  ? validateClaudeSkillFrontmatter(frontmatter)
  : target === 'cursor'
    ? validateCursorSkillFrontmatter(frontmatter)
    : validateAgentSkillsFrontmatter(frontmatter);

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
  const targets = manifestTargetNames(options.manifest).filter((target) => options.registry.has(target));
  if (targets.length === 0) return Object.freeze(diagnostics);
  const root = options.registry.root(targets);
  // A single-host root's layout diagnostics name that host; a composite's name none.
  const rootTarget = targets.length === 1 ? targets[0] : undefined;
  const skillLayout = root.artifactLayout.skills;
  const views: readonly SkillView[] = targets
    .filter((target) => root.hostRoot(target) !== '')
    .map((target) => ({
      host: target,
      prefix: `${root.hostRoot(target)}/`,
      skillLayout: options.registry.artifactLayout(target).skills,
    }));
  const rootTargets = targets.filter((target) => root.hostRoot(target) === '');
  const skills = options.files
    .map((file) => emittedSkillFor(file, skillLayout, rootTargets, views))
    .filter((skill): skill is EmittedSkill => skill !== undefined);
  const skillsByRoot = new Map(skills.map((skill) => [skill.root, skill]));

  for (const file of options.files) {
    if (!file.path.endsWith('/SKILL.md') || emittedSkillFor(file, skillLayout, rootTargets, views) !== undefined) continue;
    diagnostics.push(diagnostic(
      'AB6015',
      `Emitted Skill document ${JSON.stringify(file.path)} does not use the canonical skills/<name>/SKILL.md layout.`,
      file.path,
      rootTarget,
      skillRecovery,
    ));
  }

  const resourceFilesBySkill = new Map<string, readonly ArtifactFile[]>();
  for (const file of options.files) {
    const view = views.find((candidate) => file.path.startsWith(candidate.prefix));
    const layoutName = view === undefined ? skillLayout : view.skillLayout;
    const relativePath = view === undefined ? file.path : file.path.slice(view.prefix.length);
    const [layout, name] = relativePath.split('/');
    if (layoutName === undefined || layout !== layoutName || name === undefined) continue;
    const skillRoot = `${view?.prefix ?? ''}${layout}/${name}`;
    const existing = resourceFilesBySkill.get(skillRoot) ?? [];
    resourceFilesBySkill.set(skillRoot, [...existing, file]);
  }

  for (const [root, files] of resourceFilesBySkill) {
    if (skillsByRoot.has(root)) continue;
    diagnostics.push(diagnostic(
      'AB6015',
      `Emitted Skill resource directory ${JSON.stringify(root)} is missing its SKILL.md document.`,
      files[0]?.path,
      rootTarget,
      skillRecovery,
    ));
  }

  for (const skill of skills) {
    let markdown: string;
    try {
      markdown = await runWithPlatform(readFileString(resolve(options.artifactRoot, skill.path)));
    } catch {
      diagnostics.push(diagnostic(
        'AB6015',
        'Emitted Skill Markdown cannot be read.',
        skill.path,
        rootTarget,
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
        rootTarget,
        skillRecovery,
      ));
      continue;
    }
    if (parsed.status === 'malformed-frontmatter') {
      diagnostics.push(diagnostic(
        'AB6015',
        `Emitted Skill YAML frontmatter is invalid: ${parsed.message}`,
        skill.path,
        rootTarget,
        skillRecovery,
      ));
      continue;
    }

    // Every host reading this document must accept its frontmatter: all root
    // hosts for a shared document, the one host of a namespaced view.
    for (const target of skill.targets) {
      for (const issue of frontmatterIssuesFor(target, parsed.frontmatter)) {
        const location = issue.field ?? (issue.instancePath === '' ? 'root' : issue.instancePath);
        diagnostics.push(diagnostic(
          'AB6015',
          `Emitted Skill frontmatter ${location} ${issue.message}.`,
          skill.path,
          target,
          skillRecovery,
        ));
      }
    }
    if (typeof parsed.frontmatter.name === 'string' && parsed.frontmatter.name !== skill.name) {
      diagnostics.push(diagnostic(
        'AB6015',
        `Emitted Skill name ${JSON.stringify(parsed.frontmatter.name)} must match directory ${JSON.stringify(skill.name)}.`,
        skill.path,
        rootTarget,
        skillRecovery,
      ));
    }
    if (parsed.body.trim().length === 0) {
      diagnostics.push(diagnostic(
        'AB6034',
        'Emitted Skill Markdown must contain instructions after its YAML frontmatter.',
        skill.path,
        rootTarget,
        artifactDiagnosticRecoveries.AB6034,
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
          rootTarget,
          artifactDiagnosticRecoveries.AB6016,
        ));
      } else if (!resources.has(reference)) {
        diagnostics.push(diagnostic(
          'AB6016',
          `Emitted Skill references missing regular resource ${JSON.stringify(reference)}.`,
          skill.path,
          rootTarget,
          artifactDiagnosticRecoveries.AB6016,
        ));
      }
    }
  }

  return Object.freeze(diagnostics);
};
