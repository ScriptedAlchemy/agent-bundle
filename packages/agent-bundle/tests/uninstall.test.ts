import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';
import { userDataStateRoot } from '@agent-bundle/runtime';

import { runCli } from '../src/cli.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';
import { formatUninstallResult } from '../src/install/format.ts';
import { installBundle, type InstallCommandRunner } from '../src/install/install.ts';
import {
  emptyContentHash,
  installReceiptFile,
  installReceiptFormat,
  readInstallReceipt,
  readInstallReceiptFile,
} from '../src/install/receipt.ts';
import { installedWebDataRoot, recordInstalledState } from '../src/install/state-root.ts';
import { uninstallBundle, type UninstallResult } from '../src/install/uninstall.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';
import { writeInstallFixtureManifest } from './support/install-fixture.ts';
import { diffTreeSnapshots, snapshotTree, treesIdentical } from './support/tree-snapshot.ts';
import { removeTree } from './support/remove-tree.ts';

interface CommandCall {
  readonly args: readonly string[];
  readonly command: string;
}

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
};

interface Fixture {
  readonly bundleRoot: string;
  readonly cleanupRoot: string;
  readonly home: string;
}

const mcpDocuments = {
  claude: '.mcp.json',
  codex: '.codex-plugin/mcp.json',
  cursor: '.cursor-plugin/mcp.json',
} as const;

const createFixture = async (
  host: 'claude' | 'codex' | 'cursor',
  options: { readonly mcpDocument?: unknown } = {},
): Promise<Fixture> => {
  const cleanupRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-uninstall-'));
  const bundleRoot = join(cleanupRoot, 'bundle');
  const home = join(cleanupRoot, 'home');
  await mkdir(bundleRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(bundleRoot, 'payload.txt'), 'payload\n');
  await writeFile(join(bundleRoot, 'INSTALL.md'), '# install\n');
  await writeFile(join(bundleRoot, 'install.mjs'), '// installer\n');
  await mkdir(join(bundleRoot, 'skills', 'probe'), { recursive: true });
  await writeFile(join(bundleRoot, 'skills', 'probe', 'SKILL.md'), '# probe\n');
  if (host === 'claude') {
    await writeJson(join(bundleRoot, '.claude-plugin/plugin.json'), { name: 'uninstall-fixture', version: '1.2.3' });
    await writeJson(join(bundleRoot, '.claude-plugin/marketplace.json'), {
      name: 'uninstall-fixture-marketplace',
      plugins: [{ name: 'uninstall-fixture', source: './', version: '1.2.3' }],
    });
  } else if (host === 'codex') {
    await writeJson(join(bundleRoot, '.codex-plugin/plugin.json'), { name: 'uninstall-fixture', version: '1.2.3' });
    await writeJson(join(bundleRoot, '.agents/plugins/marketplace.json'), {
      name: 'uninstall-fixture-marketplace',
      plugins: [{
        category: 'Productivity',
        name: 'uninstall-fixture',
        policy: { authentication: 'ON_INSTALL', installation: 'AVAILABLE' },
        source: { path: './', source: 'local' },
      }],
    });
  } else {
    await writeJson(join(bundleRoot, '.cursor-plugin/plugin.json'), { name: 'uninstall-fixture', version: '1.2.3' });
  }
  const mcp = options.mcpDocument === undefined ? undefined : mcpDocuments[host];
  if (mcp !== undefined) await writeJson(join(bundleRoot, mcp), options.mcpDocument);
  await writeInstallFixtureManifest(
    bundleRoot,
    { name: 'uninstall-fixture', version: '1.2.3' },
    [{
      host,
      ...(host === 'cursor' ? {} : { marketplace: 'uninstall-fixture-marketplace' }),
      ...(mcp === undefined ? {} : { mcp }),
    }],
  );
  return {
    bundleRoot: await realpath(bundleRoot),
    cleanupRoot: await realpath(cleanupRoot),
    home: await realpath(home),
  };
};

const writeFixtureMcp = async (
  fixture: Fixture,
  host: 'claude' | 'codex' | 'cursor',
  document: unknown,
): Promise<void> => {
  await writeJson(join(fixture.bundleRoot, mcpDocuments[host]), document);
  await writeInstallFixtureManifest(
    fixture.bundleRoot,
    { name: 'uninstall-fixture', version: '1.2.3' },
    [{
      host,
      ...(host === 'cursor' ? {} : { marketplace: 'uninstall-fixture-marketplace' }),
      mcp: mcpDocuments[host],
    }],
  );
};

const failureOf = async (promise: Promise<unknown>): Promise<DiagnosticError> => {
  const error = await promise.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(DiagnosticError);
  return error as DiagnosticError;
};

