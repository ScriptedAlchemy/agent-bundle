import { resolve } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import { resolveArtifactLayoutDirectory } from '../adapters/types.ts';
import { ampMcpDocumentIssues } from '../adapters/amp-mcp.ts';
import { parseSkillMarkdown, referencedResources } from '../config/skill-references.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readFileString, runWithPlatform } from '../effect/platform.ts';
import { validateAgentSkillsFrontmatter, type AgentSkillsFrontmatterIssue } from '../schemas/agent-skills/contract.ts';
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

/** The selected host projections the composite root records. */
export const manifestTargets = (manifest: ArtifactManifest): readonly string[] =>
  manifest.projections.map((projection) => projection.host);

/**
 * The skill directories the selected hosts read, each with the hosts that
 * read it. Every built-in host emits `skills/`, so one emitted Skill is read
 * by every selected host and must satisfy each host's frontmatter contract.
 */
const skillDirectories = (
  manifest: ArtifactManifest,
  registry: TargetRegistry,
): ReadonlyMap<string, readonly string[]> => {
  const directories = new Map<string, string[]>();
  for (const target of manifestTargets(manifest)) {
    if (!registry.has(target)) continue;
    const directory = registry.artifactLayout(target).skills;
    if (directory === undefined) continue;
    const resolved = resolveArtifactLayoutDirectory(directory, manifest.application.name);
    directories.set(resolved, [...(directories.get(resolved) ?? []), target]);
  }
  return directories;
};

interface EmittedSkill {
  readonly name: string;
  readonly path: string;
  readonly root: string;
  /** The selected hosts that read this Skill directory. */
  readonly targets: readonly string[];
}

const emittedSkillFor = (
  file: ArtifactFile,
  directories: ReadonlyMap<string, readonly string[]>,
): EmittedSkill | undefined => {
  for (const [layout, targets] of directories) {
    if (!file.path.startsWith(`${layout}/`)) continue;
    const segments = file.path.slice(layout.length + 1).split('/');
    const [name, document] = segments;
    if (name !== undefined && document === 'SKILL.md' && segments.length === 2) {
      return { name, path: file.path, root: `${layout}/${name}`, targets };
    }
  }
  return undefined;
};

const ampFrontmatterValidator = (frontmatter: unknown): readonly AgentSkillsFrontmatterIssue[] => {
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    return validateAgentSkillsFrontmatter(frontmatter);
  }
  const record = frontmatter as Readonly<Record<string, unknown>>;
  const portable = Object.fromEntries(Object.entries(record).filter(([key]) =>
    ['allowed-tools', 'compatibility', 'description', 'license', 'metadata', 'name'].includes(key)));
  const issues: AgentSkillsFrontmatterIssue[] = [...validateAgentSkillsFrontmatter(portable)];
  if (
    record['builtin-tools'] !== undefined
    && (
      !Array.isArray(record['builtin-tools'])
      || !record['builtin-tools'].every((tool) => typeof tool === 'string' && tool.length > 0)
    )
  ) {
    issues.push({ instancePath: '/builtin-tools', keyword: 'type', message: 'must be an array of nonempty strings' });
  }
  if (record.mcpServers !== undefined) {
    issues.push(...ampMcpDocumentIssues(record.mcpServers).map((issue) => ({
      instancePath: `/${issue.path.replaceAll('.', '/')}`,
      keyword: 'amp-mcp',
      message: issue.message,
    })));
  }
  return Object.freeze(issues);
};

