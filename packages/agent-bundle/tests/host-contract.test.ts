import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

type Host = 'claude' | 'codex';

const fixtureRoot = (host: Host) => new URL(`../../../fixtures/contracts/hosts/${host}/`, import.meta.url);

const helpOutputFiles = {
  claude: { plugin: 'plugin-help.txt', root: 'help.txt' },
  codex: {
    exec: 'exec-help.txt',
    marketplace: 'marketplace-help.txt',
    plugin: 'plugin-help.txt',
    'plugin-add': 'plugin-add-help.txt',
    'plugin-list': 'plugin-list-help.txt',
    root: 'help.txt',
  },
} as const;

const readContractFixture = async (host: Host) => {
  const helpOutputs = Object.freeze(Object.fromEntries(await Promise.all(
    Object.entries(helpOutputFiles[host]).map(async ([id, file]) => [id, await readFile(new URL(file, fixtureRoot(host)), 'utf8')] as const),
  )));
  return {
    contract: JSON.parse(await readFile(new URL('contract.json', fixtureRoot(host)), 'utf8')) as unknown,
    helpOutput: Object.values(helpOutputs).join('\n'),
    helpOutputs,
    versionOutput: await readFile(new URL('version.txt', fixtureRoot(host)), 'utf8'),
  };
};

const loadContractModule = async () => import('../src/host-contracts/host-contract.ts').catch(() => undefined);
const nativeIt = process.env.AGENT_BUNDLE_NATIVE_HOST_CONTRACTS === '1' ? it : it.skip;

const jsonStringValues = (value: unknown): readonly string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStringValues);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(jsonStringValues);
  return [];
};

const isOfficialUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      url.hostname === 'openai.com'
      || url.hostname.endsWith('.openai.com')
      || url.hostname === 'anthropic.com'
      || url.hostname.endsWith('.anthropic.com')
    );
  } catch {
    return false;
  }
};

const containsCredentialOrHomePath = (value: string): boolean => {
  if (isOfficialUrl(value)) return false;
  return /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9_-])|(?:api[_-]?key|authorization)\s*[:=]\s*\S+)/iu.test(value)
    || /(?:^|[\s"'(=:])(?:\/Users\/[^/\s"'<>]+(?:\/|$)|\/home\/[^/\s"'<>]+(?:\/|$)|\/root\/)/u.test(value);
};

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

it('requires each declared Codex help command to supply its own compatible output', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const codex = await readContractFixture('codex');
  const compatible = contracts!.evaluateHostContract(codex.contract, codex);
  const changed = contracts!.evaluateHostContract(codex.contract, {
    ...codex,
    helpOutputs: {
      ...codex.helpOutputs,
      'plugin-list': 'Usage: codex plugin list [OPTIONS]\n\nOptions:\n  --json-lines  Emit installed plugin state as JSON Lines.\n',
    },
  });

  expect(compatible).toMatchObject({ host: 'codex', status: 'compatible', version: '0.147.0' });
  expect(changed).toEqual({
    diagnostics: [{
      code: 'host-contract.help.changed',
      host: 'codex',
      message: 'codex 0.147.0 help probe "plugin-list" is missing required options: --json. Refresh the host fixture and harness together.',
    }],
    host: 'codex',
    minimumVersion: '0.147.0',
    status: 'changed',
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
    helpOutputs: {
      ...claude.helpOutputs,
      root: claude.helpOutputs.root.replace('--plugin-dir', '--plugin-directory'),
    },
  });

  expect(result).toMatchObject({
    host: 'claude',
    minimumVersion: '2.1.232',
    status: 'changed',
    version: '2.1.232',
  });
  expect(result.diagnostics).toEqual([{
    code: 'host-contract.help.changed',
    host: 'claude',
    message: 'claude 2.1.232 help probe "root" is missing required options: --plugin-dir. Refresh the host fixture and harness together.',
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
  const run = async (command: { readonly helpId?: string; readonly kind: 'help' | 'status' | 'version' }) => {
    calls.push(command);
    return command.kind === 'version'
      ? { exitCode: 0, stdout: codex.versionOutput }
      : command.kind === 'help'
        ? { exitCode: 0, stdout: codex.helpOutputs[command.helpId!]! }
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
    { args: ['--help'], executable: 'codex', helpId: 'root', host: 'codex', kind: 'help' },
    { args: ['exec', '--help'], executable: 'codex', helpId: 'exec', host: 'codex', kind: 'help' },
    { args: ['plugin', '--help'], executable: 'codex', helpId: 'plugin', host: 'codex', kind: 'help' },
    { args: ['plugin', 'add', '--help'], executable: 'codex', helpId: 'plugin-add', host: 'codex', kind: 'help' },
    { args: ['plugin', 'list', '--help'], executable: 'codex', helpId: 'plugin-list', host: 'codex', kind: 'help' },
    { args: ['plugin', 'marketplace', '--help'], executable: 'codex', helpId: 'marketplace', host: 'codex', kind: 'help' },
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

  for (const content of [
    ...envelopeContents,
    ...jsonStringValues(claude.contract),
    ...jsonStringValues(codex.contract),
    claude.helpOutput,
    claude.versionOutput,
    codex.helpOutput,
    codex.versionOutput,
  ]) {
    expect(containsCredentialOrHomePath(content)).toBe(false);
    expect(content).not.toMatch(/"(?:cwd|session_id|thread_id)":"(?!<redacted>)/u);
  }
  for (const sensitiveValue of [
    'OPENAI_API_KEY=not-a-real-key',
    '/Users/alice/.config/host',
    '/home/alice/.config/host',
    '/root/.config/host',
  ]) expect(containsCredentialOrHomePath(sensitiveValue)).toBe(true);
  expect(containsCredentialOrHomePath('https://platform.openai.com/docs/api-reference')).toBe(false);
});

it('rejects structurally bogus host command shapes and preserves the Codex temporary home environment', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();

  const codex = await readContractFixture('codex');
  const malformed = JSON.parse(JSON.stringify(codex.contract)) as {
    probes: { help: Array<{ args: string[] }> };
  };
  malformed.probes.help[4]!.args = ['plugin', 'lists', '--help'];
  const parser = contracts as typeof contracts & {
    readonly parseHostContractManifest?: (value: unknown) => unknown;
  };

  expect(contracts!.evaluateHostContract(malformed, codex)).toMatchObject({
    diagnostics: [{ code: 'host-contract.fixture.invalid', host: 'unknown' }],
    status: 'changed',
  });
  expect(parser.parseHostContractManifest).toBeDefined();
  expect(parser.parseHostContractManifest!(codex.contract)).toMatchObject({
    temporaryHomeEnvironment: 'CODEX_HOME',
  });
});

nativeIt('compares installed host contracts through the opt-in non-model runner', async () => {
  const contracts = await loadContractModule();
  expect(contracts).toBeDefined();
  const localRunner = contracts as typeof contracts & {
    readonly compareLocalHostContract?: (manifest: unknown) => Promise<{ readonly status: string }>;
  };

  for (const host of ['claude', 'codex'] as const) {
    const fixture = await readContractFixture(host);
    const result = await localRunner.compareLocalHostContract!(fixture.contract);
    expect(result.status, JSON.stringify(result)).toBe('compatible');
  }
});
