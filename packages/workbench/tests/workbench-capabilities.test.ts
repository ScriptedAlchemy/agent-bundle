import { expect, it } from '@rstest/core';

import type { ArtifactInspection } from '../../agent-bundle/src/contracts/artifacts.ts';
import { loadWorkbenchCapabilities } from '../src/workbench-capabilities.ts';

const digest = '0'.repeat(64);
const file = (path: string) => ({
  bytes: 1,
  kind: 'generated' as const,
  path,
  sha256: digest,
  sourceInputs: [],
});

const inspection = ({ hooks = 0, mcpServers = 0, scripts = 0, targets = 1 } = {}): ArtifactInspection => ({
  epochId: 'build-a',
  files: [],
  project: {
    configDigest: digest,
    configPath: 'agent-bundle.config.ts',
    modelDigest: digest,
    revision: digest,
    sourceInputs: [],
  },
  provenance: [],
  runtime: {
    executables: [],
    hooks: Array.from({ length: hooks }, (_, index) => ({
      event: 'sessionStart',
      file: file(`claude/hooks/hook-${String(index)}.mjs`),
      id: `hook:${String(index)}`,
      name: `hook-${String(index)}`,
      path: `hooks/hook-${String(index)}.mjs`,
      target: 'claude',
    })),
    mcpServers: Array.from({ length: mcpServers }, (_, index) => ({
      entryPaths: [`portable/mcp/server-${String(index)}.mjs`],
      kind: 'stdio' as const,
      manifestPath: `portable/mcp/server-${String(index)}.json`,
      name: `server-${String(index)}`,
      target: 'portable',
    })),
    scripts: Array.from({ length: scripts }, (_, index) => ({
      file: file(`portable/scripts/script-${String(index)}.mjs`),
      id: `script:${String(index)}`,
      name: `script-${String(index)}`,
      target: 'portable',
    })),
  },
  targets: Array.from({ length: targets }, (_, index) => ({
    name: `target-${String(index)}`,
    tree: { children: [], kind: 'directory' as const, name: `target-${String(index)}`, path: `target-${String(index)}` },
  })),
});

const skill = {
  base: { kind: 'source' as const, skillId: 'skill:review' },
  body: '# Review',
  diagnostics: [],
  frontmatter: { description: 'Review changes', name: 'review' },
  id: 'skill:review',
  markdown: '---\nname: review\ndescription: Review changes\n---\n# Review',
  name: 'review',
  resources: [],
  targets: ['portable'],
};

const clientsFor = ({
  evalSuites = 0,
  hooks = 0,
  mcpServers = 0,
  scripts = 0,
  skills = 0,
  targets = 1,
} = {}) => ({
  artifactClient: { inspect: async () => inspection({ hooks, mcpServers, scripts, targets }) },
  evalClient: {
    suites: async () => ({
      diagnostics: [],
      suites: Array.from({ length: evalSuites }, (_, index) => ({
        cases: [],
        digest,
        name: `suite-${String(index)}`,
        sourcePath: `evals/suite-${String(index)}.eval.ts`,
      })),
    }),
  },
  skillClient: {
    sourceTree: async () => ({ diagnostics: [], skills: Array.from({ length: skills }, () => skill) }),
  },
});

it('derives the Skills Starter routes from its validated catalogs', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ evalSuites: 1, skills: 1, targets: 3 }),
  });

  expect([...capabilities.pages]).toEqual([
    'overview', 'skills', 'artifacts', 'logs', 'evals', 'comparisons',
  ]);
  expect(capabilities.counts).toEqual({ evalSuites: 1, hooks: 0, mcpServers: 0, scripts: 0, skills: 1, targets: 3 });
  expect(Object.isFrozen(capabilities)).toBe(true);
  expect(Object.isFrozen(capabilities.counts)).toBe(true);
});

it('derives Hooks and Playground without advertising unrelated capabilities', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ hooks: 1, scripts: 2, targets: 3 }),
  });

  expect([...capabilities.pages]).toEqual([
    'overview', 'hooks', 'artifacts', 'playground', 'logs',
  ]);
});

it('derives the complete route set for a full bundle', async () => {
  const capabilities = await loadWorkbenchCapabilities({
    buildId: 'build-a',
    ...clientsFor({ evalSuites: 1, hooks: 1, mcpServers: 1, scripts: 1, skills: 1, targets: 3 }),
  });

  expect([...capabilities.pages]).toEqual([
    'overview', 'skills', 'hooks', 'mcp', 'artifacts', 'playground', 'logs', 'evals', 'comparisons',
  ]);
  expect(capabilities.inspection.epochId).toBe('build-a');
});

it('rejects an inspection from a different build', async () => {
  await expect(loadWorkbenchCapabilities({
    buildId: 'build-b',
    ...clientsFor({ skills: 1 }),
  })).rejects.toThrow('Capability catalog did not match the current build.');
});
