import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from '@rstest/core';

const loadNativeClaudeContract = async () => import('../src/host-contracts/native-claude-contract.ts').catch(() => undefined);
const nativeIt = process.env.AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE === '1' ? it : it.skip;

it('builds a subscription-authenticated Claude command with the explicit candidate plugin', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  expect(harness!.createNativeClaudeCommand({
    pluginDirectory: '/candidate/plugin',
    prompt: 'Use the agent-bundle-native-smoke Skill and reply exactly: CLAUDE_NATIVE_SMOKE_OK.',
  })).toEqual({
    args: [
      '-p',
      '--plugin-dir',
      '/candidate/plugin',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-hook-events',
      '--no-session-persistence',
      'Use the agent-bundle-native-smoke Skill and reply exactly: CLAUDE_NATIVE_SMOKE_OK.',
    ],
    executable: 'claude',
  });
});

it('removes provider API keys while preserving ordinary Claude session environment', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  expect(harness!.createNativeClaudeChildEnvironment({
    AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE: '1',
    ANTHROPIC_API_KEY: 'must-not-reach-child',
    CLAUDE_CONFIG_DIR: '/existing/claude-config',
    OPENAI_API_KEY: 'must-not-reach-child',
    PATH: '/usr/bin',
    THIRD_PARTY_API_KEY: 'must-not-reach-child',
  })).toEqual({
    AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE: '1',
    CLAUDE_CONFIG_DIR: '/existing/claude-config',
    PATH: '/usr/bin',
  });
});

it('normalizes Claude stream output without retaining task, session, or tool-input values', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const stream = [
    '{"type":"system","subtype":"init","session_id":"private-session","plugins":[{"name":"agent-bundle-native-smoke"}],"mcp_servers":[{"name":"candidate-status"}]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"agent-bundle-native-smoke"}},{"type":"tool_use","name":"mcp__candidate-status","input":{"private":"input"}}]}}',
    '{"type":"hook_event","hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/private/workspace"}',
    '{"type":"error","message":"private error detail"}',
    '{"type":"result","subtype":"success","duration_ms":1,"usage":{"input_tokens":1}}',
  ].join('\n');

  expect(harness!.normalizeNativeClaudeStream(stream)).toEqual({
    activationEvidence: 'observed',
    envelopes: [
      { fields: ['mcp_servers', 'plugins', 'session_id', 'subtype', 'type'], subtype: 'init', type: 'system' },
      { fields: ['message', 'type'], type: 'assistant' },
      { fields: ['cwd', 'hook_event_name', 'tool_name', 'type'], type: 'hook_event' },
      { fields: ['message', 'type'], type: 'error' },
      { fields: ['duration_ms', 'subtype', 'type', 'usage'], subtype: 'success', type: 'result' },
    ],
    errorEnvelopes: [{ fields: ['message', 'type'], type: 'error' }],
    hookEnvelopes: [{ fields: ['cwd', 'hook_event_name', 'tool_name', 'type'], type: 'hook_event' }],
    mcp: { configuredServers: 1, toolCalls: 1 },
    plugins: ['agent-bundle-native-smoke'],
  });
});

