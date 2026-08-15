import { expect, it } from '@rstest/core';

import {
  normalizeProject,
  validateModel,
  validateSource,
  type NormalizationTargetRegistry,
} from '../src/config/index.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';
import type { Diagnostic } from '../src/core/diagnostics.ts';
import type { DiscoveredProject } from '../src/config/discover.ts';
import type { LoadedConfig } from '../src/config/load.ts';

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
  const dir = `${root}/skills/${directory}`;

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

  expect(sourceValidator(loaded, { skills: [] }, extensionRegistry)).toEqual([]);

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

it('rejects non-JSON values in registered config extensions before normalization', async () => {
  class ExtensionClass {
    readonly enabled = true;
  }
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
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
  ];

  for (const value of values) {
    await expect(normalizeProject(loadedProject({
      example: value,
      plugin: { name: 'extension-json-fixture', version: '1.0.0' },
    }), { skills: [] }, extensionRegistry)).rejects.toThrow(
      'AB4500: Config extension "example" must contain strict finite JSON data.',
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

  expect(sourceValidator(loaded, { skills: [] }, targetRegistry).map(({ code }) => code)).toEqual([
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
    skills: ['skills/review'],
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
      code: 'AB4007',
      message: 'Skill frontmatter unknown must NOT have additional properties.',
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

it('diagnoses a missing plugin object instead of throwing', () => {
  const loaded = loadedProject({} as AgentBundleConfig);

  expect(validateSource(loaded, { skills: [] }, registry)).toMatchObject([
    { code: 'AB4000', sourcePath: loaded.configPath },
    { code: 'AB4001', sourcePath: loaded.configPath },
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
