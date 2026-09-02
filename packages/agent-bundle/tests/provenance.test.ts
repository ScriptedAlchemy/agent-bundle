import { expect, it } from '@rstest/core';

import {
  collectBundledOutputEvidence,
  createOutputProvenance,
  type ArtifactOutputCandidate,
} from '../src/build/provenance.ts';
import { semanticGraderIdentityPattern } from '../src/eval/provenance.ts';

const projectRoot = '/work/project';
const artifactRoot = '/tmp/agent-bundle.stage';

it('accepts only the canonical semantic grader id@model identity', () => {
  expect(semanticGraderIdentityPattern.test('claude-semantic@sonnet')).toBe(true);
  expect(semanticGraderIdentityPattern.test('claude-semantic@sonnet/v1')).toBe(false);
  expect(semanticGraderIdentityPattern.test('claude@semantic@sonnet')).toBe(false);
  expect(semanticGraderIdentityPattern.test('/private/claude@sonnet')).toBe(false);
});

it('canonicalizes artifact outputs and project inputs into deeply frozen stable records', () => {
  const records = createOutputProvenance({
    artifactRoot,
    projectRoot,
    outputs: [{
      kind: 'bundle',
      path: '/tmp/agent-bundle.stage/portable/scripts/greeting.mjs',
      sourceInputs: [
        '/work/project/src/greeting.ts',
        '/work/project/src/skills/review/../review/scripts/greeting.ts',
        '/work/project/src/greeting.ts',
      ],
    } satisfies ArtifactOutputCandidate],
  });

  expect(records).toEqual([{
    kind: 'bundle',
    path: 'portable/scripts/greeting.mjs',
    sourceInputs: ['src/greeting.ts', 'src/skills/review/scripts/greeting.ts'],
  }]);
  expect(Object.isFrozen(records)).toBe(true);
  expect(Object.isFrozen(records[0]!)).toBe(true);
  expect(Object.isFrozen(records[0]!.sourceInputs)).toBe(true);
  const differentRoot = createOutputProvenance({
    artifactRoot: '/tmp/another-agent-bundle.stage',
    projectRoot: '/another/project',
    outputs: [{
      kind: 'bundle',
      path: '/tmp/another-agent-bundle.stage/portable/scripts/greeting.mjs',
      sourceInputs: [
        '/another/project/src/skills/review/scripts/greeting.ts',
        '/another/project/src/greeting.ts',
      ],
    }],
  });
  expect(JSON.stringify(differentRoot)).toBe(JSON.stringify(records));
});

it('rejects outputs and source inputs outside their build roots', () => {
  expect(() => createOutputProvenance({
    artifactRoot,
    projectRoot,
    outputs: [{
      kind: 'generated',
      path: '/tmp/not-the-stage/plugin.json',
      sourceInputs: ['/work/project/agent-bundle.config.ts'],
    }],
  })).toThrow(/outside/i);

  expect(() => createOutputProvenance({
    artifactRoot,
    projectRoot,
    outputs: [{
      kind: 'generated',
      path: '/tmp/agent-bundle.stage/portable/plugin.json',
      sourceInputs: ['/outside/project/input.ts'],
    }],
  })).toThrow(/outside/i);
});

it('collects nested authored module inputs from public stats without using identifiers', () => {
  const evidence = collectBundledOutputEvidence({
    expectedAssets: [{
      path: 'portable/scripts/greeting.mjs',
      sourceInputs: ['/work/project/src/skills/review/scripts/greeting script.ts'],
    }],
    projectRoot,
    stats: {
      toJson: () => ({
        assets: [{ name: 'portable/scripts/greeting.mjs' }],
        modules: [{
          identifier: '/outside/must-not-be-read.ts',
          modules: [{
            identifier: '/outside/also-not-read.ts',
            nameForCondition: '/work/project/src/skills/review/scripts/local greeting module.ts',
          }],
          nameForCondition: '/work/project/src/skills/review/scripts/greeting script.ts',
        }],
      }),
    },
  });

  expect(evidence).toEqual([{
    path: 'portable/scripts/greeting.mjs',
    sourceInputs: [
      '/work/project/src/skills/review/scripts/greeting script.ts',
      '/work/project/src/skills/review/scripts/local greeting module.ts',
    ],
  }]);
  expect(Object.isFrozen(evidence)).toBe(true);
  expect(Object.isFrozen(evidence[0]!)).toBe(true);
  expect(Object.isFrozen(evidence[0]!.sourceInputs)).toBe(true);
});

it('uses only declared inputs for an explicitly authorized final HTML asset without chunk association', () => {
  const configInput = '/work/project/agent-bundle.config.ts';
  const sourceA = '/work/project/views/dashboard.ts';
  const unrelatedModuleB = '/work/project/views/unrelated.ts';
  const finalHtml = {
    allowUnassociatedHtml: true as const,
    path: 'mcp-apps/dashboard.html',
    sourceInputs: [configInput, sourceA],
  };
  const evidence = collectBundledOutputEvidence({
    expectedAssets: [finalHtml],
    projectRoot,
    stats: {
      toJson: () => ({
        assets: [
          { name: 'mcp-apps/dashboard.html' },
          { chunks: [7], name: 'mcp-apps/dashboard.js' },
        ],
        modules: [{
          chunks: [7],
          nameForCondition: unrelatedModuleB,
        }],
      }),
    },
  });

  expect(evidence).toEqual([{
    path: 'mcp-apps/dashboard.html',
    sourceInputs: [configInput, sourceA],
  }]);
  expect(evidence[0]!.sourceInputs).not.toContain(unrelatedModuleB);
  expect(Object.isFrozen(evidence[0]!.sourceInputs)).toBe(true);
});

