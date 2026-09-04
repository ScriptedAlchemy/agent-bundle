import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
    expect(writes.get('install.mjs')).toContain("if (mode === 'marketplace') {");
    expect(writes.get('install.mjs')).toContain("join(cursorRoot, 'agent-bundle', 'marketplaces')");
    expect(writes.get('install.mjs')).toContain('Add Plugins from Local Repository');
    expect(writes.get('install.mjs')).toContain("await git(stage, ['init', '-q', '--object-format=sha1']);");
    // Bytes must survive the commit unchanged: attributes disabled, autocrlf off, blob ids proven against HEAD.
    expect(writes.get('install.mjs')).toContain("'* -text -eol -filter -ident -working-tree-encoding -export-ignore -export-subst\\n'");
    expect(writes.get('install.mjs')).toContain("['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', 'add', '--all', '--force']");
    expect(writes.get('install.mjs')).toContain("await git(stage, ['ls-tree', '-r', '-z', 'HEAD'])");
    expect(writes.get('install.mjs')).toContain('the committed tree differs from the staged bundle bytes');
    // Owner/description are read from the emitted .cursor-plugin/plugin.json at run time, not baked in.
    expect(writes.get('install.mjs')).toContain("typeof manifest?.author?.name === 'string' ? manifest.author.name : pluginName");
    expect(writes.get('install.mjs')).not.toContain('const pluginDescription');
    expect(writes.get('install.mjs')).toContain("await findNestedGit(source)");
  }
  for (const target of ['claude', 'codex']) {
    expect(writesFor(target).has('install.mjs')).toBe(false);
  }
});

it('documents both Cursor delivery modes without user-level hooks registration', () => {
  const install = writesFor('cursor').get('INSTALL.md');

  expect(install).toContain('### Local plugin (default)');
  expect(install).toContain('`~/.cursor/plugins/local/install-fixture`');
  expect(install).toContain('need no `~/.cursor/hooks.json` entry');
  expect(install).toContain('### Marketplace plugin');
  expect(install).toContain('node ./install.mjs --mode marketplace');
  expect(install).toContain('`~/.cursor/agent-bundle/marketplaces/install-fixture`');
  expect(install).toContain('"Add Plugins from Local Repository"');
  expect(install).toContain('`agent-bundle doctor --host cursor`');
});

it('documents native Agent Plugins clients for the portable profile', () => {
  const install = writesFor('portable').get('INSTALL.md');

  expect(install).toContain(
    'the Agent Plugins open standard (Agent Plugins 1.0.0, https://agent-plugins.org)',
  );
  expect(install).toContain('`~/.cursor/plugins/local/<name>`');
  expect(install).toContain('Developer: Reload Window');
  expect(install).toContain('Codex, VS Code, GitHub Copilot, Kiro, and ChatGPT');
  // The Cursor-only placeholder expansion is documented where the installer is (#426).
  expect(install).toContain('### Cursor placeholder expansion');
  expect(install).toContain('`~/.cursor/agent-bundle/plugin-data/<name>`');
  expect(install).toContain('`AB7326`');
  expect(install).toContain('The bundle itself');
});

/** The spec-shaped Agent Plugins pack from the 2026-09-03 Cursor observations (#426), every failing form at once. */
const agentPluginsMcp = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: {
    launcher: { args: [], command: './mcp/launch.sh', type: 'stdio' },
    probe: {
      args: ['${PLUGIN_ROOT}/mcp/report.mjs', '--cache', '${PLUGIN_DATA}/cache'],
      command: 'node',
      cwd: '${PLUGIN_ROOT}',
      env: { AGENT_BUNDLE_PLUGIN_ROOT: '${PLUGIN_ROOT}', PROBE_DATA: '${PLUGIN_DATA}', PROBE_ROOT: '${PLUGIN_ROOT}' },
      type: 'stdio',
    },
    remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
  },
};

