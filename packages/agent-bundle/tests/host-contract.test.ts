import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

type Host = 'claude' | 'codex';

const fixtureRoot = (host: Host) => new URL(`../../../fixtures/contracts/hosts/${host}/`, import.meta.url);

const readContractFixture = async (host: Host) => ({
  contract: JSON.parse(await readFile(new URL('contract.json', fixtureRoot(host)), 'utf8')) as unknown,
  helpOutput: await readFile(new URL('help.txt', fixtureRoot(host)), 'utf8'),
  versionOutput: await readFile(new URL('version.txt', fixtureRoot(host)), 'utf8'),
});

const loadContractModule = async () => import('../src/host-contracts/host-contract.ts').catch(() => undefined);

it('accepts the checked-in Claude and Codex baselines from raw version and help fixtures', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const claude = await readContractFixture('claude');
  const codex = await readContractFixture('codex');

  expect(contracts!.evaluateHostContract(claude.contract, claude)).toMatchObject({
    host: 'claude',
    minimumVersion: '2.1.232',
    status: 'compatible',
    version: '2.1.232',
  });
  expect(contracts!.evaluateHostContract(codex.contract, codex)).toMatchObject({
    host: 'codex',
    minimumVersion: '0.147.0',
    status: 'compatible',
    version: '0.147.0',
  });
});

it('parses the checked-in redacted stream and hook event envelopes', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const claudeStream = await readFile(new URL('stream-events.jsonl', fixtureRoot('claude')), 'utf8');
  const claudeHook = await readFile(new URL('hook-event.json', fixtureRoot('claude')), 'utf8');
  const codexStream = await readFile(new URL('stream-events.jsonl', fixtureRoot('codex')), 'utf8');

  expect(contracts!.parseRedactedEventEnvelopes(claudeStream)).toEqual([
    { fields: ['session_id', 'subtype', 'tools', 'type'], type: 'system' },
    { fields: ['message', 'type'], type: 'assistant' },
    { fields: ['duration_ms', 'num_turns', 'subtype', 'type'], type: 'result' },
  ]);
  expect(contracts!.parseRedactedEventEnvelopes(claudeHook)).toEqual([
    { fields: ['cwd', 'hook_event_name', 'session_id', 'tool_input', 'tool_name'] },
  ]);
  expect(contracts!.parseRedactedEventEnvelopes(codexStream)).toEqual([
    { fields: ['thread_id', 'type'], type: 'thread.started' },
    { fields: ['type'], type: 'turn.started' },
    { fields: ['item', 'type'], type: 'item.started' },
    { fields: ['type', 'usage'], type: 'turn.completed' },
  ]);
});

it('reports one actionable diagnostic when a required flag changes name', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const claude = await readContractFixture('claude');
  const result = contracts!.evaluateHostContract(claude.contract, {
    ...claude,
    helpOutput: claude.helpOutput.replace('--plugin-dir', '--plugin-directory'),
  });

  expect(result).toMatchObject({
    host: 'claude',
    minimumVersion: '2.1.232',
    status: 'changed',
    version: '2.1.232',
  });
  expect(result.diagnostics).toEqual([{
    code: 'host-contract.flags.changed',
    host: 'claude',
    message: 'claude 2.1.232 is missing required CLI contract terms: --plugin-dir. Refresh the host fixture and harness together.',
  }]);
});

it('rejects a prerelease older than the checked-in released Codex baseline', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const codex = await readContractFixture('codex');
  const result = contracts!.evaluateHostContract(codex.contract, {
    ...codex,
    versionOutput: 'codex-cli 0.147.0-beta.1\n',
  });

  expect(result).toEqual({
    diagnostics: [{
      code: 'host-contract.version.incompatible',
      host: 'codex',
      message: 'codex 0.147.0-beta.1 is older than the minimum supported version 0.147.0; upgrade the CLI.',
    }],
    host: 'codex',
    minimumVersion: '0.147.0',
    status: 'incompatible',
    version: '0.147.0-beta.1',
  });
});

it('rejects an older numeric Claude version without a compatibility branch', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const claude = await readContractFixture('claude');
  const result = contracts!.evaluateHostContract(claude.contract, {
    ...claude,
    versionOutput: '2.1.231 (Claude Code)\n',
  });

  expect(result).toMatchObject({
    diagnostics: [{ code: 'host-contract.version.incompatible', host: 'claude' }],
    host: 'claude',
    minimumVersion: '2.1.232',
    status: 'incompatible',
    version: '2.1.231',
  });
});

