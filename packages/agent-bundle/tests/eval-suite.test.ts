import { expect, it } from '@rstest/core';

import {
  defineEvalSuite,
  evalCaseFromDraft,
  EvalDefinitionError,
  expectExitCode,
  expectMcpCall,
  expectNoSkillActivation,
  expectOutcome,
  expectSkillActivation,
  resolveEvalAssertions,
  type EvalTrialEvidence,
} from '../src/eval/index.ts';
import type { DraftEvalCase } from '../src/services/playground-service.ts';

const hosts = Object.freeze({
  claude: Object.freeze({ model: 'claude-sonnet-4-5' }),
  codex: Object.freeze({ model: 'gpt-5.5-codex' }),
});

const evidenceWith = (overrides: Partial<EvalTrialEvidence> = {}): EvalTrialEvidence => ({
  mcp: { calls: [], level: 'unavailable' },
  process: { level: 'unavailable', timedOut: false },
  scripts: { level: 'unavailable', results: {} },
  skillActivation: { activated: [], level: 'unavailable' },
  ...overrides,
});

it('represents direct, automatic, none, negative, and edge cases', () => {
  const suite = defineEvalSuite({
    cases: [
      {
        assertions: [expectExitCode(0), expectOutcome({ script: './graders/review-result.ts' })],
        fixture: './fixtures/review-repo',
        hosts,
        id: 'direct-review',
        invocation: { mode: 'explicit', skill: 'review-change' },
        prompt: 'Use the review-change Skill on the staged diff.',
        trials: 3,
      },
      {
        assertions: [
          expectMcpCall({ atLeast: 1, server: 'project', tool: 'status' }),
          expectSkillActivation({ minimumEvidence: 'inferred', skill: 'review-change' }),
        ],
        fixture: './fixtures/review-repo',
        hosts,
        id: 'automatic-review',
        invocation: { mode: 'automatic', skill: 'review-change' },
        prompt: 'Review this change and report the highest-risk regression.',
        trials: 3,
      },
      {
        assertions: [expectNoSkillActivation()],
        fixture: './fixtures/unrelated',
        hosts,
        id: 'negative-unrelated',
        invocation: { mode: 'none' },
        prompt: 'Convert this CSV column to uppercase.',
      },
      {
        assertions: [expectSkillActivation({ minimumEvidence: 'observed', skill: 'review-change' })],
        fixture: { git: true, include: ['src/**', 'package.json'], path: './fixtures/empty-repo' },
        hosts,
        id: 'edge-empty-repository',
        invocation: { mode: 'automatic' },
        prompt: 'The repository has no commits yet. Decide what to do.',
      },
    ],
    name: 'review-change',
  });

  expect(suite.cases.map((entry) => entry.invocation.mode)).toEqual([
    'explicit',
    'automatic',
    'none',
    'automatic',
  ]);
  expect(suite.cases[0]?.trials).toBe(3);
  expect(suite.cases[2]?.trials).toBe(1);
  expect(suite.cases[3]?.fixture).toEqual({ git: true, include: ['package.json', 'src/**'], path: './fixtures/empty-repo' });
  expect(Object.isFrozen(suite)).toBe(true);
  expect(Object.isFrozen(suite.cases[0])).toBe(true);
  expect(suite.digest).toMatch(/^[a-f0-9]{64}$/u);
});

it('keeps identical authored suites digest-stable and distinguishes changed expectations', () => {
  const build = (exitCode: number) => defineEvalSuite({
    cases: [{
      assertions: [expectExitCode(exitCode)],
      fixture: './fixtures/repo',
      hosts,
      id: 'case',
      invocation: { mode: 'automatic' },
      prompt: 'Do the task.',
    }],
    name: 'suite',
  });

  expect(build(0).digest).toBe(build(0).digest);
  expect(build(0).digest).not.toBe(build(1).digest);
});

it('rejects reference answers and assertion material smuggled onto the case', () => {
  expect(() => defineEvalSuite({
    cases: [{
      assertions: [expectExitCode(0)],
      fixture: './fixtures/repo',
      hosts,
      id: 'case',
      invocation: { mode: 'automatic' },
      prompt: 'Do the task.',
      referenceAnswer: 'the answer is 42',
    } as never],
    name: 'suite',
  })).toThrow(EvalDefinitionError);
});

