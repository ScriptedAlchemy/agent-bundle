import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, expect, it } from '@rstest/core';

import { devProxyServerCommand } from '../src/dev/dev-proxy-command.ts';
import {
  DEV_INSTALL_MARKER,
  DevHostInstallManager,
} from '../src/dev/host-install-manager.ts';
import { ProjectEventHub } from '../src/dev/events.ts';
import { DevCoordinator } from '../src/dev/coordinator.ts';
import { EpochStore } from '../src/dev/epoch-store.ts';
import { ProjectService } from '../src/dev/project-service.ts';
import type { ArtifactEpoch, FailedBuildAttempt } from '../src/dev/types.ts';
import type { InstallBundleOptions, InstallResult } from '../src/install/install.ts';
import {
  buildHostInstallFixture,
  disposeHostInstallFixture,
  runDevHostInstallProof,
  type BuiltHostInstallFixture,
} from './support/host-install.ts';

const roots: string[] = [];
let fixture: BuiltHostInstallFixture | undefined;
const claudeAvailable = spawnSync('claude', ['--version'], { stdio: 'ignore', timeout: 5_000 }).status === 0;
const codexAvailable = spawnSync('codex', ['--version'], { stdio: 'ignore', timeout: 5_000 }).status === 0;
const claudeIt = claudeAvailable ? it : it.skip;
const codexIt = codexAvailable ? it : it.skip;

beforeAll(async () => {
  fixture = await buildHostInstallFixture({ environment: process.env });
}, 180_000);

afterAll(async () => {
  if (fixture !== undefined) await disposeHostInstallFixture(fixture);
});

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dev-host-install-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const builtFixture = (): BuiltHostInstallFixture => {
  if (fixture === undefined) throw new Error('The shared host-install fixture was not built.');
  return fixture;
};

const epoch = (projectRoot: string, id: string): ArtifactEpoch => Object.freeze({
  configDigest: `${id}-config`,
  createdAt: '2026-09-02T12:00:00.000Z',
  diagnostics: { errors: 0, infos: 0, warnings: 0 },
  id,
  manifestPath: join(projectRoot, '.agent-bundle', 'epochs', id, 'manifest.json'),
  modelDigest: `${id}-model`,
  projectRevision: `${id}-source`,
  targetDigests: { cursor: `${id}-target` },
});

const writeEpoch = async (
  projectRoot: string,
  id: string,
  values: { readonly hook: string; readonly skill: string },
): Promise<string> => {
  // The epoch root is the composite plugin root: Cursor's documents live in
  // `.cursor-plugin/`, the shared component folders at the top level.
  const root = join(projectRoot, '.agent-bundle', 'epochs', id);
  await Promise.all([
    mkdir(join(root, '.cursor-plugin'), { recursive: true }),
    mkdir(join(root, 'hooks'), { recursive: true }),
    mkdir(join(root, 'mcp'), { recursive: true }),
    mkdir(join(root, 'skills', 'probe'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'manifest.json'), '{}\n'),
    writeFile(join(root, '.cursor-plugin', 'plugin.json'), '{"name":"dev-proof","version":"1.0.0"}\n'),
    writeFile(join(root, '.cursor-plugin', 'hooks.json'), values.hook),
    writeFile(join(root, 'hooks', 'session-start.cursor.mjs'), values.hook),
    writeFile(join(root, 'mcp', 'probe-old.mjs'), 'export const old = true;\n'),
    writeFile(
      join(root, '.cursor-plugin', 'mcp.json'),
      '{"mcpServers":{"probe":{"args":["${CURSOR_PLUGIN_ROOT}/mcp/probe-old.mjs"],"command":"node","type":"stdio"}}}\n',
    ),
    writeFile(join(root, 'skills', 'probe', 'SKILL.md'), values.skill),
  ]);
  return root;
};

const activePayload = (value: ArtifactEpoch) => Object.freeze({
  activeEpoch: value,
  currentSourceRevision: value.projectRevision,
  state: 'active' as const,
});

it('defines the stage-1 proxy command shape with an absolute framework CLI entry', async () => {
  expect(await devProxyServerCommand('/workspace/project', 'probe', 'claude')).toEqual({
    args: [
      join(process.cwd(), 'packages', 'agent-bundle', 'bin', 'agent-bundle.js'),
      'dev',
      'proxy',
      '--root',
      '/workspace/project',
      '--server',
      'probe',
      '--target',
      'claude',
    ],
    command: process.execPath,
  });
});

