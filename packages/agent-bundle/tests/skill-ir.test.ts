import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from '@rstest/core';

import { sha256Hex } from '../src/core/digest.ts';
import { skillHostSchemaRevision } from '../src/schemas/skill-hosts/contract.ts';

import { standardPluginArtifactPlan } from '../src/adapters/types.ts';
import {
  discoverProject,
  normalizeProject,
  parseSkill,
  type NormalizationTargetRegistry,
} from '../src/config/index.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';
import { defineSkill, Skill } from '../src/skills/define.ts';
import { inspectSkillProjection } from '../src/skills/inspect.ts';
import { lowerSkillIr } from '../src/skills/lower.ts';
import { parseSkillIr } from '../src/skills/parse-ir.ts';
import { pathTokens } from '../src/core/types.ts';
import {
  classifySkillToken,
  skillTokenSpellings,
  type SkillHost,
} from '../src/skills/tokens.ts';

const portableMarkdown = [
  '---',
  'name: review',
  'description: Identify the purpose of a small repository fixture.',
  '---',
  '',
  '# Review',
  '',
  'Read the repository README and briefly state its purpose.',
  '',
].join('\n');

const registry: NormalizationTargetRegistry = {
  configExtensions: () => [],
  defaultTargetNames: () => ['claude', 'codex', 'cursor'],
  has: (name) => ['portable', 'codex', 'claude', 'cursor', 'plugin'].includes(name),
  supports: () => true,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const projectRoot = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-skill-ir-')));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
};

const loadedProject = (config: AgentBundleConfig, root: string): LoadedConfig => ({
  config,
  configPath: `${root}/agent-bundle.config.ts`,
  context: {
    command: 'build',
    mode: 'production',
    projectRoot: root,
    selectedTargets: [],
  },
});

const pluginConfig = (targets: readonly string[]): AgentBundleConfig => ({
  plugin: { name: 'skill-ir', version: '0.0.0' },
  targets: [...targets],
});

describe('skill host schema pins', () => {
  it('pins closed per-host Skill schemas to immutable provenance', async () => {
    const provenance = JSON.parse(await readFile(
      new URL('../src/schemas/skill-hosts/PROVENANCE.json', import.meta.url),
      'utf8',
    )) as {
      readonly derivedSchemas: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;
      readonly retrievedAt: string;
    };
    expect(skillHostSchemaRevision.retrievedAt).toBe(provenance.retrievedAt);
    for (const [name, expected] of Object.entries(provenance.derivedSchemas)) {
      const bytes = await readFile(new URL(`../src/schemas/skill-hosts/${name}`, import.meta.url));
      expect(bytes.byteLength, name).toBe(expected.bytes);
      expect(sha256Hex(bytes), name).toBe(expected.sha256);
    }
  });
});