it('uninstalls a Cursor local install through its receipt and leaves the home byte-identical', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  await mkdir(cursorRoot);
  await writeFile(join(cursorRoot, 'operator.json'), '{}\n');
  const destination = join(cursorRoot, 'plugins', 'local', 'uninstall-fixture');
  const options = { from: fixture.bundleRoot, home: fixture.home, host: 'cursor' as const };
  try {
    const before = await snapshotTree(fixture.home);
    // Nothing installed: an honest no-op with no receipt to consume.
    expect(await uninstallBundle(options)).toMatchObject({
      data: { outcome: 'absent', policy: 'keep' },
      receipt: { status: 'missing' },
      registrations: [{ action: 'already-absent', kind: 'cursor-local-plugin' }],
      state: 'not-installed',
    });
    expect(treesIdentical(before, await snapshotTree(fixture.home))).toBe(true);

    const installed = await installBundle(options);
    expect(installed.state).toBe('installed');
    const receipt = await readInstallReceipt(destination);
    expect(receipt?.hostDirectories).toEqual(['plugins', 'plugins/local']);
    const afterInstall = await snapshotTree(fixture.home);
    expect(diffTreeSnapshots(before, afterInstall).added.length).toBeGreaterThan(0);

    // --plan names every exact path and writes nothing.
    const plan = await uninstallBundle({ ...options, plan: true });
    expect(plan).toMatchObject({
      destination,
      forced: false,
      mode: 'local',
      receipt: { contentHash: installed.contentHash, path: join(destination, installReceiptFile), status: 'consumed' },
      registrations: [{ action: 'planned', kind: 'cursor-local-plugin' }],
      state: 'planned',
    });
    expect(plan.removed.files).toEqual([
      ...(receipt?.files ?? []).map((file) => join(destination, file)),
      join(destination, installReceiptFile),
    ]);
    // Deepest first (children before parents), then the plugin root, then the host directories this install created.
    expect(plan.removed.directories).toEqual([
      join(destination, '.cursor-plugin'),
      join(destination, 'skills', 'probe'),
      join(destination, 'skills'),
      destination,
      join(cursorRoot, 'plugins', 'local'),
      join(cursorRoot, 'plugins'),
    ]);
    expect(treesIdentical(afterInstall, await snapshotTree(fixture.home))).toBe(true);
    expect(formatUninstallResult(plan)).toContain('Would uninstall uninstall-fixture@1.2.3 for cursor (local mode)');
    expect(formatUninstallResult(plan)).toContain(join(destination, 'payload.txt'));

    const result = await uninstallBundle(options);
    expect(result).toMatchObject({
      data: { outcome: 'absent', paths: [], policy: 'keep' },
      receipt: { status: 'consumed' },
      registrations: [{ action: 'removed', kind: 'cursor-local-plugin' }],
      retained: [],
      state: 'uninstalled',
    });
    expect(result.removed.directories).toEqual(plan.removed.directories);
    // The isolated home is exactly what it was before the install: plugins/ and plugins/local were ours to prune.
    const afterUninstall = await snapshotTree(fixture.home);
    expect(diffTreeSnapshots(before, afterUninstall)).toEqual({ added: [], changed: [], removed: [] });
    expect(formatUninstallResult(result)).toContain('Uninstalled uninstall-fixture@1.2.3 for cursor (local mode)');

    // Rerun: idempotent no-op.
    expect(await uninstallBundle(options)).toMatchObject({ state: 'not-installed' });
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('keeps Cursor runtime state and unowned entries by default and purges state only when confirmed', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  await mkdir(join(cursorRoot, 'plugins', 'local'), { recursive: true });
  const destination = join(cursorRoot, 'plugins', 'local', 'uninstall-fixture');
  const environment = { XDG_STATE_HOME: join(fixture.cleanupRoot, 'state-home') };
  const options = { environment, from: fixture.bundleRoot, home: fixture.home, host: 'cursor' as const };
  const derivedStateRoot = userDataStateRoot(destination, environment, fixture.home);
  try {
    const before = await snapshotTree(fixture.home);
    await installBundle(options);
    // plugins/local existed before: not ours, never pruned.
    expect((await readInstallReceipt(destination))?.hostDirectories).toEqual([]);
    await mkdir(join(destination, 'state'));
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    await mkdir(derivedStateRoot, { recursive: true });
    await writeFile(join(derivedStateRoot, 'plugin.sqlite'), 'derived\n');
    await writeFile(join(destination, 'operator-notes.md'), 'mine\n');
    // Unowned directories that hold nothing retained survive too (the prune only touches owned directories):
    // one at the root and one nested inside an owned directory that would otherwise be pruned.
    await mkdir(join(destination, 'scratch'));
    await mkdir(join(destination, 'skills', 'drafts'));

    // --purge-data without confirmation is refused before anything changes.
    const unconfirmed = await failureOf(uninstallBundle({ ...options, purgeData: true }));
    expect(unconfirmed.diagnostics[0]).toMatchObject({ code: 'AB7008', target: 'cursor' });
    const conflicting = await failureOf(uninstallBundle({ ...options, confirmPurge: true, keepData: true, purgeData: true }));
    expect(conflicting.diagnostics[0]?.code).toBe('AB7008');
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');

    // --plan lists only the directories the run can actually prune: the plugin root is kept alive by the unowned
    // entries (state/ is one of them), so it is not planned for removal and the remnant receipt is announced instead.
    const keepPlan = await uninstallBundle({ ...options, keepData: true, plan: true });
    expect(keepPlan.removed.directories).not.toContain(destination);
    expect(keepPlan.removed.directories).toContain(join(destination, '.cursor-plugin'));
    // skills/ is owned but skills/drafts is not: the unowned directory survives and keeps skills/ alive.
    expect(keepPlan.removed.directories).not.toContain(join(destination, 'skills'));
    expect(keepPlan.remnantReceipt).toBe(join(destination, installReceiptFile));
    expect(keepPlan.retained).toEqual(['operator-notes.md', 'scratch/', 'skills/drafts/', 'state/plugin.sqlite']);
    // Only the receipt-recorded derived root is purge authority; the in-tree state/ is never a data path.
    const purgePlan = await uninstallBundle({ ...options, confirmPurge: true, plan: true, purgeData: true });
    expect(purgePlan.data.paths).toEqual([derivedStateRoot]);
    expect(purgePlan.removed.directories[0]).toBe(derivedStateRoot);
    expect(purgePlan.removed.directories).not.toContain(destination);
    expect(purgePlan.removed.directories).not.toContain(join(destination, 'state'));

    const kept = await uninstallBundle({ ...options, keepData: true });
    expect(kept).toMatchObject({
      data: { outcome: 'kept', paths: [derivedStateRoot], policy: 'keep' },
      remnantReceipt: join(destination, installReceiptFile),
      retained: ['operator-notes.md', 'scratch/', 'skills/drafts/', 'state/plugin.sqlite'],
      state: 'uninstalled',
    });
    expect(kept.removed.directories).toEqual(keepPlan.removed.directories);
    expect(kept.removed.directories).not.toContain(destination);
    // The surviving root keeps a remnant receipt: owns no files, records no registration, carries the host directories.
    expect((await readdir(destination)).sort()).toEqual([installReceiptFile, 'operator-notes.md', 'scratch', 'skills', 'state']);
    expect(await readdir(join(destination, 'skills'))).toEqual(['drafts']);
    expect(await readInstallReceipt(destination)).toMatchObject({ files: [], hostDirectories: [], mode: 'local', registrations: [] });
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');
    expect(await readFile(join(derivedStateRoot, 'plugin.sqlite'), 'utf8')).toBe('derived\n');
    expect(formatUninstallResult(kept)).toContain('Retained 4 unowned entries');
    expect(formatUninstallResult(kept)).toContain('Remnant receipt:');

    // Reinstall beside the retained entries (an install, not a replacement), then purge the derived root with
    // confirmation; state/ stays retained and keeps the root and its remnant receipt alive.
    await rm(join(destination, 'operator-notes.md'));
    await removeTree(join(destination, 'scratch'));
    // skills/ survived the uninstall (its unowned child kept it alive), so a reinstall would find it pre-existing
    // and not claim it; clear it so the reinstall owns its directories again.
    await removeTree(join(destination, 'skills'));
    expect(await installBundle(options)).toMatchObject({ state: 'installed' });
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');
    const purged = await uninstallBundle({ ...options, confirmPurge: true, purgeData: true });
    expect(purged).toMatchObject({
      data: { outcome: 'purged', paths: [derivedStateRoot], policy: 'purge' },
      remnantReceipt: join(destination, installReceiptFile),
      retained: ['state/plugin.sqlite'],
      state: 'uninstalled',
    });
    // The purged derived root is a directory and is reported as one, ahead of the pruned owned directories.
    expect(purged.removed.directories[0]).toBe(derivedStateRoot);
    await expect(readdir(derivedStateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(destination, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');
    // Once the operator removes state/ by hand, the exhausted remnant is consumed and the home is byte-identical.
    await removeTree(join(destination, 'state'));
    expect(await uninstallBundle(options)).toMatchObject({ data: { outcome: 'absent' }, state: 'uninstalled' });
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('keeps created host directories receipt-owned across a --keep-data cycle in a fresh Cursor home', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  await mkdir(cursorRoot);
  const destination = join(cursorRoot, 'plugins', 'local', 'uninstall-fixture');
  const options = { from: fixture.bundleRoot, home: fixture.home, host: 'cursor' as const };
  try {
    const before = await snapshotTree(fixture.home);
    await installBundle(options);
    await mkdir(join(destination, 'state'));
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    // Keep: plugins/ and plugins/local cannot be pruned (the unowned state/ keeps the root alive), so the remnant
    // receipt remembers them.
    const kept = await uninstallBundle(options);
    expect(kept).toMatchObject({ data: { outcome: 'absent' }, remnantReceipt: join(destination, installReceiptFile), retained: ['state/plugin.sqlite'] });
    expect(await readInstallReceipt(destination)).toMatchObject({ hostDirectories: ['plugins', 'plugins/local'], registrations: [] });
    // Uninstalling the remnant itself while the retained entry is still there is the documented no-op: nothing to
    // remove, the remnant receipt stays in place unchanged, and the run reports `not-installed`.
    const remnantBefore = await readFile(join(destination, installReceiptFile), 'utf8');
    const rerun = await uninstallBundle(options);
    expect(rerun).toMatchObject({
      data: { outcome: 'absent' },
      receipt: { status: 'remnant' },
      registrations: [{ action: 'already-absent', kind: 'cursor-local-plugin' }],
      remnantReceipt: join(destination, installReceiptFile),
      removed: { directories: [], files: [] },
      retained: ['state/plugin.sqlite'],
      state: 'not-installed',
    });
    expect(await readFile(join(destination, installReceiptFile), 'utf8')).toBe(remnantBefore);
    expect(await uninstallBundle({ ...options, plan: true })).toMatchObject({ receipt: { status: 'remnant' }, state: 'not-installed' });
    // Reinstall around the retained entry carries the host directories forward; once the operator removes state/,
    // a confirmed purge restores the home exactly.
    expect(await installBundle(options)).toMatchObject({ state: 'installed' });
    expect(await readInstallReceipt(destination)).toMatchObject({ hostDirectories: ['plugins', 'plugins/local'], registrations: [{ kind: 'cursor-local-plugin' }] });
    await removeTree(join(destination, 'state'));
    const purged = await uninstallBundle({ ...options, confirmPurge: true, purgeData: true });
    expect(purged.removed.directories).toEqual(expect.arrayContaining([join(cursorRoot, 'plugins', 'local'), join(cursorRoot, 'plugins')]));
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });

    // A remnant whose state/ was later removed by hand guards nothing: the keep-data no-op applies only while the
    // preserved data is still there, so a default rerun consumes the remnant (receipt, empty root, recorded host
    // directories) exactly as an explicit purge would, and `--plan` says so first.
    await installBundle(options);
    await mkdir(join(destination, 'state'));
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    expect((await uninstallBundle(options)).remnantReceipt).toBe(join(destination, installReceiptFile));
    await removeTree(join(destination, 'state'));
    const emptyPlan = await uninstallBundle({ ...options, plan: true });
    expect(emptyPlan).toMatchObject({
      data: { outcome: 'absent', policy: 'keep' },
      receipt: { status: 'consumed' },
      registrations: [{ action: 'already-absent', kind: 'cursor-local-plugin' }],
      removed: { directories: [destination, join(cursorRoot, 'plugins', 'local'), join(cursorRoot, 'plugins')], files: [join(destination, installReceiptFile)] },
      state: 'planned',
    });
    expect(emptyPlan.remnantReceipt).toBeUndefined();
    const consumed = await uninstallBundle(options);
    expect(consumed).toMatchObject({ data: { outcome: 'absent' }, removed: emptyPlan.removed, state: 'uninstalled' });
    expect(consumed.remnantReceipt).toBeUndefined();
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });

    // A state/ directory emptied by hand is still an unowned directory: the uninstall never prunes it, so the remnant
    // stays a no-op until the operator removes the directory itself.
    await installBundle(options);
    await mkdir(join(destination, 'state'));
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    expect((await uninstallBundle(options)).remnantReceipt).toBe(join(destination, installReceiptFile));
    await rm(join(destination, 'state', 'plugin.sqlite'));
    expect(await uninstallBundle(options)).toMatchObject({
      receipt: { status: 'remnant' },
      removed: { directories: [], files: [] },
      retained: ['state/'],
      state: 'not-installed',
    });
    await removeTree(join(destination, 'state'));
    const emptiedState = await uninstallBundle(options);
    expect(emptiedState).toMatchObject({ data: { outcome: 'absent' }, receipt: { status: 'consumed' }, state: 'uninstalled' });
    expect(emptiedState.removed.directories).toEqual([destination, join(cursorRoot, 'plugins', 'local'), join(cursorRoot, 'plugins')]);
    expect(emptiedState.remnantReceipt).toBeUndefined();
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });

    // A receipt recording a PLUGIN_DATA expansion (written by the emitted install.mjs for an Agent Plugins pack):
    // the directory is receipt-owned durable state outside the plugin root. Written → kept behind a remnant that
    // carries the expansion (the root survives to own it), purged only when confirmed; empty → pruned with its
    // agent-bundle parents; recorded at another home → never touched.
    const pluginData = join(cursorRoot, 'agent-bundle', 'plugin-data', 'uninstall-fixture');
    const withExpansion = async (recordedPluginData: string) => {
      await installBundle(options);
      const receipt = JSON.parse(await readFile(join(destination, installReceiptFile), 'utf8')) as Record<string, unknown>;
      await writeFile(join(destination, installReceiptFile), JSON.stringify({
        ...receipt,
        cursorExpansion: { documents: { 'mcp.json': '{}\n' }, pluginData: recordedPluginData, pluginRoot: destination },
      }));
    };
    await withExpansion(pluginData);
    await mkdir(join(pluginData, 'cache'), { recursive: true });
    await writeFile(join(pluginData, 'cache', 'index.json'), '{}\n');
    const keptPlan = await uninstallBundle({ ...options, plan: true });
    expect(keptPlan).toMatchObject({ data: { outcome: 'kept', paths: [pluginData] }, remnantReceipt: join(destination, installReceiptFile), state: 'planned' });
    expect(keptPlan.removed.directories).not.toContain(destination);
    const keptData = await uninstallBundle(options);
    expect(keptData).toMatchObject({ data: { outcome: 'kept', paths: [pluginData] }, remnantReceipt: join(destination, installReceiptFile), state: 'uninstalled' });
    expect(keptData.removed).toEqual(keptPlan.removed);
    expect(await readFile(join(pluginData, 'cache', 'index.json'), 'utf8')).toBe('{}\n');
    expect(await readInstallReceipt(destination)).toMatchObject({ cursorExpansion: { pluginData, pluginRoot: destination }, files: [], registrations: [] });
    expect(await uninstallBundle(options)).toMatchObject({ data: { outcome: 'kept', paths: [pluginData] }, receipt: { status: 'remnant' }, state: 'not-installed' });
    const purgedData = await uninstallBundle({ ...options, confirmPurge: true, purgeData: true });
    expect(purgedData).toMatchObject({ data: { outcome: 'purged', paths: [pluginData] }, state: 'uninstalled' });
    expect(purgedData.removed.directories).toEqual(expect.arrayContaining([pluginData, join(cursorRoot, 'agent-bundle', 'plugin-data'), join(cursorRoot, 'agent-bundle'), destination]));
    expect(purgedData.remnantReceipt).toBeUndefined();
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });

    // The same for a kept PLUGIN_DATA directory later emptied by hand: the remnant no longer guards data, so the next
    // default run prunes the empty directory with its agent-bundle parents and consumes the remnant.
    await withExpansion(pluginData);
    await mkdir(join(pluginData, 'cache'), { recursive: true });
    await writeFile(join(pluginData, 'cache', 'index.json'), '{}\n');
    expect(await uninstallBundle(options)).toMatchObject({ data: { outcome: 'kept' }, remnantReceipt: join(destination, installReceiptFile) });
    await removeTree(join(pluginData, 'cache'));
    const emptiedByHand = await uninstallBundle(options);
    expect(emptiedByHand).toMatchObject({ data: { detail: expect.stringContaining('is empty and is pruned'), outcome: 'absent' }, receipt: { status: 'consumed' }, state: 'uninstalled' });
    expect(emptiedByHand.removed.directories).toEqual(expect.arrayContaining([pluginData, join(cursorRoot, 'agent-bundle', 'plugin-data'), join(cursorRoot, 'agent-bundle'), destination]));
    expect(emptiedByHand.remnantReceipt).toBeUndefined();
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });

    // A symlinked ancestor on the way to PLUGIN_DATA (agent-bundle or plugin-data) would let a recursive purge of the
    // leaf follow it outside the Cursor home: refused before anything is read or removed, whichever link it is.
    const outside = join(fixture.cleanupRoot, 'outside-home');
    await mkdir(join(outside, 'plugin-data', 'uninstall-fixture'), { recursive: true });
    await writeFile(join(outside, 'plugin-data', 'uninstall-fixture', 'cache.sqlite'), 'elsewhere\n');
    await withExpansion(pluginData);
    await symlink(outside, join(cursorRoot, 'agent-bundle'));
    const linkedParent = await failureOf(uninstallBundle({ ...options, confirmPurge: true, purgeData: true }));
    expect(linkedParent.diagnostics[0]).toMatchObject({ code: 'AB7007', target: 'cursor' });
    expect(await readFile(join(outside, 'plugin-data', 'uninstall-fixture', 'cache.sqlite'), 'utf8')).toBe('elsewhere\n');
    await rm(join(cursorRoot, 'agent-bundle'));
    await mkdir(join(cursorRoot, 'agent-bundle'));
    await symlink(join(outside, 'plugin-data'), join(cursorRoot, 'agent-bundle', 'plugin-data'));
    const linkedChild = await failureOf(uninstallBundle(options));
    expect(linkedChild.diagnostics[0]).toMatchObject({ code: 'AB7007', target: 'cursor' });
    expect(await readFile(join(outside, 'plugin-data', 'uninstall-fixture', 'cache.sqlite'), 'utf8')).toBe('elsewhere\n');
    await removeTree(join(cursorRoot, 'agent-bundle'));
    await removeTree(outside);
    expect(await uninstallBundle(options)).toMatchObject({ state: 'uninstalled' });
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });

    await withExpansion(pluginData);
    await mkdir(pluginData, { recursive: true });
    const emptyData = await uninstallBundle({ ...options, plan: true });
    expect(emptyData).toMatchObject({ data: { detail: expect.stringContaining('is empty and is pruned'), outcome: 'absent' }, state: 'planned' });
    expect(emptyData.removed.directories).toEqual(expect.arrayContaining([pluginData, join(cursorRoot, 'agent-bundle', 'plugin-data'), join(cursorRoot, 'agent-bundle')]));
    expect((await uninstallBundle(options)).removed).toEqual(emptyData.removed);
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });

    const elsewhere = join(fixture.cleanupRoot, 'other-home', '.cursor', 'agent-bundle', 'plugin-data', 'uninstall-fixture');
    await withExpansion(elsewhere);
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, 'note.txt'), 'theirs\n');
    const foreignData = await uninstallBundle({ ...options, confirmPurge: true, purgeData: true });
    expect(foreignData).toMatchObject({ data: { detail: expect.stringContaining(`records PLUGIN_DATA at ${elsewhere}`), outcome: 'absent' }, state: 'uninstalled' });
    expect(await readFile(join(elsewhere, 'note.txt'), 'utf8')).toBe('theirs\n');
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('purges AGENT_BUNDLE_STATE_ROOT from the host MCP document the installed manifest points at', async () => {
  const cleanupRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-uninstall-state-'));
  const declaredStateRoot = join(cleanupRoot, 'declared-state');
  const fixture = await createFixture('cursor', {
    mcpDocument: { mcpServers: { stateful: { command: 'node', env: { AGENT_BUNDLE_STATE_ROOT: declaredStateRoot } } } },
  });
  const cursorRoot = join(fixture.home, '.cursor');
  const options = { from: fixture.bundleRoot, home: fixture.home, host: 'cursor' as const };
  try {
    await mkdir(cursorRoot, { recursive: true });
    await installBundle(options);
    expect(await readInstallReceipt(join(cursorRoot, 'plugins', 'local', 'uninstall-fixture')))
      .toMatchObject({
        state: {
          roots: [{
            ownership: { kind: 'marker', marker: join(declaredStateRoot, '.agent-bundle-state-owner.json') },
            root: declaredStateRoot,
            servers: ['stateful'],
            source: 'declared',
          }],
        },
      });
    await writeFile(join(declaredStateRoot, 'plugin.sqlite'), 'declared\n');
    const plan = await uninstallBundle({ ...options, confirmPurge: true, plan: true, purgeData: true });
    expect(plan.data.paths).toEqual([declaredStateRoot]);
    expect(plan.removed.directories).toContain(declaredStateRoot);
    const kept = await uninstallBundle({ ...options, keepData: true });
    expect(kept).toMatchObject({
      data: { outcome: 'kept', paths: [declaredStateRoot] },
      remnantReceipt: join(cursorRoot, 'plugins', 'local', 'uninstall-fixture', installReceiptFile),
    });
    expect(await readInstallReceipt(join(cursorRoot, 'plugins', 'local', 'uninstall-fixture')))
      .toMatchObject({ state: { roots: [{ root: declaredStateRoot, source: 'declared' }] } });
    expect(await readFile(join(declaredStateRoot, 'plugin.sqlite'), 'utf8')).toBe('declared\n');
    const purged = await uninstallBundle({ ...options, confirmPurge: true, purgeData: true });
    expect(purged.data).toMatchObject({ outcome: 'purged', paths: [declaredStateRoot] });
    await expect(readdir(declaredStateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await Promise.all([
      removeTree(fixture.cleanupRoot),
      removeTree(cleanupRoot),
    ]);
  }
});

it('never purges a pre-existing declared state root or its unrelated sentinel', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  const sharedRoot = join(fixture.cleanupRoot, 'shared-state');
  const sentinel = join(sharedRoot, 'unrelated.txt');
  const options = { from: fixture.bundleRoot, home: fixture.home, host: 'cursor' as const };
  try {
    await Promise.all([
      mkdir(cursorRoot, { recursive: true }),
      mkdir(sharedRoot, { recursive: true }),
      writeFixtureMcp(fixture, 'cursor', {
        mcpServers: {
          stateful: {
            command: 'node',
            env: { AGENT_BUNDLE_STATE_ROOT: sharedRoot },
          },
        },
      }),
    ]);
    await writeFile(sentinel, 'keep\n');
    await installBundle(options);
    const plan = await uninstallBundle({ ...options, confirmPurge: true, plan: true, purgeData: true });
    expect(plan.data).toMatchObject({
      outcome: 'kept',
      paths: [],
      retained: [{ path: sharedRoot, reason: 'pre-existing' }],
    });
    expect(plan.removed.directories).not.toContain(sharedRoot);
    const kept = await uninstallBundle(options);
    expect(kept.remnantReceipt).toBe(join(
      cursorRoot,
      'plugins',
      'local',
      'uninstall-fixture',
      installReceiptFile,
    ));
    expect((await readInstallReceipt(join(
      cursorRoot,
      'plugins',
      'local',
      'uninstall-fixture',
    )))?.state?.roots[0]).toMatchObject({ root: sharedRoot });
    await uninstallBundle({ ...options, confirmPurge: true, purgeData: true });
    expect(await readFile(sentinel, 'utf8')).toBe('keep\n');
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('prunes a newly marked explicit root when no runtime state was written', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  const declaredRoot = join(fixture.cleanupRoot, 'unused-state');
  const options = { from: fixture.bundleRoot, home: fixture.home, host: 'cursor' as const };
  try {
    await Promise.all([
      mkdir(cursorRoot, { recursive: true }),
      writeFixtureMcp(fixture, 'cursor', {
        mcpServers: {
          stateful: {
            command: 'node',
            env: { AGENT_BUNDLE_STATE_ROOT: declaredRoot },
          },
        },
      }),
    ]);
    await installBundle(options);
    expect(await readdir(declaredRoot)).toEqual(['.agent-bundle-state-owner.json']);
    const removed = await uninstallBundle(options);
    expect(removed.data.outcome).toBe('absent');
    expect(removed.remnantReceipt).toBeUndefined();
    await expect(readdir(declaredRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('records an inaccessible declared root as unproven without failing installation', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  const blockedParent = join(fixture.cleanupRoot, 'not-a-directory');
  try {
    await Promise.all([
      mkdir(cursorRoot, { recursive: true }),
      writeFile(blockedParent, 'file\n'),
      writeFixtureMcp(fixture, 'cursor', {
        mcpServers: {
          stateful: {
            command: 'node',
            env: { AGENT_BUNDLE_STATE_ROOT: join(blockedParent, 'state') },
          },
        },
      }),
    ]);
    const installed = await installBundle({
      from: fixture.bundleRoot,
      home: fixture.home,
      host: 'cursor',
    });
    if (installed.destination === undefined) throw new Error('Cursor install did not report its destination.');
    expect((await readInstallReceipt(installed.destination))?.state?.roots).toMatchObject([{
      ownership: { kind: 'unowned', reason: 'unproven' },
      root: join(blockedParent, 'state'),
    }]);
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('rolls back earlier state markers when a later root cannot be recorded', async () => {
  const fixture = await createFixture('cursor');
  const firstRoot = join(fixture.cleanupRoot, 'first-state');
  const invalidRoot = join(fixture.cleanupRoot, 'x'.repeat(300));
  try {
    await writeFixtureMcp(fixture, 'cursor', {
      mcpServers: {
        first: {
          command: 'node',
          env: { AGENT_BUNDLE_STATE_ROOT: firstRoot },
        },
        second: {
          command: 'node',
          env: { AGENT_BUNDLE_STATE_ROOT: invalidRoot },
        },
      },
    });
    await expect(recordInstalledState({
      environment: {},
      home: fixture.home,
      host: 'cursor',
      mode: 'local',
      plugin: 'uninstall-fixture',
      pluginRoot: fixture.bundleRoot,
      scope: 'user',
    })).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:ENAMETOOLONG|EINVAL)$/u),
    });
    await expect(readdir(firstRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('purges only the install-time AGENT_BUNDLE_STATE_ROOT when the uninstall environment changes', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  const recordedRoot = join(fixture.cleanupRoot, 'install-state-root');
  const unrelatedRoot = join(fixture.cleanupRoot, 'uninstall-state-root');
  const installEnvironment = { AGENT_BUNDLE_STATE_ROOT: recordedRoot };
  const uninstallEnvironment = { AGENT_BUNDLE_STATE_ROOT: unrelatedRoot };
  const sentinel = join(unrelatedRoot, 'unrelated.txt');
  try {
    await mkdir(cursorRoot, { recursive: true });
    await installBundle({ environment: installEnvironment, from: fixture.bundleRoot, home: fixture.home, host: 'cursor' });
    await mkdir(unrelatedRoot, { recursive: true });
    await Promise.all([
      writeFile(join(recordedRoot, 'plugin.sqlite'), 'owned\n'),
      writeFile(sentinel, 'keep\n'),
    ]);
    const purged = await uninstallBundle({
      confirmPurge: true,
      environment: uninstallEnvironment,
      from: fixture.bundleRoot,
      home: fixture.home,
      host: 'cursor',
      purgeData: true,
    });
    expect(purged.data.paths).toContain(recordedRoot);
    expect(purged.data.paths).not.toContain(unrelatedRoot);
    await expect(readdir(recordedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(sentinel, 'utf8')).toBe('keep\n');
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('records and purges each server state root using its execution cwd', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  const destination = join(cursorRoot, 'plugins', 'local', 'uninstall-fixture');
  const firstRoot = join(fixture.cleanupRoot, 'first-state');
  const relativeRoot = join(destination, 'shared-state');
  try {
    await Promise.all([
      mkdir(cursorRoot, { recursive: true }),
      writeFixtureMcp(fixture, 'cursor', {
        mcpServers: {
          alpha: {
            command: 'node',
            env: { AGENT_BUNDLE_STATE_ROOT: firstRoot },
          },
          beta: {
            command: 'node',
            cwd: '${CURSOR_PLUGIN_ROOT}/runtime',
            env: { AGENT_BUNDLE_STATE_ROOT: '../shared-state' },
          },
        },
      }),
    ]);
    await installBundle({ from: fixture.bundleRoot, home: fixture.home, host: 'cursor' });
    expect((await readInstallReceipt(destination))?.state?.roots).toEqual([
      expect.objectContaining({ root: firstRoot, servers: ['alpha'], source: 'declared' }),
      expect.objectContaining({ root: relativeRoot, servers: ['beta'], source: 'declared' }),
    ]);
    await Promise.all([
      writeFile(join(firstRoot, 'alpha.sqlite'), 'alpha\n'),
      writeFile(join(relativeRoot, 'beta.sqlite'), 'beta\n'),
    ]);
    const purged = await uninstallBundle({
      confirmPurge: true,
      from: fixture.bundleRoot,
      home: fixture.home,
      host: 'cursor',
      purgeData: true,
    });
    expect(purged.data.paths).toEqual([firstRoot, relativeRoot]);
    await expect(readdir(firstRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(relativeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('retains a marked root when its marker is replaced by another install identity', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  const declaredRoot = join(fixture.cleanupRoot, 'marked-state');
  const marker = join(declaredRoot, '.agent-bundle-state-owner.json');
  try {
    await Promise.all([
      mkdir(cursorRoot, { recursive: true }),
      writeFixtureMcp(fixture, 'cursor', {
        mcpServers: {
          stateful: {
            command: 'node',
            env: { AGENT_BUNDLE_STATE_ROOT: declaredRoot },
          },
        },
      }),
    ]);
    await installBundle({ from: fixture.bundleRoot, home: fixture.home, host: 'cursor' });
    await writeJson(marker, {
      format: 1,
      owner: { host: 'cursor', id: 'another-install', mode: 'local', plugin: 'other', scope: 'user' },
    });
    const sentinel = join(declaredRoot, 'sentinel.txt');
    await writeFile(sentinel, 'keep\n');
    const result = await uninstallBundle({
      confirmPurge: true,
      from: fixture.bundleRoot,
      home: fixture.home,
      host: 'cursor',
      purgeData: true,
    });
    expect(result.data).toMatchObject({
      outcome: 'kept',
      retained: [{ path: declaredRoot, reason: 'marker-mismatch' }],
    });
    expect(await readFile(sentinel, 'utf8')).toBe('keep\n');
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('lets only the owning installation purge a root shared by two installs', async () => {
  const owner = await createFixture('cursor');
  const observer = await createFixture('cursor');
  const sharedRoot = join(owner.cleanupRoot, 'shared-state');
  const manifest = {
    mcpServers: {
      stateful: {
        command: 'node',
        env: { AGENT_BUNDLE_STATE_ROOT: sharedRoot },
      },
    },
  };
  try {
    await Promise.all([
      mkdir(join(owner.home, '.cursor'), { recursive: true }),
      mkdir(join(observer.home, '.cursor'), { recursive: true }),
      writeFixtureMcp(owner, 'cursor', manifest),
      writeFixtureMcp(observer, 'cursor', manifest),
    ]);
    await installBundle({ from: owner.bundleRoot, home: owner.home, host: 'cursor' });
    await installBundle({ from: observer.bundleRoot, home: observer.home, host: 'cursor' });
    const observerRoot = join(observer.home, '.cursor', 'plugins', 'local', 'uninstall-fixture');
    expect((await readInstallReceipt(observerRoot))?.state?.roots[0]?.ownership).toEqual({
      kind: 'unowned',
      reason: 'foreign-marker',
    });
    const sentinel = join(sharedRoot, 'sentinel.txt');
    await writeFile(sentinel, 'keep\n');
    const retained = await uninstallBundle({
      confirmPurge: true,
      from: observer.bundleRoot,
      home: observer.home,
      host: 'cursor',
      purgeData: true,
    });
    expect(retained.data.retained).toEqual([{ path: sharedRoot, reason: 'foreign-marker' }]);
    expect(await readFile(sentinel, 'utf8')).toBe('keep\n');
    await uninstallBundle({
      confirmPurge: true,
      from: owner.bundleRoot,
      home: owner.home,
      host: 'cursor',
      purgeData: true,
    });
    await expect(readdir(sharedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await Promise.all([
      removeTree(owner.cleanupRoot),
      removeTree(observer.cleanupRoot),
    ]);
  }
});

it('retains a marked root when a symlinked ancestor is retargeted', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  const firstTarget = join(fixture.cleanupRoot, 'first-target');
  const secondTarget = join(fixture.cleanupRoot, 'second-target');
  const linkedBase = join(fixture.cleanupRoot, 'state-link');
  const declaredRoot = join(linkedBase, 'owned-state');
  try {
    await Promise.all([
      mkdir(cursorRoot, { recursive: true }),
      mkdir(firstTarget),
      mkdir(secondTarget),
      writeFixtureMcp(fixture, 'cursor', {
        mcpServers: {
          stateful: {
            command: 'node',
            env: { AGENT_BUNDLE_STATE_ROOT: declaredRoot },
          },
        },
      }),
    ]);
    await symlink(firstTarget, linkedBase);
    await installBundle({ from: fixture.bundleRoot, home: fixture.home, host: 'cursor' });
    await rm(linkedBase);
    await mkdir(join(secondTarget, 'owned-state'));
    const sentinel = join(secondTarget, 'owned-state', 'sentinel.txt');
    await writeFile(sentinel, 'keep\n');
    await symlink(secondTarget, linkedBase);
    const result = await uninstallBundle({
      confirmPurge: true,
      from: fixture.bundleRoot,
      home: fixture.home,
      host: 'cursor',
      purgeData: true,
    });
    expect(result.data).toMatchObject({
      outcome: 'kept',
      retained: [{ path: declaredRoot, reason: 'canonical-path-changed' }],
    });
    expect(await readFile(sentinel, 'utf8')).toBe('keep\n');
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('refuses Cursor local uninstalls without proof of ownership unless forced, and foreign directories always', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  await mkdir(cursorRoot);
  const destination = join(cursorRoot, 'plugins', 'local', 'uninstall-fixture');
  const options = { from: fixture.bundleRoot, home: fixture.home, host: 'cursor' as const };
  try {
    await installBundle(options);
    const receiptPath = join(destination, installReceiptFile);

    // Owned content modified after install: refused with the hash comparison; --force removes the owned set anyway.
    await writeFile(join(destination, 'payload.txt'), 'modified\n');
    const mismatch = await failureOf(uninstallBundle(options));
    expect(mismatch.diagnostics[0]).toMatchObject({ code: 'AB7007', target: 'cursor' });
    expect(mismatch.diagnostics[0]?.message).toContain('modified after installation');
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('modified\n');
    const forcedMismatch = await uninstallBundle({ ...options, force: true, plan: true });
    expect(forcedMismatch).toMatchObject({ forced: true, receipt: { status: 'forced-mismatch' }, state: 'planned' });
    expect(await uninstallBundle({ ...options, force: true })).toMatchObject({ receipt: { status: 'forced-mismatch' }, state: 'uninstalled' });
    await expect(readdir(destination)).rejects.toMatchObject({ code: 'ENOENT' });

    // A copy without a receipt (placed before receipts existed) is foreign: refused with and without --force,
    // and nothing under it is touched.
    await installBundle(options);
    await rm(receiptPath);
    await mkdir(join(destination, 'state'));
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    const preReceipt = await snapshotTree(destination);
    for (const force of [false, true]) {
      const refused = await failureOf(uninstallBundle({ ...options, force }));
      expect(refused.diagnostics[0]).toMatchObject({ code: 'AB7007', target: 'cursor' });
      expect(refused.diagnostics[0]?.message).toContain(
        `Refusing to uninstall foreign directory ${destination}: it carries no install receipt naming uninstall-fixture (manifest names "uninstall-fixture")`,
      );
      expect(refused.diagnostics[0]?.message).toContain('--force does not apply to foreign directories');
    }
    expect(diffTreeSnapshots(preReceipt, await snapshotTree(destination))).toEqual({ added: [], changed: [], removed: [] });
    await removeTree(destination);

    // A receipt naming another plugin, or a directory that is not ours at all: refused even with --force.
    await installBundle(options);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    await writeFile(receiptPath, JSON.stringify({ ...receipt, plugin: 'someone-else' }));
    const otherPlugin = await failureOf(uninstallBundle({ ...options, force: true }));
    expect(otherPlugin.diagnostics[0]).toMatchObject({ code: 'AB7007', target: 'cursor' });
    expect(otherPlugin.diagnostics[0]?.message).toContain('names plugin "someone-else"');
    await removeTree(destination);
    await mkdir(join(destination, '.cursor-plugin'), { recursive: true });
    await writeJson(join(destination, '.cursor-plugin', 'plugin.json'), { name: 'uninstall-fixture', version: '1.2.3' });
    await writeFile(join(destination, 'payload.txt'), 'someone else\n');
    const foreign = await failureOf(uninstallBundle({ ...options, force: true }));
    expect(foreign.diagnostics[0]).toMatchObject({ code: 'AB7007', target: 'cursor' });
    expect(foreign.diagnostics[0]?.message).toContain('foreign directory');
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('someone else\n');

    // A symlinked destination is never traversed.
    await removeTree(destination);
    const elsewhere = join(fixture.cleanupRoot, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, destination);
    const linked = await failureOf(uninstallBundle({ ...options, force: true }));
    expect(linked.diagnostics[0]).toMatchObject({ code: 'AB7007' });
    expect(await readdir(elsewhere)).toEqual([]);
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('treats a format/1 Cursor receipt as no receipt: install and uninstall refuse the copy as foreign', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  await mkdir(join(cursorRoot, 'plugins', 'local'), { recursive: true });
  const destination = join(cursorRoot, 'plugins', 'local', 'uninstall-fixture');
  const options = { from: fixture.bundleRoot, home: fixture.home, host: 'cursor' as const };
  try {
    await installBundle(options);
    const receiptPath = join(destination, installReceiptFile);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    const { hostDirectories: _h, mode: _m, registrations: _r, scope: _s, updatedAt: _u, ...formatOne } = receipt;
    await writeFile(receiptPath, JSON.stringify({ ...formatOne, format: 'agent-bundle-install-receipt/1' }));
    expect(await readInstallReceipt(destination)).toBeUndefined();
    const before = await snapshotTree(fixture.home);

    const install = await failureOf(installBundle({ ...options, replace: true }));
    expect(install.diagnostics[0]).toMatchObject({ code: 'AB7005', target: 'cursor' });
    expect(install.diagnostics[0]?.message).toContain(`Refusing foreign install at ${destination}`);
    for (const force of [false, true]) {
      const uninstall = await failureOf(uninstallBundle({ ...options, force }));
      expect(uninstall.diagnostics[0]).toMatchObject({ code: 'AB7007', target: 'cursor' });
      expect(uninstall.diagnostics[0]?.message).toContain(`Refusing to uninstall foreign directory ${destination}`);
    }
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('never derives purge ownership from the current environment for a receipt without a state block', async () => {
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  await mkdir(join(cursorRoot, 'plugins', 'local'), { recursive: true });
  const destination = join(cursorRoot, 'plugins', 'local', 'uninstall-fixture');
  const originalEnvironment = { XDG_STATE_HOME: join(fixture.cleanupRoot, 'original-state-home') };
  const currentEnvironment = { XDG_STATE_HOME: join(fixture.cleanupRoot, 'current-state-home') };
  const options = { from: fixture.bundleRoot, home: fixture.home, host: 'cursor' as const };
  const originalStateRoot = userDataStateRoot(destination, originalEnvironment, fixture.home);
  const currentStateRoot = userDataStateRoot(destination, currentEnvironment, fixture.home);
  const currentSentinel = join(currentStateRoot, 'unrelated.txt');
  try {
    await installBundle({ ...options, environment: originalEnvironment });
    await mkdir(originalStateRoot, { recursive: true });
    await writeFile(join(originalStateRoot, 'state.sqlite'), 'original\n');
    const receiptPath = join(destination, installReceiptFile);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    const { state: _state, ...withoutState } = receipt;
    await writeFile(receiptPath, JSON.stringify(withoutState));
    await mkdir(currentStateRoot, { recursive: true });
    await writeFile(currentSentinel, 'unrelated\n');

    const plan = await uninstallBundle({
      ...options,
      confirmPurge: true,
      environment: currentEnvironment,
      plan: true,
      purgeData: true,
    });
    expect(plan.data).toMatchObject({
      outcome: 'kept',
      paths: [],
      retained: [{ path: currentStateRoot, reason: 'unproven' }],
    });
    expect(plan.removed.directories).not.toContain(currentStateRoot);

    const kept = await uninstallBundle({ ...options, environment: currentEnvironment, keepData: true });
    expect(kept.data).toMatchObject({
      outcome: 'kept',
      paths: [],
      retained: [{ path: currentStateRoot, reason: 'unproven' }],
    });
    const remnant = await readInstallReceipt(destination);
    expect(remnant?.state).toBeUndefined();

    const purged = await uninstallBundle({
      ...options,
      confirmPurge: true,
      environment: currentEnvironment,
      purgeData: true,
    });
    expect(purged.data).toMatchObject({
      outcome: 'kept',
      paths: [],
      retained: [{ path: currentStateRoot, reason: 'unproven' }],
    });
    expect(await readFile(currentSentinel, 'utf8')).toBe('unrelated\n');
    expect(await readFile(join(originalStateRoot, 'state.sqlite'), 'utf8')).toBe('original\n');
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

const gitAvailable = (): Promise<boolean> => new Promise((resolvePromise) => {
  execFile('git', ['--version'], (error) => { resolvePromise(error === null); });
});

it('removes a staged Cursor marketplace repository only when its HEAD matches the receipt', async () => {
  if (!await gitAvailable()) return;
  const fixture = await createFixture('cursor');
  const cursorRoot = join(fixture.home, '.cursor');
  await mkdir(cursorRoot);
  const repo = join(cursorRoot, 'agent-bundle', 'marketplaces', 'uninstall-fixture');
  const receiptPath = join(cursorRoot, 'agent-bundle', 'receipts', 'uninstall-fixture.marketplace.json');
  const options = { from: fixture.bundleRoot, home: fixture.home, host: 'cursor' as const, mode: 'marketplace' as const };
  try {
    const before = await snapshotTree(fixture.home);
    expect(await uninstallBundle(options)).toMatchObject({ state: 'not-installed' });
    const staged = await installBundle(options);
    expect(staged).toMatchObject({ mode: 'marketplace', receipt: receiptPath, state: 'staged' });
    expect(await readInstallReceiptFile(receiptPath)).toMatchObject({
      files: [],
      mode: 'marketplace',
      registrations: [{ commit: staged.commit, kind: 'cursor-marketplace-staging', name: 'uninstall-fixture-marketplace' }],
    });
    // Rerunning the installer keeps the same receipt (same commit, same content).
    expect(await installBundle(options)).toMatchObject({ state: 'already-installed' });

    const plan = await uninstallBundle({ ...options, plan: true });
    expect(plan).toMatchObject({
      data: { outcome: 'unavailable' },
      destination: repo,
      registrations: [{ action: 'planned', commit: staged.commit, kind: 'cursor-marketplace-staging' }],
      // The plan names the store and staging directories the run would prune, in the run's order.
      removed: {
        directories: [repo, join(cursorRoot, 'agent-bundle', 'receipts'), join(cursorRoot, 'agent-bundle', 'marketplaces'), join(cursorRoot, 'agent-bundle')],
        files: [receiptPath],
      },
      state: 'planned',
    });
    expect(plan.nextSteps).toBeUndefined();

    // A staged tree that no longer matches the recorded commit is refused without --force.
    await writeFile(join(repo, '.git', 'HEAD'), '0000000000000000000000000000000000000000\n');
    const drifted = await failureOf(uninstallBundle(options));
    expect(drifted.diagnostics[0]).toMatchObject({ code: 'AB7007', target: 'cursor' });
    expect(drifted.diagnostics[0]?.message).toContain('receipt recorded commit');
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/master\n').catch(() => undefined);
    // Restore HEAD to whatever branch git created (main or master).
    const heads = await readdir(join(repo, '.git', 'refs', 'heads'));
    await writeFile(join(repo, '.git', 'HEAD'), `ref: refs/heads/${heads[0]}\n`);

    // HEAD matches the receipt, but someone added an untracked file to the staged working tree: the receipt does
    // not own it and the removal is recursive, so the uninstall (and its plan) refuses without --force.
    await writeFile(join(repo, 'notes.txt'), 'operator notes\n');
    const dirty = await failureOf(uninstallBundle(options));
    expect(dirty.diagnostics[0]).toMatchObject({ code: 'AB7007', target: 'cursor' });
    expect(dirty.diagnostics[0]?.message).toContain('working tree differs from the receipted commit');
    expect(dirty.diagnostics[0]?.message).toContain('"notes.txt"');
    expect((await failureOf(uninstallBundle({ ...options, plan: true }))).diagnostics[0]).toMatchObject({ code: 'AB7007' });
    expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('operator notes\n');
    // --force removes it anyway and says so through the receipt status.
    expect(await uninstallBundle({ ...options, force: true, plan: true })).toMatchObject({ receipt: { status: 'forced-mismatch' }, state: 'planned' });
    await rm(join(repo, 'notes.txt'));

    const result = await uninstallBundle(options);
    expect(result).toMatchObject({
      receipt: { status: 'consumed' },
      registrations: [{ action: 'removed', kind: 'cursor-marketplace-staging' }],
      state: 'uninstalled',
    });
    // The completed result removes exactly what the plan named.
    expect(result.removed).toEqual(plan.removed);
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });

    // Staging without a receipt (or a receipt someone deleted): refused, then removable with --force once verified ours.
    await installBundle(options);
    await rm(receiptPath);
    const missing = await failureOf(uninstallBundle(options));
    expect(missing.diagnostics[0]).toMatchObject({ code: 'AB7009', target: 'cursor' });
    expect(await uninstallBundle({ ...options, force: true })).toMatchObject({ receipt: { status: 'forced-missing' }, state: 'uninstalled' });
    // An orphaned receipt (repository already gone) is consumed quietly.
    await installBundle(options);
    await removeTree(repo);
    expect(await uninstallBundle(options)).toMatchObject({
      registrations: [{ action: 'already-absent', kind: 'cursor-marketplace-staging' }],
      removed: { files: [receiptPath] },
      state: 'uninstalled',
    });
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });

    // Cursor imported the staging (a completed cache copy at the recorded commit) and the staged repository was
    // deleted afterwards: the imported copy is still Cursor-owned, so the receipt's commit — not the repository —
    // drives the `manual` registration and the Customize step.
    const imported = await installBundle(options);
    const cachedCopy = join(cursorRoot, 'plugins', 'cache', 'uninstall-fixture-marketplace', 'uninstall-fixture', imported.commit ?? '');
    await mkdir(join(cachedCopy, '.cursor-plugin'), { recursive: true });
    await writeFile(join(cachedCopy, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'uninstall-fixture', version: '1.2.3' }));
    await writeFile(join(cachedCopy, '.cache-complete'), '');
    await removeTree(repo);
    const stagingGone = await uninstallBundle(options);
    expect(stagingGone.registrations).toEqual([
      expect.objectContaining({ action: 'already-absent', kind: 'cursor-marketplace-staging' }),
      expect.objectContaining({ action: 'manual', kind: 'cursor-marketplace-staging' }),
    ]);
    expect(stagingGone.nextSteps?.[0]).toContain('Customize -> Plugins');
    expect(await readFile(join(cachedCopy, '.cache-complete'), 'utf8')).toBe('');
    await removeTree(join(cursorRoot, 'plugins'));
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });

    // The bundle was rebuilt to a newer version after Cursor imported the staging: the imported copy carries the
    // version the receipt recorded, so detection keys on the receipt's version, not the rebuilt bundle's.
    const rebuilt = await installBundle(options);
    const olderCopy = join(cursorRoot, 'plugins', 'cache', 'uninstall-fixture-marketplace', 'uninstall-fixture', rebuilt.commit ?? '');
    await mkdir(join(olderCopy, '.cursor-plugin'), { recursive: true });
    await writeFile(join(olderCopy, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'uninstall-fixture', version: '1.2.3' }));
    await writeFile(join(olderCopy, '.cache-complete'), '');
    await writeJson(join(fixture.bundleRoot, '.cursor-plugin/plugin.json'), { name: 'uninstall-fixture', version: '1.3.0' });
    const afterRebuild = await uninstallBundle(options);
    expect(afterRebuild.registrations).toEqual([
      expect.objectContaining({ action: 'removed', kind: 'cursor-marketplace-staging' }),
      expect.objectContaining({ action: 'manual', kind: 'cursor-marketplace-staging' }),
    ]);
    expect(afterRebuild.nextSteps?.[0]).toContain('Customize -> Plugins');
    await writeJson(join(fixture.bundleRoot, '.cursor-plugin/plugin.json'), { name: 'uninstall-fixture', version: '1.2.3' });
    await removeTree(join(cursorRoot, 'plugins'));
    expect(diffTreeSnapshots(before, await snapshotTree(fixture.home))).toEqual({ added: [], changed: [], removed: [] });
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
}, 60_000);

const claudeListing = (rows: readonly Record<string, unknown>[]): string => JSON.stringify(rows);

const codexListing = (rows: readonly Record<string, unknown>[]): string => JSON.stringify({ available: [], installed: rows });

const recordingRunner = (
  respond: (call: CommandCall) => string,
): { readonly calls: CommandCall[]; readonly runner: InstallCommandRunner } => {
  const calls: CommandCall[] = [];
  return {
    calls,
    runner: {
      run: async (command, args) => {
        const call = { args: [...args], command };
        calls.push(call);
        return { code: 0, stderr: '', stdout: respond(call) };
      },
    },
  };
};

it.each([
  {
    host: 'claude' as const,
    listing: (installed: boolean, installPath: string) => claudeListing(installed
      ? [{ enabled: true, id: 'uninstall-fixture@uninstall-fixture-marketplace', installPath, scope: 'user', version: '1.2.3' }]
      : []),
    marketplaces: (present: boolean) => JSON.stringify(present ? [{ name: 'uninstall-fixture-marketplace', source: 'directory' }] : []),
    removeMarketplace: 'plugin marketplace remove uninstall-fixture-marketplace',
    uninstall: 'plugin uninstall uninstall-fixture@uninstall-fixture-marketplace --scope user --keep-data',
  },
  {
    host: 'codex' as const,
    listing: (installed: boolean) => codexListing(installed
      ? [{ enabled: true, installed: true, pluginId: 'uninstall-fixture@uninstall-fixture-marketplace', version: '1.2.3' }]
      : []),
    marketplaces: (present: boolean) => JSON.stringify({ marketplaces: present ? [{ name: 'uninstall-fixture-marketplace', root: '/x' }] : [] }),
    removeMarketplace: 'plugin marketplace remove uninstall-fixture-marketplace',
    uninstall: 'plugin remove uninstall-fixture@uninstall-fixture-marketplace',
  },
])('reverses the $host registrations the receipt records, in order, and consumes the store receipt', async ({ host, listing, marketplaces, removeMarketplace, uninstall }) => {
  const fixture = await createFixture(host);
  const hostRoot = join(fixture.cleanupRoot, `${host}-root`);
  const environment = host === 'claude' ? { CLAUDE_CONFIG_DIR: hostRoot } : { CODEX_HOME: hostRoot };
  const installPath = join(hostRoot, 'plugins', 'cache', 'uninstall-fixture-marketplace', 'uninstall-fixture', '1.2.3');
  const receiptPath = join(hostRoot, 'agent-bundle', 'receipts', 'uninstall-fixture.uninstall-fixture-marketplace.user.json');
  let installed = false;
  let marketplaceRegistered = false;
  const { calls, runner } = recordingRunner((call) => {
    const verb = call.args.join(' ');
    if (verb === 'plugin list --json') return listing(installed, installPath);
    if (verb === 'plugin marketplace list --json') return marketplaces(marketplaceRegistered);
    if (verb.startsWith('plugin marketplace add')) marketplaceRegistered = true;
    if (verb.startsWith('plugin install ') || verb.startsWith('plugin add ')) installed = true;
    if (verb === uninstall) installed = false;
    if (verb === removeMarketplace) marketplaceRegistered = false;
    return '';
  });
  const options = { commandRunner: runner, environment, from: fixture.bundleRoot, home: fixture.home, host, scope: 'user' as const };
  try {
    await mkdir(hostRoot, { recursive: true });
    const before = await snapshotTree(hostRoot);
    expect(await uninstallBundle(options)).toMatchObject({ receipt: { status: 'missing' }, state: 'not-installed' });
    expect(calls.map((call) => call.args.join(' '))).toEqual(['plugin list --json']);

    calls.length = 0;
    const result = await installBundle(options);
    expect(result).toMatchObject({ receipt: receiptPath, state: 'installed' });
    // Simulate the host's cache copy so the content check has something to compare.
    await cp(fixture.bundleRoot, installPath, { recursive: true });

    calls.length = 0;
    const plan = await uninstallBundle({ ...options, plan: true });
    expect(plan).toMatchObject({
      destination: installPath,
      mode: 'host-cli',
      receipt: { path: receiptPath, status: 'consumed' },
      // Reported in execution order: the plugin leaves before the marketplace it came from.
      registrations: [
        { action: 'planned', id: 'uninstall-fixture@uninstall-fixture-marketplace', kind: `${host}-plugin` },
        { action: 'planned', kind: `${host}-marketplace`, name: 'uninstall-fixture-marketplace' },
      ],
      // The plan names the store directories the run would prune once this last receipt is gone.
      removed: { directories: [join(hostRoot, 'agent-bundle', 'receipts'), join(hostRoot, 'agent-bundle')], files: [receiptPath] },
      state: 'planned',
    });
    // Planning reads the host inventory and marketplace list only; no mutation verb runs.
    expect(calls.map((call) => call.args.join(' '))).toEqual(['plugin list --json', 'plugin marketplace list --json', 'plugin list --json']);
    expect(await readInstallReceiptFile(receiptPath)).toBeDefined();

    // The cache copy differs from the receipt: refused without --force; nothing ran but the reads.
    calls.length = 0;
    await writeFile(join(installPath, 'payload.txt'), 'modified\n');
    const mismatch = await failureOf(uninstallBundle(options));
    expect(mismatch.diagnostics[0]).toMatchObject({ code: 'AB7007', target: host });
    expect(calls.map((call) => call.args.join(' '))).toEqual(['plugin list --json']);
    await writeFile(join(installPath, 'payload.txt'), 'payload\n');

    calls.length = 0;
    const uninstalled = await uninstallBundle(options);
    expect(uninstalled).toMatchObject({
      registrations: [
        { action: 'removed', kind: `${host}-plugin` },
        { action: 'removed', kind: `${host}-marketplace` },
      ],
      removed: { files: [receiptPath] },
      state: 'uninstalled',
    });
    expect(uninstalled.removed).toEqual(plan.removed);
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'plugin list --json',
      'plugin marketplace list --json',
      'plugin list --json',
      uninstall,
      removeMarketplace,
    ]);
    expect(await readInstallReceiptFile(receiptPath)).toBeUndefined();
    // The simulated cache copy is host-owned residue in this unit test; everything Agent Bundle wrote is gone.
    await removeTree(join(hostRoot, 'plugins'));
    expect(diffTreeSnapshots(before, await snapshotTree(hostRoot))).toEqual({ added: [], changed: [], removed: [] });

    // Host says installed but no receipt: refused (AB7009) until --force, which uninstalls through the host CLI.
    await installBundle(options);
    await rm(receiptPath);
    calls.length = 0;
    const missing = await failureOf(uninstallBundle(options));
    expect(missing.diagnostics[0]).toMatchObject({ code: 'AB7009', target: host });
    expect(calls.map((call) => call.args.join(' '))).toEqual(['plugin list --json']);
    // --force never extends to durable data: without a receipt nothing proves the web-data or Claude's plugins/data
    // are this bundle's, so a forced purge is refused before any host verb runs and the data survives.
    const unprovenData = [
      installedWebDataRoot(installPath, fixture.home),
      ...(host === 'claude' ? [join(hostRoot, 'plugins', 'data', 'uninstall-fixture@uninstall-fixture-marketplace')] : []),
    ];
    for (const path of unprovenData) await writeJson(join(path, 'data.json'), { owner: 'unknown' });
    calls.length = 0;
    const forcedPurge = await failureOf(uninstallBundle({ ...options, confirmPurge: true, force: true, purgeData: true }));
    expect(forcedPurge.diagnostics[0]).toMatchObject({ code: 'AB7009', target: host });
    expect(forcedPurge.diagnostics[0]?.message).toContain('Refusing --purge-data');
    expect((await failureOf(uninstallBundle({ ...options, confirmPurge: true, force: true, plan: true, purgeData: true }))).diagnostics[0])
      .toMatchObject({ code: 'AB7009' });
    expect(calls.map((call) => call.args.join(' '))).toEqual(['plugin list --json', 'plugin list --json']);
    for (const path of unprovenData) await access(join(path, 'data.json'));
    calls.length = 0;
    const forced = await uninstallBundle({ ...options, force: true });
    expect(forced).toMatchObject({ forced: true, receipt: { status: 'forced-missing' }, state: 'uninstalled' });
    for (const path of unprovenData) await access(join(path, 'data.json'));
    for (const path of unprovenData) await removeTree(path);
    // Without a receipt nothing proves Agent Bundle registered the marketplace, so --force removes the plugin only
    // and retains the marketplace, naming the verb to run by hand.
    expect(forced.registrations).toEqual([
      expect.objectContaining({ action: 'removed', kind: `${host}-plugin` }),
      expect.objectContaining({ action: 'retained', detail: expect.stringContaining('no Agent Bundle receipt records'), kind: `${host}-marketplace` }),
    ]);
    expect(calls.map((call) => call.args.join(' '))).toContain(uninstall);
    expect(calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
    expect(marketplaceRegistered).toBe(true);

    // The marketplace now pre-exists the next install, so that install's receipt does not claim it and its uninstall
    // retains it for the same reason; the operator removes it by hand.
    await installBundle(options);
    expect((await readInstallReceiptFile(receiptPath))?.registrations.map((registration) => registration.kind)).toEqual([`${host}-plugin`]);
    calls.length = 0;
    const unclaimed = await uninstallBundle(options);
    expect(unclaimed.registrations.find((registration) => registration.kind === `${host}-marketplace`)).toMatchObject({ action: 'retained' });
    expect(calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
    marketplaceRegistered = false;

    // Another plugin still installs from the marketplace: the marketplace registration is retained.
    await installBundle(options);
    expect((await readInstallReceiptFile(receiptPath))?.registrations.map((registration) => registration.kind))
      .toEqual([`${host}-marketplace`, `${host}-plugin`]);
    calls.length = 0;
    const shared = recordingRunner((call) => {
      const verb = call.args.join(' ');
      if (verb === 'plugin list --json') {
        return host === 'claude'
          ? claudeListing([
            { enabled: true, id: 'uninstall-fixture@uninstall-fixture-marketplace', installPath, scope: 'user', version: '1.2.3' },
            { enabled: true, id: 'other@uninstall-fixture-marketplace', installPath: join(hostRoot, 'other'), scope: 'user', version: '1.0.0' },
          ])
          : codexListing([
            { enabled: true, installed: true, pluginId: 'uninstall-fixture@uninstall-fixture-marketplace', version: '1.2.3' },
            { enabled: true, installed: true, pluginId: 'other@uninstall-fixture-marketplace', version: '1.0.0' },
          ]);
      }
      if (verb === 'plugin marketplace list --json') return marketplaces(true);
      return '';
    });
    const retained = await uninstallBundle({ ...options, commandRunner: shared.runner });
    expect(retained.registrations.find((registration) => registration.kind === `${host}-marketplace`)).toMatchObject({
      action: 'retained',
      detail: expect.stringContaining('other@uninstall-fixture-marketplace'),
    });
    // The consumed receipt was the only record that Agent Bundle registered the marketplace and the dependent is a
    // live row without a receipt to inherit the claim: the loss is stated, not hidden.
    expect(retained.registrations.find((registration) => registration.kind === `${host}-marketplace`)?.detail)
      .toContain('no dependent has a receipt to carry that claim');
    expect(shared.calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
    expect(shared.calls.map((call) => call.args.join(' '))).toContain(uninstall);
    installed = false;
    marketplaceRegistered = false;

    // The dependency re-read fails after the first inventory succeeded: a failed read is not proof that
    // nothing depends on the marketplace, so the marketplace is retained (fail-closed), never removed.
    await installBundle(options);
    let listCalls = 0;
    const flaky: { readonly calls: CommandCall[]; readonly runner: InstallCommandRunner } = { calls: [], runner: {
      run: async (command, args) => {
        const call = { args: [...args], command };
        flaky.calls.push(call);
        const verb = args.join(' ');
        if (verb === 'plugin list --json') {
          listCalls += 1;
          return listCalls === 1
            ? { code: 0, stderr: '', stdout: listing(true, installPath) }
            : { code: 1, stderr: 'transient failure', stdout: '' };
        }
        if (verb === 'plugin marketplace list --json') return { code: 0, stderr: '', stdout: marketplaces(true) };
        return { code: 0, stderr: '', stdout: '' };
      },
    } };
    const unproven = await uninstallBundle({ ...options, commandRunner: flaky.runner });
    expect(unproven).toMatchObject({
      registrations: [
        { action: 'removed', kind: `${host}-plugin` },
        { action: 'retained', detail: expect.stringContaining('could not be read to prove'), kind: `${host}-marketplace` },
      ],
      state: 'uninstalled',
    });
    expect(flaky.calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
    installed = false;
    marketplaceRegistered = false;

    if (host === 'claude') {
      // The same plugin installed at another Claude scope still depends on the marketplace, and
      // `plugin marketplace remove` applies to every scope: the marketplace is retained.
      await installBundle(options);
      const scoped = recordingRunner((call) => {
        const verb = call.args.join(' ');
        if (verb === 'plugin list --json') {
          return claudeListing([
            { enabled: true, id: 'uninstall-fixture@uninstall-fixture-marketplace', installPath, scope: 'user', version: '1.2.3' },
            { enabled: true, id: 'uninstall-fixture@uninstall-fixture-marketplace', installPath, scope: 'project', version: '1.2.3' },
          ]);
        }
        if (verb === 'plugin marketplace list --json') return marketplaces(true);
        return '';
      });
      // The cache copy and plugins/data/<id> are scope-less: while the project scope still uses them, purging
      // from the user scope is refused before any host verb runs.
      const dataDirectory = join(hostRoot, 'plugins', 'data', 'uninstall-fixture@uninstall-fixture-marketplace');
      await cp(fixture.bundleRoot, installPath, { recursive: true });
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(join(dataDirectory, 'notes.txt'), 'data\n');
      const sharedPurge = await failureOf(uninstallBundle({ ...options, commandRunner: scoped.runner, confirmPurge: true, purgeData: true }));
      expect(sharedPurge.diagnostics[0]).toMatchObject({ code: 'AB7008', target: 'claude' });
      expect(sharedPurge.diagnostics[0]?.message).toContain('(scope project)');
      expect(scoped.calls.map((call) => call.args.join(' '))).not.toContain(uninstall);
      expect(await readFile(join(dataDirectory, 'notes.txt'), 'utf8')).toBe('data\n');
      await removeTree(installPath);
      await removeTree(dataDirectory);
      scoped.calls.length = 0;
      const otherScope = await uninstallBundle({ ...options, commandRunner: scoped.runner });
      expect(otherScope.registrations.find((registration) => registration.kind === 'claude-marketplace')).toMatchObject({
        action: 'retained',
        detail: expect.stringContaining('uninstall-fixture@uninstall-fixture-marketplace (scope project)'),
      });
      expect(scoped.calls.map((call) => call.args.join(' '))).toContain(uninstall);
      expect(scoped.calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
      installed = false;
      marketplaceRegistered = false;

      // A project-scope install elsewhere is invisible to `plugin list --json` run here, but its receipt is
      // not: another store receipt recording the marketplace keeps it registered.
      await installBundle(options);
      const elsewhere = join(hostRoot, 'agent-bundle', 'receipts', 'uninstall-fixture.uninstall-fixture-marketplace.project.0123456789ab.json');
      await writeFile(elsewhere, JSON.stringify({
        contentHash: emptyContentHash,
        directories: [],
        files: [],
        format: installReceiptFormat,
        host: 'claude',
        hostDirectories: [],
        installedAt: '2026-09-03T00:00:00.000Z',
        mode: 'host-cli',
        plugin: 'uninstall-fixture',
        projectRoot: '/elsewhere/project',
        registrations: [
          { kind: 'claude-marketplace', name: 'uninstall-fixture-marketplace', scope: 'project' },
          { id: 'uninstall-fixture@uninstall-fixture-marketplace', kind: 'claude-plugin', scope: 'project' },
        ],
        scope: 'project',
        updatedAt: '2026-09-03T00:00:00.000Z',
        version: '1.2.3',
      }));
      calls.length = 0;
      const byReceipt = await uninstallBundle(options);
      expect(byReceipt.registrations.find((registration) => registration.kind === 'claude-marketplace')).toMatchObject({
        action: 'retained',
        detail: expect.stringContaining(`receipt ${elsewhere}`),
      });
      expect(calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
      // The other project's receipt already records the marketplace, so nothing moves: it is untouched, and the
      // store directory it lives in is not pruned.
      expect(byReceipt.registrations.find((registration) => registration.kind === 'claude-marketplace')?.detail).not.toContain('claim');
      expect(await readInstallReceiptFile(elsewhere)).toMatchObject({ projectRoot: '/elsewhere/project', scope: 'project', updatedAt: '2026-09-03T00:00:00.000Z' });
      installed = false;
      marketplaceRegistered = false;

      // A store receipt that cannot be parsed may be exactly the dependent (or the ownership heir) that keeps the
      // marketplace alive: an unreadable receipt makes the dependency set unknown, and unknown fails closed —
      // the marketplace is retained, never removed on the strength of a store that could not be read.
      await installBundle(options);
      await writeFile(elsewhere, '{ not a receipt');
      calls.length = 0;
      const unreadable = await uninstallBundle(options);
      expect(unreadable.registrations.find((registration) => registration.kind === 'claude-marketplace')).toMatchObject({
        action: 'retained',
        detail: expect.stringContaining('receipt in the Agent Bundle receipt store could not be read'),
      });
      expect(calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
      expect(calls.map((call) => call.args.join(' '))).toContain(uninstall);
      expect(await readFile(elsewhere, 'utf8')).toBe('{ not a receipt');
      installed = false;
      marketplaceRegistered = false;

      // An install made after the marketplace already existed records only its plugin registration, yet that
      // plugin still installs from the marketplace: a plugin-only receipt elsewhere counts as a dependent too,
      // both for the marketplace and — same plugin id — for the scope-less durable state a purge would remove.
      const pluginOnlyReceipt = (plugin: string, projectRoot: string) => JSON.stringify({
        contentHash: emptyContentHash,
        directories: [],
        files: [],
        format: installReceiptFormat,
        host: 'claude',
        hostDirectories: [],
        installedAt: '2026-09-03T00:00:00.000Z',
        mode: 'host-cli',
        plugin,
        projectRoot,
        registrations: [{ id: `${plugin}@uninstall-fixture-marketplace`, kind: 'claude-plugin', scope: 'project' }],
        scope: 'project',
        updatedAt: '2026-09-03T00:00:00.000Z',
        version: '1.2.3',
      });
      await writeFile(elsewhere, pluginOnlyReceipt('uninstall-fixture', '/elsewhere/project'));
      await installBundle(options);
      await cp(fixture.bundleRoot, installPath, { recursive: true });
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(join(dataDirectory, 'notes.txt'), 'data\n');
      calls.length = 0;
      const receiptSharedPurge = await failureOf(uninstallBundle({ ...options, confirmPurge: true, purgeData: true }));
      expect(receiptSharedPurge.diagnostics[0]).toMatchObject({ code: 'AB7008', target: 'claude' });
      expect(receiptSharedPurge.diagnostics[0]?.message).toContain(`receipt ${elsewhere} (scope project in /elsewhere/project)`);
      expect(calls.map((call) => call.args.join(' '))).not.toContain(uninstall);
      expect(await readFile(join(dataDirectory, 'notes.txt'), 'utf8')).toBe('data\n');
      await removeTree(installPath);
      await removeTree(dataDirectory);
      calls.length = 0;
      // --plan announces the move without writing it.
      const planMove = await uninstallBundle({ ...options, plan: true });
      expect(planMove.registrations.find((registration) => registration.kind === 'claude-marketplace')?.detail)
        .toContain(`claim would move to receipt ${elsewhere}`);
      expect((await readInstallReceiptFile(elsewhere))?.registrations.map((registration) => registration.kind)).toEqual(['claude-plugin']);
      calls.length = 0;
      const byPluginOnlyReceipt = await uninstallBundle(options);
      expect(byPluginOnlyReceipt.registrations.find((registration) => registration.kind === 'claude-marketplace')).toMatchObject({
        action: 'retained',
        detail: expect.stringContaining(`receipt ${elsewhere} (scope project in /elsewhere/project)`),
      });
      expect(calls.map((call) => call.args.join(' '))).toContain(uninstall);
      expect(calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
      // The consumed receipt held the only marketplace claim; it moves to the dependent's receipt (at that
      // receipt's scope) so the last uninstall can still remove the marketplace Agent Bundle created.
      expect(byPluginOnlyReceipt.registrations.find((registration) => registration.kind === 'claude-marketplace')?.detail)
        .toContain(`claim moves to receipt ${elsewhere}`);
      const heir = await readInstallReceiptFile(elsewhere);
      expect(heir?.registrations).toEqual([
        { id: 'uninstall-fixture@uninstall-fixture-marketplace', kind: 'claude-plugin', scope: 'project' },
        { kind: 'claude-marketplace', name: 'uninstall-fixture-marketplace', scope: 'project' },
      ]);
      expect(heir?.updatedAt).not.toBe('2026-09-03T00:00:00.000Z');
      expect(heir).toMatchObject({ installedAt: '2026-09-03T00:00:00.000Z', projectRoot: '/elsewhere/project' });
      installed = false;
      marketplaceRegistered = false;

      // Another plugin's plugin-only receipt from the same marketplace retains the marketplace as well, but is
      // not a same-plugin dependent: purging this plugin's own durable state is allowed.
      const otherPlugin = join(hostRoot, 'agent-bundle', 'receipts', 'other-fixture.uninstall-fixture-marketplace.project.0123456789ab.json');
      await rm(elsewhere);
      await writeFile(otherPlugin, pluginOnlyReceipt('other-fixture', '/elsewhere/other'));
      await installBundle(options);
      await cp(fixture.bundleRoot, installPath, { recursive: true });
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(join(dataDirectory, 'notes.txt'), 'data\n');
      calls.length = 0;
      const byOtherReceipt = await uninstallBundle({ ...options, confirmPurge: true, purgeData: true });
      expect(byOtherReceipt).toMatchObject({ data: { outcome: 'purged', paths: [dataDirectory] }, state: 'uninstalled' });
      await expect(readdir(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(byOtherReceipt.registrations.find((registration) => registration.kind === 'claude-marketplace')).toMatchObject({
        action: 'retained',
        detail: expect.stringContaining(`receipt ${otherPlugin}`),
      });
      expect(calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
      // The claim moves to the other plugin's receipt as well: any dependent receipt can carry it.
      expect(await readInstallReceiptFile(otherPlugin)).toMatchObject({
        plugin: 'other-fixture',
        registrations: [
          { id: 'other-fixture@uninstall-fixture-marketplace', kind: 'claude-plugin', scope: 'project' },
          { kind: 'claude-marketplace', name: 'uninstall-fixture-marketplace', scope: 'project' },
        ],
      });
      await removeTree(installPath);
      await rm(otherPlugin);
      await removeTree(join(hostRoot, 'agent-bundle'));
      installed = false;
      marketplaceRegistered = false;

      // A project- or local-scope install made by hand in another project has no receipt and is invisible to
      // `plugin list --json` run here, but Claude records every scope of every install in its own
      // plugins/installed_plugins.json: that registry is read too, so the marketplace (and, for the same plugin,
      // the scope-less durable state) is retained for consumers no receipt describes.
      const registryPath = join(hostRoot, 'plugins', 'installed_plugins.json');
      const registry = (plugins: Record<string, readonly { readonly projectPath?: string; readonly scope: string }[]>) =>
        JSON.stringify({ plugins: Object.fromEntries(Object.entries(plugins).map(([pluginId, installs]) => [pluginId, installs.map((install) => ({
          ...install, installPath, installedAt: '2026-09-03T00:00:00.000Z', lastUpdated: '2026-09-03T00:00:00.000Z', version: '1.2.3',
        }))])), version: 2 });
      await mkdir(join(hostRoot, 'plugins'), { recursive: true });
      await installBundle(options);
      await writeFile(registryPath, registry({ 'uninstall-fixture@uninstall-fixture-marketplace': [
        { scope: 'user' },
        { projectPath: '/elsewhere/by-hand', scope: 'project' },
      ] }));
      await cp(fixture.bundleRoot, installPath, { recursive: true });
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(join(dataDirectory, 'notes.txt'), 'data\n');
      calls.length = 0;
      const registrySharedPurge = await failureOf(uninstallBundle({ ...options, confirmPurge: true, purgeData: true }));
      expect(registrySharedPurge.diagnostics[0]).toMatchObject({ code: 'AB7008', target: 'claude' });
      expect(registrySharedPurge.diagnostics[0]?.message)
        .toContain('uninstall-fixture@uninstall-fixture-marketplace (scope project in /elsewhere/by-hand, per plugins/installed_plugins.json)');
      expect(calls.map((call) => call.args.join(' '))).not.toContain(uninstall);
      expect(await readFile(join(dataDirectory, 'notes.txt'), 'utf8')).toBe('data\n');
      await removeTree(installPath);
      await removeTree(dataDirectory);
      calls.length = 0;
      const byRegistry = await uninstallBundle(options);
      expect(byRegistry.registrations.find((registration) => registration.kind === 'claude-marketplace')).toMatchObject({
        action: 'retained',
        detail: expect.stringContaining('(scope project in /elsewhere/by-hand, per plugins/installed_plugins.json) still install from it'),
      });
      expect(calls.map((call) => call.args.join(' '))).toContain(uninstall);
      expect(calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
      installed = false;
      marketplaceRegistered = false;

      // Another plugin from the same marketplace, known only to the registry, retains the marketplace but is not a
      // same-plugin dependent: purging this plugin's own durable state is allowed.
      await installBundle(options);
      await writeFile(registryPath, registry({
        'other-fixture@uninstall-fixture-marketplace': [{ projectPath: '/elsewhere/other', scope: 'local' }],
        'uninstall-fixture@uninstall-fixture-marketplace': [{ scope: 'user' }],
      }));
      await cp(fixture.bundleRoot, installPath, { recursive: true });
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(join(dataDirectory, 'notes.txt'), 'data\n');
      calls.length = 0;
      const byOtherRegistered = await uninstallBundle({ ...options, confirmPurge: true, purgeData: true });
      expect(byOtherRegistered).toMatchObject({ data: { outcome: 'purged', paths: [dataDirectory] }, state: 'uninstalled' });
      expect(byOtherRegistered.registrations.find((registration) => registration.kind === 'claude-marketplace')).toMatchObject({
        action: 'retained',
        detail: expect.stringContaining('other-fixture@uninstall-fixture-marketplace (scope local in /elsewhere/other, per plugins/installed_plugins.json)'),
      });
      expect(calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
      await removeTree(installPath);
      installed = false;
      marketplaceRegistered = false;

      // The registry naming only the copy being removed is not a dependent: the marketplace goes.
      await installBundle(options);
      await writeFile(registryPath, registry({ 'uninstall-fixture@uninstall-fixture-marketplace': [{ scope: 'user' }] }));
      calls.length = 0;
      const selfOnly = await uninstallBundle(options);
      expect(selfOnly.registrations).toMatchObject([
        { action: 'removed', kind: 'claude-plugin' },
        { action: 'removed', kind: 'claude-marketplace' },
      ]);
      expect(calls.map((call) => call.args.join(' '))).toContain(removeMarketplace);
      installed = false;
      marketplaceRegistered = false;

      // A registry that cannot be parsed makes the dependency set unknown, and unknown fails closed.
      await installBundle(options);
      await writeFile(registryPath, '{ not a registry');
      calls.length = 0;
      const unreadableRegistry = await uninstallBundle(options);
      expect(unreadableRegistry.registrations.find((registration) => registration.kind === 'claude-marketplace')).toMatchObject({
        action: 'retained',
        detail: expect.stringContaining('the plugins/installed_plugins.json registry, or a receipt in the Agent Bundle receipt store could not be read'),
      });
      expect(calls.map((call) => call.args.join(' '))).toContain(uninstall);
      expect(calls.map((call) => call.args.join(' '))).not.toContain(removeMarketplace);
      await removeTree(join(hostRoot, 'plugins'));
      installed = false;
      marketplaceRegistered = false;
    }

    // An orphaned receipt (host already forgot the plugin) is consumed without any host verb.
    await installBundle(options);
    installed = false;
    marketplaceRegistered = false;
    calls.length = 0;
    const orphan = await uninstallBundle(options);
    expect(orphan).toMatchObject({
      registrations: [
        { action: 'already-absent', kind: `${host}-plugin` },
        { action: 'already-absent', kind: `${host}-marketplace` },
      ],
      state: 'uninstalled',
    });
    expect(calls.map((call) => call.args.join(' '))).toEqual(['plugin list --json', 'plugin marketplace list --json']);
    expect(await readInstallReceiptFile(receiptPath)).toBeUndefined();

    // An unusable inventory fails closed before any mutation.
    const unusable = recordingRunner(() => 'not json');
    const error = await failureOf(uninstallBundle({ ...options, commandRunner: unusable.runner }));
    expect(error.diagnostics[0]).toMatchObject({ code: 'AB7004', target: host });
    expect(unusable.calls).toHaveLength(1);
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('purges Claude durable state only when confirmed and reports the host-retained default honestly', async () => {
  const fixture = await createFixture('claude');
  const hostRoot = join(fixture.cleanupRoot, 'claude-root');
  const installPath = join(hostRoot, 'plugins', 'cache', 'uninstall-fixture-marketplace', 'uninstall-fixture', '1.2.3');
  const dataDirectory = join(hostRoot, 'plugins', 'data', 'uninstall-fixture@uninstall-fixture-marketplace');
  let installed = false;
  const { runner } = recordingRunner((call) => {
    const verb = call.args.join(' ');
    if (verb === 'plugin list --json') {
      return claudeListing(installed
        ? [{ enabled: true, id: 'uninstall-fixture@uninstall-fixture-marketplace', installPath, scope: 'user', version: '1.2.3' }]
        : []);
    }
    if (verb === 'plugin marketplace list --json') return JSON.stringify([{ name: 'uninstall-fixture-marketplace' }]);
    if (verb.startsWith('plugin install ')) installed = true;
    if (verb.startsWith('plugin uninstall ')) installed = false;
    return '';
  });
  const options = {
    commandRunner: runner,
    environment: { CLAUDE_CONFIG_DIR: hostRoot },
    from: fixture.bundleRoot,
    home: fixture.home,
    host: 'claude' as const,
  };
  try {
    await installBundle(options);
    await cp(fixture.bundleRoot, installPath, { recursive: true });
    await mkdir(join(installPath, 'state'));
    await writeFile(join(installPath, 'state', 'plugin.sqlite'), 'durable\n');
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(join(dataDirectory, 'notes.txt'), 'data\n');

    // The host-cached tree, an in-tree state/ included, belongs to Claude; only plugins/data/<id>/ is a data path.
    const kept = await uninstallBundle({ ...options, plan: true });
    expect(kept.data).toMatchObject({ outcome: 'retained-by-host', paths: [dataDirectory], policy: 'keep' });
    expect(kept.data.detail).toContain('--keep-data');

    // The plan and the run report the purged data directory as the directory it is, never as a file.
    const purgePlan = await uninstallBundle({ ...options, confirmPurge: true, plan: true, purgeData: true });
    expect(purgePlan.removed.directories[0]).toBe(dataDirectory);
    expect(purgePlan.removed.files).toEqual([expect.stringContaining('uninstall-fixture.uninstall-fixture-marketplace.user.json')]);
    const purged = await uninstallBundle({ ...options, confirmPurge: true, purgeData: true });
    expect(purged.data).toMatchObject({ outcome: 'purged', paths: [dataDirectory], policy: 'purge' });
    expect(purged.removed.directories[0]).toBe(dataDirectory);
    expect(purged.removed.files).toEqual([expect.stringContaining('uninstall-fixture.uninstall-fixture-marketplace.user.json')]);
    expect(await readFile(join(installPath, 'state', 'plugin.sqlite'), 'utf8')).toBe('durable\n');
    await expect(readdir(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('never derives host-receipt purge ownership from the current environment without a state block', async () => {
  const fixture = await createFixture('claude');
  const hostRoot = join(fixture.cleanupRoot, 'claude-root');
  const installPath = join(hostRoot, 'plugins', 'cache', 'uninstall-fixture-marketplace', 'uninstall-fixture', '1.2.3');
  const receiptPath = join(hostRoot, 'agent-bundle', 'receipts', 'uninstall-fixture.uninstall-fixture-marketplace.user.json');
  const originalEnvironment = {
    CLAUDE_CONFIG_DIR: hostRoot,
    XDG_STATE_HOME: join(fixture.cleanupRoot, 'original-state-home'),
  };
  const currentEnvironment = {
    CLAUDE_CONFIG_DIR: hostRoot,
    XDG_STATE_HOME: join(fixture.cleanupRoot, 'current-state-home'),
  };
  const originalStateRoot = userDataStateRoot(installPath, originalEnvironment, fixture.home);
  const currentStateRoot = userDataStateRoot(installPath, currentEnvironment, fixture.home);
  const currentSentinel = join(currentStateRoot, 'unrelated.txt');
  let installed = false;
  const { runner } = recordingRunner((call) => {
    const verb = call.args.join(' ');
    if (verb === 'plugin list --json') {
      return claudeListing(installed
        ? [{ enabled: true, id: 'uninstall-fixture@uninstall-fixture-marketplace', installPath, scope: 'user', version: '1.2.3' }]
        : []);
    }
    if (verb === 'plugin marketplace list --json') return JSON.stringify([{ name: 'uninstall-fixture-marketplace' }]);
    if (verb.startsWith('plugin install ')) installed = true;
    if (verb.startsWith('plugin uninstall ')) installed = false;
    return '';
  });
  const options = {
    commandRunner: runner,
    from: fixture.bundleRoot,
    home: fixture.home,
    host: 'claude' as const,
  };
  try {
    await installBundle({ ...options, environment: originalEnvironment });
    await cp(fixture.bundleRoot, installPath, { recursive: true });
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    const { state: _state, ...withoutState } = receipt;
    await writeFile(receiptPath, JSON.stringify(withoutState));
    await mkdir(originalStateRoot, { recursive: true });
    await writeFile(join(originalStateRoot, 'state.sqlite'), 'original\n');
    await mkdir(currentStateRoot, { recursive: true });
    await writeFile(currentSentinel, 'unrelated\n');

    const plan = await uninstallBundle({
      ...options,
      confirmPurge: true,
      environment: currentEnvironment,
      plan: true,
      purgeData: true,
    });
    expect(plan.data).toMatchObject({
      outcome: 'kept',
      paths: [],
      retained: [{ path: currentStateRoot, reason: 'unproven' }],
    });
    expect(plan.removed.directories).not.toContain(currentStateRoot);

    const purged = await uninstallBundle({
      ...options,
      confirmPurge: true,
      environment: currentEnvironment,
      purgeData: true,
    });
    expect(purged.data).toMatchObject({
      outcome: 'kept',
      paths: [],
      retained: [{ path: currentStateRoot, reason: 'unproven' }],
    });
    expect(await readFile(currentSentinel, 'utf8')).toBe('unrelated\n');
    expect(await readFile(join(originalStateRoot, 'state.sqlite'), 'utf8')).toBe('original\n');
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('reacquires Claude marketplace ownership after a keep-data remnant reinstall', async () => {
  const fixture = await createFixture('claude');
  const hostRoot = join(fixture.cleanupRoot, 'claude-root');
  const installPath = join(hostRoot, 'plugins', 'cache', 'uninstall-fixture-marketplace', 'uninstall-fixture', '1.2.3');
  let installed = false;
  let marketplaceRegistered = false;
  const { runner } = recordingRunner((call) => {
    const verb = call.args.join(' ');
    if (verb === 'plugin list --json') {
      return claudeListing(installed
        ? [{ enabled: true, id: 'uninstall-fixture@uninstall-fixture-marketplace', installPath, scope: 'user', version: '1.2.3' }]
        : []);
    }
    if (verb === 'plugin marketplace list --json') {
      return JSON.stringify(marketplaceRegistered ? [{ name: 'uninstall-fixture-marketplace' }] : []);
    }
    if (verb === `plugin marketplace add ${fixture.bundleRoot}`) marketplaceRegistered = true;
    if (verb.startsWith('plugin marketplace remove ')) marketplaceRegistered = false;
    if (verb.startsWith('plugin install ')) installed = true;
    if (verb.startsWith('plugin uninstall ')) installed = false;
    return '';
  });
  const options = {
    commandRunner: runner,
    environment: { CLAUDE_CONFIG_DIR: hostRoot },
    from: fixture.bundleRoot,
    home: fixture.home,
    host: 'claude' as const,
  };
  try {
    await installBundle(options);
    await cp(fixture.bundleRoot, installPath, { recursive: true });
    const stateRoot = userDataStateRoot(installPath, options.environment, fixture.home);
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, 'state.sqlite'), 'state\n');
    const plan = await uninstallBundle({ ...options, plan: true });
    const kept = await uninstallBundle(options);
    expect(kept.receipt.status).toBe('remnant');
    expect(plan.removed).toEqual(kept.removed);
    expect(marketplaceRegistered).toBe(false);

    await installBundle(options);
    expect(marketplaceRegistered).toBe(true);
    const removed = await uninstallBundle(options);
    expect(removed.registrations.find((registration) => registration.kind === 'claude-marketplace'))
      .toMatchObject({ action: 'removed' });
    expect(marketplaceRegistered).toBe(false);
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('reports only external Codex state; an in-tree state/ belongs to the host cache and is never a purge path', async () => {
  const fixture = await createFixture('codex');
  const hostRoot = join(fixture.cleanupRoot, 'codex-root');
  let installed = false;
  const { runner } = recordingRunner((call) => {
    const verb = call.args.join(' ');
    if (verb === 'plugin list --json') {
      return codexListing(installed
        ? [{ enabled: true, installed: true, pluginId: 'uninstall-fixture@uninstall-fixture-marketplace', version: '1.2.3' }]
        : []);
    }
    if (verb === 'plugin marketplace list --json') return JSON.stringify({ marketplaces: [] });
    if (verb.startsWith('plugin add ')) installed = true;
    if (verb.startsWith('plugin remove ')) installed = false;
    return '';
  });
  const options = {
    commandRunner: runner,
    environment: { CODEX_HOME: hostRoot },
    from: fixture.bundleRoot,
    home: fixture.home,
    host: 'codex' as const,
  };
  try {
    await installBundle(options);
    const installPath = join(hostRoot, 'plugins', 'cache', 'uninstall-fixture-marketplace', 'uninstall-fixture', '1.2.3');
    await cp(fixture.bundleRoot, installPath, { recursive: true });
    const stateRoot = userDataStateRoot(installPath, options.environment, fixture.home);
    await Promise.all([
      mkdir(join(installPath, 'state'), { recursive: true }),
      mkdir(stateRoot, { recursive: true }),
    ]);
    await writeFile(join(stateRoot, 'state.sqlite'), 'state\n');
    expect((await uninstallBundle({ ...options, plan: true })).data).toMatchObject({
      outcome: 'kept',
      paths: [stateRoot],
      policy: 'keep',
    });
    expect((await uninstallBundle({ ...options, confirmPurge: true, plan: true, purgeData: true })).data).toMatchObject({
      outcome: 'purged',
      paths: [stateRoot],
      policy: 'purge',
    });
    const scoped = await failureOf(uninstallBundle({ ...options, scope: 'project' }));
    expect(scoped.diagnostics[0]).toMatchObject({ code: 'AB7003', target: 'codex' });
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('rejects an uninstall mode for hosts other than Cursor before touching anything', async () => {
  const fixture = await createFixture('claude');
  const { calls, runner } = recordingRunner(() => '');
  try {
    const error = await failureOf(uninstallBundle({
      commandRunner: runner,
      environment: { CLAUDE_CONFIG_DIR: join(fixture.cleanupRoot, 'claude-root') },
      from: fixture.bundleRoot,
      home: fixture.home,
      host: 'claude',
      mode: 'marketplace',
    }));
    expect(error.diagnostics).toMatchObject([{ code: 'AB7003', target: 'claude' }]);
    expect(calls).toEqual([]);
  } finally {
    await removeTree(fixture.cleanupRoot);
  }
});

it('exposes uninstall through the public CLI with every lifecycle flag', async () => {
  const terminal = captureCliTerminal();
  const calls: unknown[] = [];
  const result: UninstallResult = {
    bundleRoot: '/tmp/example bundle',
    data: { detail: 'kept', outcome: 'kept', paths: ['/tmp/example bundle/state'], policy: 'keep' },
    destination: '/home/example/.cursor/plugins/local/fixture',
    forced: false,
    host: 'cursor',
    mode: 'local',
    plugin: 'fixture',
    receipt: { path: '/home/example/.cursor/plugins/local/fixture/.agent-bundle-install.json', status: 'consumed' },
    registrations: [{ action: 'planned', kind: 'cursor-local-plugin' }],
    removed: { directories: ['/home/example/.cursor/plugins/local/fixture'], files: ['/home/example/.cursor/plugins/local/fixture/payload.txt'] },
    retained: [],
    scope: 'user',
    state: 'planned',
    version: '1.0.0',
  };
  const code = await runCli(
    ['uninstall', 'cursor', '--from', '/tmp/example bundle', '--mode', 'local', '--plan', '--force', '--purge-data', '--confirm-purge', '--json'],
    terminal.output,
    {
      uninstallBundle: async (options: unknown) => {
        calls.push(options);
        return result;
      },
    } as unknown as Parameters<typeof runCli>[2],
  );
  expect(code).toBe(0);
  expect(terminal.stderr()).toBe('');
  expect(calls).toEqual([{
    confirmPurge: true,
    force: true,
    from: '/tmp/example bundle',
    host: 'cursor',
    mode: 'local',
    plan: true,
    purgeData: true,
    scope: 'user',
  }]);
  expect(JSON.parse(terminal.stdout())).toMatchObject({ plugin: 'fixture', state: 'planned' });

  const human = captureCliTerminal();
  await runCli(
    ['uninstall', 'cursor', '--keep-data'],
    human.output,
    { uninstallBundle: async () => result } as unknown as Parameters<typeof runCli>[2],
  );
  expect(human.stdout()).toContain('Would uninstall fixture@1.0.0 for cursor (local mode)');
  expect(human.stdout()).toContain('/home/example/.cursor/plugins/local/fixture/payload.txt');
  expect(human.stdout()).toContain('Data (keep): kept');
});
