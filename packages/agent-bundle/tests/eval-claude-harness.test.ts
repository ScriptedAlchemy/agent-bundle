import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import { runClaudeTrial } from '../src/eval/claude-harness.ts';
import { runClaudeStreamProcess } from '../src/eval/claude-process.ts';
import {
  createEvalHarness,
  createEvalRun,
  defineEvalSuite,
  expectExitCode,
  expectMcpCall,
  expectOutcome,
  expectSkillActivation,
  planEvalFixture,
  prepareEvalArtifact,
  type EvalCase,
  type EvalRunWriter,
  type EvalTrialRecord,
  type PreparedEvalArtifact,
} from '../src/eval/index.ts';
import type {
  NativeClaudeProcessRequest,
  NativeClaudeProcessResult,
} from '../src/host-contracts/native-claude-contract.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';

const nativeIt = process.env.AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE === '1' ? it : it.skip;

const hosts = Object.freeze({ claude: Object.freeze({ model: 'claude-sonnet-4-5' }) });

const hostileEnvironment: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  ANTHROPIC_API_KEY: 'must-not-reach-child',
  ANTHROPIC_AUTH_TOKEN: 'must-not-reach-child',
  ANTHROPIC_BASE_URL: 'https://must-not-reach-child.invalid',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CONFIG_DIR: '/existing/claude-config',
  OPENAI_API_KEY: 'must-not-reach-child',
  PATH: '/usr/bin',
});

const versionResult: NativeClaudeProcessResult = Object.freeze({
  exitCode: 0,
  stderr: '',
  stdout: '2.1.232 (Claude Code)\n',
});

const authenticatedResult: NativeClaudeProcessResult = Object.freeze({
  exitCode: 0,
  stderr: '',
  stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\n',
});

const activatedStream = [
  '{"type":"system","subtype":"init","session_id":"<redacted>","apiKeySource":"none","plugins":[{"name":"review"}],"mcp_servers":[{"name":"project"}]}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"review:review"}}],"usage":{"input_tokens":9,"output_tokens":3}}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__project__status_report","input":{}}]}}',
  '{"type":"result","subtype":"success","is_error":false,"duration_ms":42,"num_turns":2,"result":"Reviewed the change.","usage":{"input_tokens":9,"output_tokens":3}}',
  '',
].join('\n');

interface ClaudeTestContext {
  readonly artifact: PreparedEvalArtifact;
  readonly evalCase: EvalCase;
  readonly root: string;
  readonly suiteDir: string;
  readonly writer: EvalRunWriter;
}

const seedSuiteDirectory = async (root: string): Promise<string> => {
  const suiteDir = join(root, 'evals');
  await mkdir(join(suiteDir, 'fixtures', 'repo'), { recursive: true });
  await mkdir(join(suiteDir, 'graders'), { recursive: true });
  await writeFile(join(suiteDir, 'fixtures', 'repo', 'input.txt'), 'review me\n');
  await writeFile(
    join(suiteDir, 'graders', 'review-result.ts'),
    [
      "import { readFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      '',
      'export default async ({ fixturePath }: { fixturePath: string }) => {',
      "  const raw = await readFile(join(fixturePath, 'input.txt'), 'utf8');",
      "  return raw.includes('review me')",
      "    ? { detail: 'The trial workspace was materialized.', outcome: 'pass' }",
      "    : { detail: 'The trial workspace was empty.', outcome: 'fail' };",
      '};',
      '',
    ].join('\n'),
  );
  return suiteDir;
};

const caseFor = (assertions: EvalCase['assertions']): EvalCase => defineEvalSuite({
  cases: [{
    assertions,
    fixture: './fixtures/repo',
    hosts,
    id: 'direct-review',
    invocation: { mode: 'explicit', skill: 'review' },
    prompt: 'Use the review Skill and report the highest-risk regression.',
    trials: 1,
  }],
  name: 'review-change',
}).cases[0];

const defaultAssertions = Object.freeze([
  expectExitCode(0),
  expectMcpCall({ server: 'project', tool: 'status_report' }),
  expectOutcome({ script: './graders/review-result.ts' }),
  expectSkillActivation({ minimumEvidence: 'observed', skill: 'review' }),
]);