describe('skill token registry', () => {
  it('shares plugin and project root spellings with pathTokens', () => {
    expect(skillTokenSpellings.pluginRoot).toBe(pathTokens.pluginRoot);
    expect(skillTokenSpellings.pluginData).toBe(pathTokens.pluginData);
    expect(skillTokenSpellings.projectRoot).toBe(pathTokens.workspaceRoot);
  });

  it('classifies the six canonical tokens per host in Skill Markdown', () => {
    const hosts = ['claude', 'codex', 'cursor', 'portable'] as const satisfies readonly SkillHost[];
    const expected: Record<SkillHost, Record<keyof typeof skillTokenSpellings, 'none' | 'portable'>> = {
      claude: {
        arguments: 'portable',
        pluginData: 'portable',
        pluginRoot: 'portable',
        projectRoot: 'portable',
        sessionIdentity: 'portable',
        skillRoot: 'portable',
      },
      codex: {
        arguments: 'none',
        pluginData: 'none',
        pluginRoot: 'none',
        projectRoot: 'none',
        sessionIdentity: 'none',
        skillRoot: 'none',
      },
      cursor: {
        arguments: 'none',
        pluginData: 'none',
        pluginRoot: 'none',
        projectRoot: 'none',
        sessionIdentity: 'none',
        skillRoot: 'none',
      },
      portable: {
        arguments: 'none',
        pluginData: 'none',
        pluginRoot: 'none',
        projectRoot: 'none',
        sessionIdentity: 'none',
        skillRoot: 'none',
      },
    };

    for (const host of hosts) {
      for (const token of Object.keys(skillTokenSpellings) as (keyof typeof skillTokenSpellings)[]) {
        expect(classifySkillToken(token, host, 'skill-markdown').class, `${host}/${token}`).toBe(
          expected[host][token],
        );
      }
    }
  });

  it('lowers plugin-surface tokens to host syntax in the documented document, never at build time', () => {
    expect(classifySkillToken('pluginRoot', 'claude', 'plugin-config').syntax).toBe('${CLAUDE_PLUGIN_ROOT}');
    expect(classifySkillToken('pluginData', 'claude', 'plugin-config').syntax).toBe('${CLAUDE_PLUGIN_DATA}');
    expect(classifySkillToken('projectRoot', 'claude', 'plugin-config').syntax).toBe('${CLAUDE_PROJECT_DIR}');
    expect(classifySkillToken('pluginRoot', 'codex', 'hooks').syntax).toBe('${PLUGIN_ROOT}');
    expect(classifySkillToken('pluginData', 'codex', 'hooks').syntax).toBe('${PLUGIN_DATA}');
    expect(classifySkillToken('pluginRoot', 'cursor', 'plugin-config').syntax).toBe('${CURSOR_PLUGIN_ROOT}');
    expect(classifySkillToken('projectRoot', 'cursor', 'plugin-config').syntax).toBe('${workspaceFolder}');
    expect(classifySkillToken('pluginData', 'cursor', 'plugin-config').class).toBe('none');
    expect(classifySkillToken('arguments', 'claude', 'skill-markdown').syntax).toBe('$ARGUMENTS');
    expect(classifySkillToken('skillRoot', 'claude', 'skill-markdown').syntax).toBe('${CLAUDE_SKILL_DIR}');
    expect(classifySkillToken('sessionIdentity', 'claude', 'skill-markdown').syntax).toBe('${CLAUDE_SESSION_ID}');
  });
});

