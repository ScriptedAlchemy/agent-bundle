import { expect, it } from '@rstest/core';

import {
  normalizeProject,
  validateModel,
  validateSource,
  type NormalizationTargetRegistry,
} from '../src/config/index.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';
import type { DiscoveredProject } from '../src/config/discover.ts';
import type { LoadedConfig } from '../src/config/load.ts';

const registry: NormalizationTargetRegistry = {
  defaultTargetNames: () => ['portable'],
  has: (name) => ['portable', 'codex', 'claude'].includes(name),
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

  const diagnostics = validateSource(loaded, { skills: [first, duplicate] });

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