const withClaudeContext = async (
  assertions: EvalCase['assertions'],
  task: (context: ClaudeTestContext) => Promise<void>,
): Promise<void> => {
  const project = await createProjectFixture();
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-eval-'));
  try {
    const suiteDir = await seedSuiteDirectory(root);
    const artifactRoot = join(project.root, 'artifact');
    await build({ configPath: project.configPath, output: artifactRoot, root: project.root, targets: ['claude'] });
    const writer = await createEvalRun({
      artifact: { manifestPath: 'pending', source: 'explicit', targetDigests: { claude: 'pending' } },
      projectRoot: root,
      provenance: { agentBundleVersion: '0.1.0', harness: 'claude', projectRevision: 'unknown' },
    });
    try {
      const artifact = await prepareEvalArtifact({
        artifact: artifactRoot,
        projectRoot: root,
        runDirectory: writer.directory,
      });
      await task({ artifact, evalCase: caseFor(assertions), root, suiteDir, writer });
    } finally {
      await writer.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(project.root, { force: true, recursive: true });
  }
};

const runTrial = async (
  context: ClaudeTestContext,
  overrides: {
    readonly recorded?: NativeClaudeProcessRequest[];
    readonly run: (request: NativeClaudeProcessRequest, index: number) => NativeClaudeProcessResult;
    readonly semanticGrader?: Parameters<typeof runClaudeTrial>[0]['semanticGrader'];
  },
): Promise<EvalTrialRecord> => {
  const recorded = overrides.recorded ?? [];
  return runClaudeTrial({
    artifact: context.artifact,
    environment: hostileEnvironment,
    evalCase: context.evalCase,
    fixturePlan: await planEvalFixture({ baseDir: context.suiteDir, fixture: context.evalCase.fixture }),
    run: async (request) => {
      recorded.push(request);
      return overrides.run(request, recorded.length - 1);
    },
    ...(overrides.semanticGrader === undefined ? {} : { semanticGrader: overrides.semanticGrader }),
    suiteDir: context.suiteDir,
    trialIndex: 0,
    workspaceRoot: join(context.root, 'workspaces'),
    writer: context.writer,
  });
};

it('exposes the Claude native harness through the shared harness factory', () => {
  expect(createEvalHarness('claude')).toEqual({ kind: 'native-claude', name: 'claude' });
});

it('runs a signed-in trial with an explicit plugin directory, never --bare, and no provider API keys', async () => {
  await withClaudeContext(defaultAssertions, async (context) => {
    const recorded: NativeClaudeProcessRequest[] = [];
    const trial = await runTrial(context, {
      recorded,
      run: (_request, index) => index === 0
        ? versionResult
        : index === 1
          ? authenticatedResult
          : { exitCode: 0, stderr: 'notice\n', stdout: activatedStream },
    });

    expect(recorded.map((request) => request.args[0])).toEqual(['--version', 'auth', '-p']);
    expect(recorded.every((request) => request.executable === 'claude')).toBe(true);
    expect(recorded.every((request) => !request.args.includes('--bare'))).toBe(true);
    for (const request of recorded) {
      expect(request.environment).toEqual({ CLAUDE_CONFIG_DIR: '/existing/claude-config', PATH: '/usr/bin' });
    }
    const execution = recorded[2];
    expect(execution?.args).toEqual([
      '-p',
      '--plugin-dir',
      join(context.artifact.root, 'claude'),
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-hook-events',
      '--no-session-persistence',
      context.evalCase.prompt,
    ]);
    expect(execution?.cwd).toBe(join(context.root, 'workspaces', 'direct-review', 'claude-1'));

    expect(trial.harnessFailure).toBeUndefined();
    expect(trial.pluginFailure).toBeUndefined();
    expect(trial.outcome).toBe('pass');
    expect(trial.host).toBe('claude');
    expect(trial.model).toBe('claude-sonnet-4-5');
    expect(trial.evidence.skillActivation).toEqual({ activated: ['review', 'review:review'], level: 'observed' });
    expect(trial.evidence.mcp).toEqual({ calls: [{ server: 'project', tool: 'status_report' }], level: 'observed' });
    expect(trial.evidence.process).toEqual({ exitCode: 0, level: 'observed', timedOut: false });
    expect(trial.assertions.every((assertion) => assertion.outcome === 'pass')).toBe(true);
    expect(trial.rawArtifacts).toContain('artifacts/claude-1/stream.jsonl');
    expect(trial.rawArtifacts).toContain('artifacts/claude-1/usage.json');

    const usage = JSON.parse(
      await readFile(join(context.writer.directory, 'artifacts', 'claude-1', 'usage.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(usage).toMatchObject({ inputTokens: 9, outputTokens: 3, turns: 2 });
  });
}, 240_000);

it('turns a missing CLI into a harness-failure trial without a workspace or plugin failure', async () => {
  await withClaudeContext(defaultAssertions, async (context) => {
    const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const trial = await runTrial(context, {
      run: () => { throw missing; },
    });

    expect(trial.harnessFailure).toMatchObject({ code: 'EVAL_PROCESS_UNAVAILABLE', stage: 'preflight' });
    expect(trial.harnessFailure?.message).toMatch(/not installed/iu);
    expect(trial.pluginFailure).toBeUndefined();
    expect(trial.outcome).toBe('inconclusive');
    expect(trial.evidence.process.level).toBe('unavailable');
    expect(trial.evidence.skillActivation.level).toBe('unavailable');
    await expect(lstat(join(context.root, 'workspaces'))).rejects.toThrow();
  });
}, 240_000);

it('rejects a CLI older than the checked-in modern baseline instead of degrading', async () => {
  await withClaudeContext(defaultAssertions, async (context) => {
    const trial = await runTrial(context, {
      run: (_request, index) => index === 0
        ? { exitCode: 0, stderr: '', stdout: '2.1.231 (Claude Code)\n' }
        : authenticatedResult,
    });

    expect(trial.harnessFailure).toMatchObject({ code: 'EVAL_PROCESS_UNAVAILABLE', stage: 'preflight' });
    expect(trial.harnessFailure?.message).toContain('2.1.232');
    expect(trial.pluginFailure).toBeUndefined();
  });
}, 240_000);

it('turns an unauthenticated CLI into a harness-failure trial', async () => {
  await withClaudeContext(defaultAssertions, async (context) => {
    const trial = await runTrial(context, {
      run: (_request, index) => index === 0
        ? versionResult
        : { exitCode: 0, stderr: '', stdout: '{"loggedIn":false}\n' },
    });

    expect(trial.harnessFailure).toMatchObject({ code: 'EVAL_PROCESS_UNAVAILABLE', stage: 'preflight' });
    expect(trial.harnessFailure?.message).toMatch(/sign in|subscription|session/iu);
    expect(trial.pluginFailure).toBeUndefined();
  });
}, 240_000);

it('reports an unloaded candidate plugin as a harness failure rather than plugin evidence', async () => {
  await withClaudeContext(defaultAssertions, async (context) => {
    const trial = await runTrial(context, {
      run: (_request, index) => index < 2
        ? (index === 0 ? versionResult : authenticatedResult)
        : {
          exitCode: 0,
          stderr: '',
          stdout: '{"type":"system","subtype":"init","plugins":[],"mcp_servers":[]}\n{"type":"result","subtype":"success","result":"done"}\n',
        },
    });

    expect(trial.harnessFailure).toMatchObject({ code: 'EVAL_ARTIFACT_UNAVAILABLE', stage: 'artifact' });
    expect(trial.pluginFailure).toBeUndefined();
  });
}, 240_000);

it('records a cancelled trial as an unusable trace and a timed-out trial as a plugin failure', async () => {
  await withClaudeContext([expectExitCode(0)], async (context) => {
    const cancelled = await runTrial(context, {
      run: (_request, index) => index < 2
        ? (index === 0 ? versionResult : authenticatedResult)
        : { exitCode: null, stderr: '', stdout: '', termination: 'aborted' },
    });
    expect(cancelled.harnessFailure).toMatchObject({ code: 'EVAL_TRACE_UNAVAILABLE', stage: 'trace' });
    expect(cancelled.pluginFailure).toBeUndefined();
  });

  await withClaudeContext([expectExitCode(0)], async (context) => {
    const timedOut = await runTrial(context, {
      run: (_request, index) => index < 2
        ? (index === 0 ? versionResult : authenticatedResult)
        : { exitCode: null, stderr: '', stdout: activatedStream, termination: 'timed-out' },
    });
    expect(timedOut.harnessFailure).toBeUndefined();
    expect(timedOut.pluginFailure).toMatchObject({ code: 'EVAL_PLUGIN_TIMED_OUT' });
    expect(timedOut.pluginFailure?.message).toMatch(/timeout/iu);
    expect(timedOut.evidence.process.timedOut).toBe(true);
  });
}, 240_000);

it('gives an optional semantic grader the task, assertions, response, trace, and workspace only', async () => {
  await withClaudeContext(
    [expectExitCode(0), expectOutcome({ script: 'semantic-review' })],
    async (context) => {
      const seen: Record<string, unknown>[] = [];
      const trial = await runTrial(context, {
        run: (_request, index) => index < 2
          ? (index === 0 ? versionResult : authenticatedResult)
          : { exitCode: 0, stderr: '', stdout: activatedStream },
        semanticGrader: {
          grade: (input) => {
            seen.push(input as unknown as Record<string, unknown>);
            return { detail: 'The response names the regression.', outcome: 'pass' };
          },
          id: 'semantic-review',
        },
      });

      expect(seen).toHaveLength(1);
      const context0 = seen[0] ?? {};
      expect(Object.keys(context0).sort()).toEqual([
        'assertions',
        'finalResponse',
        'prompt',
        'trace',
        'workspacePath',
      ]);
      expect(context0.finalResponse).toBe('Reviewed the change.');
      expect(context0.prompt).toBe(context.evalCase.prompt);
      expect(JSON.stringify(context0)).not.toMatch(/with_skill|without_skill|invocation|baseline|candidate/iu);
      expect(trial.evidence.scripts.results['semantic-review']).toEqual({
        detail: 'The response names the regression.',
        outcome: 'pass',
      });
      expect(trial.outcome).toBe('pass');
    },
  );
}, 240_000);

it('keeps a failing grader a harness failure instead of plugin evidence', async () => {
  await withClaudeContext(
    [expectExitCode(0), expectOutcome({ script: 'semantic-review' })],
    async (context) => {
      const trial = await runTrial(context, {
        run: (_request, index) => index < 2
          ? (index === 0 ? versionResult : authenticatedResult)
          : { exitCode: 0, stderr: '', stdout: activatedStream },
        semanticGrader: {
          grade: () => { throw new Error('the grader endpoint is unreachable'); },
          id: 'semantic-review',
        },
      });

      expect(trial.harnessFailure).toMatchObject({ code: 'EVAL_GRADER_FAILED', stage: 'grader' });
      expect(trial.pluginFailure).toBeUndefined();
      expect(trial.outcome).toBe('inconclusive');
    },
  );
}, 240_000);

it('cancels a running child process and leaves no live process behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-cancel-'));
  try {
    const pidPath = join(root, 'child.pid');
    const controller = new AbortController();
    const pending = runClaudeStreamProcess(
      {
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
        ],
        cwd: root,
        environment: { PATH: process.env.PATH ?? '' },
        executable: process.execPath,
      },
      { gracePeriodMs: 200, signal: controller.signal, timeoutMs: 10_000 },
    );

    let pid = '';
    for (let attempt = 0; attempt < 100 && pid.length === 0; attempt += 1) {
      pid = await readFile(pidPath, 'utf8').catch(() => '');
      if (pid.length === 0) await new Promise((resolveWait) => { setTimeout(resolveWait, 20); });
    }
    expect(pid.length).toBeGreaterThan(0);

    controller.abort();
    const outcome = await pending;
    expect(outcome.termination).toBe('aborted');
    expect(outcome.failure).toBeUndefined();
    expect(() => process.kill(Number(pid), 0)).toThrow();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports a missing executable as a harness failure instead of throwing', async () => {
  const outcome = await runClaudeStreamProcess({
    args: ['--version'],
    cwd: process.cwd(),
    environment: { PATH: '/nonexistent' },
    executable: 'agent-bundle-claude-not-installed',
  });

  expect(outcome.failure).toMatchObject({ code: 'EVAL_PROCESS_UNAVAILABLE', stage: 'preflight' });
  expect(outcome.exitCode).toBeUndefined();
});

nativeIt('runs one signed-in Claude trial through the installed CLI', async () => {
  await withClaudeContext([expectExitCode(0)], async (context) => {
    const trial = await runClaudeTrial({
      artifact: context.artifact,
      evalCase: context.evalCase,
      fixturePlan: await planEvalFixture({ baseDir: context.suiteDir, fixture: context.evalCase.fixture }),
      suiteDir: context.suiteDir,
      timeoutMs: 300_000,
      trialIndex: 0,
      workspaceRoot: join(context.root, 'workspaces'),
      writer: context.writer,
    });

    expect(trial.harnessFailure, JSON.stringify(trial.harnessFailure)).toBeUndefined();
    expect(trial.evidence.process.exitCode).toBe(0);
    expect(trial.evidence.skillActivation.level).toBe('observed');
    expect(trial.outcome).toBe('pass');
  });
}, 240_000);
