import { expect, it } from '@rstest/core';

import {
  createOutputProvenance,
  type ArtifactOutputCandidate,
} from '../src/build/provenance.ts';

const projectRoot = '/work/project';
const artifactRoot = '/tmp/agent-bundle.stage';

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
