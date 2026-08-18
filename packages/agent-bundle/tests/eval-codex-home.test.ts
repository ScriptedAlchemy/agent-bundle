import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { runCodexEvalTrial, type CodexCommandInput, type CodexCommandResult } from '../src/eval/codex-harness.ts';
import {
  adoptCodexAuthState,
  codexChildEnvironment,
  codexVersionCompatible,
  digestCodexHome,
  resolveNormalCodexHome,
} from '../src/eval/codex-home.ts';
import {
  createEvalRun,
  expectExitCode,
  expectSkillActivation,
  normalizeEvalCase,
  planEvalFixture,
  type EvalCase,
} from '../src/eval/index.ts';

const fixtureRoot = new URL('../fixtures/eval/codex/', import.meta.url);
const normalCodexHome = resolveNormalCodexHome(process.env);
const smokeIt = process.env.AGENT_BUNDLE_NATIVE_CODEX_SMOKE === '1' ? it : it.skip;

const smokeCase = (): EvalCase => normalizeEvalCase({
  assertions: [expectExitCode(0), expectSkillActivation({ skill: 'agent-bundle-eval' })],
  fixture: './fixtures/workspace',
  hosts: { codex: { model: 'unpinned' } },
  id: 'codex-eval-smoke',
  invocation: { mode: 'automatic', skill: 'agent-bundle-eval' },
  prompt: 'Complete the Agent Bundle eval attestation by following its Skill, then reply with its exact sentence and nothing else.',
  trials: 1,
});

const seedProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle codex home '));
  await mkdir(join(root, 'evals', 'fixtures'), { recursive: true });
  await mkdir(join(root, 'artifact'), { recursive: true });
  await cp(new URL('workspace/', fixtureRoot).pathname, join(root, 'evals', 'fixtures', 'workspace'), { recursive: true });
  await cp(new URL('candidate/', fixtureRoot).pathname, join(root, 'artifact', 'codex'), { recursive: true });
  return root;
};

const seedNormalCodexHome = async (root: string): Promise<string> => {
  const home = join(root, 'normal-codex-home');
  await mkdir(join(home, 'plugins'), { recursive: true });
  await writeFile(join(home, 'auth.json'), '{"opaque":"session"}\n');
  await chmod(join(home, 'auth.json'), 0o600);
  await writeFile(join(home, 'config.toml'), 'model = "gpt-5-codex"\n');
  await writeFile(join(home, 'plugins', 'installed.json'), '{"installed":[]}\n');
  return home;
};

const inertRunner = async (command: CodexCommandInput): Promise<CodexCommandResult> => {
  if (command.args[0] === '--version') return { exitCode: 0, stderr: '', stdout: 'codex-cli 0.147.0\n' };
  if (command.args[1] === 'list') {
    return {
      exitCode: 0,
      stderr: '',
      stdout: await readFile(new URL('plugin-list.json', fixtureRoot), 'utf8'),
    };
  }
  if (command.args[0] === 'exec') {
    return { exitCode: 0, stderr: '', stdout: await readFile(new URL('complete-run.jsonl', fixtureRoot), 'utf8') };
  }
  return { exitCode: 0, stderr: '', stdout: '' };
};

const runOnNormalHome = async (
  root: string,
  normalHome: string,
  runner?: (command: CodexCommandInput) => Promise<CodexCommandResult>,
) => {
  const testCase = smokeCase();
  const writer = await createEvalRun({
    artifact: { manifestPath: 'pending', source: 'explicit', targetDigests: { codex: 'target-digest' } },
    projectRoot: root,
    provenance: { agentBundleVersion: '0.1.0', harness: 'codex', projectRevision: 'unknown' },
    runsDir: 'runs',
  });
  try {
    return await runCodexEvalTrial({
      artifact: {
        binding: { manifestPath: 'pending', source: 'explicit', targetDigests: { codex: 'target-digest' } },
        root: join(root, 'artifact'),
      },
      evalCase: testCase,
      fixturePlan: await planEvalFixture({ baseDir: join(root, 'evals'), fixture: testCase.fixture }),
      normalCodexHome: normalHome,
      ...(runner === undefined ? {} : { run: runner }),
      suiteDir: join(root, 'evals'),
      trialIndex: 0,
      workspaceRoot: join(root, 'workspaces'),
      writer,
    });
  } finally {
    await writer.close();
  }
};

