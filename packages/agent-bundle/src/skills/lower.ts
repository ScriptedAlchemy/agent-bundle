import { stringify as stringifyYaml } from 'yaml';

import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import {
  validateAgentSkillsFrontmatter,
} from '../schemas/agent-skills/contract.ts';
import {
  validateClaudeSkillFrontmatter,
  validateCodexOpenaiYaml,
  validateCursorSkillFrontmatter,
  type SkillHostDocumentIssue,
} from '../schemas/skill-hosts/contract.ts';
import type {
  ClaudeSkillExtension,
  CodexSkillExtension,
  CursorSkillExtension,
  PortableSkillMetadata,
  SkillHostDocument,
  SkillIr,
  SkillSidecarRef,
  SkillTokenLoweringRecord,
  SkillTreeLayoutDecision,
} from './ir.ts';
import {
  classifySkillToken,
  foreignSkillMarkdownSyntax,
  replaceSkillTokens,
  type SkillHost,
} from './tokens.ts';

const omitUndefined = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

const portableFrontmatter = (portable: PortableSkillMetadata): Record<string, unknown> => omitUndefined({
  'allowed-tools': portable.allowedTools,
  compatibility: portable.compatibility,
  description: portable.description,
  license: portable.license,
  metadata: portable.metadata,
  name: portable.name,
});

const claudeFrontmatter = (
  portable: PortableSkillMetadata,
  extension: ClaudeSkillExtension | undefined,
): Record<string, unknown> => omitUndefined({
  ...portableFrontmatter(portable),
  agent: extension?.agent,
  'allowed-tools': extension?.allowedTools ?? portable.allowedTools,
  'argument-hint': extension?.argumentHint,
  arguments: extension?.arguments,
  background: extension?.background,
  context: extension?.context,
  'disable-model-invocation': extension?.disableModelInvocation,
  'disallowed-tools': extension?.disallowedTools,
  effort: extension?.effort,
  hooks: extension?.hooks,
  model: extension?.model,
  paths: extension?.paths,
  shell: extension?.shell,
  'user-invocable': extension?.userInvocable,
  when_to_use: extension?.whenToUse,
});

const cursorFrontmatter = (
  portable: PortableSkillMetadata,
  extension: CursorSkillExtension | undefined,
): Record<string, unknown> => omitUndefined({
  ...portableFrontmatter(portable),
  color: extension?.color,
  'disable-model-invocation': extension?.disableModelInvocation,
  globs: extension?.globs,
  icon: extension?.icon,
  paths: extension?.paths,
});

const codexSidecarDocument = (extension: CodexSkillExtension): Record<string, unknown> => omitUndefined({
  ...(extension.dependencies === undefined ? {} : {
    dependencies: omitUndefined({
      tools: extension.dependencies.tools?.map((tool) => omitUndefined({ ...tool })),
    }),
  }),
  ...(extension.interface === undefined ? {} : {
    interface: omitUndefined({
      brand_color: extension.interface.brandColor,
      default_prompt: extension.interface.defaultPrompt,
      display_name: extension.interface.displayName,
      icon_large: extension.interface.iconLarge,
      icon_small: extension.interface.iconSmall,
      short_description: extension.interface.shortDescription,
    }),
  }),
  ...(extension.policy === undefined ? {} : {
    policy: omitUndefined({
      allow_implicit_invocation: extension.policy.allowImplicitInvocation,
    }),
  }),
});

const rebuildMarkdown = (frontmatter: Record<string, unknown>, body: string): string =>
  `---\n${stringifyYaml(frontmatter)}---\n${body.startsWith('\n') ? body : `\n${body}`}`;

const schemaIssues = (
  host: SkillHost,
  issues: readonly SkillHostDocumentIssue[],
  source: string,
): Diagnostic[] => issues.map((issue) => ({
  code: 'AB3010',
  message: `Lowered ${host} Skill document ${issue.field ?? (issue.instancePath || 'root')} ${issue.message}.`,
  recovery: 'Remove the unsupported field or restrict the skill to a host that documents it.',
  severity: 'error' as const,
  sourcePath: source,
  target: host,
}));

const validateFrontmatter = (
  host: SkillHost,
  frontmatter: Record<string, unknown>,
  source: string,
): Diagnostic[] => {
  switch (host) {
    case 'claude':
      return schemaIssues(host, validateClaudeSkillFrontmatter(frontmatter), source);
    case 'cursor':
      return schemaIssues(host, validateCursorSkillFrontmatter(frontmatter), source);
    case 'codex':
    case 'portable':
      return schemaIssues(host, validateAgentSkillsFrontmatter(frontmatter), source);
    default: {
      const exhaustive: never = host;
      return exhaustive;
    }
  }
};

