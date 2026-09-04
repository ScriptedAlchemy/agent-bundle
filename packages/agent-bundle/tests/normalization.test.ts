import { expect, it } from '@rstest/core';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as normalizeModule from '../src/config/normalize.ts';
import {
  normalizeProject,
  validateModel,
  validateSource,
  type NormalizationTargetRegistry,
} from '../src/config/index.ts';
import { createDefaultRegistry } from '../src/adapters/registry.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';
import type { Diagnostic } from '../src/core/diagnostics.ts';
import type { DiscoveredProject } from '../src/config/discover.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import { emptyRouteConfig, type CompiledAgentRoute, type CompiledRouteGraph } from '../src/routes/types.ts';

const registry: NormalizationTargetRegistry = {
  configExtensions: () => [],
  defaultTargetNames: () => ['portable'],
  has: (name) => ['portable', 'codex', 'claude'].includes(name),
  supports: (name, capability) => capability === 'hooks' && name !== 'portable',
};

const extensionRegistry: NormalizationTargetRegistry = {
  configExtensions: () => Object.freeze([
    Object.freeze({ key: 'example', target: 'example' }),
  ]),
  defaultTargetNames: () => ['example'],
  has: (name) => name === 'example',
  supports: (name, capability) => name === 'example' && capability === 'hooks',
};

it.each(['SRC', '.Git', 'NODE_MODULES', '.AGENT-BUNDLE'])(
  'reserves artifact output segment %s without case sensitivity',
  (distPath) => {
    expect(normalizeModule.artifactDistPathIssue(distPath)).toBe('reserved');
  },
);

it('keeps internal config-extension finite JSON failures non-constructible', () => {
  expect(normalizeModule).not.toHaveProperty('ConfigExtensionFiniteJsonError');
});

const loadedProject = (
  config: AgentBundleConfig,
  options: { root?: string; selectedTargets?: string[] } = {},
): LoadedConfig => {
  const root = options.root ?? '/workspace/project';

  return {
    config,
    configPath: `${root}/agent-bundle.config.ts`,
    context: {
      command: 'build',
      mode: 'production',
      projectRoot: root,
      selectedTargets: options.selectedTargets ?? [],
    },
  };
};

const skill = (
  root: string,
  directory: string,
  name: string,
  options: {
    body?: string;
    description?: unknown;
    resources?: string[];
  } = {},
): DiscoveredProject['skills'][number] => {
  const dir = `${root}/src/skills/${directory}`;

  return {
    body: options.body ?? '# Skill\n',
    diagnostics: [],
    dir,
    frontmatter: {
      description: options.description ?? `Use ${name}`,
      name,
    },
    markdown: options.body ?? '# Skill\n',
    resources: (options.resources ?? ['SKILL.md']).map((relativePath) => ({
      bytes: 1,
      relativePath,
      source: `${dir}/${relativePath}`,
    })),
    source: `${dir}/SKILL.md`,
  };
};

it.each([
  {
    label: 'registry defaults',
    configTargets: undefined,
    selectedTargets: [],
    expected: ['portable'],
  },
  {
    label: 'explicit config targets',
    configTargets: ['claude', 'portable'],
    selectedTargets: [],
    expected: ['claude', 'portable'],
  },
  {
    label: 'CLI-selected targets with stable deduplication',
    configTargets: ['claude'],
    selectedTargets: ['codex', 'portable', 'codex'],
    expected: ['codex', 'portable'],
  },
])('normalizes target selection from $label', async (testCase) => {
  const loaded = loadedProject(
    {
      plugin: { name: 'review-tools', version: '1.0.0' },
      targets: testCase.configTargets,
    },
    { selectedTargets: testCase.selectedTargets },
  );

  const model = await normalizeProject(loaded, { skills: [] }, registry);

  expect(model.targets.map((target) => target.name)).toEqual(testCase.expected);
  expect(model.targets.map((target) => target.id)).toEqual(
    testCase.expected.map((name) => `target:${name}`),
  );
});

it('normalizes registered extensions and validates registered script and hook targets', async () => {
  const config: AgentBundleConfig = {
    example: { nested: { enabled: true } },
    hooks: { sessionStart: { handler: './hooks/start.ts', targets: ['example'] } },
    ignored: { mustNotReachTheModel: true },
    plugin: { name: 'extension-fixture', version: '1.0.0' },
    scripts: {
      run: {
        entry: './packages/agent-bundle/src/config/normalize.ts',
        targets: ['example'],
      },
    },
  };
  const loaded = loadedProject(config, { root: process.cwd() });
  const sourceValidator = validateSource as unknown as (
    loaded: LoadedConfig,
    discovered: DiscoveredProject,
    targetRegistry: NormalizationTargetRegistry,
  ) => Diagnostic[];

  // This fixture is rooted at the workspace, whose package.json version
  // (0.0.0) differs from the fixture's plugin.version, so the AB4008
  // mismatch warning (#94) is the only expected diagnostic.
  expect(sourceValidator(loaded, { skills: [] }, extensionRegistry).map(({ code }) => code)).toEqual(['AB4008']);

  const model = await normalizeProject(loaded, { skills: [] }, extensionRegistry);
  const extensions = (model as unknown as {
    extensions: Readonly<Record<string, {
      id: string;
      key: string;
      provenance: { kind: string; sourcePath: string };
      target: string;
      value: { nested: { enabled: boolean } };
    }>>;
  }).extensions;

  expect(extensions).toEqual({
    example: {
      id: 'extension:example',
      key: 'example',
      provenance: { kind: 'config', sourcePath: loaded.configPath },
      target: 'example',
      value: { nested: { enabled: true } },
    },
  });
  expect(Object.isFrozen(extensions)).toBe(true);
  expect(Object.isFrozen(extensions.example?.value)).toBe(true);
  expect(Object.isFrozen(extensions.example?.value.nested)).toBe(true);
});