it('runs strict validation before the subscription-backed stream command and retains redacted evidence only', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const calls: unknown[] = [];
  const report = await harness!.runNativeClaudeSmoke({
    cwd: '/fresh/fixture',
    enabled: true,
    environment: { ANTHROPIC_API_KEY: 'must-not-reach-child', PATH: '/usr/bin' },
    pluginDirectory: '/candidate/plugin',
    prompt: 'Use the agent-bundle-native-smoke Skill and reply exactly: CLAUDE_NATIVE_SMOKE_OK.',
    run: async (request: unknown) => {
      calls.push(request);
      return calls.length === 1
        ? { exitCode: 0, stderr: '', stdout: '2.1.232 (Claude Code)\n' }
        : calls.length === 2
          ? { exitCode: 0, stderr: '', stdout: 'Plugin is valid.\n' }
        : {
          exitCode: 0,
          stderr: 'private stderr detail\n',
          stdout: [
            '{"type":"system","subtype":"init","plugins":[{"name":"agent-bundle-native-smoke"}],"mcp_servers":[]}',
            '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"agent-bundle-native-smoke"}}]}}',
            '{"type":"result","subtype":"success","duration_ms":1}',
          ].join('\n'),
        };
    },
  });

  expect(report).toEqual({
    diagnostics: [],
    evidence: {
      command: {
        args: [
          '-p',
          '--plugin-dir',
          '<plugin-root>',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-hook-events',
          '--no-session-persistence',
          '<task-input>',
        ],
        executable: 'claude',
      },
      stderr: { lineCount: 1, present: true },
      stream: {
        activationEvidence: 'observed',
        envelopes: [
          { fields: ['mcp_servers', 'plugins', 'subtype', 'type'], subtype: 'init', type: 'system' },
          { fields: ['message', 'type'], type: 'assistant' },
          { fields: ['duration_ms', 'subtype', 'type'], subtype: 'success', type: 'result' },
        ],
        errorEnvelopes: [],
        hookEnvelopes: [],
        mcp: { configuredServers: 0, toolCalls: 0 },
        plugins: ['agent-bundle-native-smoke'],
      },
      validation: { exitCode: 0 },
      version: '2.1.232',
    },
    status: 'passed',
  });
  expect(calls).toEqual([
    {
      args: ['--version'],
      cwd: '/fresh/fixture',
      environment: { PATH: '/usr/bin' },
      executable: 'claude',
    },
    {
      args: ['plugin', 'validate', '--strict', '/candidate/plugin'],
      cwd: '/fresh/fixture',
      environment: { PATH: '/usr/bin' },
      executable: 'claude',
    },
    {
      args: [
        '-p',
        '--plugin-dir',
        '/candidate/plugin',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-hook-events',
        '--no-session-persistence',
        'Use the agent-bundle-native-smoke Skill and reply exactly: CLAUDE_NATIVE_SMOKE_OK.',
      ],
      cwd: '/fresh/fixture',
      environment: { PATH: '/usr/bin' },
      executable: 'claude',
    },
  ]);
  expect(JSON.stringify(report)).not.toContain('private');
});

it('reports an incompatible Claude version as a harness failure before candidate validation', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const calls: unknown[] = [];
  const report = await harness!.runNativeClaudeSmoke({
    cwd: '/fresh/fixture',
    enabled: true,
    environment: {},
    pluginDirectory: '/candidate/plugin',
    prompt: 'irrelevant after the preflight failure',
    run: async (request: unknown) => {
      calls.push(request);
      return { exitCode: 0, stderr: '', stdout: '2.1.231 (Claude Code)\n' };
    },
  });

  expect(report).toEqual({
    diagnostics: [{
      code: 'claude-native.version.incompatible',
      message: 'Claude Code 2.1.231 is older than the required 2.1.232 native contract; upgrade the CLI.',
    }],
    status: 'harness-failure',
  });
  expect(calls).toEqual([{
    args: ['--version'],
    cwd: '/fresh/fixture',
    environment: {},
    executable: 'claude',
  }]);
});

it('captures a bounded child process and terminates it when the smoke is cancelled', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const completed = await harness!.runNativeClaudeProcess({
    args: ['-e', 'process.stdout.write("stream"); process.stderr.write("diagnostic");'],
    cwd: process.cwd(),
    environment: process.env,
    executable: process.execPath,
  });
  expect(completed).toEqual({ exitCode: 0, signal: null, stderr: 'diagnostic', stdout: 'stream' });

  const controller = new AbortController();
  const cancelled = harness!.runNativeClaudeProcess({
    args: ['-e', 'setInterval(() => undefined, 1000);'],
    cwd: process.cwd(),
    environment: process.env,
    executable: process.execPath,
  }, controller.signal);
  controller.abort();

  await expect(cancelled).resolves.toMatchObject({ exitCode: null, signal: 'SIGTERM' });
});