const lowerBody = (
  ir: SkillIr,
  host: SkillHost,
): { readonly body: string; readonly diagnostics: Diagnostic[]; readonly tokenLowering: SkillTokenLoweringRecord[] } => {
  const diagnostics: Diagnostic[] = [];
  const tokenLowering: SkillTokenLoweringRecord[] = ir.placeholders.map((placeholder) => {
    const classification = classifySkillToken(placeholder.token, host, 'skill-markdown');
    const record: SkillTokenLoweringRecord = {
      alias: placeholder.alias,
      class: classification.class === 'none' ? 'none' : 'portable',
      document: 'skill-markdown',
      host,
      ...(classification.syntax === undefined ? {} : { syntax: classification.syntax }),
      token: placeholder.token,
    };
    if (classification.class === 'none') {
      diagnostics.push({
        code: 'AB3008',
        message: `Skill token ${JSON.stringify(placeholder.token)} has no ${host} Skill Markdown equivalent.`,
        recovery: 'Remove the token, restrict the skill to a host that documents it, or move the reference to a document that host interpolates.',
        severity: 'error',
        sourcePath: ir.source,
        target: host,
      });
    }
    return record;
  });

  const body = replaceSkillTokens(ir.body, (occurrence) => {
    const classification = classifySkillToken(occurrence.token, host, 'skill-markdown');
    return classification.syntax ?? '';
  });

  for (const syntax of foreignSkillMarkdownSyntax(host)) {
    if (body.includes(syntax)) {
      diagnostics.push({
        code: 'AB3009',
        message: `Lowered ${host} Skill Markdown contains foreign host syntax ${JSON.stringify(syntax)}.`,
        recovery: 'Use canonical agent-bundle tokens so lowering emits only this host\'s documented placeholders.',
        severity: 'error',
        sourcePath: ir.source,
        target: host,
      });
    }
  }

  return { body, diagnostics, tokenLowering };
};

/**
 * The Codex `agents/openai.yaml` sidecar a skill's `codex` extension declares,
 * with its schema diagnostics. A file of its own beside `SKILL.md` that no
 * other host reads, so a root shared with other hosts (#555) still emits it.
 */
export const codexSkillSidecars = (
  ir: SkillIr,
): { readonly diagnostics: readonly Diagnostic[]; readonly sidecars: readonly SkillSidecarRef[] } => {
  if (ir.passThrough || ir.extensions.codex === undefined) return { diagnostics: [], sidecars: [] };
  const sidecar = codexSidecarDocument(ir.extensions.codex);
  return {
    diagnostics: schemaIssues('codex', validateCodexOpenaiYaml(sidecar), ir.source),
    sidecars: [{ content: stringifyYaml(sidecar), relativePath: 'agents/openai.yaml' }],
  };
};

export const lowerSkillIr = (ir: SkillIr, host: SkillHost): SkillHostDocument => {
  if (ir.passThrough) {
    return deepFreeze({
      diagnostics: [],
      frontmatter: { ...portableFrontmatter(ir.portable) },
      passThrough: true,
      sidecars: [],
      skillMarkdown: ir.markdown,
      target: host,
      tokenLowering: [],
    });
  }

  const lowered = lowerBody(ir, host);
  const diagnostics: Diagnostic[] = [...ir.diagnostics, ...lowered.diagnostics];
  const sidecars: SkillSidecarRef[] = [];
  let frontmatter: Record<string, unknown>;

  switch (host) {
    case 'claude':
      frontmatter = claudeFrontmatter(ir.portable, ir.extensions.claude);
      break;
    case 'cursor':
      frontmatter = cursorFrontmatter(ir.portable, ir.extensions.cursor);
      break;
    case 'codex': {
      frontmatter = portableFrontmatter(ir.portable);
      const codex = codexSkillSidecars(ir);
      diagnostics.push(...codex.diagnostics);
      sidecars.push(...codex.sidecars);
      break;
    }
    case 'portable':
      frontmatter = portableFrontmatter(ir.portable);
      break;
    default: {
      const exhaustive: never = host;
      return exhaustive;
    }
  }

  diagnostics.push(...validateFrontmatter(host, frontmatter, ir.source));
  return deepFreeze({
    diagnostics: Object.freeze(diagnostics),
    frontmatter,
    passThrough: false,
    sidecars: Object.freeze(sidecars),
    skillMarkdown: rebuildMarkdown(frontmatter, lowered.body),
    target: host,
    tokenLowering: Object.freeze(lowered.tokenLowering),
  });
};

export const decideSkillTreeLayout = (
  documents: Readonly<Record<string, SkillHostDocument>>,
): SkillTreeLayoutDecision => {
  const markdown = Object.values(documents)
    .filter((document): document is SkillHostDocument => document !== undefined)
    .map((document) => document.skillMarkdown);
  const sidecars = Object.values(documents)
    .filter((document): document is SkillHostDocument => document !== undefined)
    .some((document) => document.sidecars.length > 0);
  const unique = new Set(markdown);
  if (unique.size <= 1 && !sidecars) {
    return Object.freeze({
      decision: 'shared',
      evidence: 'Lowered Skill Markdown is byte-identical across the selected hosts and no host sidecar is required.',
      feeds: '#101',
      reason: 'A shared skills/ tree is valid only while every selected host receives the same document bytes.',
    });
  }
  return Object.freeze({
    decision: 'per-host-required',
    evidence: sidecars
      ? 'At least one host requires a sidecar (for example Codex agents/openai.yaml) or a different Skill Markdown document.'
      : 'Selected hosts lower to different Skill Markdown bytes (frontmatter extensions or placeholder syntax).',
    feeds: '#101',
    reason: 'Do not claim one shared skills/ file is valid without semantic identity. Install-time selection is #101.',
  });
};

export const lowerSkillIrForHosts = (
  ir: SkillIr,
  hosts: readonly SkillHost[],
): Readonly<Record<string, SkillHostDocument>> =>
  Object.freeze(Object.fromEntries(hosts.map((host) => [host, lowerSkillIr(ir, host)])));
