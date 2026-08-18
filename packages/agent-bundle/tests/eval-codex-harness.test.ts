import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  createCodexEvalHarness,
  runCodexEvalTrial,
  type CodexCommandInput,
  type CodexCommandResult,
} from '../src/eval/codex-harness.ts';
import {
  createEvalRun,
  expectExitCode,
  expectMcpCall,
  expectSkillActivation,
  normalizeEvalCase,
  planEvalFixture,
  type EvalCase,
  type EvalTrialRecord,
} from '../src/eval/index.ts';

const streamFixtureRoot = new URL('../fixtures/eval/codex/', import.meta.url);

const marketplace = {
  name: 'agent-bundle-eval-marketplace',
  plugins: [{ name: 'agent-bundle-eval', source: { path: './', source: 'local' } }],
};

interface TrialWorld {
  readonly commands: CodexCommandInput[];
  readonly normalCodexHome: string;
  readonly observed: { authMode?: number; authSize?: number; codexHome?: string; pluginRoots: string[] };
  readonly root: string;
  readonly suiteDir: string;
  readonly target: string;
}

const evalCase = (): EvalCase => normalizeEvalCase({
  assertions: [
    expectExitCode(0),
    expectMcpCall({ server: 'project', tool: 'status' }),
    expectSkillActivation({ skill: 'release-notes' }),
  ],
  fixture: './fixtures/repo',
  hosts: { codex: { model: 'gpt-5-codex' } },
  id: 'release-notes',
  invocation: { mode: 'automatic' },
  prompt: 'Draft the release notes for this repository.',
  trials: 1,
});