it('enumerates lsp components with unambiguous ids for any server name (#100)', async () => {
  const model = await normalizeProject(loadedProject({
    claude: {
      lspServers: {
        'a:b': { command: 'first-ls', extensionToLanguage: { '.a': 'a' } },
        'pct%': { command: 'second-ls', extensionToLanguage: { '.b': 'b' } },
        typescript: { command: 'typescript-language-server', extensionToLanguage: { '.ts': 'typescript' } },
        '\uD800': { command: 'third-ls', extensionToLanguage: { '.c': 'c' } },
      },
    },
    plugin: { name: 'claude-lsp-fixture', version: '1.0.0' },
    targets: ['claude', 'cursor'],
  }), { skills: [] }, createDefaultRegistry());

  // Separator and escape characters are escaped so the (key, name) tuple is
  // recoverable; a lone surrogate is accepted rather than aborting normalization.
  expect(new Set(model.lspServers?.map((server) => server.id))).toEqual(new Set([
    'lsp:claude:\uD800',
    'lsp:claude:a%3Ab',
    'lsp:claude:pct%25',
    'lsp:claude:typescript',
  ]));
  expect(model.lspServers).toHaveLength(4);
  // Only adapters that lower the `claude` extension are targeted.
  for (const server of model.lspServers ?? []) {
    expect(server).toMatchObject({ declaredBy: 'claude', targets: ['claude'] });
  }
  expect(Object.isFrozen(model.lspServers)).toBe(true);
});

it('normalizes the typed Claude LSP source surface through the strict JSON extension seam', async () => {
  const model = await normalizeProject(loadedProject({
    claude: {
      lspServers: {
        typescript: {
          args: ['--stdio'],
          command: 'typescript-language-server',
          extensionToLanguage: { '.ts': 'typescript' },
          workspaceFolder: '/workspace/project',
        },
      },
    },
    plugin: { name: 'claude-lsp-fixture', version: '1.0.0' },
    targets: ['claude'],
  }), { skills: [] }, createDefaultRegistry());
  const extension = model.extensions.claude;

  expect(extension).toMatchObject({
    id: 'extension:claude',
    key: 'claude',
    target: 'claude',
    value: {
      lspServers: {
        typescript: {
          args: ['--stdio'],
          command: 'typescript-language-server',
          extensionToLanguage: { '.ts': 'typescript' },
          workspaceFolder: '/workspace/project',
        },
      },
    },
  });
  expect(Object.isFrozen(extension)).toBe(true);
  expect(Object.isFrozen(extension?.value)).toBe(true);
});