describe('canonical Skill IR', () => {
  it('keeps a portable SKILL.md byte-stable when no extension or placeholder requires target output', async () => {
    const root = await projectRoot({ 'skills/review/SKILL.md': portableMarkdown });
    const document = await parseSkill(join(root, 'skills', 'review'), root);
    const ir = parseSkillIr(document);
    expect(ir.diagnostics).toEqual([]);
    expect(ir.passThrough).toBe(true);
    expect(ir.markdown).toBe(portableMarkdown);

    for (const host of ['claude', 'codex', 'cursor', 'portable'] as const) {
      const lowered = lowerSkillIr(ir, host);
      expect(lowered.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
      expect(lowered.skillMarkdown).toBe(portableMarkdown);
      expect(lowered.passThrough).toBe(true);
    }
  });

  it('peels typed host extensions and never copies them into another host document', async () => {
    const markdown = [
      '---',
      'name: review',
      'description: Review a change and report actionable findings.',
      'model: sonnet',
      'context: fork',
      'paths:',
      '  - src/**',
      'disable-model-invocation: true',
      'targets:',
      '  codex:',
      '    interface:',
      '      display_name: Review change',
      '    policy:',
      '      allow_implicit_invocation: true',
      '---',
      '',
      '# Review',
      '',
      'Review the change.',
      '',
    ].join('\n');
    const root = await projectRoot({ 'skills/review/SKILL.md': markdown });
    const document = await parseSkill(join(root, 'skills', 'review'), root);
    const ir = parseSkillIr(document);
    expect(ir.passThrough).toBe(false);
    expect(ir.extensions.claude).toEqual(expect.objectContaining({ context: 'fork', model: 'sonnet' }));
    expect(ir.extensions.cursor).toEqual(expect.objectContaining({
      disableModelInvocation: true,
      paths: ['src/**'],
    }));
    expect(ir.extensions.codex).toEqual(expect.objectContaining({
      interface: { displayName: 'Review change' },
      policy: { allowImplicitInvocation: true },
    }));

    const claude = lowerSkillIr(ir, 'claude');
    expect(claude.frontmatter.model).toBe('sonnet');
    expect(claude.frontmatter.context).toBe('fork');
    expect(claude.frontmatter).not.toHaveProperty('display_name');
    expect(claude.sidecars).toEqual([]);

    const cursor = lowerSkillIr(ir, 'cursor');
    expect(cursor.frontmatter.paths).toEqual(['src/**']);
    expect(cursor.frontmatter['disable-model-invocation']).toBe(true);
    expect(cursor.frontmatter).not.toHaveProperty('model');
    expect(cursor.frontmatter).not.toHaveProperty('context');

    const codex = lowerSkillIr(ir, 'codex');
    expect(codex.frontmatter).not.toHaveProperty('model');
    expect(codex.frontmatter).not.toHaveProperty('paths');
    expect(codex.sidecars).toEqual([expect.objectContaining({
      relativePath: 'agents/openai.yaml',
    })]);
    expect(codex.sidecars[0]?.content).toContain('display_name: Review change');
    expect(codex.sidecars[0]?.content).toContain('allow_implicit_invocation: true');
  });

  it('diagnoses a required token that the selected host cannot express', async () => {
    const markdown = [
      '---',
      'name: review',
      'description: Review arguments in the project.',
      '---',
      '',
      `Review ${skillTokenSpellings.arguments} in ${skillTokenSpellings.projectRoot}.`,
      '',
    ].join('\n');
    const root = await projectRoot({ 'skills/review/SKILL.md': markdown });
    const ir = parseSkillIr(await parseSkill(join(root, 'skills', 'review'), root));
    expect(ir.passThrough).toBe(false);
    expect(ir.placeholders.map((placeholder) => placeholder.token)).toEqual(['arguments', 'projectRoot']);

    const claude = lowerSkillIr(ir, 'claude');
    expect(claude.diagnostics).toEqual([]);
    expect(claude.skillMarkdown).toContain('$ARGUMENTS');
    expect(claude.skillMarkdown).toContain('${CLAUDE_PROJECT_DIR}');
    expect(claude.skillMarkdown).not.toContain(skillTokenSpellings.arguments);
    expect(claude.skillMarkdown).not.toContain('${CURSOR_PLUGIN_ROOT}');

    const cursor = lowerSkillIr(ir, 'cursor');
    expect(cursor.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB3008', severity: 'error', target: 'cursor' }),
    ]));
    expect(cursor.skillMarkdown).not.toContain('$ARGUMENTS');
    expect(cursor.skillMarkdown).not.toContain(skillTokenSpellings.arguments);
  });

  it('rejects unknown source fields instead of smuggling them through a closed schema', async () => {
    const markdown = [
      '---',
      'name: review',
      'description: Review a change.',
      'invented-host-field: true',
      '---',
      '',
      '# Review',
      '',
    ].join('\n');
    const root = await projectRoot({ 'skills/review/SKILL.md': markdown });
    const ir = parseSkillIr(await parseSkill(join(root, 'skills', 'review'), root));
    expect(ir.diagnostics).toEqual([expect.objectContaining({
      code: 'AB3006',
      message: expect.stringContaining('invented-host-field'),
      severity: 'error',
    })]);
  });

  it('surfaces the shared-vs-per-host skills tree as an inspect-visible evidence decision', async () => {
    const root = await projectRoot({
      'skills/review/SKILL.md': [
        '---',
        'name: review',
        'description: Review a change.',
        'model: sonnet',
        '---',
        '',
        '# Review',
        '',
      ].join('\n'),
    });
    const ir = parseSkillIr(await parseSkill(join(root, 'skills', 'review'), root));
    const inspection = inspectSkillProjection(ir, ['claude', 'codex', 'cursor']);
    expect(inspection.authoredMarkdown).toContain('model: sonnet');
    expect(inspection.skillTreeLayout.decision).toBe('per-host-required');
    expect(inspection.skillTreeLayout.feeds).toBe('#101');
    expect(inspection.hostDocuments.claude?.frontmatter).toEqual(expect.objectContaining({ model: 'sonnet' }));
    expect(inspection.hostDocuments.codex?.frontmatter).not.toHaveProperty('model');
    expect(inspection.tokenLowering.length).toBeGreaterThanOrEqual(0);
  });
});

