import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { EvalService, type EvalServiceOptions } from '../src/dev/eval-service.ts';
import type { CodexCommandInput, CodexCommandResult } from '../src/eval/codex-harness.ts';
import type {
  NativeClaudeProcessRequest,
  NativeClaudeProcessResult,
} from '../src/host-contracts/native-claude-contract.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';
import { seedEvalProject, writeEvalSuite } from './support/eval-project.ts';

const claudeModel = 'claude-sonnet-4-5';
const codexModel = 'gpt-5-codex';
const pluginName = 'review';

const claudeStream = [
  JSON.stringify({
    apiKeySource: 'none',
    mcp_servers: [{ name: 'project', status: 'connected' }],
    plugins: [{ name: pluginName, version: '1.0.0' }],
    subtype: 'init',
    type: 'system',
  }),
  JSON.stringify({
    message: {
      content: [{ input: { skill: `${pluginName}:review` }, name: 'Skill', type: 'tool_use' }],
      usage: { input_tokens: 10, output_tokens: 4 },
    },
    type: 'assistant',
  }),
  JSON.stringify({
    is_error: false,
    num_turns: 2,
    result: 'The highest-risk regression is the unguarded cache eviction.',
    subtype: 'success',
    type: 'result',
  }),
  '',
].join('\n');

const codexPluginList = JSON.stringify({
  available: [],
  installed: [{
    enabled: true,
    installed: true,
    marketplaceName: `${pluginName}-marketplace`,
    name: pluginName,
    pluginId: `${pluginName}@${pluginName}-marketplace`,
    version: 'local',
  }],
});

const codexEvents = [
  JSON.stringify({ type: 'thread.started' }),
  JSON.stringify({ item: { id: '0', text: 'Reviewed.', type: 'agent_message' }, type: 'item.completed' }),
  JSON.stringify({ type: 'turn.completed' }),
  '',
].join('\n');

interface ClaudeWorld {
  readonly requests: NativeClaudeProcessRequest[];
}

interface CodexWorld {
  readonly commands: CodexCommandInput[];
  readonly home: string;
}

const claudeRunner = (world: ClaudeWorld) => async (
  request: NativeClaudeProcessRequest,
): Promise<NativeClaudeProcessResult> => {
  world.requests.push(request);
  if (request.args[0] === '--version') {
    return { exitCode: 0, stderr: '', stdout: '2.1.240 (Claude Code)\n' };
  }
  if (request.args[0] === 'auth') {
    return {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({ authMethod: 'claude.ai', loggedIn: true, subscriptionType: 'max' }),
    };
  }
  return { exitCode: 0, stderr: '', stdout: claudeStream };
};

const codexRunner = (world: CodexWorld) => async (
  command: CodexCommandInput,
): Promise<CodexCommandResult> => {
  world.commands.push(command);
  const step = command.args[0] === 'plugin' ? `plugin.${command.args[1]}` : command.args[0] ?? '';
  if (step === 'plugin.list') return { exitCode: 0, stderr: '', stdout: codexPluginList };
  if (step === 'exec') return { exitCode: 0, stderr: '', stdout: codexEvents };
  if (step === '--version') return { exitCode: 0, stderr: '', stdout: 'codex-cli 0.147.0\n' };
  return { exitCode: 0, stderr: '', stdout: '' };
};

/** A signed-in Codex home the harness may read from but must never modify. */
const seedNormalCodexHome = async (root: string): Promise<string> => {
  const home = join(root, 'normal-codex-home');
  await mkdir(join(home, 'plugins'), { recursive: true });
  await writeFile(join(home, 'auth.json'), '{"opaque":"session"}\n');
  await chmod(join(home, 'auth.json'), 0o600);
  await writeFile(join(home, 'config.toml'), 'model = "gpt-5-codex"\n');
  return home;
};

const nativeService = (root: string, native: EvalServiceOptions['native']): EvalService => new EvalService({
  native,
  projectRoot: root,
  targets: ['claude', 'codex', 'portable'],
});

const seedNativeProject = async (root: string): Promise<void> => {
  await seedEvalProject(root, { marketplace: true, targets: ['claude', 'codex', 'portable'] });
  await writeEvalSuite(root, 'native.eval.ts', {
    cases: [{
      hosts: { claude: { model: claudeModel }, codex: { model: codexModel } },
      id: 'native-review',
      kind: 'pass',
    }],
    name: 'native-suite',
  });
};

it('runs a native Claude trial through the service with the pinned model and no --bare', async () => {
  const project = await createProjectFixture();
  try {
    await seedNativeProject(project.root);
    const world: ClaudeWorld = { requests: [] };

    const result = await nativeService(project.root, {
      claudeRun: claudeRunner(world),
      environment: { PATH: process.env.PATH ?? '/usr/bin' },
    }).run({ harness: 'claude', suites: ['native-suite'] });

    expect(result.run.harness).toBe('claude');
    expect(result.trials).toHaveLength(1);
    const trial = result.trials[0]!;
    expect(trial.host).toBe('claude');
    expect(trial.model).toBe(claudeModel);
    expect(trial.id).toBe('native-review--claude-1');
    expect(trial.harnessFailure).toBeUndefined();
    expect(trial.outcome).toBe('pass');

    expect(world.requests.map((request) => request.args[0])).toEqual(['--version', 'auth', '-p']);
    const execution = world.requests[2]!;
    expect(execution.executable).toBe('claude');
    expect(execution.args).not.toContain('--bare');
    const pluginDirectory = join(
      project.root,
      '.agent-bundle',
      'runs',
      result.run.id,
      'artifacts',
      'target',
      'claude',
    );
    expect(execution.args.slice(0, 3)).toEqual(['-p', '--plugin-dir', pluginDirectory]);
    expect(execution.args).toContain('--model');
    expect(execution.args[execution.args.indexOf('--model') + 1]).toBe(claudeModel);
    expect(trial.rawArtifacts).toContain('artifacts/native-review--claude-1/stream.jsonl');
  } finally {
    await removeProjectFixture(project.root);
  }
}, 240_000);