it('enumerates claude.bin relative to the config file into immutable executable metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-bin-normalize-'));
  const configDir = join(root, 'configs');
  const binRoot = join(root, 'tools');
  const executable = join(binRoot, 'review-tool');
  const support = join(binRoot, 'lib', 'config.json');
  const executableContents = '#!/usr/bin/env sh\nprintf "reviewed\\n"\n';
  const supportContents = '{"enabled":true}\n';
  await mkdir(join(binRoot, 'lib'), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await Promise.all([
    writeFile(executable, executableContents),
    writeFile(support, supportContents),
  ]);
  await chmod(executable, 0o751);
  const loaded: LoadedConfig = {
    ...loadedProject({
      claude: { bin: '../tools' },
      plugin: { name: 'claude-bin-fixture', version: '1.0.0' },
      targets: ['claude'],
    }, { root }),
    configPath: join(configDir, 'agent-bundle.config.ts'),
  };

  try {
    const model = await normalizeProject(loaded, { skills: [] }, createDefaultRegistry());

    expect(model.hostBins).toEqual([{
      files: [
        {
          bytes: Buffer.byteLength(supportContents),
          executable: false,
          relativePath: 'lib/config.json',
          source: support,
        },
        {
          bytes: Buffer.byteLength(executableContents),
          executable: true,
          relativePath: 'review-tool',
          source: executable,
        },
      ],
      provenance: { kind: 'config', sourcePath: loaded.configPath },
      source: binRoot,
      target: 'claude',
    }]);
    expect(Object.isFrozen(model.hostBins)).toBe(true);
    expect(Object.isFrozen(model.hostBins?.[0])).toBe(true);
    expect(Object.isFrozen(model.hostBins?.[0]?.files)).toBe(true);
    expect(Object.isFrozen(model.hostBins?.[0]?.files[0])).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('enumerates Claude workflows and output styles relative to the config file into immutable payload metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-payloads-normalize-'));
  const configDir = join(root, 'configs');
  const workflowsRoot = join(root, 'workflows');
  const outputStylesRoot = join(root, 'styles');
  const workflow = join(workflowsRoot, 'release-audit.js');
  const outputStyle = join(outputStylesRoot, 'terse.md');
  const workflowContents = 'export default async function releaseAudit() {}\n';
  const outputStyleContents = '---\nname: Terse\ndescription: Be concise\n---\n\nBe concise.\n';
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(workflowsRoot, { recursive: true }),
    mkdir(outputStylesRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(workflow, workflowContents),
    writeFile(outputStyle, outputStyleContents),
  ]);
  const loaded: LoadedConfig = {
    ...loadedProject({
      claude: {
        outputStyles: '../styles',
        workflows: '../workflows',
      },
      plugin: { name: 'claude-payload-fixture', version: '1.0.0' },
      targets: ['claude'],
    }, { root }),
    configPath: join(configDir, 'agent-bundle.config.ts'),
  };

  try {
    const model = await normalizeProject(loaded, { skills: [] }, createDefaultRegistry());

    expect(model.hostWorkflows).toEqual([{
      files: [{
        bytes: Buffer.byteLength(workflowContents),
        executable: false,
        relativePath: 'release-audit.js',
        source: workflow,
      }],
      provenance: { kind: 'config', sourcePath: loaded.configPath },
      source: workflowsRoot,
      target: 'claude',
    }]);
    expect(model.hostOutputStyles).toEqual([{
      files: [{
        bytes: Buffer.byteLength(outputStyleContents),
        executable: false,
        relativePath: 'terse.md',
        source: outputStyle,
      }],
      provenance: { kind: 'config', sourcePath: loaded.configPath },
      source: outputStylesRoot,
      target: 'claude',
    }]);
    expect(Object.isFrozen(model.hostWorkflows)).toBe(true);
    expect(Object.isFrozen(model.hostWorkflows?.[0]?.files[0])).toBe(true);
    expect(Object.isFrozen(model.hostOutputStyles)).toBe(true);
    expect(Object.isFrozen(model.hostOutputStyles?.[0]?.files[0])).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each([
  { code: 'claude.bin.directory.missing', create: false, issue: 'missing' as const },
  { code: 'claude.bin.directory.empty', create: true, issue: 'empty' as const },
])('normalizes and diagnoses a claude.bin directory that is $issue', async ({ code, create, issue }) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-bin-diagnostic-'));
  const binRoot = join(root, 'tools');
  if (create) await mkdir(binRoot, { recursive: true });
  const loaded = loadedProject({
    claude: { bin: './tools' },
    plugin: { name: 'claude-bin-diagnostic', version: '1.0.0' },
    targets: ['claude'],
  }, { root });

  try {
    const model = await normalizeProject(loaded, { skills: [] }, createDefaultRegistry());
    const plan = createDefaultRegistry().get('claude').plan(model);

    expect(model.hostBins?.[0]).toMatchObject({ files: [], issue, source: binRoot, target: 'claude' });
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code, severity: 'error' }));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each([
  {
    code: 'claude.workflows.directory.empty',
    field: 'workflows' as const,
    issue: 'empty' as const,
  },
  {
    code: 'claude.outputStyles.directory.missing',
    field: 'outputStyles' as const,
    issue: 'missing' as const,
  },
])('normalizes and diagnoses a Claude $field directory that is $issue', async ({ code, field, issue }) => {
  const root = await mkdtemp(join(tmpdir(), `agent-bundle-claude-${field}-diagnostic-`));
  const sourceRoot = join(root, 'payload');
  if (issue === 'empty') await mkdir(sourceRoot, { recursive: true });
  const loaded = loadedProject({
    claude: { [field]: './payload' },
    plugin: { name: 'claude-payload-diagnostic', version: '1.0.0' },
    targets: ['claude'],
  }, { root });

  try {
    const model = await normalizeProject(loaded, { skills: [] }, createDefaultRegistry());
    const plan = createDefaultRegistry().get('claude').plan(model);
    const payload = field === 'workflows' ? model.hostWorkflows?.[0] : model.hostOutputStyles?.[0];

    expect(payload).toMatchObject({ files: [], issue, source: sourceRoot, target: 'claude' });
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code, severity: 'error' }));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a Claude payload directory symlink that resolves outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-payload-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-payload-outside-'));
  const linked = join(root, 'styles');
  await writeFile(join(outside, 'terse.md'), 'Be concise.\n');
  await symlink(outside, linked, 'dir');
  const loaded = loadedProject({
    claude: { outputStyles: './styles' },
    plugin: { name: 'claude-payload-symlink', version: '1.0.0' },
    targets: ['claude'],
  }, { root });

  try {
    const model = await normalizeProject(loaded, { skills: [] }, createDefaultRegistry());
    const plan = createDefaultRegistry().get('claude').plan(model);

    expect(model.hostOutputStyles?.[0]).toMatchObject({
      files: [],
      issue: 'outside',
      source: linked,
      target: 'claude',
    });
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({
      code: 'claude.outputStyles.directory.outside',
      severity: 'error',
    }));
  } finally {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(outside, { force: true, recursive: true }),
    ]);
  }
});

it('rejects non-JSON values in registered config extensions before normalization', async () => {
  class ExtensionClass {
    readonly enabled = true;
  }
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const prototypeMutated = Object.setPrototypeOf({ enabled: true }, { inherited: true });
  const values: readonly unknown[] = [
    new Map([['value', true]]),
    new Set(['value']),
    new Date('2026-08-15T00:00:00.000Z'),
    /extension/u,
    new ExtensionClass(),
    () => true,
    Symbol('extension'),
    1n,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    cyclic,
    prototypeMutated,
  ];

  for (const value of values) {
    await expect(normalizeProject(loadedProject({
      example: value,
      plugin: { name: 'extension-json-fixture', version: '1.0.0' },
    }), { skills: [] }, extensionRegistry)).rejects.toThrow(
      'AB4500: A registered config extension must contain strict finite JSON data.',
    );
  }
});

it('detaches and freezes strict JSON extension values with special own keys and aliases', async () => {
  const shared = { nested: ['original'] };
  const extension = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(extension, '__proto__', {
    configurable: true,
    enumerable: true,
    value: { preserved: true },
    writable: true,
  });
  Object.defineProperties(extension, {
    constructor: { configurable: true, enumerable: true, value: { preserved: true }, writable: true },
    first: { configurable: true, enumerable: true, value: shared, writable: true },
    second: { configurable: true, enumerable: true, value: shared, writable: true },
  });
  const model = await normalizeProject(loadedProject({
    example: extension,
    plugin: { name: 'extension-json-fixture', version: '1.0.0' },
  }), { skills: [] }, extensionRegistry);
  const value = model.extensions.example!.value as Record<string, { nested?: string[]; preserved?: boolean }>;

  shared.nested[0] = 'mutated';
  expect(value).toMatchObject({
    __proto__: { preserved: true },
    constructor: { preserved: true },
    first: { nested: ['original'] },
    second: { nested: ['original'] },
  });
  expect(Object.getPrototypeOf(value)).toBeNull();
  expect(Object.hasOwn(value, '__proto__')).toBe(true);
  expect(Object.hasOwn(value, 'constructor')).toBe(true);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.first)).toBe(true);
  expect(Object.isFrozen(value.first?.nested)).toBe(true);
  expect(() => value.first!.nested!.push('blocked')).toThrow();
});

