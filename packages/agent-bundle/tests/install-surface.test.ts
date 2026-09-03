import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import type { TargetArtifactWrite } from '../src/adapters/types.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import { installReceiptFile, readInstallReceipt, treeInventory } from '../src/install/receipt.ts';

const execFile = promisify(executeFile);

const modelFor = (target: string): NormalizedPlugin => ({
  extensions: {},
  hooks: [],
  mcpServers: [],
  metadata: {
    description: 'Checks host installation.',
    id: 'plugin:install-fixture',
    name: 'install-fixture',
    provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
    version: '1.2.3',
  },
  runtime: { node: '22.19.0' },
  scripts: [],
  skills: [],
  targets: [{
    id: `target:${target}`,
    name: target,
    provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
  }],
});

const writesFor = (target: string): ReadonlyMap<string, string> => {
  const plan = createDefaultRegistry().get(target).plan(modelFor(target));
  return new Map(plan.entries
    .filter((entry): entry is TargetArtifactWrite => entry.kind === 'write')
    .map((entry) => [entry.relativePath, entry.content]));
};

it.each(['claude', 'codex', 'cursor', 'portable', 'plugin'])(
  'emits a concrete INSTALL.md for the %s target',
  (target) => {
    const install = writesFor(target).get('INSTALL.md');

    expect(install).toContain('# Install install-fixture');
    expect(install).toContain('Version: `1.2.3`');
    expect(install).not.toContain('<plugin>');
    expect(install).not.toContain('<marketplace>');
    expect(install).not.toContain('<scope>');
  },
);

it('emits always-installable Claude and Codex local marketplaces with exact commands', () => {
  const claude = writesFor('claude');
  const codex = writesFor('codex');

  expect(JSON.parse(claude.get('.claude-plugin/marketplace.json')!)).toMatchObject({
    name: 'install-fixture-marketplace',
    plugins: [{ name: 'install-fixture', source: './', version: '1.2.3' }],
  });
  expect(claude.get('INSTALL.md')).toContain('claude plugin marketplace add ./');
  expect(claude.get('INSTALL.md')).toContain(
    'claude plugin install install-fixture@install-fixture-marketplace --scope user',
  );

  expect(JSON.parse(codex.get('.agents/plugins/marketplace.json')!)).toMatchObject({
    name: 'install-fixture-marketplace',
    plugins: [{ name: 'install-fixture', source: { path: './', source: 'local' } }],
  });
  expect(codex.get('INSTALL.md')).toContain('codex plugin marketplace add ./');
  expect(codex.get('INSTALL.md')).toContain(
    'codex plugin add install-fixture@install-fixture-marketplace',
  );
});

it('emits a standalone safe-copy installer only for Cursor-compatible fallback profiles', () => {
  for (const target of ['cursor', 'portable', 'plugin']) {
    const writes = writesFor(target);
    expect(writes.get('INSTALL.md')).toContain('node ./install.mjs');
    expect(writes.get('install.mjs')).toContain("join(cursorRoot, 'plugins', 'local')");
    expect(writes.get('install.mjs')).toContain('const rootMetadata = await lstat(root);');
    expect(writes.get('install.mjs')).toContain(
      'rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()',
    );
    expect(writes.get('install.mjs')).toContain('install-fixture');
    expect(writes.get('install.mjs')).toContain('1.2.3');
    expect(writes.get('install.mjs')).not.toContain('sudo');
  }
  for (const target of ['claude', 'codex']) {
    expect(writesFor(target).has('install.mjs')).toBe(false);
  }
});

it('documents native Agent Plugins clients for the portable profile', () => {
  const install = writesFor('portable').get('INSTALL.md');

  expect(install).toContain(
    'the Agent Plugins open standard (Agent Plugins 1.0.0, https://agent-plugins.org)',
  );
  expect(install).toContain('`~/.cursor/plugins/local/<name>`');
  expect(install).toContain('Developer: Reload Window');
  expect(install).toContain('Codex, VS Code, GitHub Copilot, Kiro, and ChatGPT');
});

it('documents every real host path from the composite profile', () => {
  const install = writesFor('plugin').get('INSTALL.md');

  expect(install).toContain('claude plugin install install-fixture@install-fixture-marketplace --scope user');
  expect(install).toContain('codex plugin add install-fixture@install-fixture-marketplace');
  expect(install).toContain('node ./install.mjs');
});

