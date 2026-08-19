import { expect, it } from '@rstest/core';

import { skillEvalCoverageFor } from '../src/skills-eval-coverage.ts';

const suites = [
  {
    cases: [
      {
        assertions: [{ id: 'a1', kind: 'skill-activation', skill: 'review' }],
        id: 'activates-on-review-request',
        invocation: { mode: 'automatic', skill: 'review' },
      },
      {
        assertions: [{ id: 'a2', kind: 'no-skill-activation', skill: 'review' }],
        id: 'stays-quiet-on-unrelated-prompt',
        invocation: { mode: 'none' },
      },
      {
        assertions: [{ id: 'a3', kind: 'outcome' }, { id: 'a4', kind: 'exit-code' }],
        id: 'explicit-invocation-outcome-only',
        invocation: { mode: 'explicit', skill: 'review' },
      },
    ],
    name: 'review-suite',
  },
  {
    cases: [
      {
        assertions: [{ id: 'b1', kind: 'no-skill-activation' }],
        id: 'no-skill-should-fire',
        invocation: { mode: 'none' },
      },
      {
        assertions: [{ id: 'b2', kind: 'skill-activation', skill: 'deploy' }],
        id: 'activates-deploy',
        invocation: { mode: 'automatic', skill: 'deploy' },
      },
    ],
    name: 'other-suite',
  },
];

it('classifies direct, negative, and indirect coverage for one Skill across suites', () => {
  const coverage = skillEvalCoverageFor('review', suites);

  expect(coverage.direct).toBe(1);
  expect(coverage.negative).toBe(2);
  expect(coverage.indirect).toBe(1);
  expect(coverage.entries).toEqual([
    { caseId: 'activates-on-review-request', kinds: ['direct'], suite: 'review-suite' },
    { caseId: 'stays-quiet-on-unrelated-prompt', kinds: ['negative'], suite: 'review-suite' },
    { caseId: 'explicit-invocation-outcome-only', kinds: ['indirect'], suite: 'review-suite' },
    { caseId: 'no-skill-should-fire', kinds: ['negative'], suite: 'other-suite' },
  ]);
  expect(Object.isFrozen(coverage)).toBe(true);
  expect(Object.isFrozen(coverage.entries)).toBe(true);
  expect(coverage.entries.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.kinds))).toBe(true);
});

it('does not count an invocation as indirect when the case already asserts activation', () => {
  const coverage = skillEvalCoverageFor('deploy', suites);

  expect(coverage.direct).toBe(1);
  expect(coverage.indirect).toBe(0);
  expect(coverage.negative).toBe(1);
  expect(coverage.entries.map((entry) => entry.caseId)).toEqual(['no-skill-should-fire', 'activates-deploy']);
});

it('reports empty coverage for a Skill no authored case references', () => {
  const withoutBlanket = suites.map((suite) => ({
    ...suite,
    cases: suite.cases.filter((evalCase) =>
      !evalCase.assertions.some((assertion) => assertion.kind === 'no-skill-activation' && assertion.skill === undefined)),
  }));
  const coverage = skillEvalCoverageFor('unmentioned', withoutBlanket);

  expect(coverage).toEqual({ direct: 0, entries: [], indirect: 0, negative: 0 });
});

it('counts blanket no-skill-activation assertions as negative coverage for every Skill', () => {
  const coverage = skillEvalCoverageFor('unmentioned', suites);

  expect(coverage.direct).toBe(0);
  expect(coverage.indirect).toBe(0);
  expect(coverage.negative).toBe(1);
  expect(coverage.entries).toEqual([{ caseId: 'no-skill-should-fire', kinds: ['negative'], suite: 'other-suite' }]);
});