const frontmatterValidatorFor = (target: string): (frontmatter: unknown) => readonly AgentSkillsFrontmatterIssue[] => {
  switch (target) {
    case 'amp':
      return ampFrontmatterValidator;
    case 'claude':
      return validateClaudeSkillFrontmatter;
    case 'cursor':
      return validateCursorSkillFrontmatter;
    default:
      return validateAgentSkillsFrontmatter;
  }
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
  const directories = skillDirectories(options.manifest, options.registry);
  const skills = options.files
    .map((file) => emittedSkillFor(file, directories))
    .filter((skill): skill is EmittedSkill => skill !== undefined);
  const skillsByRoot = new Map(skills.map((skill) => [skill.root, skill]));

  for (const file of options.files) {
    if (!file.path.endsWith('/SKILL.md') || emittedSkillFor(file, directories) !== undefined) continue;
    diagnostics.push(diagnostic(
      'AB6015',
      `Emitted Skill document ${JSON.stringify(file.path)} does not use a selected target's registered Skill layout.`,
      file.path,
      undefined,
      skillRecovery,
    ));
  }

  const resourceFilesBySkill = new Map<string, readonly ArtifactFile[]>();
  for (const file of options.files) {
    for (const layout of directories.keys()) {
      if (!file.path.startsWith(`${layout}/`)) continue;
      const [name] = file.path.slice(layout.length + 1).split('/');
      if (name === undefined) continue;
      const root = `${layout}/${name}`;
      const existing = resourceFilesBySkill.get(root) ?? [];
      resourceFilesBySkill.set(root, [...existing, file]);
      break;
    }
  }

  for (const [root, files] of resourceFilesBySkill) {
    if (skillsByRoot.has(root)) continue;
    diagnostics.push(diagnostic(
      'AB6015',
      `Emitted Skill resource directory ${JSON.stringify(root)} is missing its SKILL.md document.`,
      files[0]?.path,
      undefined,
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
        undefined,
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
        undefined,
        skillRecovery,
      ));
      continue;
    }
    if (parsed.status === 'malformed-frontmatter') {
      diagnostics.push(diagnostic(
        'AB6015',
        `Emitted Skill YAML frontmatter is invalid: ${parsed.message}`,
        skill.path,
        undefined,
        skillRecovery,
      ));
      continue;
    }

    // One emitted document, read by every selected host: each host's
    // frontmatter contract judges it and names itself in the diagnostic.
    for (const target of skill.targets) {
      for (const issue of frontmatterValidatorFor(target)(parsed.frontmatter)) {
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
    if (skill.targets.includes('amp') && parsed.frontmatter.mcpServers === undefined) {
      const mcpPath = `${skill.root}/mcp.json`;
      if (options.files.some((file) => file.path === mcpPath)) {
        let document: unknown;
        try {
          document = JSON.parse(await runWithPlatform(readFileString(resolve(options.artifactRoot, mcpPath)))) as unknown;
        } catch {
          diagnostics.push(diagnostic(
            'AB6015',
            'Emitted Amp Skill mcp.json must contain one JSON value.',
            mcpPath,
            'amp',
            skillRecovery,
          ));
          document = undefined;
        }
        if (document !== undefined) {
          for (const issue of ampMcpDocumentIssues(document)) {
            diagnostics.push(diagnostic(
              'AB6015',
              `Emitted Amp Skill MCP ${issue.path || 'root'} ${issue.message}.`,
              mcpPath,
              'amp',
              skillRecovery,
            ));
          }
        }
      }
    }
    if (typeof parsed.frontmatter.name === 'string' && parsed.frontmatter.name !== skill.name) {
      diagnostics.push(diagnostic(
        'AB6015',
        `Emitted Skill name ${JSON.stringify(parsed.frontmatter.name)} must match directory ${JSON.stringify(skill.name)}.`,
        skill.path,
        undefined,
        skillRecovery,
      ));
    }
    if (parsed.body.trim().length === 0) {
      diagnostics.push(diagnostic(
        'AB6034',
        'Emitted Skill Markdown must contain instructions after its YAML frontmatter.',
        skill.path,
        undefined,
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
          undefined,
          artifactDiagnosticRecoveries.AB6016,
        ));
      } else if (!resources.has(reference)) {
        diagnostics.push(diagnostic(
          'AB6016',
          `Emitted Skill references missing regular resource ${JSON.stringify(reference)}.`,
          skill.path,
          undefined,
          artifactDiagnosticRecoveries.AB6016,
        ));
      }
    }
  }

  return Object.freeze(diagnostics);
};