it('reports unknown hook and script targets through the target registry', () => {
  const targetRegistry: NormalizationTargetRegistry = {
    configExtensions: () => [],
    defaultTargetNames: () => ['example'],
    has: (name) => name === 'example',
    supports: () => false,
  };
  const loaded = loadedProject({
    hooks: { stop: { handler: './hooks/stop.ts', targets: ['unknown'] } },
    plugin: { name: 'registry-validation', version: '1.0.0' },
    scripts: {
      run: {
        entry: './packages/agent-bundle/src/config/normalize.ts',
        targets: ['unknown'],
      },
    },
  }, { root: process.cwd() });
  const sourceValidator = validateSource as unknown as (
    config: LoadedConfig,
    discovered: DiscoveredProject,
    registry: NormalizationTargetRegistry,
  ) => Diagnostic[];

  // The workspace root package.json version (0.0.0) differs from the
  // fixture's plugin.version, adding the AB4008 mismatch warning (#94).
  expect(sourceValidator(loaded, { skills: [] }, targetRegistry).map(({ code }) => code)).toEqual([
    'AB4008',
    'AB4203',
    'AB4406',
  ]);
});

it('validates native hook targets through the target registry', async () => {
  const targetRegistry: NormalizationTargetRegistry = {
    configExtensions: () => [],
    defaultTargetNames: () => ['example'],
    has: (name) => name === 'example' || name === 'portable',
    supports: (name, capability) => name === 'example' && capability === 'hooks',
  };
  const loaded = loadedProject({
    plugin: { name: 'native-hook-targets', version: '1.0.0' },
  });
  const model = await normalizeProject(loaded, { skills: [] }, targetRegistry);
  const nativeHooks = [
    { document: {}, provenance: model.metadata.provenance, source: '/workspace/ghost.json', target: 'ghost' },
    { document: {}, provenance: model.metadata.provenance, source: '/workspace/portable.json', target: 'portable' },
    { document: {}, provenance: model.metadata.provenance, source: '/workspace/example.json', target: 'example' },
  ];

  expect(validateModel({ ...model, nativeHooks }, targetRegistry)).toEqual([
    {
      code: 'AB4206',
      message: 'Native hook selects unknown target "ghost".',
      severity: 'error',
      sourcePath: loaded.configPath,
      target: 'ghost',
    },
    {
      code: 'AB4207',
      message: 'Target "portable" cannot emit native hooks.',
      severity: 'error',
      sourcePath: loaded.configPath,
      target: 'portable',
    },
  ]);
});

it('produces root-independent IDs, complete provenance, and deeply immutable output', async () => {
  const leftRoot = '/workspace/left';
  const rightRoot = '/different/right';
  const config: AgentBundleConfig = {
    plugin: { name: 'review-tools', version: '1.0.0' },
    skills: ['src/skills/review'],
  };
  const leftSkill = skill(leftRoot, 'review', 'review', {
    resources: ['SKILL.md', 'references/checklist.md'],
  });
  const rightSkill = skill(rightRoot, 'review', 'review', {
    resources: ['SKILL.md', 'references/checklist.md'],
  });

  const left = await normalizeProject(
    loadedProject(config, { root: leftRoot }),
    { skills: [leftSkill] },
    registry,
  );
  const right = await normalizeProject(
    loadedProject(config, { root: rightRoot }),
    { skills: [rightSkill] },
    registry,
  );

  expect(left.metadata.id).toBe('plugin:review-tools');
  expect(left.skills[0]?.id).toBe('skill:review');
  expect(left.skills[0]?.provenance).toEqual({
    kind: 'explicit',
    sourcePath: leftSkill.source,
  });
  expect(left.metadata.provenance.sourcePath).toBe(
    `${leftRoot}/agent-bundle.config.ts`,
  );
  expect(left.skills.map(({ id }) => id)).toEqual(
    right.skills.map(({ id }) => id),
  );
  expect(Object.isFrozen(left)).toBe(true);
  expect(Object.isFrozen(left.metadata)).toBe(true);
  expect(Object.isFrozen(left.targets)).toBe(true);
  expect(Object.isFrozen(left.skills[0]?.resources)).toBe(true);
  expect(Object.isFrozen(left.skills[0]?.resources[0])).toBe(true);

  expect(() => {
    (
      left.skills[0]!.resources[0]! as { relativePath: string }
    ).relativePath = 'changed.md';
  }).toThrow();
  expect(leftSkill.resources[0]?.relativePath).toBe('SKILL.md');
});

it('reports stable source diagnostics for malformed and conflicting Skills', () => {
  const root = '/workspace/project';
  const first = skill(root, 'review', 'review', {
    body: '# Review\n\nSee [guide](references/missing.md).\n',
  });
  const duplicate = skill(root, 'other-directory', 'review', {
    description: 42,
  });
  duplicate.diagnostics.push({
    code: 'AB3002',
    message: 'Skill YAML frontmatter is invalid.',
    severity: 'error',
    sourcePath: duplicate.source,
  });
  const loaded = loadedProject({
    plugin: { name: 'review-tools', version: '1.0.0' },
  });

  const diagnostics = validateSource(loaded, { skills: [first, duplicate] }, registry);

  expect(diagnostics.map(({ code }) => code)).toEqual([
    'AB4005',
    'AB3002',
    'AB4003',
    'AB4004',
    'AB4006',
  ]);
  expect(diagnostics.find(({ code }) => code === 'AB4005')).toMatchObject({
    sourcePath: first.source,
  });
});