it('runs a native Codex trial in a temporary CODEX_HOME with --ephemeral and the pinned model', async () => {
  const project = await createProjectFixture();
  try {
    await seedNativeProject(project.root);
    const home = await seedNormalCodexHome(project.root);
    const before = await readFile(join(home, 'auth.json'), 'utf8');
    const world: CodexWorld = { commands: [], home };

    const result = await nativeService(project.root, {
      codexRun: codexRunner(world),
      environment: { CODEX_HOME: home, PATH: process.env.PATH ?? '/usr/bin' },
    }).run({ harness: 'codex', suites: ['native-suite'] });

    expect(result.run.harness).toBe('codex');
    expect(result.trials).toHaveLength(1);
    const trial = result.trials[0]!;
    expect(trial.host).toBe('codex');
    expect(trial.model).toBe(codexModel);
    expect(trial.harnessFailure).toBeUndefined();

    const execution = world.commands.find((command) => command.args[0] === 'exec')!;
    expect(execution.args).toContain('--ephemeral');
    expect(execution.args).toContain('--json');
    expect(execution.args).toContain('-m');
    expect(execution.args[execution.args.indexOf('-m') + 1]).toBe(codexModel);
    for (const command of world.commands) {
      expect(command.environment.CODEX_HOME).toBeDefined();
      expect(command.environment.CODEX_HOME).not.toBe(home);
      expect(command.environment.OPENAI_API_KEY).toBeUndefined();
    }
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(before);
    expect(trial.rawArtifacts).toContain('artifacts/native-review--codex-1/events.jsonl');
  } finally {
    await removeProjectFixture(project.root);
  }
}, 240_000);

it('plans only the hosts a selected native harness can drive', async () => {
  const project = await createProjectFixture();
  try {
    await seedNativeProject(project.root);
    const world: ClaudeWorld = { requests: [] };

    const result = await nativeService(project.root, {
      claudeRun: claudeRunner(world),
      environment: { PATH: process.env.PATH ?? '/usr/bin' },
    }).run({ harness: 'claude' });

    expect(result.trials.every((trial) => trial.host === 'claude')).toBe(true);
    expect(result.trials.length).toBeGreaterThan(0);
  } finally {
    await removeProjectFixture(project.root);
  }
}, 240_000);

it('refuses a native harness selection that no authored case pins', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root, { targets: ['claude', 'portable'] });

    await expect(nativeService(project.root, {}).run({ harness: 'claude' })).rejects.toMatchObject({
      code: 'EVAL_SELECTION_EMPTY',
    });
  } finally {
    await removeProjectFixture(project.root);
  }
}, 240_000);

it('refuses an unknown harness rather than silently running a deterministic stub', async () => {
  const project = await createProjectFixture();
  try {
    await seedNativeProject(project.root);

    await expect(nativeService(project.root, {}).run({ harness: 'gemini' })).rejects.toMatchObject({
      code: 'EVAL_HARNESS_UNSUPPORTED',
    });
  } finally {
    await removeProjectFixture(project.root);
  }
}, 240_000);

it('records cancellation evidence for a cancelled native run', async () => {
  const project = await createProjectFixture();
  try {
    await seedNativeProject(project.root);
    const controller = new AbortController();
    controller.abort();

    const result = await nativeService(project.root, {
      claudeRun: claudeRunner({ requests: [] }),
      environment: { PATH: process.env.PATH ?? '/usr/bin' },
    }).run({ harness: 'claude', signal: controller.signal, suites: ['native-suite'], trials: 3 });

    expect(result.trials).toEqual([]);
    expect(result.run.harness).toBe('claude');
    const events = await readFile(
      join(project.root, '.agent-bundle', 'runs', result.run.id, 'events.jsonl'),
      'utf8',
    );
    expect(events).toContain('"run.cancelled"');
    expect(events).toContain('"harness":"claude"');
  } finally {
    await removeProjectFixture(project.root);
  }
}, 240_000);

it('forwards an active AbortSignal into native Codex commands', async () => {
  const project = await createProjectFixture();
  try {
    await seedNativeProject(project.root);
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];

    const result = await nativeService(project.root, {
      codexRun: async (command) => {
        seen.push(command.signal);
        controller.abort();
        return { exitCode: 0, stderr: '', stdout: 'codex-cli 0.147.0\n' };
      },
      environment: { CODEX_HOME: await seedNormalCodexHome(project.root), PATH: process.env.PATH ?? '/usr/bin' },
    }).run({ harness: 'codex', signal: controller.signal, suites: ['native-suite'] });

    expect(seen).toEqual([controller.signal]);
    expect(result.trials).toHaveLength(1);
    expect(result.trials[0]?.harnessFailure).toMatchObject({ code: 'EVAL_TRACE_UNAVAILABLE', stage: 'trace' });
  } finally {
    await removeProjectFixture(project.root);
  }
}, 240_000);
