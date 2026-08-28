import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { runNodeScript } from './support/run-node-script.ts';
import { build } from './support/build.ts';
import { pathTokens, type NormalizedPlugin } from '../src/core/types.ts';

const configPath = '/workspace/agent-bundle.config.ts';

const bundleModel = Object.freeze({
  extensions: Object.freeze({}),
  hooks: Object.freeze([
    Object.freeze({
      event: 'sessionStart' as const,
      id: 'hook:session-start',
      name: 'session-start',
      provenance: Object.freeze({ kind: 'config' as const, sourcePath: configPath }),
      source: '/workspace/src/hooks/session-start.ts',
      targets: Object.freeze(['plugin']),
      tools: Object.freeze([]),
    }),
    Object.freeze({
      event: 'afterTool' as const,
      id: 'hook:record-write',
      name: 'record-write',
      provenance: Object.freeze({ kind: 'config' as const, sourcePath: configPath }),
      source: '/workspace/src/hooks/record-write.ts',
      targets: Object.freeze(['plugin']),
      tools: Object.freeze(['file.write' as const]),
    }),
  ]),
  marketplace: true as const,
  mcpServers: Object.freeze([
    Object.freeze({
      args: Object.freeze([`${pathTokens.pluginRoot}/mcp/server.mjs`]),
      command: 'node',
      cwd: pathTokens.pluginRoot,
      id: 'mcp:status',
      name: 'status',
      provenance: Object.freeze({ kind: 'config' as const, sourcePath: configPath }),
      targets: Object.freeze(['plugin']),
      transport: 'stdio' as const,
    }),
  ]),
  metadata: Object.freeze({
    description: 'One bundle for every supported host.',
    id: 'plugin:bundle-example',
    name: 'bundle-example',
    provenance: Object.freeze({ kind: 'config' as const, sourcePath: configPath }),
    version: '2.0.0',
  }),
  runtime: Object.freeze({ node: '22.12.0' }),
  scripts: Object.freeze([]),
  skills: Object.freeze([
    Object.freeze({
      body: '# Review\n',
      description: 'Review code and explain findings.',
      dir: '/workspace/skills/review',
      frontmatter: Object.freeze({ description: 'Review code and explain findings.', name: 'review' }),
      id: 'skill:review',
      name: 'review',
      provenance: Object.freeze({ kind: 'conventional' as const, sourcePath: '/workspace/skills/review/SKILL.md' }),
      resources: Object.freeze([
        Object.freeze({ bytes: 9, relativePath: 'SKILL.md', source: '/workspace/skills/review/SKILL.md' }),
        Object.freeze({ bytes: 8, relativePath: 'references/guide.md', source: '/workspace/skills/review/references/guide.md' }),
      ]),
      source: '/workspace/skills/review/SKILL.md',
      targets: Object.freeze(['plugin']),
    }),
  ]),
  targets: Object.freeze([
    Object.freeze({ id: 'target:plugin', name: 'plugin', provenance: Object.freeze({ kind: 'config' as const, sourcePath: configPath }) }),
  ]),
} satisfies NormalizedPlugin);

const planBundle = (model: NormalizedPlugin) => createDefaultRegistry().get('plugin').plan(model);

const writeContents = (model: NormalizedPlugin): Record<string, string> => Object.fromEntries(
  planBundle(model).entries
    .filter((entry): entry is Extract<typeof entry, { readonly kind: 'write' }> => entry.kind === 'write')
    .map((entry) => [entry.relativePath, entry.content]),
);