it('maps pinned Agent Skills schema issues to stable source diagnostics without duplicates', () => {
  const root = '/workspace/project';
  const document = skill(root, 'review-tools', 'Review-tools', {
    description: ' \t ',
  });
  document.frontmatter.unknown = true;

  expect(validateSource(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' } }),
    { skills: [document] },
    registry,
  )).toEqual([
    {
      code: 'AB3006',
      message: 'Skill frontmatter field "unknown" is not a portable Agent Skills field or a typed host extension.',
      recovery: 'Move host-only fields into `targets.<host>` or a documented host key, or remove the unknown field.',
      severity: 'error',
      sourcePath: document.source,
    },
    {
      code: 'AB4003',
      message: 'Skill frontmatter description must match pattern "\\S".',
      severity: 'error',
      sourcePath: document.source,
    },
    {
      code: 'AB4002',
      message: 'Skill frontmatter name must match pattern "^[a-z0-9]+(?:-[a-z0-9]+)*$".',
      severity: 'error',
      sourcePath: document.source,
    },
    {
      code: 'AB4004',
      message: 'Skill name "Review-tools" must match directory "review-tools".',
      severity: 'error',
      sourcePath: document.source,
    },
  ]);
});

it('validates raw optional portable Skill fields before sanitizing the Skill IR', () => {
  const root = '/workspace/project';
  const document = skill(root, 'review-tools', 'review-tools');
  document.frontmatter.compatibility = false;

  expect(validateSource(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' } }),
    { skills: [document] },
    registry,
  )).toEqual([
    {
      code: 'AB4007',
      message: 'Skill frontmatter compatibility must be string.',
      severity: 'error',
      sourcePath: document.source,
    },
  ]);
});

it('diagnoses a missing plugin object instead of throwing', () => {
  const loaded = loadedProject({} as AgentBundleConfig);

  // Only the name is required: an omitted version is inferred from
  // package.json, so AB4001 fires on a declared-but-invalid value alone.
  expect(validateSource(loaded, { skills: [] }, registry)).toMatchObject([
    { code: 'AB4000', sourcePath: loaded.configPath },
  ]);
});

it('validates reference-style links while ignoring Markdown code examples', () => {
  const root = '/workspace/project';
  const document = skill(root, 'review', 'review', {
    body: [
      '# Review',
      '',
      '[guide][missing-guide]',
      '[missing-guide]: references/missing.md',
      '',
      '`[inline example](references/inline-example.md)`',
      '',
      '```md',
      '[fenced example](references/fenced-example.md)',
      '```',
      '',
    ].join('\n'),
  });

  const diagnostics = validateSource(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' } }),
    { skills: [document] },
    registry,
  );

  expect(diagnostics).toMatchObject([
    {
      code: 'AB4005',
      message: expect.stringContaining('references/missing.md'),
      sourcePath: document.source,
    },
  ]);
});

it('accepts decoded inline Skill resource paths that contain spaces', () => {
  const root = '/workspace/project';
  const document = skill(root, 'review', 'review', {
    body: '[encoded](references/with%20space.md#section)\n\n[unescaped](references/with space.md)\n',
    resources: ['SKILL.md', 'references/with space.md'],
  });

  expect(validateSource(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' } }),
    { skills: [document] },
    registry,
  )).toEqual([]);
});

it('uses the first definition when validating shortcut Markdown references', () => {
  const root = '/workspace/project';
  const missing = skill(root, 'missing', 'missing', {
    body: '[guide]\n\n[guide]: references/missing.md\n',
  });
  const duplicateDefinition = skill(root, 'existing', 'existing', {
    body: [
      '[guide]',
      '',
      '[guide]: references/existing.md',
      '[guide]: references/missing.md',
      '',
    ].join('\n'),
    resources: ['SKILL.md', 'references/existing.md'],
  });
  const loaded = loadedProject({
    plugin: { name: 'review-tools', version: '1.0.0' },
  });

  expect(validateSource(loaded, { skills: [missing] }, registry)).toMatchObject([
    {
      code: 'AB4005',
      message: expect.stringContaining('references/missing.md'),
    },
  ]);
  expect(validateSource(loaded, { skills: [duplicateDefinition] }, registry)).toEqual([]);
});

it('does not treat definitions as uses and reserves an external first definition', () => {
  const root = '/workspace/project';
  const unusedDefinition = skill(root, 'unused', 'unused', {
    body: '[unused]: references/missing.md\n',
  });
  const externalFirst = skill(root, 'external', 'external', {
    body: [
      '[guide]',
      '',
      '[guide]: https://example.com/guide',
      '[guide]: references/missing.md',
      '',
    ].join('\n'),
  });
  const loaded = loadedProject({
    plugin: { name: 'review-tools', version: '1.0.0' },
  });

  expect(validateSource(loaded, { skills: [unusedDefinition] }, registry)).toEqual([]);
  expect(validateSource(loaded, { skills: [externalFirst] }, registry)).toEqual([]);
});

it('normalizes explicit host-native hook tool selectors alongside canonical tools', async () => {
  const model = await normalizeProject(
    loadedProject({
      hooks: {
        beforeTool: {
          handler: './hooks/guard.ts',
          targets: ['claude', 'codex'],
          tools: ['shell', 'codex:view_image', 'claude:WebSearch', 'claude:WebSearch', 'portable:Nope'],
        },
      },
      plugin: { name: 'review-tools', version: '1.0.0' },
      targets: ['claude', 'codex'],
    }),
    { skills: [] },
    registry,
  );

  expect(model.hooks[0]?.tools).toEqual(['shell']);
  expect(model.hooks[0]?.nativeTools).toEqual([
    { name: 'WebSearch', target: 'claude' },
    { name: 'view_image', target: 'codex' },
  ]);

  const withoutSelectors = await normalizeProject(
    loadedProject({
      hooks: { beforeTool: { handler: './hooks/guard.ts', tools: ['shell'] } },
      plugin: { name: 'review-tools', version: '1.0.0' },
      targets: ['claude', 'codex'],
    }),
    { skills: [] },
    registry,
  );
  expect(withoutSelectors.hooks[0]?.nativeTools).toBeUndefined();
  expect(withoutSelectors.hooks[0]?.id).not.toBe(model.hooks[0]?.id);
});