it('emitted install.mjs expands Agent Plugins placeholders for the Cursor copy only, records them in the receipt, and stays idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-install-mjs-portable-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  const pluginData = join(home, '.cursor', 'agent-bundle', 'plugin-data', 'install-fixture');
  const installer = join(bundle, 'install.mjs');
  const mcpText = `${JSON.stringify(agentPluginsMcp, null, 2)}\n`;
  try {
    const writes = writesFor('portable');
    await mkdir(join(bundle, 'mcp'), { recursive: true });
    await mkdir(join(home, '.cursor'), { recursive: true });
    await Promise.all([
      writeFile(installer, writes.get('install.mjs') ?? ''),
      writeFile(join(bundle, 'INSTALL.md'), writes.get('INSTALL.md') ?? ''),
      writeFile(join(bundle, 'plugin.json'), JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'install-fixture',
        version: '1.2.3',
      })),
      writeFile(join(bundle, 'mcp.json'), mcpText),
      writeFile(join(bundle, 'mcp', 'report.mjs'), 'process.stdin.resume();\n'),
      writeFile(join(bundle, 'mcp', 'launch.sh'), '#!/usr/bin/env bash\nexec node "$(dirname "$0")/report.mjs"\n', { mode: 0o755 }),
    ]);

    const first = await run(installer, [], home);
    expect(first).toMatchObject({ code: 0, stderr: '' });
    expect(first.stdout).toContain('Installed install-fixture@1.2.3');
    expect(first.stdout).toContain(`Expanded Agent Plugins placeholders for Cursor in mcp.json: PLUGIN_ROOT=${destination} PLUGIN_DATA=${pluginData}`);
    // The bundle is untouched and stays spec-conformant; only the Cursor copy is rewritten.
    expect(await readFile(join(bundle, 'mcp.json'), 'utf8')).toBe(mcpText);
    expect(JSON.parse(await readFile(join(destination, 'mcp.json'), 'utf8'))).toEqual({
      $schema: agentPluginsMcp.$schema,
      mcpServers: {
        launcher: {
          args: [],
          command: join(destination, 'mcp', 'launch.sh'),
          cwd: destination,
          env: { PLUGIN_DATA: pluginData, PLUGIN_ROOT: destination },
          type: 'stdio',
        },
        probe: {
          args: [join(destination, 'mcp', 'report.mjs'), '--cache', join(pluginData, 'cache')],
          command: 'node',
          cwd: destination,
          env: {
            AGENT_BUNDLE_PLUGIN_ROOT: destination,
            PLUGIN_DATA: pluginData,
            PLUGIN_ROOT: destination,
            PROBE_DATA: pluginData,
            PROBE_ROOT: destination,
          },
          type: 'stdio',
        },
        remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
      },
    });
    expect((await stat(pluginData)).isDirectory()).toBe(true);
    // The receipt hashes the installed (expanded) form and keeps the bundle's document for Doctor.
    const receipt = await readInstallReceipt(destination);
    expect(receipt).toMatchObject({
      contentHash: (await treeInventory(destination)).hash,
      cursorExpansion: { documents: { 'mcp.json': mcpText }, pluginData, pluginRoot: destination },
      plugin: 'install-fixture',
      version: '1.2.3',
    });
    expect(receipt?.contentHash).not.toBe((await treeInventory(bundle)).hash);

    // Idempotent: the rerun compares the bundle's expanded form with the copy and finds nothing to do.
    const again = await run(installer, [], home);
    expect(again).toMatchObject({ code: 0, stderr: '' });
    expect(again.stdout).toContain('Already installed install-fixture@1.2.3');
    expect(again.stdout).not.toContain('Expanded Agent Plugins');
    expect(await readInstallReceipt(destination)).toEqual(receipt);

    // A same-version rebuild replaces owned files and re-expands the rebuilt document.
    await writeFile(join(bundle, 'mcp.json'), mcpText.replace('--cache', '--store'));
    const replaced = await run(installer, [], home);
    expect(replaced).toMatchObject({ code: 0, stderr: '' });
    expect(replaced.stdout).toContain('Replaced install-fixture@1.2.3');
    expect(replaced.stdout).toContain('Expanded Agent Plugins placeholders for Cursor');
    const rebuilt = JSON.parse(await readFile(join(destination, 'mcp.json'), 'utf8')) as { mcpServers: { probe: { args: string[] } } };
    expect(rebuilt.mcpServers.probe.args).toEqual([join(destination, 'mcp', 'report.mjs'), '--store', join(pluginData, 'cache')]);
    expect((await readInstallReceipt(destination))?.cursorExpansion?.documents['mcp.json']).toBe(mcpText.replace('--cache', '--store'));

    // An unexpanded copy left by an older installer (receipt without the expansion) is same-version content
    // drift of a receipt-managed copy: replaced automatically, so a plain rerun repairs it.
    await writeFile(join(destination, 'mcp.json'), mcpText.replace('--cache', '--store'));
    const staleReceipt = JSON.parse(await readFile(join(destination, installReceiptFile), 'utf8')) as Record<string, unknown>;
    const { cursorExpansion: _expansion, ...unexpandedReceipt } = staleReceipt;
    await writeFile(join(destination, installReceiptFile), JSON.stringify({
      ...unexpandedReceipt,
      contentHash: (await treeInventory(destination)).hash,
    }));
    const repaired = await run(installer, [], home);
    expect(repaired).toMatchObject({ code: 0, stderr: '' });
    expect(repaired.stdout).toContain('Replaced install-fixture@1.2.3');
    expect((await readInstallReceipt(destination))?.cursorExpansion?.pluginRoot).toBe(destination);

    // A skills-only Agent Plugins pack (no stdio server) is copied byte-identically and records no expansion.
    await rm(destination, { force: true, recursive: true });
    await writeFile(join(bundle, 'mcp.json'), `${JSON.stringify({
      $schema: agentPluginsMcp.$schema,
      mcpServers: { remote: agentPluginsMcp.mcpServers.remote },
    }, null, 2)}\n`);
    const remoteOnly = await run(installer, [], home);
    expect(remoteOnly).toMatchObject({ code: 0, stderr: '' });
    expect(remoteOnly.stdout).not.toContain('Expanded Agent Plugins');
    expect((await readInstallReceipt(destination))?.cursorExpansion).toBeUndefined();
    expect((await readInstallReceipt(destination))?.contentHash).toBe((await treeInventory(bundle)).hash);

    // A Cursor Plugin bundle beside a root plugin.json is never rewritten: the expansion is for Agent Plugins packs only.
    await rm(destination, { force: true, recursive: true });
    await writeFile(join(bundle, 'mcp.json'), mcpText);
    await mkdir(join(bundle, '.cursor-plugin'), { recursive: true });
    await writeFile(join(bundle, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'install-fixture', version: '1.2.3' }));
    const cursorPlugin = await run(installer, [], home);
    expect(cursorPlugin).toMatchObject({ code: 0, stderr: '' });
    expect(cursorPlugin.stdout).not.toContain('Expanded Agent Plugins');
    expect(await readFile(join(destination, 'mcp.json'), 'utf8')).toBe(mcpText);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

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
      // A regression that reads a FIFO receipt would otherwise hang the whole suite.
      timeout: 30_000,
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

    // An artifact path that could not round-trip through a receipt is refused before anything is staged.
    if (process.platform !== 'win32') {
      await writeFile(join(bundle, 'back\\slash.txt'), 'odd\n');
      const odd = await run(installer, [], home);
      expect(odd.code).toBe(1);
      expect(odd.stderr).toContain('Refusing unsupported filesystem entry "back\\\\slash.txt"');
      await expect(readdir(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(join(bundle, 'back\\slash.txt'));
      // A case alias of the receipt filename is the receipt on a case-insensitive filesystem: refused.
      await writeFile(join(bundle, '.Agent-Bundle-Install.json'), '{}\n');
      const alias = await run(installer, [], home);
      expect(alias.code).toBe(1);
      expect(alias.stderr).toContain('Refusing unsupported filesystem entry ".Agent-Bundle-Install.json"');
      await rm(join(bundle, '.Agent-Bundle-Install.json'));
      await mkdir(join(bundle, '.Agent-Bundle-Install.json'));
      await writeFile(join(bundle, '.Agent-Bundle-Install.json', 'payload'), 'odd\n');
      const aliasDirectory = await run(installer, [], home);
      expect(aliasDirectory.code).toBe(1);
      expect(aliasDirectory.stderr).toContain('Refusing unsupported filesystem entry ".Agent-Bundle-Install.json/payload"');
      await rm(join(bundle, '.Agent-Bundle-Install.json'), { recursive: true });
    }

    // Empty directories are not plugin content: never hashed, installed, or owned.
    await mkdir(join(bundle, 'empty', 'nested'), { recursive: true });
    const first = await run(installer, [], home);
    expect(first).toMatchObject({ code: 0, stderr: '' });
    expect(first.stdout).toContain('Installed install-fixture@1.2.3');
    expect((await readdir(destination)).sort()).toEqual([installReceiptFile, '.cursor-plugin', 'INSTALL.md', 'install.mjs', 'payload.txt', 'removed-later.txt']);
    await rm(join(bundle, 'empty'), { recursive: true });
    const firstArtifact = await treeInventory(bundle);
    // The emitted receipt is byte-compatible with the core reader.
    expect(await readInstallReceipt(destination)).toMatchObject({
      contentHash: firstArtifact.hash,
      directories: ['.cursor-plugin'],
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

    // Owned file -> directory restructure is a replacement, not a collision.
    await rm(join(bundle, 'payload.txt'));
    await mkdir(join(bundle, 'payload.txt'));
    await writeFile(join(bundle, 'payload.txt', 'nested.md'), '# nested\n');
    const restructured = await run(installer, [], home);
    expect(restructured).toMatchObject({ code: 0, stderr: '' });
    expect(restructured.stdout).toContain('Replaced install-fixture@1.2.3');
    expect(await readFile(join(destination, 'payload.txt', 'nested.md'), 'utf8')).toBe('# nested\n');
    await rm(join(bundle, 'payload.txt'), { recursive: true });
    await writeFile(join(bundle, 'payload.txt'), 'rebuilt\n');
    const flattened = await run(installer, [], home);
    expect(flattened).toMatchObject({ code: 0, stderr: '' });
    expect(flattened.stdout).toContain('Replaced install-fixture@1.2.3');
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('rebuilt\n');

    // Only installer-created directories are pruned when a rebuild empties them; a pre-existing
    // operator directory that a rebuild wrote beneath stays. (This copy was adopted from a legacy
    // layout above, so `.cursor-plugin` predates the receipt and is not owned either.)
    await mkdir(join(destination, 'operator-dir'));
    await mkdir(join(bundle, 'operator-dir'));
    await writeFile(join(bundle, 'operator-dir', 'shipped.md'), '# shipped\n');
    await mkdir(join(bundle, 'skills', 'new'), { recursive: true });
    await writeFile(join(bundle, 'skills', 'new', 'SKILL.md'), '# new\n');
    expect((await run(installer, [], home)).stdout).toContain('Replaced install-fixture@1.2.3');
    expect((await readInstallReceipt(destination))?.directories).toEqual(['skills', 'skills/new']);
    await rm(join(bundle, 'operator-dir'), { recursive: true });
    await rm(join(bundle, 'skills'), { recursive: true });
    expect((await run(installer, [], home)).stdout).toContain('Replaced install-fixture@1.2.3');
    expect(await readdir(join(destination, 'operator-dir'))).toEqual([]);
    await expect(readdir(join(destination, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readInstallReceipt(destination))?.directories).toEqual([]);
    await rm(join(destination, 'operator-dir'), { recursive: true });

    // A receipt whose inventory drifted is refreshed even when the owned bytes hash equal.
    await writeFile(join(bundle, 'transient.txt'), 'transient\n');
    await run(installer, [], home);
    await rm(join(bundle, 'transient.txt'));
    await rm(join(destination, 'transient.txt'));
    const refreshed = await run(installer, [], home);
    expect(refreshed.stdout).toContain('Replaced install-fixture@1.2.3');
    expect((await readInstallReceipt(destination))?.files).not.toContain('transient.txt');

    // A receipt missing a field reads as absent, exactly like the core reader: the legacy gate applies.
    const receipt = JSON.parse(await readFile(join(destination, installReceiptFile), 'utf8')) as Record<string, unknown>;
    const { host: _host, ...partialReceipt } = receipt;
    await writeFile(join(destination, installReceiptFile), JSON.stringify(partialReceipt));
    await writeFile(join(bundle, 'payload.txt'), 'rebuilt again\n');
    const partial = await run(installer, [], home);
    expect(partial.code).toBe(1);
    expect(partial.stderr).toContain('Refusing content collision');
    expect(partial.stderr).toContain('predates install receipts');

    // A receipt claiming runtime state reads as absent too: the durable store is never deletion-eligible.
    await mkdir(join(destination, 'state'), { recursive: true });
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    await writeFile(join(destination, installReceiptFile), JSON.stringify({
      ...receipt,
      files: [...(receipt['files'] as string[]), 'state/plugin.sqlite'],
    }));
    const claimsState = await run(installer, [], home);
    expect(claimsState.code).toBe(1);
    expect(claimsState.stderr).toContain('predates install receipts');
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');
    const adoptedOverState = await run(installer, ['--replace'], home);
    expect(adoptedOverState).toMatchObject({ code: 0, stderr: '' });
    expect(adoptedOverState.stdout).toContain('Replaced install-fixture@1.2.3');
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');
    expect((await readInstallReceipt(destination))?.files.some((file) => file.startsWith('state/'))).toBe(false);
    await rm(join(destination, 'state'), { recursive: true });
    await writeFile(join(bundle, 'payload.txt'), 'rebuilt\n');
    await run(installer, [], home);

    // A receipt that is not a regular file (a FIFO would block the read forever) is refused before reading.
    if (process.platform !== 'win32') {
      await rm(join(destination, installReceiptFile));
      await execFile('mkfifo', [join(destination, installReceiptFile)]);
      const fifo = await run(installer, [], home);
      expect(fifo.code).toBe(1);
      expect(fifo.stderr).toContain(`Refusing unsupported filesystem entry "${installReceiptFile}"`);
      const forcedFifo = await run(installer, ['--replace'], home);
      expect(forcedFifo.code).toBe(1);
      expect(forcedFifo.stderr).toContain(`Refusing unsupported filesystem entry "${installReceiptFile}"`);
      await rm(join(destination, installReceiptFile));
    }

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