it('lays both host manifests over one shared bundle root', () => {
  const plan = planBundle(bundleModel);
  expect(plan.diagnostics).toEqual([]);
  const documents = writeContents(bundleModel);

  const claudePlugin = JSON.parse(documents['.claude-plugin/plugin.json']!) as Record<string, unknown>;
  expect(claudePlugin).toMatchObject({ name: 'bundle-example', version: '2.0.0' });
  expect(claudePlugin).not.toHaveProperty('hooks');

  const codexPlugin = JSON.parse(documents['.codex-plugin/plugin.json']!) as Record<string, unknown>;
  expect(codexPlugin).toMatchObject({
    mcpServers: './.codex-plugin/mcp.json',
    name: 'bundle-example',
    skills: './skills/',
  });

  const claudeMcp = JSON.parse(documents['.mcp.json']!) as { readonly mcpServers: Record<string, { readonly args: readonly string[] }> };
  expect(claudeMcp.mcpServers['status']!.args[0]).toBe('${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs');

  const codexMcp = JSON.parse(documents['.codex-plugin/mcp.json']!) as { readonly mcpServers: Record<string, { readonly args: readonly string[]; readonly cwd?: string }> };
  expect(codexMcp.mcpServers['status']!.args[0]).toBe('./mcp/server.mjs');

  const hooks = documents['hooks/hooks.json']!;
  expect(hooks).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs');
  expect(hooks).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/record-write.mjs');
  expect(hooks).toContain('apply_patch|Edit|Write');
  expect(codexPlugin).not.toHaveProperty('hooks');

  expect(documents['.claude-plugin/marketplace.json']).toContain('bundle-example-marketplace');
  expect(documents['.agents/plugins/marketplace.json']).toContain('bundle-example-marketplace');
  expect(documents['AGENTS.md']).toContain('multi-host agent plugin bundle');
  expect(documents['AGENTS.md']).toContain('Claude Code');
  expect(documents['AGENTS.md']).toContain('Codex');
  expect(documents['AGENTS.md']).toContain('Cursor / VS Code / GitHub Copilot');
});

it('emits each shared surface exactly once and suffixes host hook wrappers', () => {
  const plan = planBundle(bundleModel);
  const paths = plan.entries.map((entry) => entry.relativePath);
  expect(paths.filter((path) => path === 'skills/review/SKILL.md')).toHaveLength(1);
  expect(paths.filter((path) => path === 'skills/review/references/guide.md')).toHaveLength(1);
  expect(new Set(paths).size).toBe(paths.length);

  const hookEntries = plan.hookEntries ?? [];
  expect(hookEntries.map((entry) => entry.relativePath).sort()).toEqual([
    'hooks/record-write.mjs',
    'hooks/session-start.mjs',
  ]);
  expect(new Set(hookEntries.map((entry) => entry.target))).toEqual(new Set(['plugin']));
});

it('bakes runtime host detection into the universal wrapper source', () => {
  const plan = planBundle(bundleModel);
  const wrapper = (plan.hookEntries ?? []).find((entry) => entry.relativePath === 'hooks/session-start.mjs');
  expect(wrapper?.virtualSource).toContain('process.env.PLUGIN_ROOT === undefined ? "claude" : "codex"');
  expect(wrapper?.virtualSource).toContain('AGENT_BUNDLE_HOOK_HOST');
});

it('reports a bundle-target conflict instead of silently overwriting an entry', () => {
  // Two skills whose resources collide at the same artifact path with different sources.
  const model: NormalizedPlugin = {
    ...bundleModel,
    marketplace: undefined,
    mcpServers: [],
    skills: [
      bundleModel.skills[0]!,
      {
        ...bundleModel.skills[0]!,
        id: 'skill:review-shadow',
        provenance: { kind: 'explicit', sourcePath: '/workspace/other/review/SKILL.md' },
        resources: [{ bytes: 5, relativePath: 'SKILL.md', source: '/workspace/other/review/SKILL.md' }],
        source: '/workspace/other/review/SKILL.md',
      },
    ],
  };
  const plan = planBundle(model);
  const conflict = expect.objectContaining({ code: 'plugin.artifact.conflict', severity: 'error' });
  expect(plan.diagnostics).toEqual([conflict, conflict]);
});

