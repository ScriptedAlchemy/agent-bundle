import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

const fixtureRoot = new URL('../../../fixtures/contracts/hosts/codex/', import.meta.url);
const nativeIt = process.env.AGENT_BUNDLE_NATIVE_CODEX_SMOKE === '1' ? it : it.skip;

const loadContractModule = async () => import('../src/host-contracts/native-codex-contract.ts').catch(() => undefined);

it('builds the bounded temporary-home Codex lifecycle without API-key arguments', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const commands = contracts!.createCodexNativeSmokePlan({
    candidateDirectory: '/candidate',
    fixtureDirectory: '/fixture',
  });

  expect(commands).toEqual([
    {
      args: ['plugin', 'marketplace', 'add', '/candidate'],
      id: 'marketplace.add',
    },
    {
      args: ['plugin', 'add', 'agent-bundle-codex-smoke@agent-bundle-codex-smoke-marketplace'],
      id: 'plugin.add',
    },
    { args: ['plugin', 'list', '--json'], id: 'plugin.list' },
    {
      args: [
        'exec',
        '--strict-config',
        '--ephemeral',
        '--json',
        '-s',
        'read-only',
        '-C',
        '/fixture',
        'Reply with exactly: agent-bundle-codex-smoke',
      ],
      id: 'exec',
    },
  ]);
  expect(JSON.stringify(commands)).not.toMatch(/api[_-]?key|authorization/iu);
});

it('removes provider API-key variables while retaining ordinary process controls', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  expect(contracts!.withoutProviderApiKeys({
    AGENT_BUNDLE_NATIVE_CODEX_SMOKE: '1',
    CUSTOM_CONTROL: 'keep',
    GOOGLE_API_KEY: 'remove',
    OPENAI_API_KEY: 'remove',
    PATH: '/usr/bin',
  })).toEqual({
    AGENT_BUNDLE_NATIVE_CODEX_SMOKE: '1',
    CUSTOM_CONTROL: 'keep',
    PATH: '/usr/bin',
  });
});

it('normalizes only the redacted envelopes retained from a Codex JSONL run', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const raw = await readFile(new URL('native-smoke.stream.jsonl', fixtureRoot), 'utf8');
  expect(contracts!.normalizeCodexNativeSmokeEvents(raw)).toEqual([
    { fields: ['thread_id', 'type'], type: 'thread.started' },
    { fields: ['type'], type: 'turn.started' },
    { fields: ['item', 'type'], type: 'item.completed' },
    { fields: ['type', 'usage'], type: 'turn.completed' },
  ]);
});

it('keeps native Codex capability and evidence fixtures secret-free and activation-honest', async () => {
  const [capabilities, evidence] = await Promise.all([
    readFile(new URL('native-smoke.capabilities.json', fixtureRoot), 'utf8'),
    readFile(new URL('native-smoke.evidence.json', fixtureRoot), 'utf8'),
  ]);

  expect(JSON.parse(capabilities)).toMatchObject({
    automaticActivation: 'inferred',
    host: 'codex',
    minimumVersion: '0.147.0',
    pluginAvailability: 'observed',
    temporaryHome: 'CODEX_HOME',
  });
  expect(JSON.parse(evidence)).toMatchObject({
    activation: { automatic: 'inferred', pluginAvailability: 'observed' },
    host: 'codex',
  });
  for (const fixture of [capabilities, evidence]) {
    expect(fixture).not.toMatch(/(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|authorization\s*[:=]|sk-[A-Za-z0-9_-]{20,}|\/home\/|\/Users\/|Reply with exactly)/iu);
  }
});

it('classifies missing, incompatible, and unauthenticated Codex states as harness failures', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  expect(contracts!.classifyCodexNativeSmokeFailure({ code: 'ENOENT', stage: 'version' })).toEqual({
    code: 'native-codex.cli.missing',
    kind: 'harness-failure',
  });
  expect(contracts!.classifyCodexNativeSmokeFailure({ code: 'ENOENT', stage: 'auth' })).toEqual({
    code: 'native-codex.auth.missing',
    kind: 'harness-failure',
  });
  expect(contracts!.classifyCodexNativeSmokeFailure({
    stage: 'version',
    version: 'codex-cli 0.146.9',
  })).toEqual({
    code: 'native-codex.cli.incompatible',
    kind: 'harness-failure',
  });
  expect(contracts!.classifyCodexNativeSmokeFailure({
    output: 'Please run codex login before continuing.',
    stage: 'exec',
  })).toEqual({
    code: 'native-codex.cli.unauthenticated',
    kind: 'harness-failure',
  });
});