describe('static lowering through the rendered-skill path', () => {
  it('keeps defineSkill and Skill token components as identity helpers over the registry', () => {
    const skill = defineSkill({
      name: 'review',
      description: 'Review a change and report actionable findings.',
      targets: {
        claude: { model: 'sonnet', context: 'fork' },
        cursor: { paths: ['src/**'] },
      },
    });
    expect(skill.targets.claude).toEqual({ context: 'fork', model: 'sonnet' });
    expect(Skill.Arguments()).toBe(skillTokenSpellings.arguments);
    expect(Skill.ProjectRoot()).toBe(skillTokenSpellings.projectRoot);
    expect(Skill.Resource({ path: 'references/checklist.md' })).toBe(
      '[references/checklist.md](references/checklist.md)',
    );
  });

  it('compiles SKILL.tsx at build time and projects per-host Markdown without a Flight client', async () => {
    const root = await projectRoot({
      'skills/review/SKILL.ts': [
        `const argumentsToken = ${JSON.stringify(skillTokenSpellings.arguments)};`,
        `const projectRootToken = ${JSON.stringify(skillTokenSpellings.projectRoot)};`,
        "export const frontmatter = { description: 'Review a change and report actionable findings.', name: 'review' };",
        'export const targets = {',
        "  claude: { model: 'sonnet', context: 'fork' },",
        "  cursor: { paths: ['src/**'] },",
        "  codex: { interface: { displayName: 'Review change' }, policy: { allowImplicitInvocation: true } },",
        '};',
        'export default function ReviewSkill() {',
        "  return [{ props: { children: 'Review the change' }, type: 'h1' }, { props: { children: ['Review ', argumentsToken, ' in ', projectRootToken, '.'] }, type: 'p' }];",
        '}',
        '',
      ].join('\n'),
    });
    const document = await parseSkill(join(root, 'skills', 'review'), root);
    expect(document.diagnostics).toEqual([]);
    expect(document.rendered).toBe(true);
    const ir = parseSkillIr(document);
    expect(ir.extensions.claude).toEqual({ context: 'fork', model: 'sonnet' });
    const claude = lowerSkillIr(ir, 'claude');
    expect(claude.skillMarkdown).toContain('$ARGUMENTS');
    expect(claude.skillMarkdown).toContain('${CLAUDE_PROJECT_DIR}');
    expect(claude.frontmatter.model).toBe('sonnet');
  });

  it('lets the artifact planner own destinations and keeps portable skills as copy pass-through', async () => {
    const root = await projectRoot({
      'agent-bundle.config.ts': '',
      'skills/review/SKILL.md': portableMarkdown,
    });
    const loaded = loadedProject(pluginConfig(['claude', 'codex', 'cursor']), root);
    const discovered = await discoverProject(root, loaded.config);
    const model = await normalizeProject(loaded, discovered, registry);
    const skill = model.skills[0];
    expect(skill?.skillIr?.passThrough).toBe(true);
    expect(skill?.hostDocuments?.claude?.passThrough).toBe(true);
    expect(skill?.skillTreeLayout?.decision).toBe('shared');

    const plan = standardPluginArtifactPlan({
      diagnostics: [],
      hookDocumentValid: false,
      hookEntries: [],
      hookManifestPath: 'hooks/hooks.json',
      isSelected: () => true,
      marketplaceRelativePath: '.claude-plugin/marketplace.json',
      marketplaceValid: false,
      mcpValid: false,
      model,
      plugin: { name: 'skill-ir' },
      pluginRelativePath: '.claude-plugin/plugin.json',
      targetName: 'claude',
    });
    const skillMd = plan.entries.find((entry) => entry.relativePath === 'skills/review/SKILL.md');
    expect(skillMd).toEqual(expect.objectContaining({
      kind: 'copy',
      source: skill?.source,
    }));
  });
});
