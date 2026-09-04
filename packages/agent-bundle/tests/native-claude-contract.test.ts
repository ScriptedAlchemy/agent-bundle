import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@rstest/core';

const loadNativeClaudeContract = async () => import('../src/host-contracts/native-claude-contract.ts').catch(() => undefined);
const nativeIt = process.env.AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE === '1' ? it : it.skip;
const candidatePluginName = 'agent-bundle-native-smoke';
const candidateSkillName = 'agent-bundle-native-smoke';
const candidateSkillEventName = `${candidatePluginName}:${candidateSkillName}`;

/**
 * Every enabled `runNativeClaudeSmoke` digests the normal Claude home before
 * and after the run. Without an injected `homeDirectory` (or
 * `CLAUDE_CONFIG_DIR`) that is the developer's real `~/.claude`, which on a
 * machine with the Claude CLI installed holds gigabytes of plugin caches and
 * pushes a stubbed smoke past its 5 s budget. Each test gets an empty home.
 */
const withIsolatedHome = async <T>(run: (homeDirectory: string) => Promise<T>): Promise<T> => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-contract-home-'));
  try {
    return await run(homeDirectory);
  } finally {
    await rm(homeDirectory, { force: true, recursive: true });
  }
};

it('builds a subscription-authenticated Claude command with the explicit candidate plugin', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  expect(harness!.createNativeClaudeCommand({
    model: 'claude-sonnet-4-5',
    pluginDirectory: '/candidate/plugin',
    prompt: 'Use the agent-bundle-native-smoke Skill and reply exactly: CLAUDE_NATIVE_SMOKE_OK.',
  })).toEqual({
    args: [
      '-p',
      '--plugin-dir',
      '/candidate/plugin',
      '--model',
      'claude-sonnet-4-5',
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

it('removes API credentials and alternate-provider routing while preserving ordinary Claude session environment', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  expect(harness!.createNativeClaudeChildEnvironment({
    AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE: '1',
    ANTHROPIC_API_KEY: 'must-not-reach-child',
    ANTHROPIC_AUTH_TOKEN: 'must-not-reach-child',
    ANTHROPIC_BASE_URL: 'https://must-not-reach-child.invalid',
    CLAUDE_CONFIG_DIR: '/existing/claude-config',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
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
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"agent-bundle-native-smoke:agent-bundle-native-smoke"}},{"type":"tool_use","name":"mcp__candidate-status","input":{"private":"input"}}]}}',
    '{"type":"hook_event","hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/private/workspace"}',
    '{"type":"error","message":"private error detail"}',
    '{"type":"result","subtype":"success","duration_ms":1,"usage":{"input_tokens":1}}',
  ].join('\n');

  expect(harness!.normalizeNativeClaudeStream(stream, {
    candidateSkillEventName,
  })).toEqual({
    activationEvidence: 'observed',
    authSource: 'unavailable',
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
  const report = await withIsolatedHome((homeDirectory) => harness!.runNativeClaudeSmoke({
    candidatePluginName: 'agent-bundle-native-smoke',
    candidateSkillName: 'agent-bundle-native-smoke',
    cwd: '/fresh/fixture',
    enabled: true,
    environment: { ANTHROPIC_API_KEY: 'must-not-reach-child', PATH: '/usr/bin' },
    homeDirectory,
    pluginDirectory: '/candidate/plugin',
    prompt: 'Use the agent-bundle-native-smoke Skill and reply exactly: CLAUDE_NATIVE_SMOKE_OK.',
    run: async (request: unknown) => {
      calls.push(request);
      return calls.length === 1
        ? { exitCode: 0, stderr: '', stdout: '2.1.232 (Claude Code)\n' }
        : calls.length === 2
          ? { exitCode: 0, stderr: '', stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}\n' }
          : calls.length === 3
            ? { exitCode: 0, stderr: '', stdout: 'Plugin is valid.\n' }
            : {
          exitCode: 0,
          stderr: 'private stderr detail\n',
          stdout: [
            '{"type":"system","subtype":"init","apiKeySource":"none","plugins":[{"name":"agent-bundle-native-smoke"}],"mcp_servers":[]}',
            '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"agent-bundle-native-smoke:agent-bundle-native-smoke"}}]}}',
            '{"type":"result","subtype":"success","duration_ms":1}',
          ].join('\n'),
        };
    },
  }));

  expect(report).toEqual({
    diagnostics: [],
    evidence: {
      authentication: { status: 'subscription-session' },
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
        authSource: 'non-environment',
        envelopes: [
          { fields: ['apiKeySource', 'mcp_servers', 'plugins', 'subtype', 'type'], subtype: 'init', type: 'system' },
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
    normalHome: 'unchanged',
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
      args: ['auth', 'status', '--json'],
      cwd: '/fresh/fixture',
      environment: { PATH: '/usr/bin' },
      executable: 'claude',
    },
    {
      args: ['plugin', 'validate', '--strict', '/candidate/plugin/.claude-plugin/plugin.json'],
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

it('proves the normal Claude config, settings, and plugins stay unchanged without retaining local state', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-normal-home-contract-'));
  const initializeHome = async (home: string): Promise<void> => {
    await mkdir(join(home, 'plugins'), { recursive: true });
    await Promise.all([
      writeFile(join(home, 'config.json'), '{"marker":"normal-config-marker"}\n'),
      writeFile(join(home, 'settings.json'), '{"marker":"normal-settings-marker"}\n'),
      writeFile(join(home, 'settings.local.json'), '{"marker":"normal-local-settings-marker"}\n'),
      writeFile(join(home, 'plugins', 'installed.json'), '{"marker":"normal-plugin-marker"}\n'),
      writeFile(join(home, 'session.json'), '{"marker":"normal-session-marker"}\n'),
    ]);
  };
  const runSmoke = async (home: string, mutate: boolean, failExecution = false) => harness!.runNativeClaudeSmoke({
    candidatePluginName,
    candidateSkillName,
    cwd: root,
    enabled: true,
    environment: {
      AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE: '1',
      ANTHROPIC_API_KEY: 'must-not-reach-child',
      CLAUDE_CONFIG_DIR: home,
      PATH: '/usr/bin',
    },
    pluginDirectory: '/candidate/plugin',
    prompt: 'Use the candidate Skill and reply with the sentinel.',
    run: async (request: { readonly args: readonly string[] }) => {
      if (request.args[0] === '--version') return { exitCode: 0, stderr: '', stdout: '2.1.232 (Claude Code)\n' };
      if (request.args[0] === 'auth') {
        return { exitCode: 0, stderr: '', stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}\n' };
      }
      if (request.args[0] === 'plugin') return { exitCode: 0, stderr: '', stdout: 'Plugin is valid.\n' };
      if (mutate) {
        const pluginPath = join(home, 'plugins', 'installed.json');
        await writeFile(pluginPath, '{"marker":"normal-plugin-change"}\n');
        const fixedTime = new Date('2026-08-14T12:00:00.000Z');
        await utimes(pluginPath, fixedTime, fixedTime);
      }
      return {
        exitCode: failExecution ? 1 : 0,
        stderr: '',
        stdout: [
          '{"type":"system","subtype":"init","apiKeySource":"none","plugins":[{"name":"agent-bundle-native-smoke"}]}',
          '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"agent-bundle-native-smoke:agent-bundle-native-smoke"}}]}}',
          '{"type":"result","subtype":"success"}',
        ].join('\n'),
      };
    },
  });

  try {
    const unchangedHome = join(root, 'normal-unchanged');
    await initializeHome(unchangedHome);
    const unchanged = await runSmoke(unchangedHome, false);
    expect(unchanged).toMatchObject({ normalHome: 'unchanged', status: 'passed' });
    expect(JSON.stringify(unchanged)).not.toContain(root);
    expect(JSON.stringify(unchanged)).not.toMatch(/normal-(?:config|settings|local-settings|plugin|session)(?:-changed)?-marker/iu);

    const changedHome = join(root, 'normal-changed');
    await initializeHome(changedHome);
    await utimes(
      join(changedHome, 'plugins', 'installed.json'),
      new Date('2026-08-14T12:00:00.000Z'),
      new Date('2026-08-14T12:00:00.000Z'),
    );
    const changed = await runSmoke(changedHome, true);
    expect(changed.status).toBe('harness-failure');
    expect(changed.diagnostics.map((diagnostic) => diagnostic.code)).toContain('claude-native.normal-home.changed');
    expect((changed as unknown as { readonly normalHome?: unknown }).normalHome).not.toBe('unchanged');
    expect(JSON.stringify(changed)).not.toContain(root);
    expect(JSON.stringify(changed)).not.toMatch(/normal-(?:config|settings|local-settings|plugin|session)(?:-changed)?-marker/iu);

    const changedFailureHome = join(root, 'normal-changed-failure');
    await initializeHome(changedFailureHome);
    await utimes(
      join(changedFailureHome, 'plugins', 'installed.json'),
      new Date('2026-08-14T12:00:00.000Z'),
      new Date('2026-08-14T12:00:00.000Z'),
    );
    const changedFailure = await runSmoke(changedFailureHome, true, true);
    expect(changedFailure.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'claude-native.execution.failed',
      'claude-native.normal-home.changed',
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

/**
 * The sibling `.claude.json` is host bookkeeping Claude Code rewrites on every
 * signed-in turn (#439); the guard digests only its user-scope `mcpServers`
 * registrations, never its opaque contents.
 */
describe('the default sibling Claude state file', () => {
  const successfulStream = [
    '{"type":"system","subtype":"init","apiKeySource":"none","plugins":[{"name":"agent-bundle-native-smoke"}]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"agent-bundle-native-smoke:agent-bundle-native-smoke"}}]}}',
    '{"type":"result","subtype":"success"}',
  ].join('\n');

  /** Runs the smoke against `defaultHome`, letting the fake Claude rewrite `.claude.json` as `rewrite` describes. */
  const smokeWithStateRewrite = async (
    defaultHome: string,
    rewrite: (stateFile: string) => Promise<void>,
  ) => {
    const harness = await loadNativeClaudeContract();
    expect(harness).toBeDefined();
    return harness!.runNativeClaudeSmoke({
      candidatePluginName,
      candidateSkillName,
      cwd: defaultHome,
      enabled: true,
      environment: { AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE: '1', PATH: '/usr/bin' },
      homeDirectory: defaultHome,
      pluginDirectory: '/candidate/plugin',
      prompt: 'Use the candidate Skill and reply with the sentinel.',
      run: async (request: { readonly args: readonly string[] }) => {
        if (request.args[0] === '--version') return { exitCode: 0, stderr: '', stdout: '2.1.232 (Claude Code)\n' };
        if (request.args[0] === 'auth') {
          return { exitCode: 0, stderr: '', stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}\n' };
        }
        if (request.args[0] === 'plugin') return { exitCode: 0, stderr: '', stdout: 'Plugin is valid.\n' };
        await rewrite(join(defaultHome, '.claude.json'));
        return { exitCode: 0, stderr: '', stdout: successfulStream };
      },
    });
  };

  const withDefaultHome = async (
    initialState: string | undefined,
    operation: (defaultHome: string) => Promise<void>,
  ): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-default-home-contract-'));
    const defaultHome = join(root, 'home');
    try {
      await mkdir(join(defaultHome, '.claude'), { recursive: true });
      if (initialState !== undefined) await writeFile(join(defaultHome, '.claude.json'), initialState);
      await operation(defaultHome);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  };

  it('tolerates the bookkeeping rewrite of a signed-in turn and a first start creating the file', async () => {
    // Keys observed moving on Claude Code 2.1.257–2.1.260 between turns, with
    // the user-scope registrations left alone.
    const before = {
      cachedGrowthBookFeatures: { flag: 'normal-sibling-marker' },
      firstStartTime: '2026-09-01T00:00:00.000Z',
      machineID: 'normal-sibling-machine-marker',
      mcpServers: { registered: { command: 'normal-sibling-mcp-marker' } },
      numStartups: 41,
      projects: { '/elsewhere': { allowedTools: [], lastSessionId: 'old' } },
      seenNotifications: ['a'],
    };
    await withDefaultHome(`${JSON.stringify(before)}\n`, async (defaultHome) => {
      const result = await smokeWithStateRewrite(defaultHome, (stateFile) => writeFile(stateFile, JSON.stringify({
        ...before,
        cachedExperimentData: { experiment: 'normal-sibling-changed-marker' },
        cachedGrowthBookFeatures: { flag: 'normal-sibling-changed-marker' },
        numStartups: 42,
        pluginUsage: { 'agent-bundle-native-smoke': 1 },
        projects: { ...before.projects, [defaultHome]: { allowedTools: [], lastSessionId: 'new', mcpServers: {} } },
        seenNotifications: ['a', 'b'],
        skillUsage: { 'agent-bundle-native-smoke:agent-bundle-native-smoke': 1 },
      })));
      expect(result).toMatchObject({ normalHome: 'unchanged', status: 'passed' });
      expect(JSON.stringify(result)).not.toContain(defaultHome);
      expect(JSON.stringify(result)).not.toMatch(/normal-sibling-[a-z-]*marker/iu);
    });

    // A fresh home: the first start writes the file (observed on 2.1.260 even
    // signed out) without registering anything.
    await withDefaultHome(undefined, async (defaultHome) => {
      const result = await smokeWithStateRewrite(defaultHome, (stateFile) => writeFile(
        stateFile,
        '{"firstStartTime":"2026-09-04T05:36:00.000Z","machineID":"normal-sibling-marker","numStartups":1}\n',
      ));
      expect(result).toMatchObject({ normalHome: 'unchanged', status: 'passed' });
    });
  });

  it('still fails when the smoke adds, changes, or removes user-scope MCP registrations', async () => {
    const registered = '{"mcpServers":{"registered":{"command":"normal-sibling-mcp-marker"}},"numStartups":1}\n';
    const cases: readonly (readonly [string | undefined, string])[] = [
      [registered, '{"mcpServers":{"registered":{"command":"normal-sibling-changed-marker"}},"numStartups":2}\n'],
      [registered, '{"mcpServers":{},"numStartups":2}\n'],
      [registered, '{"numStartups":2}\n'],
      ['{"numStartups":1}\n', '{"mcpServers":{"added":{"command":"normal-sibling-changed-marker"}},"numStartups":2}\n'],
      [undefined, '{"mcpServers":{"added":{"command":"normal-sibling-changed-marker"}}}\n'],
      // Corrupting the state file is a change too.
      [registered, 'not json\n'],
    ];
    for (const [initial, rewritten] of cases) {
      await withDefaultHome(initial, async (defaultHome) => {
        const result = await smokeWithStateRewrite(defaultHome, (stateFile) => writeFile(stateFile, rewritten));
        expect(result.status).toBe('harness-failure');
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['claude-native.normal-home.changed']);
        expect((result as unknown as { readonly normalHome?: unknown }).normalHome).not.toBe('unchanged');
        expect(JSON.stringify(result)).not.toContain(defaultHome);
        expect(JSON.stringify(result)).not.toMatch(/normal-sibling-[a-z-]*marker/iu);
      });
    }
  });
});

it('reports an incompatible Claude version as a harness failure before candidate validation', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const calls: unknown[] = [];
  const report = await withIsolatedHome((homeDirectory) => harness!.runNativeClaudeSmoke({
    candidatePluginName: 'agent-bundle-native-smoke',
    candidateSkillName: 'agent-bundle-native-smoke',
    cwd: '/fresh/fixture',
    enabled: true,
    environment: {},
    homeDirectory,
    pluginDirectory: '/candidate/plugin',
    prompt: 'irrelevant after the preflight failure',
    run: async (request: unknown) => {
      calls.push(request);
      return { exitCode: 0, stderr: '', stdout: '2.1.231 (Claude Code)\n' };
    },
  }));

  expect(report).toEqual({
    diagnostics: [{
      code: 'claude-native.version.incompatible',
      message: 'Claude Code 2.1.231 is older than the required 2.1.232 native contract; upgrade the CLI.',
    }],
    normalHome: 'unchanged',
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

it('enforces a process timeout and output cap even when the child ignores termination', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const timedOut = await harness!.runNativeClaudeProcess({
    args: ['-e', 'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000);'],
    cwd: process.cwd(),
    environment: process.env,
    executable: process.execPath,
  }, { gracePeriodMs: 100, maxOutputBytes: 64, timeoutMs: 300 });
  expect(timedOut).toMatchObject({ exitCode: null, signal: 'SIGKILL', termination: 'timed-out' });

  const oversized = await harness!.runNativeClaudeProcess({
    args: ['-e', 'process.stdout.write("x".repeat(4096)); process.stderr.write("y".repeat(4096)); setInterval(() => undefined, 1000);'],
    cwd: process.cwd(),
    environment: process.env,
    executable: process.execPath,
  }, { gracePeriodMs: 100, maxOutputBytes: 64, timeoutMs: 1_000 });
  expect(oversized).toMatchObject({ termination: 'output-limit' });
  expect(Buffer.byteLength(oversized.stdout)).toBeLessThanOrEqual(64);
  expect(Buffer.byteLength(oversized.stderr)).toBeLessThanOrEqual(64);
});

it('requires the signed-in subscription preflight, loaded candidate plugin, and exact candidate Skill event', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const calls: unknown[] = [];
  const report = await withIsolatedHome((homeDirectory) => harness!.runNativeClaudeSmoke({
    candidatePluginName: 'agent-bundle-native-smoke',
    candidateSkillName: 'agent-bundle-native-smoke',
    cwd: '/fresh/fixture',
    enabled: true,
    environment: {
      ANTHROPIC_API_KEY: 'must-not-reach-child',
      ANTHROPIC_AUTH_TOKEN: 'must-not-reach-child',
      ANTHROPIC_BASE_URL: 'https://must-not-reach-child.invalid',
      CLAUDE_CODE_USE_BEDROCK: '1',
      PATH: '/usr/bin',
    },
    homeDirectory,
    pluginDirectory: '/candidate/plugin',
    prompt: 'Use the candidate skill.',
    run: async (request: unknown) => {
      calls.push(request);
      return calls.length === 1
        ? { exitCode: 0, stderr: '', stdout: '2.1.232 (Claude Code)\n' }
        : calls.length === 2
          ? { exitCode: 0, stderr: '', stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}\n' }
          : calls.length === 3
            ? { exitCode: 0, stderr: '', stdout: 'Plugin is valid.\n' }
            : {
              exitCode: 0,
              stderr: '',
              stdout: [
                '{"type":"system","subtype":"init","apiKeySource":"none","plugins":[{"name":"agent-bundle-native-smoke"}]}',
                '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"agent-bundle-native-smoke:agent-bundle-native-smoke"}}]}}',
                '{"type":"result","subtype":"success"}',
              ].join('\n'),
            };
    },
  }));

  expect(report).toMatchObject({
    diagnostics: [],
    evidence: {
      authentication: { status: 'subscription-session' },
      stream: {
        activationEvidence: 'observed',
        authSource: 'non-environment',
        plugins: ['agent-bundle-native-smoke'],
      },
    },
    status: 'passed',
  });
  expect(calls).toEqual([
    { args: ['--version'], cwd: '/fresh/fixture', environment: { PATH: '/usr/bin' }, executable: 'claude' },
    { args: ['auth', 'status', '--json'], cwd: '/fresh/fixture', environment: { PATH: '/usr/bin' }, executable: 'claude' },
    { args: ['plugin', 'validate', '--strict', '/candidate/plugin/.claude-plugin/plugin.json'], cwd: '/fresh/fixture', environment: { PATH: '/usr/bin' }, executable: 'claude' },
    expect.objectContaining({ executable: 'claude' }),
  ]);
});

it('does not upgrade an unrelated Skill event or a missing candidate plugin to observed evidence', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const stream = [
    '{"type":"system","plugins":[]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"unrelated-skill"}}]}}',
  ].join('\n');
  expect(harness!.normalizeNativeClaudeStream(stream, {
    allowedPluginNames: ['agent-bundle-native-smoke'],
    candidateSkillEventName,
  })).toMatchObject({ activationEvidence: 'unavailable', plugins: [] });
});

it('fails closed when the candidate plugin, exact Skill event, or subscription auth source is absent', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const smokeWithExecution = async (execution: string) => withIsolatedHome((homeDirectory) => harness!.runNativeClaudeSmoke({
    candidatePluginName: 'agent-bundle-native-smoke',
    candidateSkillName: 'agent-bundle-native-smoke',
    cwd: '/fresh/fixture',
    enabled: true,
    environment: {},
    homeDirectory,
    pluginDirectory: '/candidate/plugin',
    prompt: 'Use the candidate skill.',
    run: async (request: { readonly args: readonly string[] }) => {
      if (request.args[0] === '--version') return { exitCode: 0, stderr: '', stdout: '2.1.232 (Claude Code)\n' };
      if (request.args[0] === 'auth') {
        return { exitCode: 0, stderr: '', stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}\n' };
      }
      if (request.args[0] === 'plugin') return { exitCode: 0, stderr: '', stdout: 'Plugin is valid.\n' };
      return { exitCode: 0, stderr: '', stdout: execution };
    },
  }));

  await expect(smokeWithExecution([
    '{"type":"system","plugins":[]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"agent-bundle-native-smoke:agent-bundle-native-smoke"}}]}}',
    '{"type":"result","subtype":"success"}',
  ].join('\n'))).resolves.toMatchObject({
    diagnostics: [{ code: 'claude-native.plugin.not-loaded' }],
    status: 'harness-failure',
  });
  await expect(smokeWithExecution([
    '{"type":"system","plugins":[{"name":"agent-bundle-native-smoke"}]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"unrelated-skill"}}]}}',
    '{"type":"result","subtype":"success"}',
  ].join('\n'))).resolves.toMatchObject({
    diagnostics: [{ code: 'claude-native.activation.unobserved' }],
    status: 'harness-failure',
  });
  await expect(smokeWithExecution([
    '{"type":"system","apiKeySource":"environment","plugins":[{"name":"agent-bundle-native-smoke"}]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"agent-bundle-native-smoke:agent-bundle-native-smoke"}}]}}',
    '{"type":"result","subtype":"success"}',
  ].join('\n'))).resolves.toMatchObject({
    diagnostics: [{ code: 'claude-native.auth.environment-key' }],
    evidence: { stream: { authSource: 'environment-key' } },
    status: 'harness-failure',
  });
});

it('rejects an API-key or alternate-provider auth status before plugin validation', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const calls: unknown[] = [];
  const report = await withIsolatedHome((homeDirectory) => harness!.runNativeClaudeSmoke({
    candidatePluginName: 'agent-bundle-native-smoke',
    candidateSkillName: 'agent-bundle-native-smoke',
    cwd: '/fresh/fixture',
    enabled: true,
    environment: {},
    homeDirectory,
    pluginDirectory: '/candidate/plugin',
    prompt: 'irrelevant after authentication fails',
    run: async (request: unknown) => {
      calls.push(request);
      return calls.length === 1
        ? { exitCode: 0, stderr: '', stdout: '2.1.232 (Claude Code)\n' }
        : { exitCode: 0, stderr: '', stdout: '{"loggedIn":true,"authMethod":"api-key","subscriptionType":"pro"}\n' };
    },
  }));

  expect(report).toMatchObject({
    diagnostics: [{ code: 'claude-native.auth.unsupported' }],
    status: 'harness-failure',
  });
  expect(calls).toHaveLength(2);
});

it('reports a signed-out Claude execution as a redacted harness failure', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const report = await withIsolatedHome((homeDirectory) => harness!.runNativeClaudeSmoke({
    candidatePluginName: 'agent-bundle-native-smoke',
    candidateSkillName: 'agent-bundle-native-smoke',
    cwd: '/fresh/fixture',
    enabled: true,
    environment: {},
    homeDirectory,
    pluginDirectory: '/candidate/plugin',
    prompt: 'irrelevant after authentication fails',
    run: async (request: { readonly args: readonly string[] }) => request.args[0] === '--version'
      ? { exitCode: 0, stderr: '', stdout: '2.1.232 (Claude Code)\n' }
      : { exitCode: 0, stderr: '', stdout: '{"loggedIn":false}\n' },
  }));

  expect(report).toMatchObject({
    diagnostics: [{
      code: 'claude-native.auth.unsupported',
      message: 'Claude is not signed in with a supported subscription/session; sign in with Claude Code and retry.',
    }],
    status: 'harness-failure',
  });
  expect(JSON.stringify(report)).not.toContain('private');
});

it('matches the checked-in redacted Claude candidate stream and capability evidence', async () => {
  const harness = await loadNativeClaudeContract();
  expect(harness).toBeDefined();

  const fixtureRoot = new URL('../../../fixtures/contracts/hosts/claude/', import.meta.url);
  const [expected, capabilities, stream, pluginManifest, skill] = await Promise.all([
    readFile(new URL('native-smoke.evidence.json', fixtureRoot), 'utf8').then((value) => JSON.parse(value) as unknown),
    readFile(new URL('native-smoke.capabilities.json', fixtureRoot), 'utf8').then((value) => JSON.parse(value) as unknown),
    readFile(new URL('native-smoke.stream.jsonl', fixtureRoot), 'utf8'),
    readFile(new URL('candidate/.claude-plugin/plugin.json', fixtureRoot), 'utf8'),
    readFile(new URL('candidate/skills/agent-bundle-native-smoke/SKILL.md', fixtureRoot), 'utf8'),
  ]);

  expect(expected).toMatchObject({ provenance: 'synthetic-redacted-contract' });
  expect(capabilities).toMatchObject({ fixtureProvenance: 'synthetic-redacted-contract' });
  expect(harness!.normalizeNativeClaudeStream(stream, {
    allowedPluginNames: ['agent-bundle-native-smoke'],
    candidateSkillEventName,
  })).toEqual((expected as { readonly stream: unknown }).stream);
  for (const fixture of [stream, pluginManifest, skill, JSON.stringify(expected), JSON.stringify(capabilities)]) {
    expect(fixture).not.toMatch(/(?:(?:ANTHROPIC|OPENAI|THIRD_PARTY)_API_KEY\s*[:=]|authorization\s*[:=]|\/(?:home|Users)\/)/iu);
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
      candidatePluginName: 'agent-bundle-native-smoke',
      candidateSkillName: 'agent-bundle-native-smoke',
      cwd: fixture,
      enabled: harness!.nativeClaudeSmokeEnabled(),
      pluginDirectory,
      // The Skill invocation is itself a tool call, so only forbid other tools;
      // a blanket "no tools" instruction suppresses the activation event this
      // smoke asserts.
      prompt: 'Invoke the agent-bundle-native-smoke Skill with the Skill tool now, then reply exactly: CLAUDE_NATIVE_SMOKE_OK. Do not use any other tool and do not access files.',
      // Loaded machines routinely exceed the 60s default; stay under the 120s test budget.
      timeoutMs: 100_000,
    });
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, 'w2-claude-native-smoke.json'), `${JSON.stringify({ report }, null, 2)}\n`);

    expect(report.status).toBe('passed');
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
}, 120_000);
