import { execFile as executeFile } from 'node:child_process';
import { access, chmod, cp, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { installBundle, type InstallCommandRunner } from '../src/install/install.ts';
import {
  installReceiptFile,
  readInstallReceipt,
  treeInventory,
} from '../src/install/receipt.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';
import { runCli } from '../src/cli.ts';

interface CommandCall {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
}

const recordingRunner = (
  respond: (call: CommandCall) => string = () => '',
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
        return { code: 0, stderr: '', stdout: respond(call) };
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

it.each([
  {
    expected: [
      { args: ['plugin', 'list', '--json'], command: 'claude' },
      { args: ['plugin', 'marketplace', 'add', resolve('/bundle')], command: 'claude' },
      {
        args: ['plugin', 'install', 'install-fixture@install-fixture-marketplace', '--scope', 'project'],
        command: 'claude',
      },
    ],
    host: 'claude' as const,
    scope: 'project' as const,
  },
  {
    expected: [
      { args: ['plugin', 'list', '--json'], command: 'codex' },
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
    const result = await installBundle({ commandRunner: runner, from: fixture.from, host, scope });

    expect(result).toMatchObject({
      contentHash: (await treeInventory(fixture.bundleRoot)).hash,
      host,
      plugin: 'install-fixture',
      state: 'installed',
    });
    expect(calls).toEqual(expected.map((call) => ({ ...call, args: call.args.map((arg) =>
      arg === resolve('/bundle') ? fixture.bundleRoot : arg), cwd: fixture.bundleRoot })));
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
  const { calls, runner } = recordingRunner((call) => isInventoryCall(call) ? claudeInventory(installed) : '');
  try {
    const identical = await installBundle({ commandRunner: runner, from: fixture.from, host: 'claude', scope: 'user' });
    expect(identical).toMatchObject({ destination: installed, host: 'claude', state: 'already-installed' });
    expect(calls.map((call) => call.args.join(' '))).toEqual(['plugin list --json']);

    calls.length = 0;
    await writeFile(join(installed, 'payload.txt'), 'stale\n');
    const replaced = await installBundle({ commandRunner: runner, from: fixture.from, host: 'claude', scope: 'user' });
    expect(replaced).toMatchObject({
      contentHash: (await treeInventory(fixture.bundleRoot)).hash,
      destination: installed,
      previousContentHash: (await treeInventory(installed)).hash,
      state: 'replaced',
    });
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'plugin list --json',
      'plugin uninstall install-fixture@install-fixture-marketplace --scope user --keep-data',
      `plugin marketplace add ${fixture.bundleRoot}`,
      'plugin install install-fixture@install-fixture-marketplace --scope user',
    ]);

    // A reported copy that cannot be compared never passes as "no drift": fail closed without --replace.
    const missingCache = recordingRunner((call) => isInventoryCall(call)
      ? claudeInventory(join(fixture.cleanupRoot, 'claude-cache', 'missing'))
      : '');
    const uncomparable = await installBundle({ commandRunner: missingCache.runner, from: fixture.from, host: 'claude', scope: 'user' })
      .catch((failure: unknown) => failure);
    expect(uncomparable).toBeInstanceOf(DiagnosticError);
    expect((uncomparable as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7004', target: 'claude' });
    expect((uncomparable as DiagnosticError).diagnostics[0]?.message).toContain('could not be compared');
    expect(missingCache.calls).toHaveLength(1);
    const reinstalled = await installBundle({ commandRunner: missingCache.runner, from: fixture.from, host: 'claude', replace: true, scope: 'user' });
    expect(reinstalled).toMatchObject({ state: 'replaced' });
    expect(reinstalled.previousContentHash).toBeUndefined();

    // A matching row without a readable scope or version is an unusable inventory, not "not installed".
    for (const row of [
      { id: 'install-fixture@install-fixture-marketplace', installPath: installed, version: '1.2.3' },
      { id: 'install-fixture@install-fixture-marketplace', installPath: installed, scope: 'user' },
    ]) {
      const malformed = recordingRunner((call) => isInventoryCall(call) ? JSON.stringify([row]) : '');
      const error = await installBundle({
        commandRunner: malformed.runner,
        from: fixture.from,
        host: 'claude',
        replace: true,
        scope: 'user',
      }).catch((failure: unknown) => failure);
      expect(error, JSON.stringify(row)).toBeInstanceOf(DiagnosticError);
      expect((error as DiagnosticError).diagnostics[0]?.message).toContain('plugin list --json was unusable');
      expect(malformed.calls).toHaveLength(1);
    }
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
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'plugin list --json',
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
      const error = await installBundle({
        commandRunner: unusable.runner,
        from: fixture.from,
        host: 'codex',
        replace: true,
        scope: 'user',
      }).catch((failure: unknown) => failure);
      expect(error, stdout).toBeInstanceOf(DiagnosticError);
      expect((error as DiagnosticError).diagnostics[0]).toMatchObject({ code: 'AB7004', target: 'codex' });
      expect((error as DiagnosticError).diagnostics[0]?.message).toContain('plugin list --json was unusable');
      expect(unusable.calls).toHaveLength(1);
    }
  } finally {
    await rm(fixture.cleanupRoot, { force: true, recursive: true });
  }
});

it('accepts an artifact root containing the requested host target', async () => {
  const fixture = await createHostBundle('claude', { artifactRoot: true });
  const { calls, runner } = recordingRunner();
  try {
    const result = await installBundle({
      commandRunner: runner,
      from: fixture.from,
      host: 'claude',
      scope: 'user',
    });

    expect(result.bundleRoot).toBe(fixture.bundleRoot);
    expect(calls[0]).toMatchObject({ cwd: fixture.bundleRoot });
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
      format: 'agent-bundle-install-receipt/1',
      host: 'cursor',
      plugin: 'install-fixture',
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
      ['notes.md:stream'], ['trailing.'], ['trailing '], ['bad<name'], ['tab\tname'],
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
    expect(await readInstallReceipt(root)).toMatchObject({
      directories: ['skills', 'skills/probe'],
      files: ['skills/probe/SKILL.md', 'plugin.json'],
    });
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
    for (const name of ['back\\slash.txt', 'notes.md:stream', 'trailing.', 'trailing ', 'bad<name']) {
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
  const stderr: string[] = [];
  const stdout: string[] = [];
  const calls: unknown[] = [];
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });

  const code = await runCli(
    ['install', 'claude', '--from', '/tmp/example bundle', '--scope', 'project', '--force', '--json'],
    {
      stderr: { write: (chunk: string) => stderr.push(chunk) },
      stdout: { write: (chunk: string) => stdout.push(chunk) },
    },
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
  expect(stderr.join('')).toBe('');
  expect(calls).toEqual([{
    from: '/tmp/example bundle',
    host: 'claude',
    replace: true,
    scope: 'project',
  }]);
  expect(JSON.parse(stdout.join(''))).toMatchObject({
    host: 'claude',
    plugin: 'fixture',
    state: 'installed',
  });
});