it('keeps unassociated assets strict when final HTML authorization is absent or invalid', () => {
  const stats = {
    toJson: () => ({
      assets: [
        { name: 'mcp-apps/dashboard.html' },
        { chunks: [7], name: 'mcp-apps/dashboard.js' },
        { chunks: [8], name: 'mcp-apps/dashboard.css' },
      ],
      modules: [{
        chunks: [7],
        nameForCondition: '/work/project/views/dashboard.ts',
      }],
    }),
  };
  const collect = (expectedAssets: readonly { readonly path: string; readonly sourceInputs: readonly string[] }[]) =>
    collectBundledOutputEvidence({ expectedAssets, projectRoot, stats });
  const authorizedHtml = (sourceInputs: readonly string[]) => ({
    allowUnassociatedHtml: true as const,
    path: 'mcp-apps/dashboard.html',
    sourceInputs,
  });

  expect(() => collect([{
    path: 'mcp-apps/dashboard.html',
    sourceInputs: ['/work/project/views/dashboard.ts'],
  }])).toThrow(/associate/i);
  expect(() => collect([authorizedHtml([])])).toThrow(/declare source inputs/i);
  expect(() => collect([authorizedHtml(['/outside/project/dashboard.ts'])])).toThrow(/outside/i);
  const authorizedScript = {
    allowUnassociatedHtml: true as const,
    path: 'mcp-apps/dashboard.js',
    sourceInputs: ['/work/project/views/dashboard.ts'],
  };
  expect(() => collect([authorizedScript])).toThrow(/HTML/i);
  const authorizedStylesheet = {
    allowUnassociatedHtml: true as const,
    path: 'mcp-apps/dashboard.css',
    sourceInputs: ['/work/project/views/dashboard.css'],
  };
  expect(() => collect([authorizedStylesheet])).toThrow(/HTML/i);
  expect(() => collectBundledOutputEvidence({
    expectedAssets: [authorizedHtml(['/work/project/views/dashboard.ts'])],
    projectRoot,
    stats: {
      toJson: () => ({
        assets: [
          { name: 'mcp-apps/dashboard.html' },
          { name: 'mcp-apps/dashboard.html' },
        ],
        modules: [],
      }),
    },
  })).toThrow(/ambiguous/i);
});

it('rejects incomplete, ambiguous, filtered, and outside-root public stats', () => {
  const expectedAssets = [{
    path: 'portable/scripts/greeting.mjs',
    sourceInputs: ['/work/project/src/greeting.ts'],
  }];
  const collect = (stats: unknown) => collectBundledOutputEvidence({
    expectedAssets,
    projectRoot,
    stats: stats as { toJson(): unknown } | undefined,
  });

  expect(() => collect(undefined)).toThrow(/stats/i);
  expect(() => collect({ toJson: () => ({ assets: [], modules: [] }) })).toThrow(/expected output asset/i);
  expect(() => collect({
    toJson: () => ({
      assets: [{ name: 'portable/scripts/greeting.mjs' }, { name: 'portable/scripts/greeting.mjs' }],
      modules: [],
    }),
  })).toThrow(/ambiguous/i);
  expect(() => collect({
    toJson: () => ({
      assets: [{ name: 'portable/scripts/greeting.mjs' }],
      filteredModules: 1,
      modules: [],
    }),
  })).toThrow(/filtered/i);
  expect(() => collect({
    toJson: () => ({
      assets: [{ name: 'portable/scripts/greeting.mjs' }],
      modules: [{ nameForCondition: '/outside/project/entry.ts' }],
    }),
  })).toThrow(/outside/i);
});

it('ignores a Windows virtual-module descendant through lexical containment', () => {
  const evidence = collectBundledOutputEvidence({
    expectedAssets: [{
      path: 'portable/hooks/entry.mjs',
      sourceInputs: ['/work/project/src/entry.ts'],
    }],
    ignoredSourcePaths: ['C:\\stage\\.agent-bundle-virtual'],
    projectRoot,
    stats: {
      toJson: () => ({
        assets: [{ name: 'portable/hooks/entry.mjs' }],
        modules: [{ nameForCondition: 'C:\\stage\\.agent-bundle-virtual\\entry.mjs' }],
      }),
    },
  });

  expect(evidence).toEqual([{
    path: 'portable/hooks/entry.mjs',
    sourceInputs: ['/work/project/src/entry.ts'],
  }]);
});

it('permits classified no-source modules and rejects anonymous or unknown selected modules', () => {
  const expectedAssets = [{
    path: 'portable/scripts/greeting.mjs',
    sourceInputs: ['/work/project/src/greeting.ts'],
  }];
  const collect = (modules: readonly Record<string, unknown>[]) => collectBundledOutputEvidence({
    expectedAssets,
    projectRoot,
    stats: {
      toJson: () => ({
        assets: [{ name: 'portable/scripts/greeting.mjs' }],
        modules,
      }),
    },
  });

  expect(collect([
    { moduleType: 'runtime' },
    { moduleType: 'external', name: 'external "node:fs"' },
    { identifier: '/work/project/node_modules/agent-bundle/dist|sync', moduleType: 'javascript/auto' },
    { modules: [{ nameForCondition: '/work/project/src/greeting.ts' }] },
  ])).toEqual([{
    path: 'portable/scripts/greeting.mjs',
    sourceInputs: ['/work/project/src/greeting.ts'],
  }]);
  expect(() => collect([{}])).toThrow(/source/i);
  expect(() => collect([{ name: 'unknown generated module' }])).toThrow(/source/i);
});