it('installs a marked Cursor dev variant and atomically re-points top-level directories on epoch swap', async () => {
  const root = await createRoot();
  const home = join(root, 'home');
  const projectRoot = join(root, 'project');
  const destination = join(home, '.cursor', 'plugins', 'local', 'dev-proof');
  await mkdir(join(home, '.cursor'), { recursive: true });
  const firstEpochRoot = await writeEpoch(projectRoot, 'epoch-1', {
    hook: 'first hook\n',
    skill: 'first skill\n',
  });
  const secondEpochRoot = await writeEpoch(projectRoot, 'epoch-2', {
    hook: 'second hook\n',
    skill: 'second skill\n',
  });
  const thirdEpochRoot = await writeEpoch(projectRoot, 'epoch-3', {
    hook: 'third hook\n',
    skill: 'third skill\n',
  });
  const rootsByEpoch = new Map([
    ['epoch-1', firstEpochRoot],
    ['epoch-2', secondEpochRoot],
    ['epoch-3', thirdEpochRoot],
  ]);
  const installs: InstallBundleOptions[] = [];
  const syncEvents: unknown[] = [];
  const installBundle = async (options: InstallBundleOptions): Promise<InstallResult> => {
    installs.push(options);
    await mkdir(join(destination, '..'), { recursive: true });
    await cp(options.from, destination, { recursive: true });
    return {
      bundleRoot: options.from,
      destination,
      host: 'cursor',
      plugin: 'dev-proof',
      state: 'installed',
      version: '1.0.0',
    };
  };
  const eventHub = new ProjectEventHub();
  eventHub.subscribe((event) => {
    if (event.type === 'dev.host.sync') syncEvents.push(event.payload);
  });
  const manager = new DevHostInstallManager({
    epochStore: {
      acquireEpochReference: async (epochId) => ({
        close: async () => undefined,
        epoch: epoch(projectRoot, epochId),
        root: rootsByEpoch.get(epochId)!,
      }),
    },
    eventHub,
    home,
    hosts: ['cursor'],
    installBundle,
    projectRoot,
  });
  manager.start();

  eventHub.publish({
    epochId: 'epoch-1',
    payload: activePayload(epoch(projectRoot, 'epoch-1')),
    type: 'artifact.available',
  });
  await manager.settled();
  expect(syncEvents.at(-1)).toMatchObject({ epochId: 'epoch-1', state: 'succeeded' });

  expect(installs).toHaveLength(1);
  expect(JSON.parse(await readFile(join(destination, DEV_INSTALL_MARKER), 'utf8'))).toMatchObject({
    epochId: 'epoch-1',
    host: 'cursor',
    projectRoot,
    schemaVersion: 1,
  });
  const mcpBefore = await readFile(join(destination, '.cursor-plugin', 'mcp.json'), 'utf8');
  expect(JSON.parse(mcpBefore)).toEqual({
    mcpServers: {
      probe: await devProxyServerCommand(projectRoot, 'probe', 'cursor'),
    },
  });
  expect((await lstat(join(destination, 'skills'))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(destination, 'hooks'))).isSymbolicLink()).toBe(true);

  eventHub.publish({
    epochId: 'epoch-2',
    payload: activePayload(epoch(projectRoot, 'epoch-2')),
    type: 'artifact.available',
  });
  await manager.settled();
  expect(syncEvents.at(-1)).toMatchObject({ epochId: 'epoch-2', state: 'succeeded' });

  expect(await readFile(join(destination, 'skills', 'probe', 'SKILL.md'), 'utf8')).toBe('second skill\n');
  expect(await readFile(join(destination, 'hooks', 'session-start.cursor.mjs'), 'utf8')).toBe('second hook\n');
  expect(await readFile(join(destination, '.cursor-plugin', 'mcp.json'), 'utf8')).toBe(mcpBefore);
  expect((await lstat(join(destination, 'skills'))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(destination, 'hooks'))).isSymbolicLink()).toBe(true);

  eventHub.publish({
    epochId: 'epoch-3',
    payload: activePayload(epoch(projectRoot, 'epoch-3')),
    type: 'artifact.available',
  });
  await manager.settled();
  expect((await readdir(join(destination, '.agent-bundle-dev', 'generations'))).sort()).toEqual([
    'epoch-2',
    'epoch-3',
  ]);

  const failed: FailedBuildAttempt = Object.freeze({
    completedAt: '2026-09-02T12:00:01.000Z',
    diagnostics: [{ code: 'TEST_BUILD_FAILED', message: 'broken source', severity: 'error' }] as const,
    id: 'failed-build',
    outcome: 'failed',
    sourceRevision: 'broken-source',
    startedAt: '2026-09-02T12:00:00.000Z',
  });
  eventHub.publish({ payload: failed, type: 'build.failed' });
  await manager.settled();
  expect(await readFile(join(destination, 'skills', 'probe', 'SKILL.md'), 'utf8')).toBe('third skill\n');

  await manager.close();
  await expect(readFile(join(destination, DEV_INSTALL_MARKER), 'utf8')).resolves.toContain('"epochId":"epoch-3"');
});