it('validates host-native hook tool selectors against the registry and hook targets', () => {
  const diagnosticsFor = (tools: readonly string[], targets?: readonly string[]): readonly string[] =>
    validateSource(
      loadedProject({
        hooks: { beforeTool: { handler: './hooks/guard.ts', ...(targets === undefined ? {} : { targets: [...targets] }), tools: [...tools] } },
        plugin: { name: 'review-tools', version: '1.0.0' },
      }),
      { skills: [] },
      registry,
    ).map(({ code }) => code);

  expect(diagnosticsFor(['claude:WebSearch'], ['claude'])).toEqual([]);
  expect(validateSource(
    loadedProject({
      hooks: { beforeTool: { handler: './hooks/guard.ts', tools: ['claude:WebSearch'] } },
      plugin: { name: 'review-tools', version: '1.0.0' },
      targets: ['codex'],
    }),
    { skills: [] },
    registry,
  ).map(({ code }) => code)).toEqual(['AB4212']);
  expect(diagnosticsFor(['future-host:tool'])).toEqual(['AB4210']);
  expect(diagnosticsFor(['portable:tool'])).toEqual(['AB4211']);
  expect(diagnosticsFor(['claude:WebSearch'], ['codex'])).toEqual(['AB4212']);
  expect(diagnosticsFor(['claude:'])).toEqual(['AB4202']);
  expect(diagnosticsFor([':WebSearch'])).toEqual(['AB4202']);
});

it('normalizes the generated-executable runtime floor and validates raises only', async () => {
  const defaulted = await normalizeProject(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' } }),
    { skills: [] },
    registry,
  );
  expect(defaulted.runtime).toEqual({ node: '22.12.0' });

  const raised = await normalizeProject(
    loadedProject({
      plugin: { name: 'review-tools', version: '1.0.0' },
      runtime: { node: '24.1' },
    }),
    { skills: [] },
    registry,
  );
  expect(raised.runtime).toEqual({ node: '24.1.0' });

  const diagnosticsFor = (runtime: unknown): readonly string[] =>
    validateSource(
      loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' }, runtime } as AgentBundleConfig),
      { skills: [] },
      registry,
    ).map(({ code }) => code);

  expect(diagnosticsFor(undefined)).toEqual([]);
  expect(diagnosticsFor({ node: '22.12' })).toEqual([]);
  expect(diagnosticsFor({ node: '24.0.0' })).toEqual([]);
  expect(diagnosticsFor('22.16')).toEqual(['AB4600']);
  expect(diagnosticsFor({})).toEqual(['AB4600']);
  expect(diagnosticsFor({ node: '24.0', extra: true })).toEqual(['AB4600']);
  expect(diagnosticsFor({ node: 'v22.16' })).toEqual(['AB4601']);
  expect(diagnosticsFor({ node: 'latest' })).toEqual(['AB4601']);
  expect(diagnosticsFor({ node: `${'9'.repeat(400)}.0` })).toEqual(['AB4601']);
  expect(diagnosticsFor({ node: '22.11.9' })).toEqual(['AB4602']);
  expect(diagnosticsFor({ node: '20.19.0' })).toEqual(['AB4602']);
});

it('reports unknown targets, duplicate IDs, and portable output collisions', async () => {
  const root = '/workspace/project';
  const loaded = loadedProject({
    plugin: { name: 'review-tools', version: '1.0.0' },
    targets: ['portable', 'future-host'],
  });
  const model = await normalizeProject(
    loaded,
    {
      skills: [
        skill(root, 'first', 'duplicate'),
        skill(root, 'second', 'duplicate'),
      ],
    },
    registry,
  );

  const diagnostics = validateModel(model, registry);

  expect(diagnostics.map(({ code }) => code)).toEqual([
    'AB4100',
    'AB4101',
    'AB4102',
    'AB4102',
  ]);
  expect(diagnostics.find(({ code }) => code === 'AB4100')).toMatchObject({
    target: 'future-host',
  });
  expect(diagnostics.filter(({ code }) => code === 'AB4102')).toMatchObject([
    { generatedPath: 'portable/skills/duplicate/SKILL.md' },
    { generatedPath: 'future-host/skills/duplicate/SKILL.md' },
  ]);
});

it('rejects the retired plugin target as unknown (#555 acceptance 3)', async () => {
  // The composite root is the only output shape; `plugin` is not a target
  // that selects anything inside it, so it fails like any other unknown name.
  const model = await normalizeProject(loadedProject({
    plugin: { name: 'review-tools', version: '1.0.0' },
    targets: ['plugin'],
  }), { skills: [] }, registry);

  expect(model.targets.map((target) => target.name)).toEqual(['plugin']);
  expect(validateModel(model, registry)).toMatchObject([{
    code: 'AB4100',
    message: 'Unknown target "plugin".',
    severity: 'error',
    target: 'plugin',
  }]);
});

it('normalizes discovered assets with stable IDs, provenance, and all selected targets', async () => {
  const discovered = {
    assets: [
      { bytes: 6, relativePath: 'logo.svg', source: '/workspace/project/assets/logo.svg' },
      { bytes: 3, relativePath: 'branding/logo.png', source: '/workspace/project/branding/logo.png' },
    ],
    skills: [],
  };
  const conventional = await normalizeProject(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' }, targets: ['portable', 'claude'] }),
    discovered,
    registry,
  );

  expect(conventional.assets).toEqual([
    {
      bytes: 6,
      id: 'asset:logo.svg',
      name: 'logo.svg',
      provenance: { kind: 'conventional', sourcePath: '/workspace/project/agent-bundle.config.ts' },
      relativePath: 'logo.svg',
      source: '/workspace/project/assets/logo.svg',
      targets: ['portable', 'claude'],
    },
    {
      bytes: 3,
      id: 'asset:branding/logo.png',
      name: 'branding/logo.png',
      provenance: { kind: 'conventional', sourcePath: '/workspace/project/agent-bundle.config.ts' },
      relativePath: 'branding/logo.png',
      source: '/workspace/project/branding/logo.png',
      targets: ['portable', 'claude'],
    },
  ]);

  const explicit = await normalizeProject(
    loadedProject({ assets: ['assets/logo.svg'], plugin: { name: 'review-tools', version: '1.0.0' } }),
    discovered,
    registry,
  );
  expect(explicit.assets?.every((asset) => asset.provenance.kind === 'explicit')).toBe(true);

  const withoutAssets = await normalizeProject(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' } }),
    { skills: [] },
    registry,
  );
  expect(withoutAssets.assets).toBeUndefined();
});