it('rejects a provider credential as a configuration field', () => {
  const attempt = () => defineEvalSuite({
    cases: [{
      assertions: [expectExitCode(0)],
      fixture: './fixtures/repo',
      hosts: { claude: { apiKey: 'sk-ant-0123456789abcdefghij', model: 'claude-sonnet-4-5' } },
      id: 'case',
      invocation: { mode: 'automatic' },
      prompt: 'Do the task.',
    } as never],
    name: 'suite',
  });

  expect(attempt).toThrow(EvalDefinitionError);
  expect(attempt).toThrow(/credential/iu);
});

it('reserves the server-owned Claude semantic grader id from authored outcome expectations', () => {
  expect(() => expectOutcome({ script: 'claude-semantic' })).toThrow(EvalDefinitionError);
  expect(() => expectOutcome({ script: 'claude-semantic' })).toThrow(
    'Authored outcome graders must not use the reserved grader id "claude-semantic".',
  );
});

it('rejects an explicit invocation without a Skill and a none invocation with one', () => {
  const withoutSkill = () => defineEvalSuite({
    cases: [{
      assertions: [expectExitCode(0)],
      fixture: './fixtures/repo',
      hosts,
      id: 'case',
      invocation: { mode: 'explicit' },
      prompt: 'Do the task.',
    }],
    name: 'suite',
  });
  const negativeWithSkill = () => defineEvalSuite({
    cases: [{
      assertions: [expectNoSkillActivation()],
      fixture: './fixtures/repo',
      hosts,
      id: 'case',
      invocation: { mode: 'none', skill: 'review-change' },
      prompt: 'Do the task.',
    }],
    name: 'suite',
  });

  expect(withoutSkill).toThrow(EvalDefinitionError);
  expect(negativeWithSkill).toThrow(EvalDefinitionError);
});

it('rejects duplicate case ids, empty assertion sets, and escaping fixtures', () => {
  const duplicate = () => defineEvalSuite({
    cases: [
      {
        assertions: [expectExitCode(0)],
        fixture: './fixtures/repo',
        hosts,
        id: 'case',
        invocation: { mode: 'automatic' },
        prompt: 'One.',
      },
      {
        assertions: [expectExitCode(0)],
        fixture: './fixtures/repo',
        hosts,
        id: 'case',
        invocation: { mode: 'automatic' },
        prompt: 'Two.',
      },
    ],
    name: 'suite',
  });
  const empty = () => defineEvalSuite({
    cases: [{
      assertions: [],
      fixture: './fixtures/repo',
      hosts,
      id: 'case',
      invocation: { mode: 'automatic' },
      prompt: 'One.',
    }],
    name: 'suite',
  });
  const escaping = () => defineEvalSuite({
    cases: [{
      assertions: [expectExitCode(0)],
      fixture: '../outside',
      hosts,
      id: 'case',
      invocation: { mode: 'automatic' },
      prompt: 'One.',
    }],
    name: 'suite',
  });

  expect(duplicate).toThrow(EvalDefinitionError);
  expect(empty).toThrow(EvalDefinitionError);
  expect(escaping).toThrow(EvalDefinitionError);
});

it('resolves every assertion to pass, fail, or inconclusive without silently passing weak evidence', () => {
  const assertions = [
    expectExitCode(0),
    expectMcpCall({ atLeast: 2, server: 'project', tool: 'status' }),
    expectSkillActivation({ minimumEvidence: 'observed', skill: 'review-change' }),
    expectNoSkillActivation(),
    expectOutcome({ script: './graders/review-result.ts' }),
  ];

  const inconclusive = resolveEvalAssertions(assertions, evidenceWith());
  expect(inconclusive.map((result) => result.outcome)).toEqual([
    'inconclusive',
    'inconclusive',
    'inconclusive',
    'inconclusive',
    'inconclusive',
  ]);

  const resolved = resolveEvalAssertions(assertions, evidenceWith({
    mcp: {
      calls: [
        { server: 'project', tool: 'status' },
        { server: 'project', tool: 'status' },
      ],
      level: 'observed',
    },
    process: { exitCode: 0, level: 'observed', timedOut: false },
    scripts: { level: 'observed', results: { './graders/review-result.ts': { detail: 'ok', outcome: 'pass' } } },
    skillActivation: { activated: ['review-change'], level: 'observed' },
  }));
  expect(resolved.map((result) => result.outcome)).toEqual([
    'pass',
    'pass',
    'pass',
    'fail',
    'pass',
  ]);
});

