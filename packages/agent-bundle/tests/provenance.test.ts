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
        '/work/project/skills/review/../review/scripts/greeting.ts',
        '/work/project/src/greeting.ts',
      ],
    } satisfies ArtifactOutputCandidate],
  });

  expect(records).toEqual([{
    kind: 'bundle',
    path: 'portable/scripts/greeting.mjs',
    sourceInputs: ['skills/review/scripts/greeting.ts', 'src/greeting.ts'],
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
        '/another/project/skills/review/scripts/greeting.ts',
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
      sourceInputs: ['/work/project/skills/review/scripts/greeting script.ts'],
    }],
    projectRoot,
    stats: {
      toJson: () => ({
        assets: [{ name: 'portable/scripts/greeting.mjs' }],
        modules: [{
          identifier: '/outside/must-not-be-read.ts',
          modules: [{
            identifier: '/outside/also-not-read.ts',
            nameForCondition: '/work/project/skills/review/scripts/local greeting module.ts',
          }],
          nameForCondition: '/work/project/skills/review/scripts/greeting script.ts',
        }],
      }),
    },
  });

  expect(evidence).toEqual([{
    path: 'portable/scripts/greeting.mjs',
    sourceInputs: [
      '/work/project/skills/review/scripts/greeting script.ts',
      '/work/project/skills/review/scripts/local greeting module.ts',
    ],
  }]);
  expect(Object.isFrozen(evidence)).toBe(true);
  expect(Object.isFrozen(evidence[0]!)).toBe(true);
  expect(Object.isFrozen(evidence[0]!.sourceInputs)).toBe(true);
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
    { modules: [{ nameForCondition: '/work/project/src/greeting.ts' }] },
  ])).toEqual([{
    path: 'portable/scripts/greeting.mjs',
    sourceInputs: ['/work/project/src/greeting.ts'],
  }]);
  expect(() => collect([{}])).toThrow(/source/i);
  expect(() => collect([{ name: 'unknown generated module' }])).toThrow(/source/i);
});