it('builds the unified bundle root on disk with compiled per-host hook wrappers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-plugin-bundle-'));
  const outputRoot = join(root, 'dist');
  const skillRoot = join(root, 'skills', 'review');
  const skillMarkdown = '---\nname: review\ndescription: Review code and explain findings.\n---\n\n# Review\n';
  await mkdir(join(skillRoot, 'references'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
    writeFile(join(skillRoot, 'SKILL.md'), skillMarkdown),
    writeFile(join(skillRoot, 'references', 'guide.md'), '# Guide\n'),
  ]);
  const hookSource = join(root, 'src', 'hooks', 'session-start.ts');
  await mkdir(join(root, 'src', 'hooks'), { recursive: true });
  await writeFile(hookSource, "export default (event: unknown, context: { target: string }) => ({ additionalContext: `host:${context.target}`, outcome: 'continue' as const });\n");
  const model: NormalizedPlugin = {
    ...bundleModel,
    hooks: [{
      ...bundleModel.hooks[0]!,
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
      source: hookSource,
    }],
    mcpServers: [],
    metadata: {
      ...bundleModel.metadata,
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
    },
    skills: [{
      ...bundleModel.skills[0]!,
      dir: skillRoot,
      provenance: { kind: 'conventional', sourcePath: join(skillRoot, 'SKILL.md') },
      resources: [
        { bytes: Buffer.byteLength(skillMarkdown), relativePath: 'SKILL.md', source: join(skillRoot, 'SKILL.md') },
        { bytes: 8, relativePath: 'references/guide.md', source: join(skillRoot, 'references', 'guide.md') },
      ],
      source: join(skillRoot, 'SKILL.md'),
    }],
    targets: [
      { id: 'target:plugin', name: 'plugin', provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') } },
    ],
  };

  try {
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });
    const bundleRoot = join(outputRoot, 'plugin');
    await expect(readFile(join(bundleRoot, '.claude-plugin', 'plugin.json'), 'utf8')).resolves.toContain('bundle-example');
    await expect(readFile(join(bundleRoot, '.codex-plugin', 'plugin.json'), 'utf8')).resolves.toContain('./skills/');
    await expect(readFile(join(bundleRoot, 'AGENTS.md'), 'utf8')).resolves.toContain('multi-host agent plugin bundle');
    await expect(readFile(join(bundleRoot, 'skills', 'review', 'SKILL.md'), 'utf8')).resolves.toBe(skillMarkdown);
    await expect(readFile(join(bundleRoot, 'hooks', 'hooks.json'), 'utf8')).resolves.toContain('${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs');
    const wrapper = join(bundleRoot, 'hooks', 'session-start.mjs');
    const nativeInput = JSON.stringify({
      cwd: '/workspace', hook_event_name: 'SessionStart', session_id: 'session-1', source: 'startup', transcript_path: '/workspace/transcript.json',
    });
    // Codex documents exporting PLUGIN_ROOT into hook processes; Claude does not.
    expect(process.env['PLUGIN_ROOT']).toBeUndefined();
    await expect(runNodeScript({ args: [wrapper], env: { PLUGIN_ROOT: '/plugin' }, input: nativeInput })).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('host:codex'),
    });
    await expect(runNodeScript({ args: [wrapper], input: nativeInput })).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('host:claude'),
    });
    await expect(runNodeScript({ args: [wrapper], env: { AGENT_BUNDLE_HOOK_HOST: 'codex' }, input: nativeInput })).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('host:codex'),
    });
    const manifest = JSON.parse(await readFile(join(outputRoot, 'agent-bundle.manifest.json'), 'utf8')) as {
      readonly files: readonly { readonly path: string }[];
      readonly targets: readonly { readonly name: string }[];
    };
    expect(manifest.targets.map(({ name }) => name)).toEqual(['plugin']);
    expect(manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'plugin/.claude-plugin/plugin.json',
      'plugin/.codex-plugin/plugin.json',
      'plugin/AGENTS.md',
      'plugin/skills/review/SKILL.md',
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
