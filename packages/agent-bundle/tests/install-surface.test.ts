import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import type { TargetArtifactWrite } from '../src/adapters/types.ts';
import { composeProjections } from '../src/build/compose.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import {
  installReceiptFile,
  installReceiptFormat,
  legacyInstallReceiptFormat,
  readInstallReceipt,
  readInstallReceiptFile,
  treeInventory,
} from '../src/install/receipt.ts';
import { diffTreeSnapshots, snapshotTree } from './support/tree-snapshot.ts';

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

// The install surface is written once for the composite root, so the
// production path is the composed plan, not one adapter's.
const writesFor = (target: string): ReadonlyMap<string, string> => {
  const plan = composeProjections(modelFor(target), createDefaultRegistry());
  return new Map(plan.entries
    .filter((entry): entry is TargetArtifactWrite => entry.kind === 'write')
    .map((entry) => [entry.relativePath, entry.content]));
};

it.each(['claude', 'codex', 'cursor', 'portable'])(
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

// A consumer never needs the framework CLI: the bundle is self-contained, so
// install, reinstall, and uninstall are host commands, and `agent-bundle
// install`/`uninstall`/`doctor` are documented as optional automation only.
it.each(['claude', 'codex', 'cursor', 'portable'])(
  'documents host-native install and uninstall for %s and marks the agent-bundle CLI optional',
  (target) => {
    const install = writesFor(target).get('INSTALL.md')!;
    expect(install).toContain('nothing requires the `agent-bundle` CLI');
    const codeBlocks = [...install.matchAll(/```sh\n([\s\S]*?)```/gu)].map((match) => match[1]!);
    expect(codeBlocks.length).toBeGreaterThan(0);
    for (const block of codeBlocks) expect(block).not.toContain('agent-bundle ');
    // Every paragraph that names a framework CLI verb says the CLI is optional.
    const paragraphs = install.split('\n\n').filter((paragraph) => /`agent-bundle (?:install|uninstall|doctor)/u.test(paragraph));
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const paragraph of paragraphs) expect(paragraph).toMatch(/optional/u);
  },
);

it('emits the exact host uninstall commands the framework CLI itself runs, with marketplace removal gated on an inventory check', () => {
  const claude = writesFor('claude').get('INSTALL.md')!;
  expect(claude).toContain('```sh\nclaude plugin uninstall install-fixture@install-fixture-marketplace --scope user --keep-data\n```');
  // `plugin marketplace remove` applies to every scope, so it never sits in the same executable block.
  expect(claude).not.toMatch(/--keep-data\nclaude plugin marketplace remove/u);
  // Claude's project/local installs elsewhere are invisible to `plugin list`; the registry is the inventory.
  expect(claude).toMatch(/stays registered\. Remove it only when nothing else installs from it:\n(?:[^\n]+\n){4}\n```sh\nclaude plugin marketplace remove install-fixture-marketplace\n```/u);
  expect(claude).toContain('`claude plugin list` shows only\nthe current project, so also check `~/.claude/plugins/installed_plugins.json`');
  const codex = writesFor('codex').get('INSTALL.md')!;
  expect(codex).toContain('```sh\ncodex plugin remove install-fixture@install-fixture-marketplace\n```');
  expect(codex).toMatch(/Remove it only when nothing else installs from it:\n`codex plugin list` shows every other plugin from it\.\n\n```sh\ncodex plugin marketplace remove install-fixture-marketplace\n```/u);
});

it('emits a standalone safe-copy installer only for Cursor-compatible fallback profiles', () => {
  for (const target of ['cursor', 'portable']) {
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

    // PLUGIN_DATA through --uninstall: a written directory is durable state — kept by default behind a remnant
    // receipt that carries the expansion (the data lives outside the plugin root, so the root stays to own it),
    // purged only by --purge-data --confirm-purge; an empty, installer-created one is pruned with its parents.
    await mkdir(join(pluginData, 'cache'), { recursive: true });
    await writeFile(join(pluginData, 'cache', 'index.json'), '{}\n');
    const keptPlan = await run(installer, ['--uninstall', '--plan'], home);
    expect(keptPlan).toMatchObject({ code: 0, stderr: '' });
    expect(keptPlan.stdout).toContain(`Data (keep): kept — Durable runtime state — the PLUGIN_DATA directory ${pluginData} — is kept`);
    expect(keptPlan.stdout).toContain('Remnant receipt (would be written)');
    const kept = await run(installer, ['--uninstall'], home);
    expect(kept).toMatchObject({ code: 0, stderr: '' });
    expect(kept.stdout).toContain('Uninstalled install-fixture@1.2.3');
    expect(await readFile(join(pluginData, 'cache', 'index.json'), 'utf8')).toBe('{}\n');
    expect(await readInstallReceipt(destination)).toMatchObject({
      cursorExpansion: { pluginData, pluginRoot: destination },
      files: [],
      registrations: [],
    });
    expect(await readdir(destination)).toEqual([installReceiptFile]);
    const purged = await run(installer, ['--uninstall', '--purge-data', '--confirm-purge'], home);
    expect(purged).toMatchObject({ code: 0, stderr: '' });
    expect(purged.stdout).toContain(`Data (purge): purged — Durable runtime state — the PLUGIN_DATA directory ${pluginData} — is removed`);
    expect(await stat(pluginData).catch(() => undefined)).toBeUndefined();
    expect(await stat(join(home, '.cursor', 'agent-bundle')).catch(() => undefined)).toBeUndefined();
    expect(await stat(destination).catch(() => undefined)).toBeUndefined();
    // A kept PLUGIN_DATA directory later emptied by hand leaves a remnant guarding nothing: the next default run prunes
    // the empty directory with its agent-bundle parents and consumes the remnant instead of the keep-data no-op.
    await writeFile(join(bundle, 'mcp.json'), mcpText);
    expect(await run(installer, [], home)).toMatchObject({ code: 0, stderr: '' });
    await writeFile(join(pluginData, 'cache.sqlite'), 'durable\n');
    expect((await run(installer, ['--uninstall'], home)).stdout).toContain('Remnant receipt:');
    expect((await run(installer, ['--uninstall'], home)).stdout).toContain('Not installed install-fixture@1.2.3');
    await rm(join(pluginData, 'cache.sqlite'));
    const emptiedByHand = await run(installer, ['--uninstall'], home);
    expect(emptiedByHand).toMatchObject({ code: 0, stderr: '' });
    expect(emptiedByHand.stdout).toContain('Uninstalled install-fixture@1.2.3');
    expect(emptiedByHand.stdout).toContain(`the installer-created PLUGIN_DATA directory ${pluginData} is empty and is pruned`);
    expect(emptiedByHand.stdout).not.toContain('Remnant receipt:');
    expect(await stat(pluginData).catch(() => undefined)).toBeUndefined();
    expect(await stat(join(home, '.cursor', 'agent-bundle')).catch(() => undefined)).toBeUndefined();
    expect(await stat(destination).catch(() => undefined)).toBeUndefined();
    // A symlinked agent-bundle or plugin-data ancestor would let a recursive purge of the leaf follow it outside the
    // Cursor home: refused before anything is read or removed.
    expect(await run(installer, [], home)).toMatchObject({ code: 0, stderr: '' });
    const outside = join(root, 'outside-home');
    await mkdir(join(outside, 'plugin-data', 'install-fixture'), { recursive: true });
    await writeFile(join(outside, 'plugin-data', 'install-fixture', 'cache.sqlite'), 'elsewhere\n');
    await rm(join(home, '.cursor', 'agent-bundle'), { force: true, recursive: true });
    await symlink(outside, join(home, '.cursor', 'agent-bundle'));
    const linkedParent = await run(installer, ['--uninstall', '--purge-data', '--confirm-purge'], home);
    expect(linkedParent.code).toBe(1);
    expect(linkedParent.stderr).toContain('Refusing unsupported filesystem entry');
    expect(await readFile(join(outside, 'plugin-data', 'install-fixture', 'cache.sqlite'), 'utf8')).toBe('elsewhere\n');
    await rm(join(home, '.cursor', 'agent-bundle'));
    await mkdir(join(home, '.cursor', 'agent-bundle'));
    await symlink(join(outside, 'plugin-data'), join(home, '.cursor', 'agent-bundle', 'plugin-data'));
    const linkedChild = await run(installer, ['--uninstall'], home);
    expect(linkedChild.code).toBe(1);
    expect(linkedChild.stderr).toContain('Refusing unsupported filesystem entry');
    expect(await readFile(join(outside, 'plugin-data', 'install-fixture', 'cache.sqlite'), 'utf8')).toBe('elsewhere\n');
    await rm(join(home, '.cursor', 'agent-bundle'), { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
    expect(await run(installer, ['--uninstall'], home)).toMatchObject({ code: 0, stderr: '' });
    // Fresh install, nothing written to PLUGIN_DATA: the default uninstall prunes it (and the empty agent-bundle parents).
    await writeFile(join(bundle, 'mcp.json'), mcpText);
    expect(await run(installer, [], home)).toMatchObject({ code: 0, stderr: '' });
    expect((await stat(pluginData)).isDirectory()).toBe(true);
    const emptyPlan = await run(installer, ['--uninstall', '--plan'], home);
    expect(emptyPlan.stdout).toContain(`the installer-created PLUGIN_DATA directory ${pluginData} is empty and is pruned`);
    expect(emptyPlan.stdout).toContain(`  ${pluginData}\n`);
    expect(await run(installer, ['--uninstall'], home)).toMatchObject({ code: 0, stderr: '' });
    expect(await stat(pluginData).catch(() => undefined)).toBeUndefined();
    expect(await stat(join(home, '.cursor', 'agent-bundle')).catch(() => undefined)).toBeUndefined();

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

  for (const target of ['cursor', 'portable']) {
    const install = writesFor(target).get('INSTALL.md') ?? '';
    expect(install).toContain(installReceiptFile);
    expect(install).toContain('--replace');
    expect(install).toContain('`state/`');
    expect(install).toContain('### Uninstall');
    expect(install).toContain('node ./install.mjs --uninstall --plan');
    expect(install).toContain('--purge-data --confirm-purge');
  }
  expect(claude).toContain('agent-bundle uninstall claude --from ./ --plan');
  expect(claude).toContain('~/.claude/agent-bundle/receipts/install-fixture.install-fixture-marketplace.user.json');
  expect(codex).toContain('agent-bundle uninstall codex --from ./ --plan');
  expect(codex).toMatch(/has no\s+keep-data\s+option/u);
  expect(writesFor('cursor').get('INSTALL.md')).toContain('node ./install.mjs --replace');
  expect(writesFor('cursor').get('INSTALL.md')).toContain('content-hash comparison');

  const installer = writesFor('cursor').get('install.mjs') ?? '';
  expect(installer).toContain("argument === '--replace' || argument === '--force'");
  expect(installer).toContain(`const receiptFile = ${JSON.stringify(installReceiptFile)};`);
  expect(installer).toContain(`const receiptFormat = ${JSON.stringify(installReceiptFormat)};`);
  expect(installer).toContain(`const legacyReceiptFormat = ${JSON.stringify(legacyInstallReceiptFormat)};`);
  expect(installer).toContain("if (uninstall && mode === 'local') {");
  expect(installer).toContain("if (uninstall && mode === 'marketplace') {");
  expect(installer).toContain('Refusing to uninstall foreign directory');
  expect(installer).toContain('--purge-data deletes the plugin\'s durable runtime state');
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
    // The emitted receipt is byte-compatible with the core reader, lifecycle fields included (#101).
    expect(await readInstallReceipt(destination)).toMatchObject({
      contentHash: firstArtifact.hash,
      directories: ['.cursor-plugin'],
      files: firstArtifact.files,
      format: installReceiptFormat,
      host: 'cursor',
      hostDirectories: ['plugins', 'plugins/local'],
      mode: 'local',
      plugin: 'install-fixture',
      registrations: [{ kind: 'cursor-local-plugin' }],
      scope: 'user',
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

it('emitted install.mjs --uninstall mirrors the core lifecycle: plan, receipt-owned removal, data policy, refusals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-uninstall-mjs-'));
  const bundle = join(root, 'bundle');
  const home = join(root, 'home');
  const cursorRoot = join(home, '.cursor');
  const destination = join(cursorRoot, 'plugins', 'local', 'install-fixture');
  const installer = join(bundle, 'install.mjs');
  try {
    const writes = writesFor('cursor');
    await mkdir(join(bundle, '.cursor-plugin'), { recursive: true });
    await mkdir(join(bundle, 'skills', 'probe'), { recursive: true });
    await mkdir(cursorRoot, { recursive: true });
    await writeFile(join(cursorRoot, 'operator.json'), '{}\n');
    await Promise.all([
      writeFile(installer, writes.get('install.mjs') ?? ''),
      writeFile(join(bundle, 'INSTALL.md'), writes.get('INSTALL.md') ?? ''),
      writeFile(join(bundle, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'install-fixture', version: '1.2.3' })),
      writeFile(join(bundle, 'payload.txt'), 'payload\n'),
      writeFile(join(bundle, 'skills', 'probe', 'SKILL.md'), '# probe\n'),
    ]);
    const before = await snapshotTree(home);

    // Flag validation happens before anything is read or written.
    for (const [args, message] of [
      [['--plan'], '--plan, --keep-data, --purge-data, and --confirm-purge apply to --uninstall only.'],
      [['--uninstall', '--purge-data'], '--purge-data deletes the plugin\'s durable runtime state'],
      [['--uninstall', '--purge-data', '--confirm-purge', '--keep-data'], '--keep-data and --purge-data are mutually exclusive.'],
    ] as const) {
      const refused = await run(installer, [...args], home);
      expect(refused.code, args.join(' ')).toBe(2);
      expect(refused.stderr, args.join(' ')).toContain(message);
    }
    const nothing = await run(installer, ['--uninstall'], home);
    expect(nothing).toMatchObject({ code: 0, stderr: '' });
    expect(nothing.stdout).toContain(`Not installed install-fixture@1.2.3 for cursor (local mode) at ${destination}`);
    expect(diffTreeSnapshots(before, await snapshotTree(home))).toEqual({ added: [], changed: [], removed: [] });

    expect((await run(installer, [], home)).stdout).toContain('Installed install-fixture@1.2.3');
    const afterInstall = await snapshotTree(home);
    const receipt = await readInstallReceipt(destination);
    expect(receipt?.hostDirectories).toEqual(['plugins', 'plugins/local']);

    // --plan prints every exact path and changes nothing.
    const plan = await run(installer, ['--uninstall', '--plan'], home);
    expect(plan).toMatchObject({ code: 0, stderr: '' });
    expect(plan.stdout).toContain(`Would uninstall install-fixture@1.2.3 for cursor (local mode) at ${destination}`);
    expect(plan.stdout).toContain(`Receipt: consumed (${join(destination, installReceiptFile)})`);
    for (const file of receipt?.files ?? []) expect(plan.stdout).toContain(join(destination, file));
    expect(plan.stdout).toContain(join(cursorRoot, 'plugins', 'local'));
    expect(plan.stdout).toContain('Data (keep): absent');
    expect(diffTreeSnapshots(afterInstall, await snapshotTree(home))).toEqual({ added: [], changed: [], removed: [] });

    // Real uninstall: the home is byte-identical to before the install; a rerun is a no-op.
    const uninstalled = await run(installer, ['--uninstall'], home);
    expect(uninstalled).toMatchObject({ code: 0, stderr: '' });
    expect(uninstalled.stdout).toContain(`Uninstalled install-fixture@1.2.3 for cursor (local mode) at ${destination}`);
    expect(uninstalled.stdout).toContain(`Removed directory 6 entries:`);
    expect(diffTreeSnapshots(before, await snapshotTree(home))).toEqual({ added: [], changed: [], removed: [] });
    expect((await run(installer, ['--uninstall'], home)).stdout).toContain('Not installed install-fixture@1.2.3');

    // Durable state and unowned files survive a default uninstall; state goes only with confirmed --purge-data.
    await run(installer, [], home);
    await mkdir(join(destination, 'state'));
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    await writeFile(join(destination, 'notes.md'), 'operator\n');
    // An unowned empty directory is never pruned (only owned directories are candidates) and is listed as retained.
    await mkdir(join(destination, 'scratch'));
    const keepPlan = await run(installer, ['--uninstall', '--keep-data', '--plan'], home);
    expect(keepPlan).toMatchObject({ code: 0, stderr: '' });
    expect(keepPlan.stdout).toContain(`Retained unowned under ${destination}:`);
    expect(keepPlan.stdout).toContain('  notes.md');
    expect(keepPlan.stdout).toContain('  scratch/');
    const kept = await run(installer, ['--uninstall', '--keep-data'], home);
    expect(kept).toMatchObject({ code: 0, stderr: '' });
    expect(kept.stdout).toContain(`Data (keep): kept`);
    expect(kept.stdout).toContain(`Retained unowned under ${destination}:`);
    expect(kept.stdout).toContain('  notes.md');
    expect(kept.stdout).toContain('  scratch/');
    expect(kept.stdout).toContain(`Remnant receipt: ${join(destination, installReceiptFile)}`);
    expect((await readdir(destination)).sort()).toEqual([installReceiptFile, 'notes.md', 'scratch', 'state']);
    // The remnant receipt owns nothing and remembers the host directories the install created.
    expect(await readInstallReceipt(destination)).toMatchObject({ files: [], hostDirectories: ['plugins', 'plugins/local'], registrations: [] });
    await rm(join(destination, 'notes.md'));
    await rm(join(destination, 'scratch'), { recursive: true });
    // Reinstalling around the preserved state is an install, not a foreign-directory refusal.
    const reinstalled = await run(installer, [], home);
    expect(reinstalled).toMatchObject({ code: 0, stderr: '' });
    expect(reinstalled.stdout).toContain('Installed install-fixture@1.2.3');
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');
    const purged = await run(installer, ['--uninstall', '--purge-data', '--confirm-purge'], home);
    expect(purged).toMatchObject({ code: 0, stderr: '' });
    expect(purged.stdout).toContain('Data (purge): purged');
    expect(purged.stdout).toContain(join(destination, 'state'));
    expect(diffTreeSnapshots(before, await snapshotTree(home))).toEqual({ added: [], changed: [], removed: [] });

    // A remnant whose state/ was removed by hand guards nothing: the keep-data no-op applies only while the preserved
    // data is still there, so a default rerun consumes the remnant receipt and prunes the host directories it recorded.
    await run(installer, [], home);
    await mkdir(join(destination, 'state'));
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    await run(installer, ['--uninstall'], home);
    expect((await run(installer, ['--uninstall'], home)).stdout).toContain('Not installed install-fixture@1.2.3');
    await rm(join(destination, 'state'), { recursive: true });
    const emptyRemnant = await run(installer, ['--uninstall'], home);
    expect(emptyRemnant).toMatchObject({ code: 0, stderr: '' });
    expect(emptyRemnant.stdout).toContain('Uninstalled install-fixture@1.2.3');
    expect(emptyRemnant.stdout).toContain('Data (keep): absent');
    expect(emptyRemnant.stdout).not.toContain('Remnant receipt:');
    expect(diffTreeSnapshots(before, await snapshotTree(home))).toEqual({ added: [], changed: [], removed: [] });
    // A state/ emptied by hand (directory left behind) is not durable state either: pruned with the exhausted remnant.
    await run(installer, [], home);
    await mkdir(join(destination, 'state'));
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    await run(installer, ['--uninstall'], home);
    await rm(join(destination, 'state', 'plugin.sqlite'));
    const emptiedState = await run(installer, ['--uninstall'], home);
    expect(emptiedState).toMatchObject({ code: 0, stderr: '' });
    expect(emptiedState.stdout).toContain('Uninstalled install-fixture@1.2.3');
    expect(emptiedState.stdout).toContain('state/ under the installed plugin root is empty and is pruned');
    expect(emptiedState.stdout).not.toContain('Remnant receipt:');
    expect(diffTreeSnapshots(before, await snapshotTree(home))).toEqual({ added: [], changed: [], removed: [] });

    // Modified owned content: refused with the hash comparison until --force.
    await run(installer, [], home);
    await writeFile(join(destination, 'payload.txt'), 'modified\n');
    const mismatch = await run(installer, ['--uninstall'], home);
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain('modified after installation');
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('modified\n');
    const forced = await run(installer, ['--uninstall', '--force'], home);
    expect(forced).toMatchObject({ code: 0, stderr: '' });
    expect(forced.stdout).toContain('Receipt: forced-mismatch');
    expect(forced.stdout).toContain('[--force]');
    expect(diffTreeSnapshots(before, await snapshotTree(home))).toEqual({ added: [], changed: [], removed: [] });

    // Legacy (receipt-less) copy: AB7009-style refusal, then --force removes the inventoried files only.
    await run(installer, [], home);
    await rm(join(destination, installReceiptFile));
    const legacy = await run(installer, ['--uninstall'], home);
    expect(legacy.code).toBe(1);
    expect(legacy.stderr).toContain('predates install receipts');
    const forcedLegacy = await run(installer, ['--uninstall', '--force'], home);
    expect(forcedLegacy).toMatchObject({ code: 0, stderr: '' });
    expect(forcedLegacy.stdout).toContain('Receipt: forced-legacy');
    // The legacy inventory owns no host directories: plugins/local stays (it was not proven ours).
    expect(await readdir(join(cursorRoot, 'plugins', 'local'))).toEqual([]);
    await rm(join(cursorRoot, 'plugins'), { recursive: true });

    // A format/1 receipt is consumed as migrated.
    await run(installer, [], home);
    const written = JSON.parse(await readFile(join(destination, installReceiptFile), 'utf8')) as Record<string, unknown>;
    const { hostDirectories: _h, mode: _m, registrations: _r, scope: _s, updatedAt: _u, ...legacyReceipt } = written;
    await writeFile(join(destination, installReceiptFile), JSON.stringify({ ...legacyReceipt, format: legacyInstallReceiptFormat }));
    const migrated = await run(installer, ['--uninstall'], home);
    expect(migrated).toMatchObject({ code: 0, stderr: '' });
    expect(migrated.stdout).toContain('Receipt: migrated');
    // The migrated receipt carried no host directories, so plugins/ stays behind; that is the honest downgrade.
    await rm(join(cursorRoot, 'plugins'), { recursive: true });
    expect(diffTreeSnapshots(before, await snapshotTree(home))).toEqual({ added: [], changed: [], removed: [] });

    // Foreign directory (another plugin's receipt, or no receipt and no install surface): refused even with --force.
    await run(installer, [], home);
    const own = JSON.parse(await readFile(join(destination, installReceiptFile), 'utf8')) as Record<string, unknown>;
    await writeFile(join(destination, installReceiptFile), JSON.stringify({ ...own, plugin: 'someone-else' }));
    const otherPlugin = await run(installer, ['--uninstall', '--force'], home);
    expect(otherPlugin.code).toBe(1);
    expect(otherPlugin.stderr).toContain('names plugin "someone-else"');
    await rm(destination, { force: true, recursive: true });
    await mkdir(destination);
    await writeFile(join(destination, 'payload.txt'), 'someone else\n');
    const foreign = await run(installer, ['--uninstall', '--force'], home);
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toContain('Refusing to uninstall foreign directory');
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('someone else\n');
    await rm(join(cursorRoot, 'plugins'), { recursive: true });

    // Marketplace mode: staging writes a store receipt; --uninstall --mode marketplace removes the repository and receipt.
    const staged = await run(installer, ['--mode', 'marketplace'], home);
    expect(staged).toMatchObject({ code: 0, stderr: '' });
    const receiptPath = join(cursorRoot, 'agent-bundle', 'receipts', 'install-fixture.marketplace.json');
    const commit = /@ ([0-9a-f]{40})$/u.exec(staged.stdout.split('\n')[1] ?? '')?.[1];
    expect(await readInstallReceiptFile(receiptPath)).toMatchObject({
      files: [],
      mode: 'marketplace',
      registrations: [{ commit, kind: 'cursor-marketplace-staging', name: 'install-fixture-marketplace' }],
    });
    // An untracked file in the staged working tree is not receipt-owned: refused (plan included) until --force.
    const stagedRepo = join(cursorRoot, 'agent-bundle', 'marketplaces', 'install-fixture');
    await writeFile(join(stagedRepo, 'notes.txt'), 'operator notes\n');
    const dirty = await run(installer, ['--uninstall', '--mode', 'marketplace', '--plan'], home);
    expect(dirty.code).toBe(1);
    expect(dirty.stderr).toContain('working tree differs from the receipted commit');
    expect(dirty.stderr).toContain('"notes.txt"');
    expect(await readFile(join(stagedRepo, 'notes.txt'), 'utf8')).toBe('operator notes\n');
    const dirtyForced = await run(installer, ['--uninstall', '--mode', 'marketplace', '--plan', '--force'], home);
    expect(dirtyForced).toMatchObject({ code: 0, stderr: '' });
    expect(dirtyForced.stdout).toContain('Receipt: forced-mismatch');
    await rm(join(stagedRepo, 'notes.txt'));
    const marketplacePlan = await run(installer, ['--uninstall', '--mode', 'marketplace', '--plan'], home);
    expect(marketplacePlan).toMatchObject({ code: 0, stderr: '' });
    expect(marketplacePlan.stdout).toContain(`Would uninstall install-fixture@1.2.3 for cursor (marketplace mode) at ${join(cursorRoot, 'agent-bundle', 'marketplaces', 'install-fixture')}`);
    expect(marketplacePlan.stdout).toContain(receiptPath);
    expect(await readInstallReceiptFile(receiptPath)).toBeDefined();
    const marketplaceUninstalled = await run(installer, ['--uninstall', '--mode', 'marketplace'], home);
    expect(marketplaceUninstalled).toMatchObject({ code: 0, stderr: '' });
    expect(marketplaceUninstalled.stdout).toContain('Registration cursor-marketplace-staging install-fixture-marketplace: removed');
    // The plan is exact: this was the last staged marketplace and store receipt, so the run prunes the receipt
    // store, the marketplaces root, and the agent-bundle namespace — and the plan already named every one of them.
    const pathLines = (stdout: string, label: string): string[] => {
      const lines = stdout.split('\n');
      const start = lines.findIndex((line) => line.startsWith(label));
      const listed: string[] = [];
      for (const line of lines.slice(start + 1)) {
        if (!line.startsWith('  ')) break;
        listed.push(line.trim());
      }
      return listed.sort();
    };
    const plannedDirectories = pathLines(marketplacePlan.stdout, 'Would remove directory');
    expect(plannedDirectories).toEqual(pathLines(marketplaceUninstalled.stdout, 'Removed directory'));
    expect(plannedDirectories).toEqual(expect.arrayContaining([
      join(cursorRoot, 'agent-bundle', 'receipts'),
      join(cursorRoot, 'agent-bundle', 'marketplaces'),
      join(cursorRoot, 'agent-bundle'),
    ]));
    expect(marketplaceUninstalled.stdout).toContain('Data (keep): unavailable');
    expect(diffTreeSnapshots(before, await snapshotTree(home))).toEqual({ added: [], changed: [], removed: [] });
    expect((await run(installer, ['--uninstall', '--mode', 'marketplace'], home)).stdout).toContain('Not installed install-fixture@1.2.3 for cursor (marketplace mode)');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 120_000);