it('reports duplicate asset destinations as duplicate IDs and output collisions', async () => {
  const model = await normalizeProject(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' }, targets: ['portable'] }),
    {
      assets: [
        { bytes: 6, relativePath: 'logo.svg', source: '/workspace/project/assets/logo.svg' },
        { bytes: 4, relativePath: 'logo.svg', source: '/workspace/project/branding/logo.svg' },
      ],
      skills: [],
    },
    registry,
  );

  const diagnostics = validateModel(model, registry);

  expect(diagnostics.map(({ code }) => code)).toEqual(['AB4101', 'AB4102']);
  expect(diagnostics[1]).toMatchObject({
    generatedPath: 'portable/assets/logo.svg',
    sourcePath: '/workspace/project/branding/logo.svg',
  });
});

it('validates the assets configuration shape, containment, and literal existence', () => {
  const diagnosticsFor = (assets: unknown, root?: string): readonly string[] =>
    validateSource(
      loadedProject(
        { assets, plugin: { name: 'review-tools', version: '1.0.0' } } as AgentBundleConfig,
        root === undefined ? {} : { root },
      ),
      { skills: [] },
      registry,
    ).map(({ code }) => code);

  expect(diagnosticsFor(undefined)).toEqual([]);
  expect(diagnosticsFor('assets')).toEqual(['AB4600']);
  expect(diagnosticsFor([''])).toEqual(['AB4600']);
  expect(diagnosticsFor([42])).toEqual(['AB4600']);
  // Fixtures rooted at the workspace also report the AB4008
  // plugin.version/package version mismatch warning (#94).
  expect(diagnosticsFor(['../outside'], process.cwd())).toEqual(['AB4601', 'AB4008']);
  expect(diagnosticsFor(['definitely-missing-asset-entry'], process.cwd())).toEqual(['AB4602', 'AB4008']);
  expect(diagnosticsFor(['definitely-missing/*.svg'], process.cwd())).toEqual(['AB4008']);
  expect(diagnosticsFor(['package.json'], process.cwd())).toEqual(['AB4008']);
});

const scriptRouteFixture = (root: string, relativePath: string): CompiledAgentRoute => {
  const identity = relativePath
    .split('/')
    .slice(2)
    .join('/')
    .replace(/\.[^./]+$/u, '');
  return {
    config: emptyRouteConfig,
    id: `script:${identity}`,
    kind: 'script',
    provenance: { kind: 'conventional', relativePath },
    source: `${root}/${relativePath}`,
  };
};

const routeGraphWithScripts = (root: string, relativePaths: readonly string[]): CompiledRouteGraph => ({
  diagnostics: [],
  digest: 'fixture-digest',
  events: [],
  providers: [],
  scripts: relativePaths.map((relativePath) => scriptRouteFixture(root, relativePath)),
  servers: [],
});

it('normalizes shippable conventional script routes through the explicit scripts pipeline', async () => {
  const root = '/workspace/project';
  const loaded = loadedProject({
    plugin: { name: 'review-tools', version: '1.0.0' },
    scripts: { 'detect-risk': { entry: './src/tasks/detect-risk.ts', targets: ['claude'] } },
  });
  const discovered: DiscoveredProject = {
    routeGraph: routeGraphWithScripts(root, [
      'src/scripts/detect-risk.ts',
      'src/scripts/release/tag.ts',
      'src/scripts/render-notes.tsx',
      'src/scripts/verify-release.ts',
    ]),
    skills: [],
  };

  const model = await normalizeProject(loaded, discovered, registry);

  expect(model.scripts).toEqual([
    {
      id: 'script:detect-risk',
      mode: 'bundle',
      name: 'detect-risk',
      provenance: { kind: 'config', sourcePath: `${root}/agent-bundle.config.ts` },
      source: `${root}/src/tasks/detect-risk.ts`,
      targets: ['claude'],
    },
    // Rendered routes ship through the renderer pipeline (#102 stage 3).
    {
      id: 'script:render-notes',
      mode: 'bundle',
      name: 'render-notes',
      provenance: { kind: 'conventional', sourcePath: `${root}/src/scripts/render-notes.tsx` },
      rendered: true,
      source: `${root}/src/scripts/render-notes.tsx`,
      targets: ['portable'],
    },
    {
      id: 'script:verify-release',
      mode: 'bundle',
      name: 'verify-release',
      provenance: { kind: 'conventional', sourcePath: `${root}/src/scripts/verify-release.ts` },
      source: `${root}/src/scripts/verify-release.ts`,
      targets: ['portable'],
    },
  ]);
});

it('normalizes conventional scripts when config declares none', async () => {
  const root = '/workspace/project';
  const model = await normalizeProject(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' } }),
    { routeGraph: routeGraphWithScripts(root, ['src/scripts/verify-release.ts']), skills: [] },
    registry,
  );

  expect(model.scripts).toEqual([
    {
      id: 'script:verify-release',
      mode: 'bundle',
      name: 'verify-release',
      provenance: { kind: 'conventional', sourcePath: `${root}/src/scripts/verify-release.ts` },
      source: `${root}/src/scripts/verify-release.ts`,
      targets: ['portable'],
    },
  ]);
});