it('compares an installed contract only when explicitly opted in with non-model probes', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const codex = await readContractFixture('codex');
  const calls: unknown[] = [];
  const run = async (command: { readonly kind: 'help' | 'status' | 'version' }) => {
    calls.push(command);
    return command.kind === 'version'
      ? { exitCode: 0, stdout: codex.versionOutput }
      : command.kind === 'help'
        ? { exitCode: 0, stdout: codex.helpOutput }
        : { exitCode: 0, stdout: 'this status output must not be retained' };
  };

  const skipped = await contracts!.compareInstalledHostContract(codex.contract, { enabled: false, run });
  expect(skipped).toEqual({
    diagnostics: [{
      code: 'host-contract.opt-in.required',
      host: 'codex',
      message: 'Set AGENT_BUNDLE_NATIVE_HOST_CONTRACTS=1 to compare the installed codex CLI contract.',
    }],
    host: 'codex',
    minimumVersion: '0.147.0',
    status: 'skipped',
  });
  expect(calls).toEqual([]);

  const compared = await contracts!.compareInstalledHostContract(codex.contract, { enabled: true, run });
  expect(compared).toEqual({
    diagnostics: [],
    host: 'codex',
    minimumVersion: '0.147.0',
    status: 'compatible',
    version: '0.147.0',
  });
  expect(calls).toEqual([
    { args: ['--version'], executable: 'codex', host: 'codex', kind: 'version' },
    { args: ['--help'], executable: 'codex', host: 'codex', kind: 'help' },
    { args: ['plugin', 'list', '--json'], executable: 'codex', host: 'codex', kind: 'status' },
  ]);
  expect(JSON.stringify(compared)).not.toContain('this status output must not be retained');
});

it('returns a structured missing-host diagnostic without a compatibility fallback', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const claude = await readContractFixture('claude');
  const missing = await contracts!.compareInstalledHostContract(claude.contract, {
    enabled: true,
    run: async () => {
      const error = Object.assign(new Error('not found'), { code: 'ENOENT' });
      throw error;
    },
  });

  expect(missing).toEqual({
    diagnostics: [{
      code: 'host-contract.cli.missing',
      host: 'claude',
      message: 'claude is not installed or is not on PATH; install claude 2.1.232 or newer.',
    }],
    host: 'claude',
    minimumVersion: '2.1.232',
    status: 'missing',
  });
});

it('keeps host fixtures to redacted envelopes and required command shapes', async () => {
  const claude = await readContractFixture('claude');
  const codex = await readContractFixture('codex');
  const claudeContract = claude.contract as {
    readonly commandShapes: Record<string, readonly string[]>;
    readonly eventEnvelopeFiles: readonly string[];
  };
  const codexContract = codex.contract as {
    readonly commandShapes: Record<string, readonly string[]>;
    readonly eventEnvelopeFiles: readonly string[];
    readonly temporaryHomeEnvironment: string;
  };
  const envelopeContents = await Promise.all([
    ...claudeContract.eventEnvelopeFiles.map((name) => readFile(new URL(name, fixtureRoot('claude')), 'utf8')),
    ...codexContract.eventEnvelopeFiles.map((name) => readFile(new URL(name, fixtureRoot('codex')), 'utf8')),
  ]);

  expect(claudeContract.commandShapes).toEqual({
    hookEvent: ['hook_event_name', 'PreToolUse'],
    nativeExecution: [
      '-p',
      '--plugin-dir',
      '<plugin-root>',
      '--output-format',
      'stream-json',
      '--no-session-persistence',
      '<task-input>',
    ],
  });
  expect(codexContract).toMatchObject({
    commandShapes: {
      ephemeralExecution: ['exec', '--ephemeral', '--json', '<task-input>'],
      marketplaceAdd: ['plugin', 'marketplace', 'add', '<marketplace-path>'],
      pluginAdd: ['plugin', 'add', '<plugin>@<marketplace>'],
      pluginList: ['plugin', 'list', '--json'],
    },
    temporaryHomeEnvironment: 'CODEX_HOME',
  });

  for (const content of [...envelopeContents, claude.helpOutput, claude.versionOutput, codex.helpOutput, codex.versionOutput]) {
    expect(content).not.toMatch(/(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|api[_-]?key|\/home\/|[A-Z]:\\Users\\|sk-[A-Za-z0-9_-]+)/iu);
    expect(content).not.toMatch(/"(?:cwd|session_id|thread_id)":"(?!<redacted>)/u);
  }
});