it('never upgrades inferred activation evidence to an observed expectation', () => {
  const inferred = evidenceWith({ skillActivation: { activated: ['review-change'], level: 'inferred' } });

  expect(resolveEvalAssertions([expectSkillActivation({ minimumEvidence: 'observed', skill: 'review-change' })], inferred)[0]?.outcome)
    .toBe('inconclusive');
  expect(resolveEvalAssertions([expectSkillActivation({ minimumEvidence: 'inferred', skill: 'review-change' })], inferred)[0]?.outcome)
    .toBe('pass');
});

it('fails an exit-code assertion when the harness recorded a timeout', () => {
  const timedOut = evidenceWith({ process: { level: 'observed', timedOut: true } });
  const result = resolveEvalAssertions([expectExitCode(0)], timedOut)[0];

  expect(result?.outcome).toBe('fail');
  expect(result?.detail).toMatch(/timed out/iu);
});

const draft: DraftEvalCase = Object.freeze({
  assertions: Object.freeze([
    Object.freeze({ evidence: Object.freeze({ level: 'observed' }), expectation: Object.freeze({ expected: 0 }), id: 'a1', kind: 'exit-code' }),
    Object.freeze({
      evidence: Object.freeze({ level: 'observed' }),
      expectation: Object.freeze({ atLeast: 1, server: 'project', tool: 'status' }),
      id: 'a2',
      kind: 'mcp-call',
    }),
  ]),
  epoch: Object.freeze({ digest: 'epoch-digest', id: 'epoch-1' }),
  fixture: Object.freeze({ digest: 'fixture-digest', id: 'fixture-1' }),
  invocation: Object.freeze({ intent: Object.freeze({ mode: 'automatic', skill: 'review-change' }), kind: 'skill-select' }),
  outcome: Object.freeze({ response: 'the highest risk regression is the cache eviction path', status: 'succeeded' }),
  schemaVersion: 1,
  target: Object.freeze({ digest: 'target-digest', name: 'claude' }),
  task: Object.freeze({ id: 'direct-review', text: 'Review this change and report the highest-risk regression.' }),
});

it('converts a frozen W17 draft into an authored case without leaking the recorded answer', () => {
  const converted = evalCaseFromDraft(draft, { fixture: './fixtures/review-repo', hosts });

  expect(converted.case.id).toBe('direct-review');
  expect(converted.case.prompt).toBe('Review this change and report the highest-risk regression.');
  expect(converted.case.invocation).toEqual({ mode: 'automatic', skill: 'review-change' });
  expect(converted.case.assertions.map((assertion) => assertion.kind)).toEqual(['exit-code', 'mcp-call']);
  expect(converted.provenance).toEqual({
    epoch: { digest: 'epoch-digest', id: 'epoch-1' },
    fixtureDigest: 'fixture-digest',
    schemaVersion: 1,
    target: { digest: 'target-digest', name: 'claude' },
  });
  expect(JSON.stringify(converted)).not.toContain('cache eviction');
  expect(JSON.stringify(converted)).not.toContain('succeeded');
});

it('accepts the converted draft case inside a suite unchanged', () => {
  const converted = evalCaseFromDraft(draft, { fixture: './fixtures/review-repo', hosts, trials: 3 });
  const suite = defineEvalSuite({ cases: [converted.case], name: 'promoted' });

  expect(suite.cases[0]).toEqual({ ...converted.case, trials: 3 });
});

it('rejects a draft whose invocation intent has no supported mode', () => {
  const unsupported: DraftEvalCase = Object.freeze({
    ...draft,
    invocation: Object.freeze({ intent: Object.freeze({}), kind: 'script' }),
  });

  expect(() => evalCaseFromDraft(unsupported, { fixture: './fixtures/review-repo', hosts })).toThrow(EvalDefinitionError);
});