it('gates nested and conflicting conventional script routes as AB4808/AB4809 and ships rendered ones', () => {
  const root = '/workspace/project';
  const loaded = loadedProject({
    plugin: { name: 'review-tools', version: '1.0.0' },
    scripts: { 'detect-risk': './src/tasks/detect-risk.ts' },
  });
  const discovered: DiscoveredProject = {
    routeGraph: routeGraphWithScripts(root, [
      'src/scripts/detect-risk.ts',
      'src/scripts/release/tag.ts',
      'src/scripts/render-notes.tsx',
      'src/scripts/render-poster.jsx',
      'src/scripts/verify-release.ts',
    ]),
    skills: [],
  };

  const gate = validateSource(loaded, discovered, registry)
    .filter(({ code }) => code.startsWith('AB48'));

  // AB4807 is retired: rendered script routes ship through the Agent
  // renderer pipeline (#102 stage 3) instead of failing validation.
  expect(gate).toEqual([
    {
      code: 'AB4809',
      message: 'Conventional script src/scripts/detect-risk.ts and the configured script "detect-risk" share one script identity; the compiler never chooses silently.',
      recovery: 'Point the scripts.detect-risk config entry at src/scripts/detect-risk.ts to claim the module, or rename one of the two scripts.',
      severity: 'error',
      sourcePath: `${root}/src/scripts/detect-risk.ts`,
    },
    {
      code: 'AB4808',
      message: 'Conventional script src/scripts/release/tag.ts nests below the src/scripts/ root; conventional scripts ship as direct children only.',
      recovery: 'Move the module directly under src/scripts/, prefix a path segment with "_" to keep it private, or declare it under scripts in config with a flat name.',
      severity: 'error',
      sourcePath: `${root}/src/scripts/release/tag.ts`,
    },
  ]);
});

it('ships a bin-claimed plain conventional script as both surfaces and refuses a bin-claimed rendered one with AB4737 (#389)', async () => {
  const root = '/workspace/project';
  const loaded = loadedProject({
    bin: {
      hauler: './src/scripts/hauler.ts',
      notes: { entry: './src/scripts/render-notes.tsx' },
      'notes-again': './src/scripts/render-notes.tsx',
    },
    plugin: { name: 'review-tools', version: '1.0.0' },
  });
  const discovered: DiscoveredProject = {
    routeGraph: routeGraphWithScripts(root, ['src/scripts/hauler.ts', 'src/scripts/render-notes.tsx']),
    skills: [],
  };

  // The fixture root has no files, so the export scan finds neither export and the gate fires.
  const gate = validateSource(loaded, discovered, registry).filter(({ code }) => code === 'AB4737');
  expect(gate).toEqual([
    {
      code: 'AB4737',
      message: 'Rendered script src/scripts/render-notes.tsx is also the entry of bin "notes", "notes-again" but exports neither an async default Server Component nor a named main; the artifact script renders the default component and the bin envelope calls main(argv).',
      recovery: 'Export both an async default Server Component and a named main(argv) from the module, point the bin entry at a plain module that exports main, rename the script to .ts so one plain module ships as both the bin and the artifact script, or prefix a path segment with "_" to keep the module bin-only.',
      severity: 'error',
      sourcePath: `${root}/src/scripts/render-notes.tsx`,
    },
  ]);

  // The plain script stays in the model beside its bin; nothing about it is gated.
  const model = await normalizeProject(loaded, discovered, registry);
  expect(model.scripts.map((script) => script.name)).toEqual(['hauler', 'render-notes']);
  expect(model.packageBuild?.bins.map((bin) => bin.name)).toEqual(['hauler', 'notes', 'notes-again']);
});

it('normalizes rendered conventional script routes onto the renderer pipeline (#102 stage 3)', async () => {
  const root = '/workspace/project';
  const model = await normalizeProject(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' } }),
    { routeGraph: routeGraphWithScripts(root, ['src/scripts/render-notes.tsx']), skills: [] },
    registry,
  );

  expect(model.scripts).toEqual([
    {
      id: 'script:render-notes',
      mode: 'bundle',
      name: 'render-notes',
      provenance: { kind: 'conventional', sourcePath: `${root}/src/scripts/render-notes.tsx` },
      rendered: true,
      source: `${root}/src/scripts/render-notes.tsx`,
      targets: ['portable'],
    },
  ]);
});

it('keeps shippable conventional script routes free of stage-1 gate diagnostics', () => {
  const root = '/workspace/project';
  const diagnostics = validateSource(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' } }),
    { routeGraph: routeGraphWithScripts(root, ['src/scripts/verify-release.ts']), skills: [] },
    registry,
  );

  expect(diagnostics.filter(({ code }) => code.startsWith('AB48'))).toEqual([]);
});


const routeGraphWithGeneratedServer = (root: string): CompiledRouteGraph => {
  const route: CompiledAgentRoute = {
    config: { annotations: { readOnlyHint: true }, description: 'Inspect sources.' },
    id: 'tool:curator/inspect',
    kind: 'tool',
    provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
    serverId: 'mcp:curator',
    source: `${root}/src/mcp/curator/tools/inspect.tsx`,
  };
  return {
    diagnostics: [],
    digest: 'generated-server-digest',
    events: [],
    providers: [],
    scripts: [],
    servers: [{ id: 'mcp:curator', mode: 'generated', name: 'curator', routes: [route] }],
  };
};

it('normalizes generated MCP route servers without a handwritten server declaration', async () => {
  const root = '/workspace/project';
  const graph = routeGraphWithGeneratedServer(root);
  const model = await normalizeProject(
    loadedProject({ plugin: { name: 'review-tools', version: '1.0.0' } }),
    { routeGraph: graph, skills: [] },
    registry,
  );

  expect(model.mcpServers).toHaveLength(1);
  expect(model.mcpServers[0]).toMatchObject({
    command: 'node',
    generatedRoutes: graph.servers[0]!.routes,
    id: 'mcp:curator',
    name: 'curator',
    provenance: { kind: 'conventional', sourcePath: `${root}/src/mcp/curator/tools/inspect.tsx` },
    source: `${root}/src/mcp/curator/tools/inspect.tsx`,
    targets: ['portable'],
    transport: 'stdio',
  });
  expect(model.mcpServers[0]!.args?.[0]).toMatch(/^mcp\/mcp-curator-[a-f\d]{8}\.mjs$/u);
});