it('reports a signed-out Claude execution as a redacted harness failure', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const report = await harness!.runNativeClaudeSmoke({
    cwd: '/fresh/fixture',
    enabled: true,
    environment: {},
    pluginDirectory: '/candidate/plugin',
    prompt: 'irrelevant after authentication fails',
    run: async (request: { readonly args: readonly string[] }) => request.args[0] === '--version'
      ? { exitCode: 0, stderr: '', stdout: '2.1.232 (Claude Code)\n' }
      : request.args[0] === 'plugin'
        ? { exitCode: 0, stderr: '', stdout: 'Plugin is valid.\n' }
        : {
          exitCode: 1,
          stderr: 'Not logged in with the private account.',
          stdout: '{"type":"result","subtype":"error"}\n',
        },
  });

  expect(report).toMatchObject({
    diagnostics: [{
      code: 'claude-native.authentication.unavailable',
      message: 'Claude is not authenticated with a usable subscription/session; sign in with Claude Code and retry.',
    }],
    status: 'harness-failure',
  });
  expect(JSON.stringify(report)).not.toContain('private');
});

it('matches the checked-in redacted Claude candidate stream and capability evidence', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const fixtureRoot = new URL('../../../fixtures/contracts/hosts/claude/', import.meta.url);
  const [expected, stream, pluginManifest, skill] = await Promise.all([
    readFile(new URL('native-smoke.evidence.json', fixtureRoot), 'utf8').then((value) => JSON.parse(value) as unknown),
    readFile(new URL('native-smoke.stream.jsonl', fixtureRoot), 'utf8'),
    readFile(new URL('candidate/.claude-plugin/plugin.json', fixtureRoot), 'utf8'),
    readFile(new URL('candidate/skills/agent-bundle-native-smoke/SKILL.md', fixtureRoot), 'utf8'),
  ]);

  expect(harness!.normalizeNativeClaudeStream(stream)).toEqual(expected);
  for (const fixture of [stream, pluginManifest, skill, JSON.stringify(expected)]) {
    expect(fixture).not.toMatch(/(?:API_KEY|authorization\s*[:=]|\/(?:home|Users)\/)/iu);
  }
});

it('retains only declared candidate plugin names when normalizing a live Claude trace', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const stream = '{"type":"system","plugins":[{"name":"agent-bundle-native-smoke"},{"name":"ordinary-user-plugin"}]}\n';
  expect(harness!.normalizeNativeClaudeStream(stream, {
    allowedPluginNames: ['agent-bundle-native-smoke'],
  }).plugins).toEqual(['agent-bundle-native-smoke']);
});

it('captures Claude hook lifecycle envelopes emitted by --include-hook-events', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const stream = '{"type":"system","subtype":"hook_started","hook_event":"PreToolUse","hook_id":"<redacted>"}\n';
  expect(harness!.normalizeNativeClaudeStream(stream).hookEnvelopes).toEqual([
    { fields: ['hook_event', 'hook_id', 'subtype', 'type'], subtype: 'hook_started', type: 'system' },
  ]);
});

nativeIt('runs the checked-in candidate with the existing signed-in Claude subscription and writes redacted evidence', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const fixture = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-native-smoke-'));
  const pluginDirectory = fileURLToPath(new URL('../../../fixtures/contracts/hosts/claude/candidate/', import.meta.url));
  const evidenceDirectory = fileURLToPath(new URL('../../../.agent-bundle/', import.meta.url));
  try {
    await writeFile(join(fixture, 'README.md'), 'Claude native smoke fixture.\n');
    const report = await harness!.runNativeClaudeSmoke({
      candidatePluginNames: ['agent-bundle-native-smoke'],
      cwd: fixture,
      enabled: harness!.nativeClaudeSmokeEnabled(),
      pluginDirectory,
      prompt: 'Use the agent-bundle-native-smoke Skill now. Reply exactly: CLAUDE_NATIVE_SMOKE_OK. Do not access tools or files.',
    });
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, 'w2-claude-native-smoke.json'), `${JSON.stringify({ schemaVersion: 1, report }, null, 2)}\n`);

    expect(report.status).toBe('passed');
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
}, 120_000);
