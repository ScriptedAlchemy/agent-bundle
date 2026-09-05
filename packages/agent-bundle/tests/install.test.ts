import { execFile as executeFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';
import { Ajv } from 'ajv/dist/ajv.js';
import addFormats from 'ajv-formats';

import cursorMarketplaceSchema from '../src/adapters/schemas/cursor/marketplace.schema.json' with { type: 'json' };
import { stageCursorMarketplace } from '../src/install/cursor-marketplace.ts';
import { formatInstallResult } from '../src/install/format.ts';
import { installBundle, type InstallCommandRunner } from '../src/install/install.ts';
import {
  installReceiptFile,
  installReceiptFormat,
  readInstallReceipt,
  readInstallReceiptFile,
  treeInventory,
} from '../src/install/receipt.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';
import { runCli } from '../src/cli.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';

interface CommandCall {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
}

/** What a faithful `git ls-tree -r -z HEAD` would print for the files under `root` (SHA-1 blob ids). */
const fakeTreeListing = async (root: string, relative = ''): Promise<string> => {
  let listing = '';
  for (const name of (await readdir(join(root, relative))).sort()) {
    if (relative === '' && name === '.git') continue;
    const child = relative === '' ? name : `${relative}/${name}`;
    const metadata = await lstat(join(root, child));
    if (metadata.isDirectory()) {
      listing += await fakeTreeListing(root, child);
    } else if (metadata.isFile()) {
      const bytes = await readFile(join(root, child));
      const id = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      listing += `100644 blob ${id}\t${child}\0`;
    }
  }
  return listing;
};

const isMarketplaceListCall = (call: CommandCall): boolean =>
  call.args.join(' ') === 'plugin marketplace list --json';

/** A host with no marketplaces configured: the install then registers (and records owning) the bundle's marketplace. */
const noMarketplaces = (call: CommandCall): string =>
  call.command === 'claude' ? JSON.stringify([]) : JSON.stringify({ marketplaces: [] });

/**
 * Default fake host: answers `ls-tree` faithfully for the staged tree so byte proofs pass, reports no configured
 * marketplaces, and is silent otherwise.
 */
const gitLike = async (call: CommandCall): Promise<string> => call.args[0] === 'ls-tree'
  ? fakeTreeListing(call.cwd)
  : isMarketplaceListCall(call) ? noMarketplaces(call) : '';

const recordingRunner = (
  respond: (call: CommandCall) => string | Promise<string> = gitLike,
): {
  readonly calls: CommandCall[];
  readonly runner: InstallCommandRunner;
} => {
  const calls: CommandCall[] = [];
  return {
    calls,
    runner: {
      run: async (command, args, options) => {
        const call = { args: [...args], command, cwd: options.cwd };
        calls.push(call);
        return { code: 0, stderr: '', stdout: await respond(call) };
      },
    },
  };
};

const isInventoryCall = (call: CommandCall): boolean =>
  call.args.join(' ') === 'plugin list --json';

const listFiles = async (root: string): Promise<readonly string[]> =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort((left, right) => left.localeCompare(right));

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
};

const execFile = promisify(executeFile);

/** Creates a named pipe; Windows has no FIFOs, so callers skip there. */
const makeFifo = async (path: string): Promise<void> => {
  await execFile('mkfifo', [path]);
};

const createHostBundle = async (
  host: 'claude' | 'codex' | 'cursor',
  options: { readonly artifactRoot?: boolean } = {},
): Promise<{ readonly bundleRoot: string; readonly cleanupRoot: string; readonly from: string }> => {
  const cleanupRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-install-'));
  const from = options.artifactRoot === true ? cleanupRoot : join(cleanupRoot, 'bundle');
  const bundleRoot = options.artifactRoot === true ? join(cleanupRoot, host) : from;
  await mkdir(bundleRoot, { recursive: true });
  await writeFile(join(bundleRoot, 'payload.txt'), 'payload\n');

  if (host === 'claude') {
    await Promise.all([
      writeJson(join(bundleRoot, '.claude-plugin/plugin.json'), {
        name: 'install-fixture',
        version: '1.2.3',
      }),
      writeJson(join(bundleRoot, '.claude-plugin/marketplace.json'), {
        name: 'install-fixture-marketplace',
        plugins: [{ name: 'install-fixture', source: './', version: '1.2.3' }],
      }),
    ]);
  } else if (host === 'codex') {
    await Promise.all([
      writeJson(join(bundleRoot, '.codex-plugin/plugin.json'), {
        name: 'install-fixture',
        version: '1.2.3',
      }),
      writeJson(join(bundleRoot, '.agents/plugins/marketplace.json'), {
        name: 'install-fixture-marketplace',
        plugins: [{
          category: 'Productivity',
          name: 'install-fixture',
          policy: { authentication: 'ON_INSTALL', installation: 'AVAILABLE' },
          source: { path: './', source: 'local' },
        }],
      }),
    ]);
  } else {
    await writeJson(join(bundleRoot, '.cursor-plugin/plugin.json'), {
      name: 'install-fixture',
      version: '1.2.3',
    });
  }
  return { bundleRoot, cleanupRoot, from };
};

/**
 * Host-CLI installs now write a store receipt under the host root (#101), so every Claude/Codex
 * scenario pins its host roots inside the fixture's cleanup root instead of the developer's home.
 */
const isolated = (fixture: { readonly cleanupRoot: string }): {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly home: string;
} => ({
  environment: {
    CLAUDE_CONFIG_DIR: join(fixture.cleanupRoot, 'claude-config'),
    CODEX_HOME: join(fixture.cleanupRoot, 'codex-home'),
  },
  home: join(fixture.cleanupRoot, 'home'),
});