it('documents the same-version reinstall recipe per host, including Claude\'s version-gated update', () => {
  const claude = writesFor('claude').get('INSTALL.md') ?? '';
  expect(claude).toContain('Reinstall after a same-version rebuild');
  expect(claude).toContain('version-gated');
  expect(claude).toContain('claude plugin uninstall install-fixture@install-fixture-marketplace --scope user --keep-data');
  expect(claude).toContain('agent-bundle install claude --from ./');
  expect(claude).toContain('--replace');

  const codex = writesFor('codex').get('INSTALL.md') ?? '';
  expect(codex).toContain('Reinstall after a same-version rebuild');
  expect(codex).toContain('codex plugin remove install-fixture@install-fixture-marketplace');
  expect(codex).toContain('--replace');

  for (const target of ['cursor', 'portable', 'plugin']) {
    const install = writesFor(target).get('INSTALL.md') ?? '';
    expect(install).toContain(installReceiptFile);
    expect(install).toContain('--replace');
    expect(install).toContain('`state/`');
  }
  expect(writesFor('cursor').get('INSTALL.md')).toContain('node ./install.mjs --replace');
  expect(writesFor('cursor').get('INSTALL.md')).toContain('content-hash comparison');

  const installer = writesFor('cursor').get('install.mjs') ?? '';
  expect(installer).toContain("argument === '--replace' || argument === '--force'");
  expect(installer).toContain(`const receiptFile = ${JSON.stringify(installReceiptFile)};`);
  expect(installer).toContain('Refusing foreign install');
  expect(installer).toContain('Refusing content collision');
  expect(installer).toContain('Refusing version collision');
  expect(installer).toContain('Refusing to overwrite unowned files');
  expect(installer).toContain("!value.includes('\\\\')");
});

const run = async (
  installer: string,
  args: readonly string[],
  home: string,
): Promise<{ readonly code: number; readonly stderr: string; readonly stdout: string }> => {
  try {
    const result = await execFile(process.execPath, [installer, ...args], {
      cwd: dirname(installer),
      env: { ...process.env, HOME: home },
    });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    const failure = error as { readonly code?: number; readonly stderr?: string; readonly stdout?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stderr: failure.stderr ?? '', stdout: failure.stdout ?? '' };
  }
};

const listFiles = async (root: string): Promise<readonly string[]> =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort((left, right) => left.localeCompare(right));