it('publishes a diagnostic event and preserves the installed generation when re-sync fails', async () => {
  const root = await createRoot();
  const home = join(root, 'home');
  const projectRoot = join(root, 'project');
  const destination = join(home, '.cursor', 'plugins', 'local', 'dev-proof');
  await mkdir(join(home, '.cursor'), { recursive: true });
  const firstEpochRoot = await writeEpoch(projectRoot, 'epoch-1', { hook: 'first hook\n', skill: 'first skill\n' });
  const eventHub = new ProjectEventHub();
  const events: unknown[] = [];
  eventHub.subscribe((event) => {
    if (event.type === 'dev.host.sync') events.push(event.payload);
  });
  const manager = new DevHostInstallManager({
    epochStore: {
      acquireEpochReference: async (epochId) => ({
        close: async () => undefined,
        epoch: epoch(projectRoot, epochId),
        root: epochId === 'epoch-1' ? firstEpochRoot : join(root, 'missing-epoch'),
      }),
    },
    eventHub,
    home,
    hosts: ['cursor'],
    installBundle: async (options) => {
      await mkdir(join(destination, '..'), { recursive: true });
      await cp(options.from, destination, { recursive: true });
      return {
        bundleRoot: options.from,
        destination,
        host: 'cursor',
        plugin: 'dev-proof',
        state: 'installed',
        version: '1.0.0',
      };
    },
    projectRoot,
  });
  manager.start();
  eventHub.publish({
    epochId: 'epoch-1',
    payload: activePayload(epoch(projectRoot, 'epoch-1')),
    type: 'artifact.available',
  });
  await manager.settled();
  eventHub.publish({
    epochId: 'epoch-2',
    payload: activePayload(epoch(projectRoot, 'epoch-2')),
    type: 'artifact.available',
  });
  await manager.settled();

  expect(await readFile(join(destination, 'skills', 'probe', 'SKILL.md'), 'utf8')).toBe('first skill\n');
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({
      diagnostics: [expect.objectContaining({ code: 'AB7202', severity: 'error' })],
      epochId: 'epoch-2',
      host: 'cursor',
      state: 'failed',
    }),
  ]));
  await manager.close();
});