it.each([
  {
    expected: [
      { args: ['plugin', 'list', '--json'], command: 'claude' },
      { args: ['plugin', 'marketplace', 'list', '--json'], command: 'claude' },
      { args: ['plugin', 'marketplace', 'add', resolve('/bundle')], command: 'claude' },
      {
        args: ['plugin', 'install', 'install-fixture@install-fixture-marketplace', '--scope', 'project'],
        command: 'claude',
      },
      // Post-install load verdict: `plugin install` exits 0 for a plugin Claude Code then refuses (#464).
      { args: ['plugin', 'list', '--json'], command: 'claude' },
    ],
    host: 'claude' as const,
    scope: 'project' as const,
  },
  {
    expected: [
      { args: ['plugin', 'list', '--json'], command: 'codex' },
      { args: ['plugin', 'marketplace', 'list', '--json'], command: 'codex' },
      { args: ['plugin', 'marketplace', 'add', resolve('/bundle')], command: 'codex' },
      { args: ['plugin', 'add', 'install-fixture@install-fixture-marketplace'], command: 'codex' },
    ],
    host: 'codex' as const,
    scope: 'user' as const,
  },
])('delegates $host installation to its public CLI without a shell', async ({ expected, host, scope }) => {
  const fixture = await createHostBundle(host);
  const { calls, runner } = recordingRunner();
  try {
    const result = await installBundle({ ...isolated(fixture), commandRunner: runner, from: fixture.from, host, scope });

    const hostRoot = join(fixture.cleanupRoot, host === 'claude' ? 'claude-config' : 'codex-home');
    // A Claude project-scope registration belongs to the working directory the host verbs ran in (the bundle
    // root), so its receipt is keyed by a digest of that root: two projects never share one receipt.
    // The key also carries the marketplace: the host identifies the install as `<plugin>@<marketplace>`.
    const receiptPath = join(hostRoot, 'agent-bundle', 'receipts', scope === 'user'
      ? `install-fixture.install-fixture-marketplace.${scope}.json`
      : `install-fixture.install-fixture-marketplace.${scope}.${createHash('sha256').update(fixture.bundleRoot).digest('hex').slice(0, 12)}.json`);
    expect(result).toMatchObject({
      contentHash: (await treeInventory(fixture.bundleRoot)).hash,
      host,
      plugin: 'install-fixture',
      receipt: receiptPath,
      state: 'installed',
    });
    // The marketplace ownership read happens before any host verb: the receipt records the pre-install state.
    expect(calls).toEqual(expected.map((call) => ({ ...call, args: call.args.map((arg) =>
      arg === resolve('/bundle') ? fixture.bundleRoot : arg), cwd: fixture.bundleRoot })));
    // The store receipt records the delivery and the exact host registrations, in order, for uninstall.
    expect(await readInstallReceiptFile(receiptPath)).toMatchObject({
      contentHash: (await treeInventory(fixture.bundleRoot)).hash,
      directories: [],
      files: [],
      format: installReceiptFormat,
      host,
      hostDirectories: [],
      mode: 'host-cli',
      plugin: 'install-fixture',
      ...(scope === 'user' ? {} : { projectRoot: fixture.bundleRoot }),
      registrations: host === 'claude'
        ? [
          { kind: 'claude-marketplace', name: 'install-fixture-marketplace', scope },
          { id: 'install-fixture@install-fixture-marketplace', kind: 'claude-plugin', scope },
        ]
        : [
          { kind: 'codex-marketplace', name: 'install-fixture-marketplace' },
          { id: 'install-fixture@install-fixture-marketplace', kind: 'codex-plugin' },
        ],
      scope,
      version: '1.2.3',
    });
    if (scope === 'user') expect((await readInstallReceiptFile(receiptPath))?.projectRoot).toBeUndefined();

    // A marketplace that was already configured before the install is not claimed: the receipt records the
    // plugin registration only, so a later uninstall retains the marketplace instead of removing someone else's.
    const preRegistered = recordingRunner((call) => isMarketplaceListCall(call)
      ? (host === 'claude'
        ? JSON.stringify([{ name: 'install-fixture-marketplace' }])
        : JSON.stringify({ marketplaces: [{ name: 'install-fixture-marketplace', root: '/elsewhere' }] }))
      : '');
    await rm(receiptPath);
    await installBundle({ ...isolated(fixture), commandRunner: preRegistered.runner, from: fixture.from, host, scope });
    expect((await readInstallReceiptFile(receiptPath))?.registrations).toEqual([
      host === 'claude'
        ? { id: 'install-fixture@install-fixture-marketplace', kind: 'claude-plugin', scope }
        : { id: 'install-fixture@install-fixture-marketplace', kind: 'codex-plugin' },
    ]);
    // An unreadable marketplace list is not proof of ownership either (fail-closed).
    const unreadable = recordingRunner(() => '');
    await rm(receiptPath);
    await installBundle({ ...isolated(fixture), commandRunner: unreadable.runner, from: fixture.from, host, scope });
    expect((await readInstallReceiptFile(receiptPath))?.registrations.map((registration) => registration.kind)).toEqual([`${host}-plugin`]);

    // `marketplace add` succeeded but the plugin install failed: the marketplace this run created is claimed only
    // in memory, so it is rolled back rather than left registered with no receipt (a retry would otherwise sample it
    // as pre-existing, record only the plugin, and `uninstall` would retain it as user-owned forever).
    await rm(receiptPath);
    const installVerb = host === 'claude' ? 'plugin install' : 'plugin add';
    const failing: CommandCall[] = [];
    const rolledBack = await installBundle({
      ...isolated(fixture),
      commandRunner: { run: async (command, args, runOptions) => {
        const call = { args: [...args], command, cwd: runOptions.cwd };
        failing.push(call);
        if (isMarketplaceListCall(call)) return { code: 0, stderr: '', stdout: noMarketplaces(call) };
        return args.join(' ').startsWith(installVerb)
          ? { code: 1, stderr: 'install exploded', stdout: '' }
          : { code: 0, stderr: '', stdout: '' };
      } },
      from: fixture.from,
      host,
      scope,
    }).catch((failure: unknown) => failure);
    expect(rolledBack).toBeInstanceOf(DiagnosticError);
    expect((rolledBack as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7004', target: host });
    expect((rolledBack as DiagnosticError).diagnostics[0]?.message).toContain('install exploded');
    expect(failing.map((call) => call.args.join(' ')).slice(-2)).toEqual([
      `${installVerb} install-fixture@install-fixture-marketplace${host === 'claude' ? ` --scope ${scope}` : ''}`,
      'plugin marketplace remove install-fixture-marketplace',
    ]);
    expect(await readInstallReceiptFile(receiptPath)).toBeUndefined();

    // A marketplace that pre-existed the install is not this run's to roll back.
    const preExisting: CommandCall[] = [];
    await installBundle({
      ...isolated(fixture),
      commandRunner: { run: async (command, args, runOptions) => {
        const call = { args: [...args], command, cwd: runOptions.cwd };
        preExisting.push(call);
        if (isMarketplaceListCall(call)) {
          return { code: 0, stderr: '', stdout: host === 'claude'
            ? JSON.stringify([{ name: 'install-fixture-marketplace' }])
            : JSON.stringify({ marketplaces: [{ name: 'install-fixture-marketplace', root: '/elsewhere' }] }) };
        }
        return args.join(' ').startsWith(installVerb)
          ? { code: 1, stderr: 'install exploded', stdout: '' }
          : { code: 0, stderr: '', stdout: '' };
      } },
      from: fixture.from,
      host,
      scope,
    }).catch(() => undefined);
    expect(preExisting.map((call) => call.args.join(' '))).not.toContain('plugin marketplace remove install-fixture-marketplace');

    // The host install succeeded but the receipt could not be written: the plugin registration is reversed too
    // (plugin first, then the marketplace this run created), so nothing stays registered without a receipt.
    const receiptStore = join(hostRoot, 'agent-bundle', 'receipts');
    await rm(join(hostRoot, 'agent-bundle'), { force: true, recursive: true });
    await mkdir(receiptStore, { recursive: true });
    if (process.getuid?.() === 0) return; // root ignores directory modes; the receipt write cannot be made to fail here.
    await chmod(receiptStore, 0o555);
    const unwritable: CommandCall[] = [];
    const receiptFailed = await installBundle({
      ...isolated(fixture),
      commandRunner: { run: async (command, args, runOptions) => {
        const call = { args: [...args], command, cwd: runOptions.cwd };
        unwritable.push(call);
        return { code: 0, stderr: '', stdout: isMarketplaceListCall(call) ? noMarketplaces(call) : '' };
      } },
      from: fixture.from,
      host,
      scope,
    }).catch((failure: unknown) => failure);
    expect(receiptFailed).toBeInstanceOf(Error);
    expect(receiptFailed).not.toBeInstanceOf(DiagnosticError);
    expect(unwritable.map((call) => call.args.join(' ')).slice(-2)).toEqual([
      host === 'claude'
        ? `plugin uninstall install-fixture@install-fixture-marketplace --scope ${scope} --keep-data`
        : 'plugin remove install-fixture@install-fixture-marketplace',
      'plugin marketplace remove install-fixture-marketplace',
    ]);
    await chmod(receiptStore, 0o755);
  } finally {
    await rm(fixture.cleanupRoot, { force: true, recursive: true });
  }
});

const claudeInventory = (installPath: string, version = '1.2.3'): string => JSON.stringify([{
  enabled: true,
  id: 'install-fixture@install-fixture-marketplace',
  installPath,
  scope: 'user',
  version,
}]);

const codexInventory = (version = '1.2.3'): string => JSON.stringify({
  available: [],
  installed: [{
    enabled: true,
    installed: true,
    marketplaceName: 'install-fixture-marketplace',
    name: 'install-fixture',
    pluginId: 'install-fixture@install-fixture-marketplace',
    version,
  }],
});

it('replaces a stale same-version Claude install through uninstall + install and skips identical copies', async () => {
  const fixture = await createHostBundle('claude');
  const installed = join(fixture.cleanupRoot, 'claude-cache', '1.2.3');
  await cp(fixture.bundleRoot, installed, { recursive: true });
  const { calls, runner } = recordingRunner((call) => isInventoryCall(call)
    ? claudeInventory(installed)
    : isMarketplaceListCall(call) ? JSON.stringify([{ name: 'install-fixture-marketplace' }]) : '');
  const options = { ...isolated(fixture), commandRunner: runner, from: fixture.from, host: 'claude' as const, scope: 'user' as const };
  const receiptPath = join(fixture.cleanupRoot, 'claude-config', 'agent-bundle', 'receipts', 'install-fixture.install-fixture-marketplace.user.json');
  try {
    const identical = await installBundle(options);
    expect(identical).toMatchObject({ destination: installed, host: 'claude', state: 'already-installed' });
    // Only reads: the inventory, then the marketplace list that decides whether the receipt may claim the marketplace.
    expect(calls.map((call) => call.args.join(' '))).toEqual(['plugin list --json', 'plugin marketplace list --json']);
    // An identical pre-#101 install gains its store receipt without any host command; the marketplace it came
    // from already existed, so the receipt does not claim it.
    expect(await readInstallReceiptFile(receiptPath)).toMatchObject({
      mode: 'host-cli',
      plugin: 'install-fixture',
      registrations: [{ id: 'install-fixture@install-fixture-marketplace', kind: 'claude-plugin', scope: 'user' }],
    });

    calls.length = 0;
    await writeFile(join(installed, 'payload.txt'), 'stale\n');
    const replaced = await installBundle(options);
    expect(replaced).toMatchObject({
      contentHash: (await treeInventory(fixture.bundleRoot)).hash,
      destination: installed,
      previousContentHash: (await treeInventory(installed)).hash,
      state: 'replaced',
    });
    // A receipted replacement keeps the previous receipt's ownership answer instead of re-reading the marketplace list.
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'plugin list --json',
      'plugin uninstall install-fixture@install-fixture-marketplace --scope user --keep-data',
      `plugin marketplace add ${fixture.bundleRoot}`,
      'plugin install install-fixture@install-fixture-marketplace --scope user',
      'plugin list --json',
    ]);

    // A reported copy that cannot be compared never passes as "no drift": fail closed without --replace.
    const missingCache = recordingRunner((call) => isInventoryCall(call)
      ? claudeInventory(join(fixture.cleanupRoot, 'claude-cache', 'missing'))
      : '');
    const uncomparable = await installBundle({ ...options, commandRunner: missingCache.runner })
      .catch((failure: unknown) => failure);
    expect(uncomparable).toBeInstanceOf(DiagnosticError);
    expect((uncomparable as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7004', target: 'claude' });
    expect((uncomparable as DiagnosticError).diagnostics[0]?.message).toContain('could not be compared');
    expect(missingCache.calls).toHaveLength(1);
    const reinstalled = await installBundle({ ...options, commandRunner: missingCache.runner, replace: true });
    expect(reinstalled).toMatchObject({ state: 'replaced' });
    // The cache copy could not be read, so the superseded hash comes from the store receipt the last install wrote.
    expect(reinstalled.previousContentHash).toBe((await treeInventory(fixture.bundleRoot)).hash);
    // Without a receipt there is nothing to remember: the superseded hash is honestly absent.
    await rm(receiptPath);
    const reinstalledWithoutReceipt = await installBundle({ ...options, commandRunner: missingCache.runner, replace: true });
    expect(reinstalledWithoutReceipt).toMatchObject({ state: 'replaced' });
    expect(reinstalledWithoutReceipt.previousContentHash).toBeUndefined();

    // A matching row without a readable scope or version is an unusable inventory, not "not installed".
    for (const row of [
      { id: 'install-fixture@install-fixture-marketplace', installPath: installed, version: '1.2.3' },
      { id: 'install-fixture@install-fixture-marketplace', installPath: installed, scope: 'user' },
    ]) {
      const malformed = recordingRunner((call) => isInventoryCall(call) ? JSON.stringify([row]) : '');
      const error = await installBundle({ ...options, commandRunner: malformed.runner, replace: true })
        .catch((failure: unknown) => failure);
      expect(error, JSON.stringify(row)).toBeInstanceOf(DiagnosticError);
      expect((error as DiagnosticError).diagnostics[0]?.message).toContain('plugin list --json was unusable');
      expect(malformed.calls).toHaveLength(1);
    }
  } finally {
    await rm(fixture.cleanupRoot, { force: true, recursive: true });
  }
});

// Verbatim `claude plugin list --json` row shape (Claude Code 2.1.259) for a plugin Claude Code refused: the
// row stays `enabled: true`; the load verdict is only in `errors`. Healthy rows omit the key entirely.
const claudeRefusedInventory = (installPath: string): string => JSON.stringify([{
  enabled: true,
  errors: [
    'Hook load failed: Duplicate hooks file detected: ./hooks/hooks.json resolves to already-loaded file ' +
    `${installPath}/hooks/hooks.json. The standard hooks/hooks.json is loaded automatically, so manifest.hooks ` +
    'should only reference additional hook files.',
  ],
  id: 'install-fixture@install-fixture-marketplace',
  installPath,
  installedAt: '2026-09-03T22:57:19.526Z',
  lastUpdated: '2026-09-03T22:57:19.526Z',
  scope: 'user',
  version: '1.2.3',
}]);

it('fails a Claude install (AB7006) when plugin list --json reports load errors for the installed copy (#464)', async () => {
  const fixture = await createHostBundle('claude');
  const installed = join(fixture.cleanupRoot, 'claude-cache', '1.2.3');
  try {
    // Fresh install: `plugin install` exits 0, the follow-up listing says Claude Code refused the copy.
    let listings = 0;
    const fresh = recordingRunner((call) => {
      if (!isInventoryCall(call)) return '';
      listings += 1;
      return listings === 1 ? '[]' : claudeRefusedInventory(installed);
    });
    const error = await installBundle({ ...isolated(fixture), commandRunner: fresh.runner, from: fixture.from, host: 'claude', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DiagnosticError);
    const [diagnostic] = (error as DiagnosticError).diagnostics;
    expect(diagnostic).toMatchObject({ code: 'AB7006', severity: 'error', target: 'claude' });
    expect(diagnostic?.message).toContain(`claude refused to load install-fixture@install-fixture-marketplace (version 1.2.3) at ${JSON.stringify(installed)} (scope user) after installation`);
    expect(diagnostic?.message).toContain('Duplicate hooks file detected');
    expect(diagnostic?.message).toContain('--replace');
    // The receipt lands before the load verdict, so the refused copy stays receipt-owned for `uninstall`.
    expect(fresh.calls.map((call) => call.args.join(' '))).toEqual([
      'plugin list --json',
      'plugin marketplace list --json',
      `plugin marketplace add ${fixture.bundleRoot}`,
      'plugin install install-fixture@install-fixture-marketplace --scope user',
      'plugin list --json',
    ]);
    expect(await readInstallReceiptFile(join(fixture.cleanupRoot, 'claude-config', 'agent-bundle', 'receipts', 'install-fixture.install-fixture-marketplace.user.json')))
      .toMatchObject({ plugin: 'install-fixture', scope: 'user' });

    // A byte-identical copy the host already refuses is never "already installed": reinstalling the same
    // bytes cannot help, so the defect is reported instead of a success.
    await cp(fixture.bundleRoot, installed, { recursive: true });
    const identical = recordingRunner((call) => isInventoryCall(call) ? claudeRefusedInventory(installed) : '');
    const existing = await installBundle({ ...isolated(fixture), commandRunner: identical.runner, from: fixture.from, host: 'claude', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect(existing).toBeInstanceOf(DiagnosticError);
    expect((existing as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7006', target: 'claude' });
    expect((existing as DiagnosticError).diagnostics[0]?.message).not.toContain('after installation');
    expect(identical.calls.map((call) => call.args.join(' '))).toEqual(['plugin list --json']);

    // Healthy rows (no `errors` key) keep the install result unchanged.
    const healthy = recordingRunner((call) => isInventoryCall(call) ? claudeInventory(installed) : '');
    await expect(installBundle({ ...isolated(fixture), commandRunner: healthy.runner, from: fixture.from, host: 'claude', scope: 'user' }))
      .resolves.toMatchObject({ state: 'already-installed' });
  } finally {
    await rm(fixture.cleanupRoot, { force: true, recursive: true });
  }
});

it('honours --replace for Codex through remove + add and fails closed without a usable inventory', async () => {
  const fixture = await createHostBundle('codex');
  const home = join(fixture.cleanupRoot, 'home');
  const codexHome = join(fixture.cleanupRoot, 'codex-home');
  // The host reports an older version installed from the pinned cache layout.
  const installed = join(codexHome, 'plugins', 'cache', 'install-fixture-marketplace', 'install-fixture', '1.0.0');
  await cp(fixture.bundleRoot, installed, { recursive: true });
  const { calls, runner } = recordingRunner((call) => isInventoryCall(call) ? codexInventory('1.0.0') : '');
  const options = {
    commandRunner: runner,
    environment: { CODEX_HOME: codexHome },
    from: fixture.from,
    home,
    host: 'codex' as const,
    scope: 'user' as const,
  };
  try {
    // A different installed version is a collision without --replace: nothing runs after the inventory read.
    const plain = await installBundle(options).catch((failure: unknown) => failure);
    expect(plain).toBeInstanceOf(DiagnosticError);
    expect((plain as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7005', target: 'codex' });
    expect((plain as DiagnosticError).diagnostics[0]?.message).toContain('Refusing version collision');
    expect((plain as DiagnosticError).diagnostics[0]?.message).toContain('installed install-fixture@1.0.0');
    expect((plain as DiagnosticError).diagnostics[0]?.message).toContain('(same content, different version)');
    expect(calls.map((call) => call.args.join(' '))).toEqual(['plugin list --json']);

    calls.length = 0;
    const forced = await installBundle({ ...options, replace: true });
    expect(forced).toMatchObject({
      destination: join(codexHome, 'plugins', 'cache', 'install-fixture-marketplace', 'install-fixture', '1.2.3'),
      host: 'codex',
      previousContentHash: (await treeInventory(installed)).hash,
      state: 'replaced',
    });
    // No receipt yet, so the marketplace ownership read precedes every host verb.
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'plugin list --json',
      'plugin marketplace list --json',
      'plugin remove install-fixture@install-fixture-marketplace',
      `plugin marketplace add ${fixture.bundleRoot}`,
      'plugin add install-fixture@install-fixture-marketplace',
    ]);

    // Unparsable output, and a matching row that cannot be read, both fail --replace closed.
    const malformedRow = JSON.stringify({
      installed: [{ installed: true, pluginId: 'install-fixture@install-fixture-marketplace' }],
    });
    for (const stdout of ['not json', malformedRow]) {
      const unusable = recordingRunner(() => stdout);
      const error = await installBundle({ ...options, commandRunner: unusable.runner, replace: true })
        .catch((failure: unknown) => failure);
      expect(error, stdout).toBeInstanceOf(DiagnosticError);
      expect((error as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7004', target: 'codex' });
      expect((error as DiagnosticError).diagnostics[0]?.message).toContain('plugin list --json was unusable');
      expect(unusable.calls).toHaveLength(1);
    }
  } finally {
    await rm(fixture.cleanupRoot, { force: true, recursive: true });
  }
});

it('refuses --from that names a directory above the plugin root instead of probing into it (#555)', async () => {
  // The bundle sits under `<from>/claude`: every host reads the one root it is
  // given, so nothing nested is probed and the refusal names the manifest.
  const fixture = await createHostBundle('claude', { artifactRoot: true });
  const { calls, runner } = recordingRunner();
  try {
    await expect(installBundle({
      ...isolated(fixture),
      commandRunner: runner,
      from: fixture.from,
      host: 'claude',
      scope: 'user',
    })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({
        code: 'AB7001',
        message: expect.stringContaining('No claude bundle manifest ".claude-plugin/plugin.json" was found'),
      })],
    });
    expect(calls).toEqual([]);
  } finally {
    await rm(fixture.cleanupRoot, { force: true, recursive: true });
  }
});

it('fails with a typed diagnostic when the public host CLI is missing', async () => {
  const fixture = await createHostBundle('codex');
  const missingRunner: InstallCommandRunner = {
    run: async () => {
      const error = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    },
  };
  try {
    const error = await installBundle({
      ...isolated(fixture),
      commandRunner: missingRunner,
      from: fixture.from,
      host: 'codex',
      scope: 'user',
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toMatchObject([{
      code: 'AB7002',
      severity: 'error',
      target: 'codex',
    }]);
  } finally {
    await rm(fixture.cleanupRoot, { force: true, recursive: true });
  }
});

it('rejects scopes the selected host does not support', async () => {
  const fixture = await createHostBundle('codex');
  try {
    const error = await installBundle({
      ...isolated(fixture),
      commandRunner: recordingRunner().runner,
      from: fixture.from,
      host: 'codex',
      scope: 'project',
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7003', target: 'codex' }]);
  } finally {
    await rm(fixture.cleanupRoot, { force: true, recursive: true });
  }
});

it('copies a Cursor bundle into a fake home and is idempotent', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  try {
    // Empty directories are not plugin content: never hashed, installed, or owned.
    await mkdir(join(fixture.bundleRoot, 'empty', 'nested'), { recursive: true });
    const first = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    await mkdir(join(fixture.bundleRoot, 'another-empty'));
    const second = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });

    const artifact = await treeInventory(fixture.bundleRoot);
    expect(first).toMatchObject({ contentHash: artifact.hash, destination, host: 'cursor', state: 'installed' });
    expect(second).toMatchObject({ contentHash: artifact.hash, destination, host: 'cursor', state: 'already-installed' });
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('payload\n');
    expect((await readdir(destination)).sort()).toEqual([installReceiptFile, '.cursor-plugin', 'payload.txt']);
    expect(await readInstallReceipt(destination)).toMatchObject({
      contentHash: artifact.hash,
      // A fresh install created every directory, so it owns them all.
      directories: ['.cursor-plugin'],
      files: ['.cursor-plugin/plugin.json', 'payload.txt'],
      format: installReceiptFormat,
      host: 'cursor',
      // A fresh install into a home without plugins/local created both host directories (#101).
      hostDirectories: ['plugins', 'plugins/local'],
      mode: 'local',
      plugin: 'install-fixture',
      registrations: [{ kind: 'cursor-local-plugin' }],
      scope: 'user',
      version: '1.2.3',
    });
    expect(await listFiles(destination)).toEqual([installReceiptFile, '.cursor-plugin/plugin.json', 'payload.txt']);
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('replaces a stale same-version receipt-managed Cursor install in place, touching owned files only', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  try {
    await writeFile(join(fixture.bundleRoot, 'removed-later.txt'), 'old\n');
    const first = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    const previousHash = first.contentHash;
    // Runtime state beside the plugin is unowned and must survive replacement.
    await mkdir(join(destination, 'state'), { recursive: true });
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    await writeFile(join(destination, 'operator-note.txt'), 'keep me\n');

    // Same version, different content: one owned file rewritten, one removed, one added.
    await writeFile(join(fixture.bundleRoot, 'payload.txt'), 'rebuilt\n');
    await rm(join(fixture.bundleRoot, 'removed-later.txt'));
    await mkdir(join(fixture.bundleRoot, 'skills', 'new'), { recursive: true });
    await writeFile(join(fixture.bundleRoot, 'skills', 'new', 'SKILL.md'), '# new\n');
    const artifact = await treeInventory(fixture.bundleRoot);

    const replaced = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(replaced).toMatchObject({
      contentHash: artifact.hash,
      destination,
      previousContentHash: previousHash,
      state: 'replaced',
    });
    expect(await listFiles(destination)).toEqual([
      installReceiptFile,
      '.cursor-plugin/plugin.json',
      'operator-note.txt',
      'payload.txt',
      'skills/new/SKILL.md',
      'state/plugin.sqlite',
    ]);
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('rebuilt\n');
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');
    expect(await readInstallReceipt(destination)).toMatchObject({
      contentHash: artifact.hash,
      directories: ['.cursor-plugin', 'skills', 'skills/new'],
      files: ['.cursor-plugin/plugin.json', 'payload.txt', 'skills/new/SKILL.md'],
    });

    const again = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(again).toMatchObject({ contentHash: artifact.hash, state: 'already-installed' });
    expect(again.previousContentHash).toBeUndefined();

    // Directories the installer created are pruned once a rebuild empties them; a directory that
    // existed before the installer wrote beneath it is not the installer's to delete.
    await mkdir(join(destination, 'operator-dir'));
    await mkdir(join(fixture.bundleRoot, 'operator-dir'));
    await writeFile(join(fixture.bundleRoot, 'operator-dir', 'shipped.md'), '# shipped\n');
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect((await readInstallReceipt(destination))?.directories).toEqual(['.cursor-plugin', 'skills', 'skills/new']);
    await rm(join(fixture.bundleRoot, 'operator-dir'), { recursive: true });
    await rm(join(fixture.bundleRoot, 'skills'), { recursive: true });
    expect(await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })).toMatchObject({ state: 'replaced' });
    expect((await stat(join(destination, 'operator-dir'))).isDirectory()).toBe(true);
    expect(await readdir(join(destination, 'operator-dir'))).toEqual([]);
    await expect(access(join(destination, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readInstallReceipt(destination))?.directories).toEqual(['.cursor-plugin']);
    await rm(join(destination, 'operator-dir'), { recursive: true });
    await mkdir(join(fixture.bundleRoot, 'skills', 'new'), { recursive: true });
    await writeFile(join(fixture.bundleRoot, 'skills', 'new', 'SKILL.md'), '# new\n');
    expect(await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })).toMatchObject({ state: 'replaced' });
    expect((await readInstallReceipt(destination))?.directories).toEqual(['.cursor-plugin', 'skills', 'skills/new']);

    // An incoming file that would land on an existing unowned file aborts before any change.
    await writeFile(join(fixture.bundleRoot, 'operator-note.txt'), 'from the artifact\n');
    const collision = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect(collision).toBeInstanceOf(DiagnosticError);
    expect((collision as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7004', target: 'cursor' });
    expect((collision as DiagnosticError).diagnostics[0]?.message).toContain('Refusing to overwrite unowned files');
    expect((collision as DiagnosticError).diagnostics[0]?.message).toContain('operator-note.txt');
    expect(await readFile(join(destination, 'operator-note.txt'), 'utf8')).toBe('keep me\n');
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('rebuilt\n');
    expect(await readInstallReceipt(destination)).toMatchObject({ contentHash: artifact.hash });
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('requires --replace for a legacy pre-receipt Cursor copy and then adopts it', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  try {
    await writeFile(join(fixture.bundleRoot, 'INSTALL.md'), '# install\n');
    await writeFile(join(fixture.bundleRoot, 'install.mjs'), '// installer\n');
    await cp(fixture.bundleRoot, destination, { recursive: true });

    // Byte-identical legacy copy: a plain rerun is a no-op; --replace adopts it by writing the receipt.
    const identical = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(identical).toMatchObject({ state: 'already-installed' });
    expect(await readInstallReceipt(destination)).toBeUndefined();
    const adopted = await installBundle({ from: fixture.from, home, host: 'cursor', replace: true, scope: 'user' });
    expect(adopted).toMatchObject({ contentHash: (await treeInventory(fixture.bundleRoot)).hash, state: 'adopted' });
    // Adoption created no directories, so the legacy copy's directories are never pruned.
    expect(await readInstallReceipt(destination)).toMatchObject({ directories: [], plugin: 'install-fixture', version: '1.2.3' });
    await rm(join(destination, installReceiptFile));

    await writeFile(join(destination, 'payload.txt'), 'stale\n');
    // Operator content and a file the rebuild dropped: a legacy copy has no inventory, so both stay.
    await writeFile(join(destination, 'operator-note.txt'), 'keep me\n');
    await writeFile(join(destination, 'dropped-by-rebuild.txt'), 'old artifact file\n');
    const legacyHash = (await treeInventory(destination)).hash;
    const artifact = await treeInventory(fixture.bundleRoot);

    const refused = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect(refused).toBeInstanceOf(DiagnosticError);
    const message = (refused as DiagnosticError).diagnostics[0]?.message ?? '';
    expect((refused as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7005', target: 'cursor' });
    expect(message).toContain('Refusing content collision');
    expect(message).toContain(`content ${legacyHash.slice(0, 12)}`);
    expect(message).toContain(`content ${artifact.hash.slice(0, 12)}`);
    expect(message).toContain('same version, different content');
    expect(message).toContain('--replace');

    const replaced = await installBundle({ from: fixture.from, home, host: 'cursor', replace: true, scope: 'user' });
    expect(replaced).toMatchObject({ contentHash: artifact.hash, previousContentHash: legacyHash, state: 'replaced' });
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('payload\n');
    expect(await readFile(join(destination, 'operator-note.txt'), 'utf8')).toBe('keep me\n');
    expect(await readFile(join(destination, 'dropped-by-rebuild.txt'), 'utf8')).toBe('old artifact file\n');
    const receipt = await readInstallReceipt(destination);
    expect(receipt).toMatchObject({ contentHash: artifact.hash, directories: [], plugin: 'install-fixture' });
    expect(receipt?.files).toEqual(artifact.files);
    // From now on the leftovers are unowned: a later same-version replace leaves them alone.
    await writeFile(join(fixture.bundleRoot, 'payload.txt'), 'rebuilt\n');
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(await readFile(join(destination, 'dropped-by-rebuild.txt'), 'utf8')).toBe('old artifact file\n');
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('fails closed when Cursor is not detected in the selected home', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  try {
    const error = await installBundle({
      from: fixture.from,
      home,
      host: 'cursor',
      scope: 'user',
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toMatchObject([{
      code: 'AB7002',
      target: 'cursor',
    }]);
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('reports a Cursor home it cannot inspect as AB7004 for the cursor host, like every other Cursor install failure', async () => {
  // POSIX directory modes drive the failure: root ignores them, and Windows has no `getuid` and does not
  // make a `0o000` directory untraversable, so neither can make the lstat fail here.
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const fixture = await createHostBundle('cursor');
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  const home = join(parent, 'home');
  await mkdir(join(home, '.cursor'), { recursive: true });
  await chmod(home, 0o000);
  try {
    const error = await installBundle({
      from: fixture.from,
      home,
      host: 'cursor',
      scope: 'user',
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toMatchObject([{
      code: 'AB7004',
      message: expect.stringContaining('EACCES'),
      severity: 'error',
      target: 'cursor',
    }]);
  } finally {
    await chmod(home, 0o755);
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(parent, { force: true, recursive: true }),
    ]);
  }
});

it('removes the staging parent after a failed replacement and re-raises the refusal as AB7004', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  const installRoot = join(home, '.cursor', 'plugins', 'local');
  await mkdir(installRoot, { recursive: true });
  try {
    const first = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(first.state).toBe('installed');
    const destination = first.destination;
    if (destination === undefined) throw new Error('Expected a local Cursor install destination.');
    // The rebuilt artifact ships a new file exactly where the installed copy holds an unowned one, so
    // the swap is staged in full and then refused by replaceInstalledTree.
    await mkdir(join(fixture.bundleRoot, 'skills', 'new'), { recursive: true });
    await writeFile(join(fixture.bundleRoot, 'skills', 'new', 'SKILL.md'), '# new\n');
    await mkdir(join(destination, 'skills', 'new'), { recursive: true });
    await writeFile(join(destination, 'skills', 'new', 'SKILL.md'), '# operator-owned\n');
    const error = await installBundle({ from: fixture.from, home, host: 'cursor', replace: true, scope: 'user' })
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toMatchObject([{
      code: 'AB7004',
      message: expect.stringContaining('Refusing to overwrite unowned files'),
      target: 'cursor',
    }]);
    // The refusal happened after staging: the staging parent is gone and the installed copy is untouched.
    expect(await readdir(installRoot)).toEqual([destination.slice(installRoot.length + 1)]);
    await expect(readFile(join(destination, 'skills', 'new', 'SKILL.md'), 'utf8')).resolves.toBe('# operator-owned\n');
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('refreshes a receipt whose inventory drifted even when the owned bytes hash equal, and restructures owned paths', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  try {
    await writeFile(join(fixture.bundleRoot, 'removed-later.txt'), 'old\n');
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });

    // The owned file vanished and the rebuild dropped it too: bytes hash equal, inventory does not.
    await rm(join(destination, 'removed-later.txt'));
    await rm(join(fixture.bundleRoot, 'removed-later.txt'));
    const refreshed = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(refreshed).toMatchObject({ state: 'replaced' });
    expect((await readInstallReceipt(destination))?.files).toEqual(['.cursor-plugin/plugin.json', 'payload.txt']);
    // A later unowned file at that path is never mistaken for stale owned content.
    await writeFile(join(destination, 'removed-later.txt'), 'operator\n');
    await writeFile(join(fixture.bundleRoot, 'payload.txt'), 'rebuilt\n');
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(await readFile(join(destination, 'removed-later.txt'), 'utf8')).toBe('operator\n');
    await rm(join(destination, 'removed-later.txt'));

    // Owned file -> directory, then directory -> file.
    await rm(join(fixture.bundleRoot, 'payload.txt'));
    await mkdir(join(fixture.bundleRoot, 'payload.txt'));
    await writeFile(join(fixture.bundleRoot, 'payload.txt', 'nested.md'), '# nested\n');
    const toDirectory = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(toDirectory).toMatchObject({ state: 'replaced' });
    expect(await listFiles(destination)).toEqual([installReceiptFile, '.cursor-plugin/plugin.json', 'payload.txt/nested.md']);
    await rm(join(fixture.bundleRoot, 'payload.txt'), { recursive: true });
    await writeFile(join(fixture.bundleRoot, 'payload.txt'), 'flat again\n');
    const toFile = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(toFile).toMatchObject({ state: 'replaced' });
    expect(await listFiles(destination)).toEqual([installReceiptFile, '.cursor-plugin/plugin.json', 'payload.txt']);
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('flat again\n');

    // An artifact that was run in place may carry state/: it is never installed, hashed, or owned.
    await mkdir(join(destination, 'state'), { recursive: true });
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    await mkdir(join(fixture.bundleRoot, 'state'), { recursive: true });
    await writeFile(join(fixture.bundleRoot, 'state', 'plugin.sqlite'), 'artifact-side state\n');
    const withState = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(withState).toMatchObject({ state: 'already-installed' });
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');
    await writeFile(join(fixture.bundleRoot, 'payload.txt'), 'rebuilt with state beside\n');
    const replacedBesideState = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(replacedBesideState).toMatchObject({ state: 'replaced' });
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');
    expect((await readInstallReceipt(destination))?.files.some((file) => file.startsWith('state/'))).toBe(false);
    await rm(join(fixture.bundleRoot, 'state'), { recursive: true });

    // Flipping only the executable bit is a content change: the installed copy must receive it.
    await chmod(join(fixture.bundleRoot, 'payload.txt'), 0o755);
    const executable = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    expect(executable).toMatchObject({ state: 'replaced' });
    expect((await stat(join(destination, 'payload.txt'))).mode & 0o111).not.toBe(0);
    expect(await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' }))
      .toMatchObject({ state: 'already-installed' });

    // An operator hard link to an owned file under an unrelated name is not ours: incoming path → collision.
    await link(join(destination, 'payload.txt'), join(destination, 'hard-linked.txt'));
    await writeFile(join(fixture.bundleRoot, 'hard-linked.txt'), 'from the artifact\n');
    const hardLink = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect((hardLink as DiagnosticError).diagnostics[0]?.message).toContain('Refusing to overwrite unowned files');
    expect((hardLink as DiagnosticError).diagnostics[0]?.message).toContain('hard-linked.txt');
    await rm(join(fixture.bundleRoot, 'hard-linked.txt'));
    await rm(join(destination, 'hard-linked.txt'));

    // An empty unowned directory at an incoming file path is a collision too (no ownership evidence).
    await rm(join(fixture.bundleRoot, 'payload.txt'));
    await writeFile(join(fixture.bundleRoot, 'payload.txt'), 'flat again\n');
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    await mkdir(join(destination, 'empty-dir'));
    await writeFile(join(fixture.bundleRoot, 'empty-dir'), 'now a file\n');
    const emptyCollision = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect((emptyCollision as DiagnosticError).diagnostics[0]?.message).toContain('Refusing to overwrite unowned files');
    expect((emptyCollision as DiagnosticError).diagnostics[0]?.message).toContain('empty-dir');
    await rm(join(fixture.bundleRoot, 'empty-dir'));
    await rm(join(destination, 'empty-dir'), { recursive: true });

    // An owned directory that also holds an unowned empty subdirectory is a collision, not a restructure.
    await rm(join(fixture.bundleRoot, 'payload.txt'));
    await mkdir(join(fixture.bundleRoot, 'payload.txt'));
    await writeFile(join(fixture.bundleRoot, 'payload.txt', 'nested.md'), '# nested\n');
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    await mkdir(join(destination, 'payload.txt', 'scratch'));
    await rm(join(fixture.bundleRoot, 'payload.txt'), { recursive: true });
    await writeFile(join(fixture.bundleRoot, 'payload.txt'), 'flat\n');
    const emptyNested = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect((emptyNested as DiagnosticError).diagnostics[0]?.message).toContain('Refusing to overwrite unowned files');
    expect(await readFile(join(destination, 'payload.txt', 'nested.md'), 'utf8')).toBe('# nested\n');
    await rm(join(destination, 'payload.txt', 'scratch'), { recursive: true });
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });

    // A directory that also holds an unowned file is a collision, not a restructure.
    await rm(join(fixture.bundleRoot, 'payload.txt'));
    await mkdir(join(fixture.bundleRoot, 'payload.txt'));
    await writeFile(join(fixture.bundleRoot, 'payload.txt', 'nested.md'), '# nested\n');
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    await writeFile(join(destination, 'payload.txt', 'operator.md'), 'mine\n');
    await rm(join(fixture.bundleRoot, 'payload.txt'), { recursive: true });
    await writeFile(join(fixture.bundleRoot, 'payload.txt'), 'flat\n');
    const collision = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect((collision as DiagnosticError).diagnostics[0]?.message).toContain('Refusing to overwrite unowned files');
    expect(await readFile(join(destination, 'payload.txt', 'operator.md'), 'utf8')).toBe('mine\n');
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('refuses to hash or write through a symlinked directory inside a receipt-managed Cursor install', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'agent-bundle-elsewhere-'));
  await mkdir(join(home, '.cursor'));
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  try {
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });

    // An unowned symlinked directory that a rebuilt artifact starts writing beneath: refused before any change.
    await symlink(elsewhere, join(destination, 'skills'));
    await writeFile(join(fixture.bundleRoot, 'payload.txt'), 'rebuilt\n');
    await mkdir(join(fixture.bundleRoot, 'skills', 'new'), { recursive: true });
    await writeFile(join(fixture.bundleRoot, 'skills', 'new', 'SKILL.md'), '# new\n');
    const incoming = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect(incoming).toBeInstanceOf(DiagnosticError);
    expect((incoming as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7004', target: 'cursor' });
    expect((incoming as DiagnosticError).diagnostics[0]?.message).toContain('Refusing unsupported filesystem entry "skills"');
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('payload\n');

    await rm(join(destination, 'skills'));
    await rm(join(fixture.bundleRoot, 'skills'), { recursive: true });

    // A symlinked receipt is never deletion authority.
    const receiptPath = join(destination, installReceiptFile);
    await rm(receiptPath);
    await writeFile(join(elsewhere, 'receipt.json'), JSON.stringify({
      contentHash: 'abc',
      directories: [],
      files: ['payload.txt'],
      format: 'agent-bundle-install-receipt/1',
      host: 'cursor',
      installedAt: '2026-09-03T00:00:00.000Z',
      plugin: 'install-fixture',
      version: '1.2.3',
    }));
    await symlink(join(elsewhere, 'receipt.json'), receiptPath);
    const linkedReceipt = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect((linkedReceipt as DiagnosticError).diagnostics[0]?.message).toContain(
      `Refusing unsupported filesystem entry "${installReceiptFile}"`,
    );
    await rm(join(elsewhere, 'receipt.json'));
    await rm(destination, { force: true, recursive: true });
    expect(await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' }))
      .toMatchObject({ state: 'installed' });

    // An owned path whose ancestor became a symlink (development installs re-point top-level directories).
    await cp(join(destination, '.cursor-plugin'), join(destination, '.real-manifest'), { recursive: true });
    await rm(join(destination, '.cursor-plugin'), { recursive: true });
    await symlink(join(destination, '.real-manifest'), join(destination, '.cursor-plugin'));
    const owned = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect(owned).toBeInstanceOf(DiagnosticError);
    expect((owned as DiagnosticError).diagnostics[0]?.message).toContain('Refusing unsupported filesystem entry ".cursor-plugin"');
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
      rm(elsewhere, { force: true, recursive: true }),
    ]);
  }
});

it('ignores receipts whose file list could escape the plugin root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-receipt-'));
  try {
    for (const files of [
      ['..\\outside'], ['../outside'], ['/etc/passwd'], ['a//b'], ['./x'], ['C:/x'], [installReceiptFile],
      [installReceiptFile.toUpperCase()], ['.Agent-Bundle-Install.json'], [`${installReceiptFile}/nested`],
      ['.Agent-Bundle-Install.json/payload'],
      ['notes.md:stream'], ['trailing.'], ['trailing '], ['bad<name'], ['tab\tname'],
      ['NUL'], ['nul'], ['CON.txt'], ['skills/COM1'], ['LPT1.json'], ['aux.md'], ['prn'],
      ['state/plugin.sqlite'], ['state'], ['State/plugin.sqlite'], ['STATE'],
    ]) {
      // The same rules gate the owned-directory list: it drives `rmdir`, exactly like files drive `rm`.
      for (const field of ['files', 'directories'] as const) {
        await writeJson(join(root, installReceiptFile), {
          contentHash: 'abc',
          directories: [],
          files: [],
          format: 'agent-bundle-install-receipt/1',
          host: 'cursor',
          installedAt: '2026-09-03T00:00:00.000Z',
          plugin: 'install-fixture',
          version: '1.2.3',
          [field]: files,
        });
        expect(await readInstallReceipt(root), `${field} ${JSON.stringify(files)}`).toBeUndefined();
      }
    }
    const complete = {
      contentHash: 'abc',
      directories: ['skills', 'skills/probe'],
      files: ['skills/probe/SKILL.md', 'plugin.json'],
      format: 'agent-bundle-install-receipt/1',
      host: 'cursor',
      installedAt: '2026-09-03T00:00:00.000Z',
      plugin: 'install-fixture',
      version: '1.2.3',
    };
    for (const missing of ['host', 'installedAt', 'contentHash', 'version', 'plugin', 'format', 'directories', 'files'] as const) {
      const { [missing]: _omitted, ...partial } = complete;
      await writeJson(join(root, installReceiptFile), partial);
      expect(await readInstallReceipt(root), missing).toBeUndefined();
    }
    await writeJson(join(root, installReceiptFile), complete);
    // A format/1 receipt (#420) reads with its lifecycle fields synthesized and the downgrade recorded (#101).
    expect(await readInstallReceipt(root)).toEqual({
      contentHash: 'abc',
      directories: ['skills', 'skills/probe'],
      files: ['skills/probe/SKILL.md', 'plugin.json'],
      format: installReceiptFormat,
      host: 'cursor',
      hostDirectories: [],
      installedAt: '2026-09-03T00:00:00.000Z',
      migratedFrom: 'agent-bundle-install-receipt/1',
      mode: 'local',
      plugin: 'install-fixture',
      registrations: [{ kind: 'cursor-local-plugin' }],
      scope: 'user',
      updatedAt: '2026-09-03T00:00:00.000Z',
      version: '1.2.3',
    });
    // A current-format receipt must carry every lifecycle field with a valid shape, or it reads as absent.
    const current = {
      ...complete,
      format: installReceiptFormat,
      hostDirectories: ['plugins', 'plugins/local'],
      mode: 'local',
      registrations: [{ kind: 'cursor-local-plugin' }],
      scope: 'user',
      updatedAt: '2026-09-03T01:00:00.000Z',
    };
    for (const broken of [
      { mode: 'remote' },
      { scope: 'team' },
      { updatedAt: 42 },
      { hostDirectories: ['../outside'] },
      { registrations: [{ kind: 'unknown-kind' }] },
      { registrations: [{ kind: 'claude-plugin', scope: 'team' }] },
      { registrations: 'cursor-local-plugin' },
    ]) {
      await writeJson(join(root, installReceiptFile), { ...current, ...broken });
      expect(await readInstallReceipt(root), JSON.stringify(broken)).toBeUndefined();
    }
    for (const missing of ['mode', 'scope', 'updatedAt', 'hostDirectories', 'registrations'] as const) {
      const { [missing]: _omitted, ...partial } = current;
      await writeJson(join(root, installReceiptFile), partial);
      expect(await readInstallReceipt(root), missing).toBeUndefined();
    }
    await writeJson(join(root, installReceiptFile), { ...current, format: 'agent-bundle-install-receipt/3' });
    expect(await readInstallReceipt(root)).toBeUndefined();
    await writeJson(join(root, installReceiptFile), current);
    expect(await readInstallReceipt(root)).toEqual(current);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('refuses artifact paths that could not round-trip through a receipt', async () => {
  if (process.platform === 'win32') return;
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  try {
    // Includes a case alias of the receipt filename: on a case-insensitive filesystem it is the receipt.
    for (const name of ['back\\slash.txt', 'notes.md:stream', 'trailing.', 'trailing ', 'bad<name', 'CON.txt', '.Agent-Bundle-Install.json']) {
      await writeFile(join(fixture.bundleRoot, name), 'odd\n');
      await expect(treeInventory(fixture.bundleRoot), name).rejects.toThrow(
        `Refusing unsupported filesystem entry ${JSON.stringify(name)}`,
      );
      const refused = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
        .catch((failure: unknown) => failure);
      expect(refused, name).toBeInstanceOf(DiagnosticError);
      expect((refused as DiagnosticError).diagnostics[0], name).toMatchObject({ code: 'AB7004', target: 'cursor' });
      await expect(access(destination), name).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(join(fixture.bundleRoot, name));
    }
    // Nested odd names are refused too, before anything is staged.
    await mkdir(join(fixture.bundleRoot, 'skills', 'odd.'), { recursive: true });
    await writeFile(join(fixture.bundleRoot, 'skills', 'odd.', 'SKILL.md'), '# odd\n');
    await expect(treeInventory(fixture.bundleRoot)).rejects.toThrow('Refusing unsupported filesystem entry "skills/odd./SKILL.md"');
    await rm(join(fixture.bundleRoot, 'skills'), { recursive: true });
    // So is a directory spelled like the receipt: on a case-insensitive filesystem it is the receipt's path.
    await mkdir(join(fixture.bundleRoot, '.Agent-Bundle-Install.json'));
    await writeFile(join(fixture.bundleRoot, '.Agent-Bundle-Install.json', 'payload'), 'odd\n');
    await expect(treeInventory(fixture.bundleRoot)).rejects.toThrow(
      'Refusing unsupported filesystem entry ".Agent-Bundle-Install.json/payload"',
    );
    await rm(join(fixture.bundleRoot, '.Agent-Bundle-Install.json'), { recursive: true });
    expect(await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })).toMatchObject({ state: 'installed' });
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('never lets a receipt claim runtime state: a receipt owning state/ reads as legacy and the store survives', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  try {
    // Emitted bundles carry the install surface; without a trusted receipt that is what marks a copy as legacy.
    await writeFile(join(fixture.bundleRoot, 'INSTALL.md'), '# install\n');
    await writeFile(join(fixture.bundleRoot, 'install.mjs'), '// installer\n');
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    await mkdir(join(destination, 'state'));
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');

    // A corrupted (or pre-policy) receipt that lists the durable store as an owned file.
    const receipt = JSON.parse(await readFile(join(destination, installReceiptFile), 'utf8')) as { files: string[] };
    await writeJson(join(destination, installReceiptFile), { ...receipt, files: [...receipt.files, 'state/plugin.sqlite'] });
    expect(await readInstallReceipt(destination)).toBeUndefined();

    // Same-version drift is no longer automatic: the copy is treated as legacy, nothing is touched.
    await writeFile(join(fixture.bundleRoot, 'payload.txt'), 'rebuilt\n');
    const refused = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect(refused).toBeInstanceOf(DiagnosticError);
    expect((refused as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7005', target: 'cursor' });
    expect((refused as DiagnosticError).diagnostics[0]?.message).toContain('predates install receipts');
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('payload\n');
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');

    // Explicit adoption rewrites the artifact's files and leaves the store alone and unowned.
    expect(await installBundle({ from: fixture.from, home, host: 'cursor', replace: true, scope: 'user' }))
      .toMatchObject({ state: 'replaced' });
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('rebuilt\n');
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');
    expect((await readInstallReceipt(destination))?.files.some((file) => file.startsWith('state/'))).toBe(false);
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('refuses a receipt that is not a regular file before reading it', async () => {
  if (process.platform === 'win32') return;
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  try {
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    const receiptPath = join(destination, installReceiptFile);
    await rm(receiptPath);
    // A FIFO with no writer would block `readFile` forever; the lstat gate refuses it instead.
    await makeFifo(receiptPath);

    const expectRefused = (failure: unknown): void => {
      expect(failure).toBeInstanceOf(DiagnosticError);
      expect((failure as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7004', target: 'cursor' });
      expect((failure as DiagnosticError).diagnostics[0]?.message).toContain(
        `Refusing unsupported filesystem entry "${installReceiptFile}"`,
      );
    };
    expectRefused(await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure));
    expectRefused(await installBundle({ from: fixture.from, home, host: 'cursor', replace: true, scope: 'user' })
      .catch((failure: unknown) => failure));
    await expect(readInstallReceipt(destination)).rejects.toThrow(
      `Refusing unsupported filesystem entry "${installReceiptFile}"`,
    );
    await expect(treeInventory(destination)).rejects.toThrow(
      `Refusing unsupported filesystem entry "${installReceiptFile}"`,
    );
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('payload\n');
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('refuses foreign Cursor directories even with --replace and gates version collisions behind it', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  try {
    // A hand-made directory under the plugin name: manifest present, no receipt, no install surface.
    await writeJson(join(destination, '.cursor-plugin/plugin.json'), { name: 'install-fixture', version: '1.2.3' });
    await writeFile(join(destination, 'payload.txt'), 'someone else\n');
    const foreignHash = (await treeInventory(destination)).hash;
    for (const replace of [false, true]) {
      const error = await installBundle({ from: fixture.from, home, host: 'cursor', replace, scope: 'user' })
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(DiagnosticError);
      expect((error as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7005', target: 'cursor' });
      const message = (error as DiagnosticError).diagnostics[0]?.message ?? '';
      expect(message).toContain('Refusing foreign install');
      expect(message).toContain(`content ${foreignHash.slice(0, 12)}`);
      expect(message).toContain('same version, different content');
    }
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('someone else\n');

    // A different plugin's receipt-managed install at this path is foreign as well, even byte-identical.
    await rm(destination, { force: true, recursive: true });
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    const receipt = JSON.parse(await readFile(join(destination, installReceiptFile), 'utf8')) as Record<string, unknown>;
    await writeJson(join(destination, installReceiptFile), { ...receipt, plugin: 'other-plugin' });
    const identicalForeign = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect((identicalForeign as DiagnosticError).diagnostics[0]?.message).toContain('Refusing foreign install');
    expect((identicalForeign as DiagnosticError).diagnostics[0]?.message).toContain('(same content)');
    await writeJson(join(destination, '.cursor-plugin/plugin.json'), { name: 'other-plugin', version: '1.2.3' });
    const otherError = await installBundle({ from: fixture.from, home, host: 'cursor', replace: true, scope: 'user' })
      .catch((failure: unknown) => failure);
    expect((otherError as DiagnosticError).diagnostics[0]?.message).toContain('Refusing foreign install');
    expect((otherError as DiagnosticError).diagnostics[0]?.message).toContain('installed other-plugin@1.2.3');

    // A receipt-managed install of this plugin at another version needs --replace.
    await rm(destination, { force: true, recursive: true });
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    await writeJson(join(destination, '.cursor-plugin/plugin.json'), { name: 'install-fixture', version: '9.0.0' });
    const versionError = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect(versionError).toBeInstanceOf(DiagnosticError);
    expect((versionError as DiagnosticError).diagnostics[0]?.message).toContain('Refusing version collision');
    expect((versionError as DiagnosticError).diagnostics[0]?.message).toContain('installed install-fixture@9.0.0');
    expect((versionError as DiagnosticError).diagnostics[0]?.message).toContain('(different version)');
    const forced = await installBundle({ from: fixture.from, home, host: 'cursor', replace: true, scope: 'user' });
    expect(forced).toMatchObject({ state: 'replaced', version: '1.2.3' });
    expect(JSON.parse(await readFile(join(destination, '.cursor-plugin/plugin.json'), 'utf8'))).toMatchObject({
      version: '1.2.3',
    });
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('refuses symlinks in a Cursor source bundle', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  await symlink('/tmp', join(fixture.bundleRoot, 'unsafe-link'));
  try {
    const error = await installBundle({
      from: fixture.from,
      home,
      host: 'cursor',
      scope: 'user',
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7004', target: 'cursor' }]);
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('refuses a symlinked Cursor install destination even when its content matches', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  const installRoot = join(home, '.cursor', 'plugins', 'local');
  const destination = join(installRoot, 'install-fixture');
  await mkdir(installRoot, { recursive: true });
  await symlink(fixture.bundleRoot, destination);
  try {
    const error = await installBundle({
      from: fixture.from,
      home,
      host: 'cursor',
      scope: 'user',
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7004', target: 'cursor' }]);
    expect((error as DiagnosticError).diagnostics[0]?.message).toContain(
      'Refusing unsupported filesystem entry "."',
    );
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('rejects a Cursor plugin name that could escape the local install root', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await writeJson(join(fixture.bundleRoot, '.cursor-plugin/plugin.json'), {
    name: '../escape',
    version: '1.2.3',
  });
  try {
    const error = await installBundle({
      from: fixture.from,
      home,
      host: 'cursor',
      scope: 'user',
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7001', target: 'cursor' }]);
    await expect(access(join(home, '.cursor', 'plugins', 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('dispatches the public CLI install command to the native installer', async () => {
  const terminal = captureCliTerminal();
  const calls: unknown[] = [];
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });

  const code = await runCli(
    ['install', 'claude', '--from', '/tmp/example bundle', '--scope', 'project', '--force', '--json'],
    terminal.output,
    {
      installBundle: async (options: unknown) => {
        calls.push(options);
        return {
          bundleRoot: '/tmp/example bundle',
          host: 'claude',
          marketplace: 'fixture-marketplace',
          plugin: 'fixture',
          state: 'installed',
          version: '1.0.0',
        };
      },
    } as unknown as Parameters<typeof runCli>[2],
  );

  expect(code).toBe(0);
  expect(terminal.stderr()).toBe('');
  expect(calls).toEqual([{
    from: '/tmp/example bundle',
    host: 'claude',
    replace: true,
    scope: 'project',
  }]);
  expect(JSON.parse(terminal.stdout())).toMatchObject({
    host: 'claude',
    plugin: 'fixture',
    state: 'installed',
  });
});

const marketplaceRepo = (home: string): string =>
  join(home, '.cursor', 'agent-bundle', 'marketplaces', 'install-fixture');

it('stages a committed local marketplace repository for Cursor in marketplace mode', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const repo = marketplaceRepo(home);
  const { calls, runner } = recordingRunner();
  try {
    const result = await installBundle({
      commandRunner: runner,
      from: fixture.from,
      home,
      host: 'cursor',
      mode: 'marketplace',
      scope: 'user',
    });

    expect(result).toMatchObject({
      destination: repo,
      host: 'cursor',
      marketplace: 'install-fixture-marketplace',
      mode: 'marketplace',
      plugin: 'install-fixture',
      state: 'staged',
      version: '1.2.3',
    });
    expect(result.nextSteps?.[0]).toContain('Add Plugins from Local Repository');
    expect(result.nextSteps?.[0]).toContain(repo);
    const marketplaceManifest = JSON.parse(await readFile(join(repo, '.cursor-plugin/marketplace.json'), 'utf8')) as unknown;
    expect(marketplaceManifest).toEqual({
      metadata: { description: 'Agent Bundle local marketplace for install-fixture@1.2.3.' },
      name: 'install-fixture-marketplace',
      owner: { name: 'install-fixture' },
      plugins: [{ name: 'install-fixture', source: 'plugins/install-fixture' }],
    });
    const validator = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true });
    (addFormats as unknown as (target: Ajv) => void)(validator);
    const validate = validator.compile(cursorMarketplaceSchema);
    expect(validate(marketplaceManifest), JSON.stringify(validate.errors)).toBe(true);
    expect(await readFile(join(repo, 'plugins', 'install-fixture', 'payload.txt'), 'utf8')).toBe('payload\n');
    expect(await readFile(join(repo, 'plugins', 'install-fixture', '.cursor-plugin/plugin.json'), 'utf8'))
      .toContain('"install-fixture"');
    expect(calls.map((call) => [call.command, call.args[0], call.args.at(-1)])).toEqual([
      ['git', 'init', '--object-format=sha1'],
      ['git', '-c', '--force'],
      ['git', '-c', 'install-fixture@1.2.3'],
      ['git', 'ls-tree', 'HEAD'],
      ['git', 'rev-parse', 'HEAD'],
    ]);
    expect(calls[1]?.args).toEqual(['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', 'add', '--all', '--force']);
    expect(calls.every((call) => call.cwd.startsWith(join(home, '.cursor', 'agent-bundle', 'marketplaces')))).toBe(true);
    // Attributes that would rewrite bytes in the index are disabled for every path of the staged repository.
    expect(await readFile(join(repo, '.git', 'info', 'attributes'), 'utf8')).toBe('* -text -eol -filter -ident -working-tree-encoding -export-ignore -export-subst\n');
    await expect(access(join(home, '.cursor', 'plugins', 'local', 'install-fixture'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('re-runs marketplace mode idempotently with real git and refuses collisions', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const repo = marketplaceRepo(home);
  try {
    await writeFile(join(fixture.bundleRoot, '.gitignore'), '*.log\n');
    await writeFile(join(fixture.bundleRoot, 'ignored.log'), 'kept\n');
    // Attributes that would normalise bytes into the index must not change what Cursor imports.
    await writeFile(join(fixture.bundleRoot, '.gitattributes'), '*.txt text eol=lf\n* ident\n');
    await writeFile(join(fixture.bundleRoot, 'crlf.txt'), 'line one\r\nline two $Id$\r\n');
    const first = await installBundle({ from: fixture.from, home, host: 'cursor', mode: 'marketplace' });
    const second = await installBundle({ from: fixture.from, home, host: 'cursor', mode: 'marketplace' });

    expect(first.state).toBe('staged');
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(second).toMatchObject({ commit: first.commit, destination: repo, state: 'already-installed' });
    await access(join(repo, '.git', 'HEAD'));
    // Files the bundle's own .gitignore would exclude are still committed (Cursor imports the commit, not the tree).
    const { stdout: tracked } = await execFile('git', ['ls-files'], { cwd: repo });
    expect(tracked.split('\n')).toEqual(expect.arrayContaining([
      'plugins/install-fixture/.gitattributes',
      'plugins/install-fixture/.gitignore',
      'plugins/install-fixture/crlf.txt',
      'plugins/install-fixture/ignored.log',
      'plugins/install-fixture/payload.txt',
    ]));
    const { stdout: committedCrlf } = await execFile('git', ['cat-file', 'blob', 'HEAD:plugins/install-fixture/crlf.txt'], { cwd: repo, encoding: 'buffer' });
    expect(Buffer.from(committedCrlf).toString('utf8')).toBe('line one\r\nline two $Id$\r\n');

    const manifestPath = join(repo, '.cursor-plugin', 'marketplace.json');
    const manifest = await readFile(manifestPath, 'utf8');
    await writeJson(manifestPath, { ...JSON.parse(manifest), plugins: [{ name: 'other-plugin', source: 'plugins/other-plugin' }] });
    const manifestError = await installBundle({ from: fixture.from, home, host: 'cursor', mode: 'marketplace' })
      .catch((failure: unknown) => failure);
    expect((manifestError as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7005' }]);
    expect((manifestError as DiagnosticError).diagnostics[0]?.message).toContain('marketplace.json differs');
    await writeFile(manifestPath, manifest);
    expect(await installBundle({ from: fixture.from, home, host: 'cursor', mode: 'marketplace' })).toMatchObject({ state: 'already-installed' });

    // The working tree may match the bundle while HEAD records different bytes; Cursor imports HEAD, so refuse.
    const git = async (args: readonly string[]): Promise<string> => (await execFile('git', [...args], { cwd: repo })).stdout;
    await writeFile(join(repo, 'plugins', 'install-fixture', 'payload.txt'), 'committed elsewhere\n');
    await git(['add', '--all']);
    await git(['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'edit']);
    await writeFile(join(repo, 'plugins', 'install-fixture', 'payload.txt'), 'payload\n');
    const dirtyError = await installBundle({ from: fixture.from, home, host: 'cursor', mode: 'marketplace' })
      .catch((failure: unknown) => failure);
    expect((dirtyError as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7005' }]);
    expect((dirtyError as DiagnosticError).diagnostics[0]?.message).toContain('committed HEAD');
    await git(['reset', '-q', '--hard', first.commit ?? 'HEAD~1']);
    expect(await installBundle({ from: fixture.from, home, host: 'cursor', mode: 'marketplace' })).toMatchObject({ commit: first.commit, state: 'already-installed' });

    // An ignored, uncommitted file in the staged tree also means HEAD is not what was verified.
    await writeFile(join(repo, 'plugins', 'install-fixture', 'stray.log'), 'not committed\n');
    await writeFile(join(fixture.bundleRoot, 'stray.log'), 'not committed\n');
    const ignoredError = await installBundle({ from: fixture.from, home, host: 'cursor', mode: 'marketplace' })
      .catch((failure: unknown) => failure);
    expect((ignoredError as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7005' }]);
    expect((ignoredError as DiagnosticError).diagnostics[0]?.message).toContain('committed HEAD');
    await rm(join(repo, 'plugins', 'install-fixture', 'stray.log'));
    await rm(join(fixture.bundleRoot, 'stray.log'));

    await writeFile(join(repo, 'plugins', 'install-fixture', 'payload.txt'), 'changed\n');
    const contentError = await installBundle({ from: fixture.from, home, host: 'cursor', mode: 'marketplace' })
      .catch((failure: unknown) => failure);
    expect((contentError as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7005' }]);
    expect((contentError as DiagnosticError).diagnostics[0]?.message).toContain('content collision');

    await writeJson(join(repo, 'plugins', 'install-fixture', '.cursor-plugin/plugin.json'), {
      name: 'install-fixture',
      version: '9.0.0',
    });
    const versionError = await installBundle({ from: fixture.from, home, host: 'cursor', mode: 'marketplace' })
      .catch((failure: unknown) => failure);
    expect((versionError as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7005' }]);
    expect((versionError as DiagnosticError).diagnostics[0]?.message).toContain('version collision');
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('fails closed without git in marketplace mode and leaves no staged repository', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const missing = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  try {
    const error = await installBundle({
      commandRunner: { run: async () => { throw missing; } },
      from: fixture.from,
      home,
      host: 'cursor',
      mode: 'marketplace',
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DiagnosticError);
    expect((error as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7002', target: 'cursor' }]);
    expect((error as DiagnosticError).diagnostics[0]?.message).toContain('--mode local');
    await expect(access(marketplaceRepo(home))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('refuses marketplace mode for an Agent Plugins bundle without .cursor-plugin/plugin.json', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const { calls, runner } = recordingRunner();
  try {
    await rm(join(fixture.bundleRoot, '.cursor-plugin'), { recursive: true });
    await writeJson(join(fixture.bundleRoot, 'plugin.json'), { name: 'install-fixture', version: '1.2.3' });
    const error = await installBundle({
      commandRunner: runner,
      from: fixture.from,
      home,
      host: 'cursor',
      mode: 'marketplace',
    }).catch((failure: unknown) => failure);

    // The public install path already fails closed on the missing Cursor manifest (AB7001);
    // stageCursorMarketplace repeats the check (AB7003) for direct callers.
    expect((error as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7001', target: 'cursor' }]);
    expect((error as DiagnosticError).diagnostics[0]?.message).toContain('No cursor bundle manifest');
    expect(calls).toEqual([]);
    await expect(access(join(home, '.cursor', 'agent-bundle'))).rejects.toMatchObject({ code: 'ENOENT' });

    const direct = await stageCursorMarketplace({
      cursorRoot: join(home, '.cursor'),
      identity: { bundleRoot: fixture.bundleRoot, plugin: 'install-fixture', version: '1.2.3' },
      runner,
      treeHash: async () => 'unused',
    }).catch((failure: unknown) => failure);
    expect((direct as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7003', target: 'cursor' }]);
    expect((direct as DiagnosticError).diagnostics[0]?.message).toContain('--mode local');
    expect(calls).toEqual([]);
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('refuses marketplace mode for a bundle that contains nested Git metadata', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const { calls, runner } = recordingRunner();
  try {
    // A `.git` anywhere in the bundle would be committed as an empty gitlink (mode 160000), not as files.
    await mkdir(join(fixture.bundleRoot, 'vendor', 'tool', '.git'), { recursive: true });
    await writeJson(join(fixture.bundleRoot, 'vendor', 'tool', '.git', 'config'), {});
    const error = await installBundle({
      commandRunner: runner,
      from: fixture.from,
      home,
      host: 'cursor',
      mode: 'marketplace',
    }).catch((failure: unknown) => failure);

    expect((error as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7003', target: 'cursor' }]);
    expect((error as DiagnosticError).diagnostics[0]?.message).toContain(join('vendor', 'tool', '.git'));
    expect(calls).toEqual([]);
    await expect(access(join(home, '.cursor', 'agent-bundle'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('fails closed when the committed tree does not hold the staged bytes', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  // A git that silently transformed one blob (e.g. through a clean filter) reports a different id for it.
  const { runner } = recordingRunner(async (call) => (await gitLike(call))
    .replace(/[0-9a-f]{40}(\tplugins\/install-fixture\/payload\.txt)/u, `${'0'.repeat(40)}$1`));
  try {
    const error = await installBundle({ commandRunner: runner, from: fixture.from, home, host: 'cursor', mode: 'marketplace' })
      .catch((failure: unknown) => failure);
    expect((error as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7004', target: 'cursor' }]);
    expect((error as DiagnosticError).diagnostics[0]?.message).toContain('plugins/install-fixture/payload.txt');
    await expect(access(marketplaceRepo(home))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(home, '.cursor', 'agent-bundle', 'marketplaces'))).toEqual([]);
  } finally {
    await Promise.all([
      rm(fixture.cleanupRoot, { force: true, recursive: true }),
      rm(home, { force: true, recursive: true }),
    ]);
  }
});

it('rejects an install mode for hosts other than Cursor', async () => {
  const fixture = await createHostBundle('claude');
  const { calls, runner } = recordingRunner();
  try {
    const error = await installBundle({
      commandRunner: runner,
      from: fixture.from,
      host: 'claude',
      mode: 'marketplace',
    }).catch((failure: unknown) => failure);

    expect((error as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7003', target: 'claude' }]);
    expect(calls).toEqual([]);
  } finally {
    await rm(fixture.cleanupRoot, { force: true, recursive: true });
  }
});

it('passes --mode through the public CLI and prints the staged next steps', async () => {
  const calls: unknown[] = [];
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });
  const dependencies = {
    installBundle: async (options: unknown) => {
      calls.push(options);
      return {
        bundleRoot: '/tmp/example bundle',
        commit: 'abc123',
        destination: '/home/user/.cursor/agent-bundle/marketplaces/fixture',
        host: 'cursor',
        marketplace: 'fixture-marketplace',
        mode: 'marketplace',
        nextSteps: ['Open Cursor and import /home/user/.cursor/agent-bundle/marketplaces/fixture.'],
        plugin: 'fixture',
        state: 'staged',
        version: '1.0.0',
      };
    },
  } as unknown as Parameters<typeof runCli>[2];

  const terminal = captureCliTerminal();
  const code = await runCli(
    ['install', 'cursor', '--from', '/tmp/example bundle', '--mode', 'marketplace'],
    terminal.output,
    dependencies,
  );

  expect(code).toBe(0);
  expect(terminal.stderr()).toBe('');
  expect(calls).toEqual([{ from: '/tmp/example bundle', host: 'cursor', mode: 'marketplace', replace: false, scope: 'user' }]);
  expect(terminal.stdout()).toBe([
    'Staged fixture@1.0.0 for cursor (marketplace mode) at /home/user/.cursor/agent-bundle/marketplaces/fixture',
    'Marketplace: fixture-marketplace @ abc123',
    'Next steps:',
    '  1. Open Cursor and import /home/user/.cursor/agent-bundle/marketplaces/fixture.',
    '',
  ].join('\n'));

  const invalidTerminal = captureCliTerminal();
  const invalid = await runCli(
    ['install', 'cursor', '--from', '/tmp/example bundle', '--mode', 'remote'],
    invalidTerminal.output,
    dependencies,
  );
  expect(invalid).not.toBe(0);
  expect(invalidTerminal.stderr()).toContain('Install mode must be local or marketplace.');
});

it('labels a repeated marketplace-mode run as already staged, not installed', () => {
  const base = {
    bundleRoot: '/tmp/example bundle',
    host: 'cursor' as const,
    plugin: 'fixture',
    state: 'already-installed' as const,
    version: '1.0.0',
  };
  expect(formatInstallResult({
    ...base,
    commit: 'abc123',
    destination: '/home/user/.cursor/agent-bundle/marketplaces/fixture',
    marketplace: 'fixture-marketplace',
    mode: 'marketplace',
    nextSteps: ['Open Cursor and import the repository.'],
  })).toBe([
    'Already staged fixture@1.0.0 for cursor (marketplace mode) at /home/user/.cursor/agent-bundle/marketplaces/fixture',
    'Marketplace: fixture-marketplace @ abc123',
    'Next steps:',
    '  1. Open Cursor and import the repository.',
    '',
  ].join('\n'));
  expect(formatInstallResult({ ...base, destination: '/home/user/.cursor/plugins/local/fixture', mode: 'local' }))
    .toBe('Already installed fixture@1.0.0 for cursor (local mode) at /home/user/.cursor/plugins/local/fixture\n');
});