const seedWorld = async (): Promise<TrialWorld> => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle codex harness '));
  const suiteDir = join(root, 'evals');
  const target = join(root, 'artifact', 'codex');
  const normalCodexHome = join(root, 'normal-codex-home');
  await mkdir(join(suiteDir, 'fixtures', 'repo'), { recursive: true });
  await mkdir(join(target, '.agents', 'plugins'), { recursive: true });
  await mkdir(join(target, 'skills', 'release-notes'), { recursive: true });
  await mkdir(join(normalCodexHome, 'plugins'), { recursive: true });
  await writeFile(join(suiteDir, 'fixtures', 'repo', 'input.txt'), 'release me\n');
  await writeFile(join(target, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify(marketplace)}\n`);
  await writeFile(join(target, 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\n---\n');
  await writeFile(join(normalCodexHome, 'auth.json'), '{"opaque":"session"}\n');
  await chmod(join(normalCodexHome, 'auth.json'), 0o600);
  await writeFile(join(normalCodexHome, 'config.toml'), 'model = "gpt-5-codex"\n');
  await writeFile(join(normalCodexHome, 'plugins', 'installed.json'), '{"installed":[]}\n');
  return {
    commands: [],
    normalCodexHome,
    observed: { pluginRoots: [] },
    root,
    suiteDir,
    target,
  };
};

const stubResponses = async (): Promise<Readonly<Record<string, string>>> => Object.freeze({
  exec: await readFile(new URL('complete-run.jsonl', streamFixtureRoot), 'utf8'),
  list: await readFile(new URL('plugin-list.json', streamFixtureRoot), 'utf8'),
});

const stubRunner = (
  world: TrialWorld,
  responses: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, CodexCommandResult | (() => never)>> = {},
) => async (command: CodexCommandInput): Promise<CodexCommandResult> => {
  world.commands.push(command);
  const codexHome = command.environment.CODEX_HOME;
  if (codexHome !== undefined) {
    world.observed.codexHome = codexHome;
    try {
      const authState = await stat(join(codexHome, 'auth.json'));
      world.observed.authMode = authState.mode & 0o777;
      world.observed.authSize = authState.size;
    } catch {
      // The auth copy has not happened yet at this step.
    }
  }
  const step = command.args[0] === 'plugin'
    ? `${command.args[0]}.${command.args[1]}`
    : command.args[0] ?? 'unknown';
  const override = overrides[step];
  if (typeof override === 'function') return override();
  if (override !== undefined) return override;
  if (step === 'plugin.marketplace' || step === 'plugin.add') {
    world.observed.pluginRoots.push(command.args[command.args.length - 1] ?? '');
    return { exitCode: 0, stderr: '', stdout: '' };
  }
  if (step === 'plugin.list') return { exitCode: 0, stderr: '', stdout: responses.list ?? '' };
  if (step === 'exec') return { exitCode: 0, stderr: '', stdout: responses.exec ?? '' };
  return { exitCode: 0, stderr: '', stdout: 'codex-cli 0.147.0\n' };
};

const runTrial = async (
  world: TrialWorld,
  overrides: Readonly<Record<string, CodexCommandResult | (() => never)>> = {},
  extra: Readonly<{ readonly signal?: AbortSignal }> = {},
): Promise<EvalTrialRecord> => {
  const testCase = evalCase();
  const writer = await createEvalRun({
    artifact: { manifestPath: 'pending', source: 'explicit', targetDigests: { codex: 'target-digest' } },
    projectRoot: world.root,
    provenance: { agentBundleVersion: '0.1.0', harness: 'codex', projectRevision: 'unknown' },
    runsDir: 'runs',
  });
  try {
    return await runCodexEvalTrial({
      artifact: {
        binding: { manifestPath: 'pending', source: 'explicit', targetDigests: { codex: 'target-digest' } },
        root: join(world.root, 'artifact'),
      },
      environment: {
        ANTHROPIC_API_KEY: 'must-not-reach-the-child',
        CUSTOM_CONTROL: 'keep',
        OPENAI_API_KEY: 'must-not-reach-the-child',
        PATH: process.env.PATH ?? '/usr/bin',
      },
      evalCase: testCase,
      fixturePlan: await planEvalFixture({ baseDir: world.suiteDir, fixture: testCase.fixture }),
      normalCodexHome: world.normalCodexHome,
      run: stubRunner(world, await stubResponses(), overrides),
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
      suiteDir: world.suiteDir,
      trialIndex: 0,
      workspaceRoot: join(world.root, 'workspaces'),
      writer,
    });
  } finally {
    await writer.close();
  }
};

const withWorld = async (task: (world: TrialWorld) => Promise<void>): Promise<void> => {
  const world = await seedWorld();
  try {
    await task(world);
  } finally {
    await rm(world.root, { force: true, recursive: true });
  }
};

const missingExecutable = (): never => {
  const error: NodeJS.ErrnoException = new Error('spawn codex ENOENT');
  error.code = 'ENOENT';
  throw error;
};

it('names the native Codex harness without claiming a deterministic kind', () => {
  const harness = createCodexEvalHarness();

  expect(harness.kind).toBe('native-codex');
  expect(harness.name).toBe('codex');
  expect(typeof harness.runTrial).toBe('function');
});

it('runs an ephemeral Codex trial and records inferred activation beside observed MCP evidence', async () => {
  await withWorld(async (world) => {
    const trial = await runTrial(world);

    expect(trial.outcome).toBe('pass');
    expect(trial.harnessFailure).toBeUndefined();
    expect(trial.pluginFailure).toBeUndefined();
    expect(trial.evidence.skillActivation).toEqual({ activated: ['release-notes'], level: 'inferred' });
    expect(trial.evidence.mcp).toEqual({ calls: [{ server: 'project', tool: 'status' }], level: 'observed' });
    expect(trial.evidence.process).toEqual({ exitCode: 0, level: 'observed', timedOut: false });
    expect(trial.rawArtifacts).toContain('artifacts/codex-1/events.jsonl');
    expect(trial.assertions.every((assertion) => assertion.outcome === 'pass')).toBe(true);
  });
});

it('installs and verifies the candidate only inside the temporary home', async () => {
  await withWorld(async (world) => {
    await runTrial(world);

    expect(world.observed.codexHome).toBeDefined();
    expect(world.observed.codexHome).not.toBe(world.normalCodexHome);
    expect(world.observed.codexHome?.startsWith(join(world.root, 'workspaces'))).toBe(true);
    for (const root of world.observed.pluginRoots) {
      expect(root.startsWith(world.normalCodexHome)).toBe(false);
    }
    expect(world.observed.pluginRoots[0]?.startsWith(join(world.root, 'workspaces'))).toBe(true);
    await expect(lstat(join(world.normalCodexHome, 'plugins', 'cache'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('copies the opaque auth state with its mode and leaves the normal home untouched', async () => {
  await withWorld(async (world) => {
    const before = await readFile(join(world.normalCodexHome, 'auth.json'), 'utf8');
    await runTrial(world);
    const after = await readFile(join(world.normalCodexHome, 'auth.json'), 'utf8');

    expect(world.observed.authMode).toBe(0o600);
    expect(world.observed.authSize).toBe(Buffer.byteLength(before));
    expect(after).toBe(before);
  });
});

it('never hands a provider API key or an API-key argument to the installed CLI', async () => {
  await withWorld(async (world) => {
    await runTrial(world);

    expect(world.commands.length).toBeGreaterThan(0);
    for (const command of world.commands) {
      expect(command.environment.ANTHROPIC_API_KEY).toBeUndefined();
      expect(command.environment.OPENAI_API_KEY).toBeUndefined();
      expect(command.environment.CUSTOM_CONTROL).toBe('keep');
      expect(JSON.stringify(command.args)).not.toMatch(/api[_-]?key|authorization/iu);
    }
  });
});

it('removes the temporary home, candidate copy, and workspace after a trial', async () => {
  await withWorld(async (world) => {
    await runTrial(world);

    const codexHome = world.observed.codexHome ?? '';
    await expect(lstat(codexHome)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(codexHome, '..'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('turns a missing Codex CLI into a harness-failure trial rather than a plugin failure', async () => {
  await withWorld(async (world) => {
    const trial = await runTrial(world, { '--version': missingExecutable });

    expect(trial.outcome).toBe('inconclusive');
    expect(trial.pluginFailure).toBeUndefined();
    expect(trial.harnessFailure).toEqual({
      code: 'EVAL_PROCESS_UNAVAILABLE',
      message: expect.stringContaining('CODEX_CLI_MISSING'),
      stage: 'preflight',
    });
  });
});

it('turns an incompatible Codex CLI into a harness-failure trial', async () => {
  await withWorld(async (world) => {
    const trial = await runTrial(world, {
      '--version': { exitCode: 0, stderr: '', stdout: 'codex-cli 0.140.0\n' },
    });

    expect(trial.harnessFailure?.message).toMatch(/CODEX_CLI_INCOMPATIBLE/u);
    expect(trial.harnessFailure?.stage).toBe('preflight');
  });
});

it('turns an unauthenticated Codex CLI into a harness-failure trial', async () => {
  await withWorld(async (world) => {
    await rm(join(world.normalCodexHome, 'auth.json'));
    const trial = await runTrial(world);

    expect(trial.harnessFailure?.message).toMatch(/CODEX_CLI_UNAUTHENTICATED/u);
    expect(trial.evidence.process.level).toBe('unavailable');
  });
});

it('turns a sign-in demand reported by the CLI into a harness-failure trial', async () => {
  await withWorld(async (world) => {
    const trial = await runTrial(world, {
      exec: { exitCode: 1, stderr: 'Please sign in with your subscription before running codex exec.', stdout: '' },
    });

    expect(trial.harnessFailure?.message).toMatch(/CODEX_CLI_UNAUTHENTICATED/u);
    expect(trial.pluginFailure).toBeUndefined();
  });
});

it('turns an unverifiable candidate plugin into a harness-failure trial', async () => {
  await withWorld(async (world) => {
    const disabled = await readFile(new URL('plugin-list-disabled.json', streamFixtureRoot), 'utf8');
    const trial = await runTrial(world, {
      'plugin.list': { exitCode: 0, stderr: '', stdout: disabled },
    });

    expect(trial.harnessFailure?.message).toMatch(/CODEX_PLUGIN_UNAVAILABLE/u);
    expect(trial.harnessFailure?.stage).toBe('preflight');
  });
});

it('turns an unreadable event stream into a trace harness failure', async () => {
  await withWorld(async (world) => {
    const malformed = await readFile(new URL('malformed.jsonl', streamFixtureRoot), 'utf8');
    const trial = await runTrial(world, { exec: { exitCode: 0, stderr: '', stdout: malformed } });

    expect(trial.harnessFailure).toEqual({
      code: 'EVAL_TRACE_UNAVAILABLE',
      message: expect.stringContaining('CODEX_TRACE_INVALID'),
      stage: 'trace',
    });
  });
});

it('reports a plugin failure when the ephemeral run itself fails', async () => {
  await withWorld(async (world) => {
    const responses = await stubResponses();
    const trial = await runTrial(world, {
      exec: { exitCode: 3, stderr: 'the plugin command exited non-zero', stdout: responses.exec ?? '' },
    });

    expect(trial.harnessFailure).toBeUndefined();
    expect(trial.pluginFailure).toEqual({
      code: 'EVAL_PLUGIN_PROCESS_FAILED',
      message: 'The trial process exited with code 3.',
    });
  });
});

it('records a timed-out ephemeral run as a plugin failure with observed process evidence', async () => {
  await withWorld(async (world) => {
    const trial = await runTrial(world, {
      exec: { exitCode: 1, failure: 'timeout', stderr: '', stdout: '' },
    });

    expect(trial.evidence.process.timedOut).toBe(true);
    expect(trial.pluginFailure?.code).toBe('EVAL_PLUGIN_TIMED_OUT');
  });
});

it('cleans up and reports a harness failure when the trial is cancelled', async () => {
  await withWorld(async (world) => {
    const controller = new AbortController();
    const trial = await runTrial(world, {
      exec: (() => {
        controller.abort();
        const error: NodeJS.ErrnoException = new Error('The operation was aborted');
        error.code = 'ABORT_ERR';
        throw error;
      }) as () => never,
    }, { signal: controller.signal });

    expect(trial.harnessFailure).toEqual({
      code: 'EVAL_TRACE_UNAVAILABLE',
      message: expect.stringContaining('CODEX_TRIAL_CANCELLED'),
      stage: 'trace',
    });
    await expect(lstat(world.observed.codexHome ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