it('re-syncs the isolated Cursor install from coordinator epochs and ignores a failed rebuild', async () => {
  const built = builtFixture();
  const projectRoot = join(built.artifactRoot, '..');
  const home = await createRoot();
  await mkdir(join(home, '.cursor'), { recursive: true });
  const eventHub = new ProjectEventHub();
  const epochStore = new EpochStore({ projectRoot });
  const manager = new DevHostInstallManager({
    epochStore,
    eventHub,
    home,
    hosts: ['cursor'],
    projectRoot,
  });
  const coordinator = new DevCoordinator({
    acquireLock: async () => ({ close: async () => undefined }),
    epochStore,
    eventHub,
    prepareCommand: 'dev',
    projectService: new ProjectService({ root: projectRoot }),
    root: projectRoot,
  });
  const destination = join(home, '.cursor', 'plugins', 'local', 'host-install-proof');
  manager.start();
  try {
    await coordinator.start();
    await manager.settled();
    const mcpBefore = await readFile(join(destination, '.cursor-plugin', 'mcp.json'), 'utf8');
    expect(mcpBefore).toContain(`"command":${JSON.stringify(process.execPath)}`);
    expect(await readFile(join(destination, 'skills', 'probe', 'SKILL.md'), 'utf8')).toContain(
      'host-install proof fixture',
    );

    await Promise.all([
      writeFile(
        join(projectRoot, 'src', 'skills', 'probe', 'SKILL.md'),
        '---\nname: probe\ndescription: Updated dev proof.\n---\n\n# Updated skill\n',
      ),
      writeFile(
        join(projectRoot, 'src', 'hooks', 'session-start.ts'),
        "export default () => ({ additionalContext: 'updated hook', outcome: 'continue' as const });\n",
      ),
    ]);
    const rebuilt = await coordinator.rebuild({
      occurredAt: '2026-09-02T12:00:00.000Z',
      paths: ['skills/probe/SKILL.md', 'src/hooks/session-start.ts'],
      reason: 'source-change',
    });
    expect(rebuilt.outcome).toBe('succeeded');
    await manager.settled();
    expect(await readFile(join(destination, 'skills', 'probe', 'SKILL.md'), 'utf8')).toContain('# Updated skill');
    const hookFiles = await readdir(join(destination, 'hooks'));
    const hookModule = hookFiles.find((name) => name.endsWith('.mjs'));
    if (hookModule === undefined) throw new Error('Updated installed hooks contained no executable module.');
    expect(await readFile(join(destination, 'hooks', hookModule), 'utf8')).toContain('updated hook');
    expect(await readFile(join(destination, '.cursor-plugin', 'mcp.json'), 'utf8')).toBe(mcpBefore);
    const markerBeforeFailure = await readFile(join(destination, DEV_INSTALL_MARKER), 'utf8');

    await writeFile(join(projectRoot, 'src', 'hooks', 'session-start.ts'), 'export default () => ({;\n');
    const failed = await coordinator.rebuild({
      occurredAt: '2026-09-02T12:00:01.000Z',
      paths: ['src/hooks/session-start.ts'],
      reason: 'source-change',
    });
    expect(failed.outcome).toBe('failed');
    await manager.settled();
    expect(await readFile(join(destination, 'skills', 'probe', 'SKILL.md'), 'utf8')).toContain('# Updated skill');
    expect(await readFile(join(destination, DEV_INSTALL_MARKER), 'utf8')).toBe(markerBeforeFailure);
  } finally {
    await manager.close();
    await coordinator.close();
  }
}, 180_000);

it('spawns the exact Cursor development proxy command without relying on PATH', async () => {
  await expect(runDevHostInstallProof(builtFixture(), 'cursor', { environment: process.env })).resolves.toEqual({
    hookChanged: true,
    host: 'cursor',
    marker: expect.objectContaining({ epochId: 'epoch-2', host: 'cursor', schemaVersion: 1 }),
    mcpUnchanged: true,
    skillChanged: true,
    spawn: {
      exitCode: 1,
      unavailableDiagnostic: '[AB8025] Development MCP server is unavailable.',
    },
    status: 'passed',
  });
}, 180_000);

claudeIt(
  claudeAvailable
    ? 'installs a Claude dev variant and re-syncs its host-owned cache without another CLI call'
    : 'installs a Claude dev variant and re-syncs its host-owned cache [missing evidence: claude binary unavailable on PATH]',
  async () => {
    await expect(runDevHostInstallProof(builtFixture(), 'claude', { environment: process.env })).resolves.toEqual({
      hookChanged: true,
      host: 'claude',
      marker: expect.objectContaining({ epochId: 'epoch-2', host: 'claude', schemaVersion: 1 }),
      mcpUnchanged: true,
      skillChanged: true,
      spawn: {
        exitCode: 1,
        unavailableDiagnostic: '[AB8025] Development MCP server is unavailable.',
      },
      status: 'passed',
    });
  },
  180_000,
);

codexIt(
  codexAvailable
    ? 'installs a Codex dev variant and re-syncs its host-owned cache without another CLI call'
    : 'installs a Codex dev variant and re-syncs its host-owned cache [missing evidence: codex binary unavailable on PATH]',
  async () => {
    await expect(runDevHostInstallProof(builtFixture(), 'codex', { environment: process.env })).resolves.toEqual({
      hookChanged: true,
      host: 'codex',
      marker: expect.objectContaining({ epochId: 'epoch-2', host: 'codex', schemaVersion: 1 }),
      mcpUnchanged: true,
      skillChanged: true,
      spawn: {
        exitCode: 1,
        unavailableDiagnostic: '[AB8025] Development MCP server is unavailable.',
      },
      status: 'passed',
    });
  },
  180_000,
);