it('pins the temporary home and strips provider API keys from the inherited environment', () => {
  const child = codexChildEnvironment(
    {
      ANTHROPIC_API_KEY: 'remove',
      CODEX_API_KEY: 'remove',
      CODEX_HOME: '/home/example/.codex',
      OPENAI_API_KEY: 'remove',
      OPENAI_BASE_URL: 'remove',
      PATH: '/usr/bin',
      TERM: 'xterm',
    },
    '/tmp/temporary-home',
  );

  expect(child).toEqual({ CODEX_HOME: '/tmp/temporary-home', PATH: '/usr/bin', TERM: 'xterm' });
  expect(codexVersionCompatible('codex-cli 0.147.0')).toBe(true);
  expect(codexVersionCompatible('codex-cli 0.146.9')).toBe(false);
  expect(codexVersionCompatible('codex-cli 0.147.0-alpha.1')).toBe(false);
});

it('copies auth state byte for byte with its mode and never rewrites the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle codex auth '));
  try {
    const source = join(root, 'normal');
    const destination = join(root, 'temporary');
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, 'auth.json'), '{"opaque":"session","tokens":{"id":"opaque"}}\n');
    await chmod(join(source, 'auth.json'), 0o600);
    const before = await stat(join(source, 'auth.json'));

    await adoptCodexAuthState(source, destination);

    const copied = await stat(join(destination, 'auth.json'));
    expect(copied.mode & 0o777).toBe(0o600);
    expect(await readFile(join(destination, 'auth.json'))).toEqual(await readFile(join(source, 'auth.json')));
    expect((await stat(join(source, 'auth.json'))).mtimeMs).toBe(before.mtimeMs);

    await rm(join(source, 'auth.json'));
    await expect(adoptCodexAuthState(source, destination)).rejects.toMatchObject({
      code: 'CODEX_CLI_UNAUTHENTICATED',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('leaves a controlled normal Codex home digest unchanged across a trial', async () => {
  const root = await seedProject();
  try {
    const controlledNormalHome = await seedNormalCodexHome(root);
    const before = await digestCodexHome(controlledNormalHome);
    const trial = await runOnNormalHome(root, controlledNormalHome, inertRunner);
    const after = await digestCodexHome(controlledNormalHome);

    expect(after).toEqual(before);
    expect(trial.harnessFailure?.message ?? '').not.toMatch(/CODEX_HOME_MUTATED/u);
    await expect(lstat(join(root, 'workspaces'))).resolves.toMatchObject({});
    expect(existsSync(join(root, 'workspaces', 'home'))).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

smokeIt('runs one signed-in ephemeral Codex trial without touching the normal home', async () => {
  const root = await seedProject();
  try {
    const before = await digestCodexHome(normalCodexHome);
    const trial = await runOnNormalHome(root, normalCodexHome);
    const after = await digestCodexHome(normalCodexHome);

    expect(after).toEqual(before);
    expect(trial.harnessFailure).toBeUndefined();
    expect(trial.evidence.process).toMatchObject({ exitCode: 0, level: 'observed', timedOut: false });
    expect(trial.evidence.skillActivation.level).toBe('inferred');
    expect(trial.evidence.mcp.level).toBe('observed');
    // The host exposes no authoritative activation event, so the assertion resolves at the
    // inferred level whatever the model chose to say.
    expect(trial.assertions.find((assertion) => assertion.kind === 'skill-activation')?.evidence).toBe('inferred');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 600_000);