it('emitted install.mjs mirrors the core replace policy: no-op, owned-only replace, legacy gate, foreign refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-install-mjs-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  const installer = join(bundle, 'install.mjs');
  try {
    const writes = writesFor('cursor');
    await mkdir(join(bundle, '.cursor-plugin'), { recursive: true });
    await mkdir(join(home, '.cursor'), { recursive: true });
    await Promise.all([
      writeFile(installer, writes.get('install.mjs') ?? ''),
      writeFile(join(bundle, 'INSTALL.md'), writes.get('INSTALL.md') ?? ''),
      writeFile(join(bundle, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'install-fixture', version: '1.2.3' })),
      writeFile(join(bundle, 'payload.txt'), 'payload\n'),
      writeFile(join(bundle, 'removed-later.txt'), 'old\n'),
    ]);

    const help = await run(installer, ['--help'], home);
    expect(help).toMatchObject({ code: 0 });
    expect(help.stdout).toContain('[--replace|--force]');
    const unknown = await run(installer, ['--bogus'], home);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Unknown installer argument "--bogus"');

    const first = await run(installer, [], home);
    expect(first).toMatchObject({ code: 0, stderr: '' });
    expect(first.stdout).toContain('Installed install-fixture@1.2.3');
    const firstArtifact = await treeInventory(bundle);
    // The emitted receipt is byte-compatible with the core reader.
    expect(await readInstallReceipt(destination)).toMatchObject({
      contentHash: firstArtifact.hash,
      files: firstArtifact.files,
      host: 'cursor',
      plugin: 'install-fixture',
      version: '1.2.3',
    });

    const again = await run(installer, [], home);
    expect(again).toMatchObject({ code: 0, stderr: '' });
    expect(again.stdout).toContain('Already installed install-fixture@1.2.3');
    const forcedNoop = await run(installer, ['--replace'], home);
    expect(forcedNoop.stdout).toContain('Already installed install-fixture@1.2.3');

    // Same version, different content: owned files replaced, runtime state and operator files preserved.
    await mkdir(join(destination, 'state'), { recursive: true });
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    await writeFile(join(bundle, 'payload.txt'), 'rebuilt\n');
    await rm(join(bundle, 'removed-later.txt'));
    const replaced = await run(installer, [], home);
    expect(replaced).toMatchObject({ code: 0, stderr: '' });
    expect(replaced.stdout).toContain('Replaced install-fixture@1.2.3');
    expect(replaced.stdout).toContain(`-> ${(await treeInventory(bundle)).hash.slice(0, 12)}`);
    expect(await listFiles(destination)).toEqual([
      installReceiptFile,
      '.cursor-plugin/plugin.json',
      'INSTALL.md',
      'install.mjs',
      'payload.txt',
      'state/plugin.sqlite',
    ]);
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('rebuilt\n');
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');

    // An incoming file that would land on an existing unowned file aborts before any change.
    await writeFile(join(destination, 'notes.md'), 'operator\n');
    await writeFile(join(bundle, 'notes.md'), 'artifact\n');
    const collision = await run(installer, [], home);
    expect(collision.code).toBe(1);
    expect(collision.stderr).toContain('Refusing to overwrite unowned files');
    expect(collision.stderr).toContain('notes.md');
    expect(await readFile(join(destination, 'notes.md'), 'utf8')).toBe('operator\n');
    await rm(join(bundle, 'notes.md'));
    await rm(join(destination, 'notes.md'));

    // Byte-identical legacy copy (receipt-less copies hash as a full tree, so runtime state is cleared
    // first): plain rerun is a no-op, --replace adopts it by writing the receipt.
    await rm(join(destination, installReceiptFile));
    await rm(join(destination, 'state'), { force: true, recursive: true });
    const identicalLegacy = await run(installer, [], home);
    expect(identicalLegacy).toMatchObject({ code: 0, stderr: '' });
    expect(identicalLegacy.stdout).toContain('Already installed install-fixture@1.2.3');
    expect(await readInstallReceipt(destination)).toBeUndefined();
    const adoptedIdentical = await run(installer, ['--replace'], home);
    expect(adoptedIdentical).toMatchObject({ code: 0, stderr: '' });
    expect(adoptedIdentical.stdout).toContain('Adopted install-fixture@1.2.3');
    expect(await readInstallReceipt(destination)).toMatchObject({
      contentHash: (await treeInventory(bundle)).hash,
      plugin: 'install-fixture',
    });

    // A receipt missing a field reads as absent, exactly like the core reader: the legacy gate applies.
    const receipt = JSON.parse(await readFile(join(destination, installReceiptFile), 'utf8')) as Record<string, unknown>;
    const { host: _host, ...partialReceipt } = receipt;
    await writeFile(join(destination, installReceiptFile), JSON.stringify(partialReceipt));
    await writeFile(join(bundle, 'payload.txt'), 'rebuilt again\n');
    const partial = await run(installer, [], home);
    expect(partial.code).toBe(1);
    expect(partial.stderr).toContain('Refusing content collision');
    expect(partial.stderr).toContain('predates install receipts');
    await writeFile(join(bundle, 'payload.txt'), 'rebuilt\n');

    // An unowned symlinked directory beneath which the artifact starts writing: refused before any change.
    await writeFile(join(destination, installReceiptFile), JSON.stringify(receipt));
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, join(destination, 'skills'));
    await mkdir(join(bundle, 'skills', 'new'), { recursive: true });
    await writeFile(join(bundle, 'skills', 'new', 'SKILL.md'), '# new\n');
    const symlinked = await run(installer, [], home);
    expect(symlinked.code).toBe(1);
    expect(symlinked.stderr).toContain('Refusing unsupported filesystem entry "skills"');
    expect(await readdir(elsewhere)).toEqual([]);
    await rm(join(destination, 'skills'));
    await rm(join(bundle, 'skills'), { recursive: true });

    // Legacy pre-receipt copy with drift: refused with a hash comparison until --replace adopts it.
    await rm(join(destination, installReceiptFile));
    await writeFile(join(destination, 'payload.txt'), 'legacy\n');
    const legacyHash = (await treeInventory(destination)).hash;
    const legacy = await run(installer, [], home);
    expect(legacy.code).toBe(1);
    expect(legacy.stderr).toContain('Refusing content collision');
    expect(legacy.stderr).toContain(`content ${legacyHash.slice(0, 12)}`);
    expect(legacy.stderr).toContain('same version, different content');
    expect(legacy.stderr).toContain('--replace');
    const adopted = await run(installer, ['--force'], home);
    expect(adopted).toMatchObject({ code: 0, stderr: '' });
    expect(adopted.stdout).toContain('Replaced install-fixture@1.2.3');
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('rebuilt\n');
    expect(await readInstallReceipt(destination)).toMatchObject({ plugin: 'install-fixture' });

    // Foreign directory under the plugin name: refused even with --replace.
    await rm(destination, { force: true, recursive: true });
    await mkdir(join(destination, '.cursor-plugin'), { recursive: true });
    await writeFile(join(destination, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'install-fixture', version: '1.2.3' }));
    await writeFile(join(destination, 'payload.txt'), 'someone else\n');
    const foreign = await run(installer, ['--replace'], home);
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toContain('Refusing foreign install');
    expect(foreign.stderr).toContain('same version, different content');
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('someone else\n');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