it('copies auth bytes opaquely with the source mode preserved', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-codex-auth-contract-'));
  const source = join(root, 'source-auth.json');
  const destination = join(root, 'temporary-home', 'auth.json');
  try {
    await writeFile(source, '{"opaque":"state"}\n');
    await chmod(source, 0o640);

    await contracts!.copyOpaqueCodexAuthState(source, destination);

    expect(await readFile(destination, 'utf8')).toBe('{"opaque":"state"}\n');
    expect((await stat(destination)).mode & 0o777).toBe((await stat(source)).mode & 0o777);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('uses and removes an isolated temporary home while retaining only redacted evidence', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-codex-lifecycle-contract-'));
  const normalCodexHome = join(root, 'normal-codex-home');
  const temporaryDirectoryParent = join(root, 'temporary-homes');
  const temporaryHomes: string[] = [];
  const initializedFixtures: string[] = [];
  try {
    await mkdir(normalCodexHome, { recursive: true });
    await writeFile(join(normalCodexHome, 'auth.json'), '{"opaque":"state"}\n', { mode: 0o600 });
    await writeFile(join(normalCodexHome, 'config.toml'), 'model = "subscription"\n');

    const result = await contracts!.runCodexNativeSmoke({
      candidateDirectory: new URL('candidate/', fixtureRoot).pathname,
      environment: {
        AGENT_BUNDLE_NATIVE_CODEX_SMOKE: '1',
        OPENAI_API_KEY: 'must-not-reach-codex',
        PATH: process.env.PATH,
      },
      fixtureDirectory: new URL('workspace/', fixtureRoot).pathname,
      initializeFixture: async (fixtureDirectory) => { initializedFixtures.push(fixtureDirectory); },
      normalCodexHome,
      run: async (command) => {
        temporaryHomes.push(command.environment.CODEX_HOME!);
        expect(command.environment.OPENAI_API_KEY).toBeUndefined();
        if (command.args[0] === '--version') return { exitCode: 0, stderr: '', stdout: 'codex-cli 0.147.0\n' };
        if (command.args[1] === 'list') {
          return { exitCode: 0, stderr: '', stdout: '[{"name":"agent-bundle-codex-smoke"}]\n' };
        }
        if (command.args[0] === 'exec') {
          return {
            exitCode: 0,
            stderr: 'unretained local stderr',
            stdout: await readFile(new URL('native-smoke.stream.jsonl', fixtureRoot), 'utf8'),
          };
        }
        return { exitCode: 0, stderr: '', stdout: '' };
      },
      temporaryDirectoryParent,
    });

    expect(result).toMatchObject({
      activation: { automatic: 'inferred', pluginAvailability: 'observed' },
      normalHome: { auth: 'unchanged', config: 'unchanged', plugins: 'unchanged' },
      status: 'passed',
    });
    expect(new Set(temporaryHomes)).toEqual(new Set([expect.stringContaining(temporaryDirectoryParent)]));
    expect(initializedFixtures).toEqual([expect.stringContaining(temporaryDirectoryParent)]);
    await expect(stat(temporaryHomes[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(result)).not.toContain('unretained local stderr');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('retains a failed exec JSONL error only as a redacted envelope', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-codex-error-envelope-contract-'));
  const normalCodexHome = join(root, 'normal-codex-home');
  try {
    await mkdir(normalCodexHome, { recursive: true });
    await writeFile(join(normalCodexHome, 'auth.json'), '{"opaque":"state"}\n', { mode: 0o600 });

    const result = await contracts!.runCodexNativeSmoke({
      candidateDirectory: new URL('candidate/', fixtureRoot).pathname,
      environment: { AGENT_BUNDLE_NATIVE_CODEX_SMOKE: '1', PATH: process.env.PATH },
      fixtureDirectory: new URL('workspace/', fixtureRoot).pathname,
      normalCodexHome,
      run: async (command) => {
        if (command.args[0] === '--version') return { exitCode: 0, stderr: '', stdout: 'codex-cli 0.147.0\n' };
        if (command.args[1] === 'list') {
          return { exitCode: 0, stderr: '', stdout: '[{"name":"agent-bundle-codex-smoke"}]\n' };
        }
        if (command.args[0] === 'exec') {
          return {
            exitCode: 1,
            stderr: 'unretained local stderr',
            stdout: await readFile(new URL('native-smoke.error.jsonl', fixtureRoot), 'utf8'),
          };
        }
        return { exitCode: 0, stderr: '', stdout: '' };
      },
      temporaryDirectoryParent: join(root, 'temporary-homes'),
    });

    expect(result).toEqual({
      activation: { automatic: 'unavailable', pluginAvailability: 'unavailable' },
      diagnostic: { code: 'native-codex.exec.failed', kind: 'harness-failure' },
      eventEnvelopes: [{ fields: ['message', 'type'], type: 'error' }],
      normalHome: { auth: 'unchanged', config: 'unchanged', plugins: 'unchanged' },
      status: 'harness-failure',
    });
    expect(JSON.stringify(result)).not.toContain('unretained local stderr');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('runs the signed-in Codex candidate only when explicitly opted in', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const result = await contracts!.runCodexNativeSmoke({
    candidateDirectory: new URL('candidate/', fixtureRoot).pathname,
    fixtureDirectory: new URL('workspace/', fixtureRoot).pathname,
  });

  await mkdir(join(process.cwd(), '.agent-bundle'), { recursive: true });
  await writeFile(contracts!.codexNativeSmokeReportPath(process.cwd()), `${JSON.stringify({
    cliVersion: '0.147.0',
    eventEnvelopes: result.eventEnvelopes,
    host: 'codex',
    normalHome: result.normalHome,
    schemaVersion: 1,
    status: result.status,
  }, null, 2)}\n`);

  expect(result, JSON.stringify(result)).toMatchObject({
    activation: { automatic: 'inferred', pluginAvailability: 'observed' },
    status: 'passed',
  });
  expect(JSON.stringify(result)).not.toMatch(/(?:api[_-]?key|authorization|Reply with exactly)/iu);
}, 120_000);
