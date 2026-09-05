import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';
import { userDataStateRoot } from '@agent-bundle/runtime';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import type { TargetArtifactWrite } from '../src/adapters/types.ts';
import { composeProjections } from '../src/build/compose.ts';
import { runCli } from '../src/cli.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';
import { eventRuntimeEndpoint } from '../src/events/ipc.ts';
import { installBundle } from '../src/install/install.ts';
import { emptyContentHash, installReceiptFile, installReceiptFormat, installReceiptScopeKey, treeInventory } from '../src/install/receipt.ts';
import { uninstallBundle } from '../src/install/uninstall.ts';
import {
  doctorEndpointDirectory,
  doctorEndpointProbeConcurrency,
  runDoctor,
  type DoctorCommandRunner,
  type DoctorHost,
  type DoctorReport,
} from '../src/install/doctor.ts';

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
};

const errno = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

const commandResult = (
  overrides: Partial<Awaited<ReturnType<DoctorCommandRunner>>> = {},
): Awaited<ReturnType<DoctorCommandRunner>> => Object.freeze({
  exitCode: 0,
  signal: null,
  stderr: '',
  stdout: '',
  ...overrides,
});

const versionRunner: DoctorCommandRunner = async (request) =>
  commandResult({ stdout: `${request.executable} 1.2.3\n` });

const temporaryDoctor = async (): Promise<{
  readonly cleanup: () => Promise<void>;
  readonly endpointDirectory: string;
  readonly home: string;
  readonly root: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-doctor-'));
  const home = join(root, 'home');
  const endpointDirectory = join(root, 'endpoints');
  await mkdir(home, { recursive: true });
  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    endpointDirectory,
    home,
    root,
  };
};

const createBundle = async (
  root: string,
  host: DoctorHost,
  version = '1.2.3',
): Promise<string> => {
  const bundle = join(root, `bundle-${host}-${version}`);
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, 'payload.txt'), 'payload\n');
  if (host === 'claude') {
    await Promise.all([
      writeJson(join(bundle, '.claude-plugin/plugin.json'), {
        author: { name: 'Doctor Fixture' },
        description: 'Doctor fixture plugin.',
        name: 'doctor-fixture',
        version,
      }),
      writeJson(join(bundle, '.claude-plugin/marketplace.json'), {
        name: 'doctor-fixture-marketplace',
        owner: { name: 'Doctor Fixture' },
        plugins: [{ name: 'doctor-fixture', source: './' }],
      }),
    ]);
  } else if (host === 'codex') {
    await Promise.all([
      writeJson(join(bundle, '.codex-plugin/plugin.json'), {
        author: { name: 'Doctor Fixture' },
        description: 'Doctor fixture plugin.',
        interface: {
          capabilities: ['skills'],
          category: 'Productivity',
          defaultPrompt: ['Use the doctor fixture.'],
          developerName: 'Doctor Fixture',
          displayName: 'Doctor Fixture',
          longDescription: 'Doctor fixture plugin.',
          shortDescription: 'Doctor fixture plugin.',
        },
        name: 'doctor-fixture',
        skills: './skills/',
        version,
      }),
      writeJson(join(bundle, '.agents/plugins/marketplace.json'), {
        interface: { displayName: 'Doctor Fixture' },
        name: 'doctor-fixture-marketplace',
        plugins: [{
          category: 'Productivity',
          name: 'doctor-fixture',
          policy: { authentication: 'ON_INSTALL', installation: 'AVAILABLE' },
          source: { path: './', source: 'local' },
        }],
      }),
    ]);
  } else {
    // Every emitted Cursor-compatible bundle carries the install surface; a receipt-less copy of it
    // is a legacy agent-bundle install rather than a foreign directory.
    await Promise.all([
      writeJson(join(bundle, '.cursor-plugin/plugin.json'), { name: 'doctor-fixture', version }),
      writeFile(join(bundle, 'INSTALL.md'), '# Install doctor-fixture\n'),
      writeFile(join(bundle, 'install.mjs'), '// installer\n'),
    ]);
  }
  return bundle;
};

const staticDiagnosticCodes = new Set(['AB7319', 'AB7320']);

const hostReport = (report: DoctorReport, host: DoctorHost) => {
  const found = report.hosts.find((entry) => entry.host === host);
  if (found === undefined) throw new Error(`Missing ${host} report.`);
  return found;
};

it.each(['claude', 'codex'] as const)(
  'reports %s version probes as available, unavailable, or failed',
  async (host) => {
    const fixture = await temporaryDoctor();
    try {
      const available = await runDoctor({
        commandRunner: versionRunner,
        endpointDirectory: fixture.endpointDirectory,
        home: fixture.home,
        hosts: [host],
      });
      expect(hostReport(available, host).probe).toMatchObject({
        status: 'available',
        version: '1.2.3',
      });

      const unavailable = await runDoctor({
        commandRunner: async () => { throw errno('ENOENT'); },
        endpointDirectory: fixture.endpointDirectory,
        home: fixture.home,
        hosts: [host],
      });
      expect(hostReport(unavailable, host).probe.status).toBe('unavailable');
      expect(unavailable.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'AB7300', severity: 'info' }),
      ]));

      const failed = await runDoctor({
        commandRunner: async () => commandResult({ termination: 'timed-out' }),
        endpointDirectory: fixture.endpointDirectory,
        home: fixture.home,
        hosts: [host],
      });
      expect(hostReport(failed, host).probe.status).toBe('failed');
      expect(failed.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'AB7301', severity: 'error' }),
      ]));
    } finally {
      await fixture.cleanup();
    }
  },
);

it('reports Cursor directory evidence as available, unavailable, or failed', async () => {
  const fixture = await temporaryDoctor();
  try {
    await mkdir(join(fixture.home, '.cursor'));
    const available = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(hostReport(available, 'cursor').probe).toMatchObject({
      evidence: 'directory',
      status: 'available',
    });

    await rm(join(fixture.home, '.cursor'), { recursive: true });
    const unavailable = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(hostReport(unavailable, 'cursor').probe.status).toBe('unavailable');

    await writeFile(join(fixture.home, '.cursor'), 'not a directory');
    const failed = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(hostReport(failed, 'cursor').probe.status).toBe('failed');
    expect(failed.diagnostics).toMatchObject([{ code: 'AB7302', severity: 'error' }]);
  } finally {
    await fixture.cleanup();
  }
});

it('inventories all pinned Cursor manifest candidates in loader order', async () => {
  const fixture = await temporaryDoctor();
  const installRoot = join(fixture.home, '.cursor', 'plugins', 'local');
  try {
    for (const [index, manifest] of [
      '.cursor-plugin/plugin.json',
      '.claude-plugin/plugin.json',
      'plugin.json',
    ].entries()) {
      await writeJson(join(installRoot, `fixture-${index}`, manifest), {
        name: `fixture-${index}`,
        version: `${index}.0.0`,
      });
    }
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(hostReport(report, 'cursor').inventory).toMatchObject({
      findings: [
        { manifest: '.cursor-plugin/plugin.json', state: 'installed' },
        { manifest: '.claude-plugin/plugin.json', state: 'installed' },
        { manifest: 'plugin.json', state: 'installed' },
      ],
      status: 'known',
    });
    expect(report.diagnostics.filter((entry) => entry.code === 'AB7320')).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('.claude-plugin/plugin.json'),
        severity: 'info',
      }),
      expect.objectContaining({
        message: expect.stringContaining('plugin.json'),
        severity: 'info',
      }),
    ]);
  } finally {
    await fixture.cleanup();
  }
});

it('validates root plugin.json installs that declare an Agent Plugins schema against the pinned 1.0.0 contract', async () => {
  const fixture = await temporaryDoctor();
  const installRoot = join(fixture.home, '.cursor', 'plugins', 'local');
  const pluginSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
  const mcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
  try {
    await writeJson(join(installRoot, 'conformant', 'plugin.json'), {
      $schema: pluginSchema,
      name: 'conformant',
      version: '1.0.0',
    });
    await writeJson(join(installRoot, 'conformant', 'mcp.json'), {
      $schema: mcpSchema,
      mcpServers: { tool: { args: ['${PLUGIN_ROOT}/mcp/tool.mjs'], command: 'node', type: 'stdio' } },
    });
    await mkdir(join(installRoot, 'conformant', 'mcp'), { recursive: true });
    await writeFile(join(installRoot, 'conformant', 'mcp', 'tool.mjs'), 'export {};\n');
    await writeJson(join(installRoot, 'broken', 'plugin.json'), {
      $schema: pluginSchema,
      name: 'broken',
      unknownField: true,
      version: '1.0.0',
    });
    await writeJson(join(installRoot, 'broken', 'mcp.json'), {
      $schema: mcpSchema,
      mcpServers: { remote: { type: 'streamable-http', url: 'http://mcp.example.test/mcp' } },
    });

    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(hostReport(report, 'cursor').inventory).toMatchObject({
      findings: [
        { manifest: 'plugin.json', name: 'broken', state: 'corrupt' },
        { manifest: 'plugin.json', name: 'conformant', state: 'installed' },
      ],
      status: 'known',
    });
    const staticDiagnostics = report.diagnostics.filter((entry) => entry.code === 'AB7320');
    expect(staticDiagnostics.filter((entry) => entry.severity === 'info')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('/broken" is a root plugin.json') }),
      expect.objectContaining({ message: expect.stringContaining('/conformant" is a root plugin.json') }),
    ]);
    for (const info of staticDiagnostics.filter((entry) => entry.severity === 'info')) {
      expect(info.message).toContain('Agent Plugins package');
      expect(info.message).toContain(pluginSchema);
    }
    expect(staticDiagnostics.filter((entry) => entry.severity === 'error').map((entry) => entry.message)).toEqual([
      expect.stringMatching(/reported AB6035: plugin\.json\/: must NOT have additional properties/u),
      expect.stringMatching(/reported AB6036: mcp\.json\/mcpServers\/remote\/url uses plain HTTP against non-loopback host/u),
    ]);
  } finally {
    await fixture.cleanup();
  }
});

it('proves Agent Plugins stdio launch on Cursor: unexpanded spec forms warn, the emitted installer\'s expansion is verified, drift is corrupt (AB7326)', async () => {
  const fixture = await temporaryDoctor();
  const installRoot = join(fixture.home, '.cursor', 'plugins', 'local');
  const pluginSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
  const mcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
  const ab7325 = (report: DoctorReport) => report.diagnostics.filter((entry) => entry.code === 'AB7326');
  const ab7320Errors = (report: DoctorReport) => report.diagnostics.filter((entry) => entry.code === 'AB7320' && entry.severity === 'error');
  const doctor = () => runDoctor({ endpointDirectory: fixture.endpointDirectory, home: fixture.home, hosts: ['cursor'] });
  try {
    // 1. The spec-shaped pack from the 2026-09-03 observations, copied in by hand: every form Cursor leaves unresolved.
    await writeJson(join(installRoot, 'spec-shape', 'plugin.json'), { $schema: pluginSchema, name: 'spec-shape', version: '1.0.0' });
    await writeJson(join(installRoot, 'spec-shape', 'mcp.json'), {
      $schema: mcpSchema,
      mcpServers: {
        launcher: { args: [], command: './mcp/launch.sh', type: 'stdio' },
        probe: { args: ['${PLUGIN_ROOT}/mcp/report.mjs'], command: 'node', cwd: '${PLUGIN_ROOT}', env: { PROBE_DATA: '${PLUGIN_DATA}' }, type: 'stdio' },
        remote: { type: 'streamable-http', url: 'https://example.test/mcp' },
      },
    });
    await mkdir(join(installRoot, 'spec-shape', 'mcp'), { recursive: true });
    await writeFile(join(installRoot, 'spec-shape', 'mcp', 'report.mjs'), 'process.stdin.resume();\n');
    await writeFile(join(installRoot, 'spec-shape', 'mcp', 'launch.sh'), '#!/bin/sh\n', { mode: 0o755 });
    const unexpanded = await doctor();
    expect(ab7320Errors(unexpanded)).toEqual([]);
    expect(ab7325(unexpanded)).toEqual([expect.objectContaining({
      message: expect.stringContaining('"launcher", "probe" depend on client-side Agent Plugins 1.0.0 resolution that Cursor 3.18.25 does not perform'),
      recovery: expect.stringContaining('emitted `install.mjs`'),
      severity: 'warning',
    })]);
    const [unexpandedMessage] = ab7325(unexpanded).map((entry) => entry.message);
    expect(unexpandedMessage).toContain('launcher: plugin-relative `./` command resolved against the workspace folder');
    expect(unexpandedMessage).toContain('omitted `cwd` defaulted to the home directory');
    expect(unexpandedMessage).toContain('probe: ${PLUGIN_ROOT}/${PLUGIN_DATA} left unexpanded in args, env, cwd (spec §9.2)');
    expect(unexpandedMessage).toContain('reserved `PLUGIN_ROOT`/`PLUGIN_DATA` variables not provided');
    expect(hostReport(unexpanded, 'cursor').inventory.findings).toEqual([
      expect.objectContaining({ launch: { servers: ['launcher', 'probe'], state: 'unexpanded' }, name: 'spec-shape', state: 'installed' }),
    ]);
    await rm(join(installRoot, 'spec-shape'), { recursive: true });

    // 2. The same pack installed by the emitted install.mjs: expanded, recorded, and verified — the Agent Plugins
    //    contract is checked against the bundle's document, so the absolute paths and §9.1 keys in the copy are no error.
    const bundle = join(fixture.root, 'portable-bundle');
    const installerSource = composeProjections({
      extensions: {},
      hooks: [],
      mcpServers: [],
      metadata: {
        id: 'plugin:expanded',
        name: 'expanded',
        provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
        version: '1.0.0',
      },
      runtime: { node: '22.19.0' },
      scripts: [],
      skills: [],
      targets: [{ id: 'target:portable', name: 'portable', provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' } }],
    }, createDefaultRegistry()).entries.find((entry): entry is TargetArtifactWrite => entry.kind === 'write' && entry.relativePath === 'install.mjs');
    if (installerSource === undefined) throw new Error('portable composite root emitted no install.mjs');
    await mkdir(join(bundle, 'mcp'), { recursive: true });
    await writeFile(join(bundle, 'install.mjs'), installerSource.content);
    await writeFile(join(bundle, 'INSTALL.md'), '# Install expanded\n');
    await writeJson(join(bundle, 'plugin.json'), { $schema: pluginSchema, name: 'expanded', version: '1.0.0' });
    await writeJson(join(bundle, 'mcp.json'), {
      $schema: mcpSchema,
      mcpServers: {
        launcher: { args: [], command: './mcp/launch.sh', type: 'stdio' },
        probe: { args: ['${PLUGIN_ROOT}/mcp/report.mjs'], command: 'node', cwd: '${PLUGIN_ROOT}', env: { PROBE_DATA: '${PLUGIN_DATA}' }, type: 'stdio' },
      },
    });
    await writeFile(join(bundle, 'mcp', 'report.mjs'), 'process.stdin.resume();\n');
    await writeFile(join(bundle, 'mcp', 'launch.sh'), '#!/bin/sh\n', { mode: 0o755 });
    await new Promise<void>((resolveInstall, reject) => {
      const child = spawn(process.execPath, [join(bundle, 'install.mjs')], { cwd: bundle, env: { ...process.env, HOME: fixture.home }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolveInstall() : reject(new Error(`install.mjs exited ${String(code)}: ${output}`)));
    });
    const destination = join(installRoot, 'expanded');
    const pluginData = join(fixture.home, '.cursor', 'agent-bundle', 'plugin-data', 'expanded');
    const expanded = await doctor();
    expect(ab7320Errors(expanded)).toEqual([]);
    expect(expanded.diagnostics.filter((entry) => entry.code === 'AB7320' && entry.severity === 'info').map((entry) => entry.message)).toEqual([
      expect.stringContaining('using the pre-expansion mcp.json its install receipt recorded'),
    ]);
    expect(ab7325(expanded)).toEqual([expect.objectContaining({
      message: expect.stringContaining(`were expanded for Cursor at install (provenance: derived; Cursor 3.18.25 expands no Agent Plugins placeholder itself): PLUGIN_ROOT=${JSON.stringify(destination)}, PLUGIN_DATA=${JSON.stringify(pluginData)}`),
      severity: 'info',
    })]);
    expect(hostReport(expanded, 'cursor').inventory.findings).toEqual([
      expect.objectContaining({ launch: { pluginData, pluginRoot: destination, servers: ['launcher', 'probe'], state: 'expanded' }, name: 'expanded', state: 'installed' }),
    ]);

    // 3. Drift: the data directory disappears and a referenced script is removed — Cursor would spawn paths that do not exist.
    await rm(pluginData, { recursive: true });
    await rm(join(destination, 'mcp', 'report.mjs'));
    const drifted = await doctor();
    expect(ab7325(drifted)).toEqual([expect.objectContaining({
      message: expect.stringContaining('no longer describes the installed copy'),
      recovery: expect.stringContaining('reinstalled at its current location'),
      severity: 'error',
    })]);
    const [driftMessage] = ab7325(drifted).map((entry) => entry.message);
    expect(driftMessage).toContain(`the PLUGIN_DATA directory ${JSON.stringify(pluginData)} does not exist`);
    expect(driftMessage).toContain(`mcpServers/probe/args/0 ${JSON.stringify(join(destination, 'mcp', 'report.mjs'))} does not exist under the plugin root`);
    expect(hostReport(drifted, 'cursor').inventory.findings).toEqual([
      expect.objectContaining({ launch: expect.objectContaining({ state: 'drifted' }), name: 'expanded', state: 'corrupt' }),
    ]);

    // 4. A copy moved to another plugin directory carries a receipt expanded for its old root.
    await mkdir(pluginData, { recursive: true });
    await writeFile(join(destination, 'mcp', 'report.mjs'), 'process.stdin.resume();\n');
    await cp(destination, join(installRoot, 'moved'), { recursive: true });
    await rm(destination, { recursive: true });
    const moved = await doctor();
    expect(ab7325(moved).map((entry) => entry.severity)).toEqual(['error']);
    expect(ab7325(moved)[0]?.message).toContain(`the receipt expanded PLUGIN_ROOT to ${JSON.stringify(destination)} but the package is installed at ${JSON.stringify(join(installRoot, 'moved'))}`);
    // The moved copy's on-disk mcp.json is still validated against the recorded bundle document, not its expanded bytes.
    expect(ab7320Errors(moved)).toEqual([]);
    await rm(join(installRoot, 'moved'), { recursive: true });

    // 5. An edit to the installed copy that keeps every path valid (a bare command renamed) is still drift:
    //    the installed bytes must equal the expansion of the recorded document, and the byte lane then
    //    validates the installed bytes themselves (which are not Agent Plugins-conformant), so the entry is corrupt.
    await cp(bundle, join(fixture.root, 'bundle-again'), { recursive: true });
    await new Promise<void>((resolveInstall, reject) => {
      const child = spawn(process.execPath, [join(fixture.root, 'bundle-again', 'install.mjs')], { cwd: join(fixture.root, 'bundle-again'), env: { ...process.env, HOME: fixture.home }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolveInstall() : reject(new Error(`install.mjs exited ${String(code)}: ${output}`)));
    });
    const installedMcp = await readFile(join(destination, 'mcp.json'), 'utf8');
    await writeFile(join(destination, 'mcp.json'), installedMcp.replace('"command": "node"', '"command": "bun"'));
    const edited = await doctor();
    expect(ab7325(edited)).toEqual([expect.objectContaining({
      message: expect.stringContaining('the installed mcp.json is not the expansion of the recorded document (edited or replaced after install)'),
      severity: 'error',
    })]);
    expect(ab7320Errors(edited).length).toBeGreaterThan(0);
    expect(hostReport(edited, 'cursor').inventory.findings).toEqual([
      expect.objectContaining({ launch: expect.objectContaining({ state: 'drifted' }), name: 'expanded', state: 'corrupt' }),
    ]);

    // 6. The expanded document removed altogether while the receipt still records it.
    await rm(join(destination, 'mcp.json'));
    const removed = await doctor();
    expect(ab7325(removed).map((entry) => entry.severity)).toEqual(['error']);
    expect(ab7325(removed)[0]?.message).toContain('mcp.json is missing or not a regular file although the receipt recorded its expansion');
    expect(hostReport(removed, 'cursor').inventory.findings).toEqual([
      expect.objectContaining({ launch: { pluginData, pluginRoot: destination, servers: [], state: 'drifted' }, state: 'corrupt' }),
    ]);
  } finally {
    await fixture.cleanup();
  }
}, 60_000);

it('accepts a versionless Cursor inventory manifest as installed', async () => {
  const fixture = await temporaryDoctor();
  const installRoot = join(fixture.home, '.cursor', 'plugins', 'local');
  try {
    await writeJson(
      join(installRoot, 'versionless', '.cursor-plugin/plugin.json'),
      { name: 'versionless' },
    );
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    const finding = hostReport(report, 'cursor').inventory.findings.find(
      (entry) => entry.entry === 'versionless',
    );
    expect(finding).toMatchObject({
      manifest: '.cursor-plugin/plugin.json',
      name: 'versionless',
      state: 'installed',
    });
    expect(finding).not.toHaveProperty('version');
    expect(report.diagnostics.some((entry) => entry.code === 'AB7304')).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

it('inventories durable SQLite stores and sidecars without opening them', async () => {
  const fixture = await temporaryDoctor();
  const pluginRoot = join(fixture.home, '.cursor', 'plugins', 'local', 'stateful');
  const environment = { XDG_STATE_HOME: join(fixture.root, 'state-home') };
  const stateRoot = userDataStateRoot(pluginRoot, environment, fixture.home);
  const legacyStateRoot = join(pluginRoot, 'state');
  const store = 'project-tasks-0123456789abcdef.sqlite';
  try {
    await Promise.all([
      writeJson(
        join(pluginRoot, '.cursor-plugin/plugin.json'),
        { name: 'stateful', version: '1.0.0' },
      ),
      mkdir(stateRoot, { recursive: true }),
      mkdir(legacyStateRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(stateRoot, store), 'database'),
      writeFile(join(stateRoot, `${store}-wal`), 'wal!'),
      writeFile(join(stateRoot, `${store}-shm`), 'shm'),
      writeFile(join(stateRoot, 'ignore.txt'), 'ignored'),
    ]);

    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      environment,
      home: fixture.home,
      hosts: ['cursor'],
    });
    const finding = hostReport(report, 'cursor').inventory.findings.find(
      (entry) => entry.entry === 'stateful',
    );
    expect(finding?.durableState).toMatchObject({
      directory: stateRoot,
      exists: true,
      findings: [{
        bytes: 15,
        file: store,
        mtime: expect.any(String),
        path: join(stateRoot, store),
      }],
      status: 'known',
      summary: { bytes: 15, stores: 1 },
      ownership: 'unrecorded',
      purgeable: false,
      servers: ['default'],
      writable: true,
    });
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB7332',
        message: expect.stringContaining(legacyStateRoot),
      }),
    ]));

    const human = captureCliTerminal();
    const humanCode = await runCli(['doctor'], human.output, { runDoctor: async () => report });
    expect(humanCode).toBe(0);
    expect(human.stdout()).toContain('durable state: 1 store, 15 B');
    expect(human.stdout()).toContain(`state root: ${stateRoot} (exists, writable, derived)`);
    expect(human.stdout()).toContain('ownership: unrecorded, retained, servers: default');

    const json = captureCliTerminal();
    await runCli(['doctor', '--json'], json.output, { runDoctor: async () => report });
    expect(JSON.parse(json.stdout()).hosts[0].inventory.findings[0].durableState).toMatchObject({
      findings: [{ bytes: 15, file: store }],
      exists: true,
      summary: { bytes: 15, stores: 1 },
      writable: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

it('reports a missing derived state root and a declared state-root override', async () => {
  const fixture = await temporaryDoctor();
  const pluginRoot = join(fixture.home, '.cursor', 'plugins', 'local', 'configured-state');
  const declaredStateRoot = join(fixture.root, 'declared-state');
  try {
    await Promise.all([
      writeJson(join(pluginRoot, '.cursor-plugin/plugin.json'), { name: 'configured-state', version: '1.0.0' }),
      writeJson(join(pluginRoot, '.cursor-plugin/mcp.json'), {
        mcpServers: {
          configured: {
            command: 'node',
            env: { AGENT_BUNDLE_STATE_ROOT: declaredStateRoot },
          },
        },
      }),
    ]);
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    const finding = hostReport(report, 'cursor').inventory.findings.find((entry) => entry.entry === 'configured-state');
    expect(finding?.durableState).toMatchObject({
      directory: declaredStateRoot,
      exists: false,
      findings: [],
      ownership: 'unrecorded',
      purgeable: false,
      servers: ['configured'],
      summary: { bytes: 0, stores: 0 },
      writable: false,
    });
  } finally {
    await fixture.cleanup();
  }
});

it('reports an unresolved relative state override without treating the plugin root as state', async () => {
  const fixture = await temporaryDoctor();
  const pluginRoot = join(fixture.home, '.cursor', 'plugins', 'local', 'relative-state');
  try {
    await Promise.all([
      writeJson(join(pluginRoot, '.cursor-plugin/plugin.json'), { name: 'relative-state', version: '1.0.0' }),
      writeJson(join(pluginRoot, '.cursor-plugin/mcp.json'), {
        mcpServers: {
          configured: {
            command: 'node',
            env: { AGENT_BUNDLE_STATE_ROOT: '../state' },
          },
        },
      }),
    ]);
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    const finding = hostReport(report, 'cursor').inventory.findings.find((entry) => entry.entry === 'relative-state');
    expect(finding?.durableState).toMatchObject({
      directory: '<unresolved state root: configured>',
      exists: false,
      ownership: 'unrecorded',
      ownershipReason: 'relative override has no provable execution directory',
      purgeable: false,
      servers: ['configured'],
    });
    expect(finding?.durableState?.directory).not.toBe(pluginRoot);
  } finally {
    await fixture.cleanup();
  }
});

it('reports whether an installed pack carries an operator .env file, never its contents (#469)', async () => {
  const fixture = await temporaryDoctor();
  const pluginRoot = join(fixture.home, '.cursor', 'plugins', 'local', 'configured');
  try {
    await writeJson(
      join(pluginRoot, '.cursor-plugin/plugin.json'),
      { name: 'configured', version: '1.0.0' },
    );
    await writeFile(join(pluginRoot, '.env'), '# operator credentials\nIPT_SESSION=s3cr3t-session\nMAM_SESSION="s3cr3t-mam"\n');

    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    const finding = hostReport(report, 'cursor').inventory.findings.find((entry) => entry.entry === 'configured');
    expect(finding?.operatorEnv).toEqual({
      diagnostics: [expect.objectContaining({ code: 'AB7331', severity: 'info' })],
      files: [
        { path: join(pluginRoot, '.env'), state: 'present', variables: 2 },
        { path: join(pluginRoot, '.env.local'), state: 'absent' },
      ],
      status: 'present',
    });
    const info = report.diagnostics.find((entry) => entry.code === 'AB7331');
    expect(info?.message).toContain(`Operator env file ${JSON.stringify(join(pluginRoot, '.env'))} is present and declares 2 variables`);
    // Names and values stay out of the report entirely.
    expect(JSON.stringify(report)).not.toMatch(/s3cr3t|IPT_SESSION|MAM_SESSION/u);
    expect(report.summary).toMatchObject({ errors: 0, warnings: 0 });

    const human = captureCliTerminal();
    await runCli(['doctor'], human.output, { runDoctor: async () => report });
    expect(human.stdout()).toContain(`operator env: ${join(pluginRoot, '.env')} (2 variables)`);
    expect(human.stdout()).not.toContain('s3cr3t');
  } finally {
    await fixture.cleanup();
  }
});

it('records both operator env files as absent for a pack that ships none, without a diagnostic', async () => {
  const fixture = await temporaryDoctor();
  const pluginRoot = join(fixture.home, '.cursor', 'plugins', 'local', 'plain');
  try {
    await writeJson(join(pluginRoot, '.cursor-plugin/plugin.json'), { name: 'plain', version: '1.0.0' });
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    const finding = hostReport(report, 'cursor').inventory.findings.find((entry) => entry.entry === 'plain');
    expect(finding?.operatorEnv).toEqual({
      diagnostics: [],
      files: [
        { path: join(pluginRoot, '.env'), state: 'absent' },
        { path: join(pluginRoot, '.env.local'), state: 'absent' },
      ],
      status: 'absent',
    });
    expect(report.diagnostics.some((entry) => entry.code === 'AB7331')).toBe(false);
    const human = captureCliTerminal();
    await runCli(['doctor'], human.output, { runDoctor: async () => report });
    expect(human.stdout()).not.toContain('operator env:');
  } finally {
    await fixture.cleanup();
  }
});

it('prints a web surface line when the bundle manifest exposes Apps', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'cursor');
    await writeJson(join(bundle, 'agent-bundle.manifest.json'), {
      web: { apps: [{ app: 'status/status' }, { app: 'status/other' }] },
    });
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(report.web).toEqual({
      apps: 2,
      line: 'web: 2 App(s) exposed — run doctor-fixture web',
      plugin: 'doctor-fixture',
    });
    const human = captureCliTerminal();
    const humanCode = await runCli(['doctor'], human.output, { runDoctor: async () => report });
    expect(humanCode).toBe(0);
    expect(human.stdout()).toContain('web: 2 App(s) exposed — run doctor-fixture web');
  } finally {
    await fixture.cleanup();
  }
});

it('inventories durable state under a checked --from bundle', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'codex');
    const stateRoot = join(bundle, 'state');
    await mkdir(stateRoot);
    await writeFile(join(stateRoot, 'from-bundle-fedcba9876543210.sqlite'), 'state');
    const report = await runDoctor({
      commandRunner: versionRunner,
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['codex'],
    });
    expect(hostReport(report, 'codex').bundle?.durableState).toMatchObject({
      directory: stateRoot,
      findings: [{ bytes: 5, file: 'from-bundle-fedcba9876543210.sqlite' }],
      summary: { bytes: 5, stores: 1 },
    });
  } finally {
    await fixture.cleanup();
  }
});

it('warns when an installed bundle state directory cannot be read', async () => {
  const fixture = await temporaryDoctor();
  const pluginRoot = join(fixture.home, '.cursor', 'plugins', 'local', 'blocked-state');
  try {
    await writeJson(
      join(pluginRoot, '.cursor-plugin/plugin.json'),
      { name: 'blocked-state', version: '1.0.0' },
    );
    await writeFile(join(pluginRoot, 'state'), 'not a directory');
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7316', severity: 'warning' }),
    ]));
    expect(report.summary).toMatchObject({ errors: 0, warnings: 1 });
  } finally {
    await fixture.cleanup();
  }
});

it('reports a Cursor inventory manifest with a non-string version as corrupt', async () => {
  const fixture = await temporaryDoctor();
  const installRoot = join(fixture.home, '.cursor', 'plugins', 'local');
  try {
    await writeJson(join(installRoot, 'bad-version', '.cursor-plugin/plugin.json'), {
      name: 'x',
      version: 7,
    });
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(hostReport(report, 'cursor').inventory.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ entry: 'bad-version', state: 'corrupt' }),
    ]));
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7304', severity: 'error' }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('reports corrupt, symlinked, and interrupted Cursor inventory entries', async () => {
  const fixture = await temporaryDoctor();
  const installRoot = join(fixture.home, '.cursor', 'plugins', 'local');
  try {
    await mkdir(join(installRoot, 'no-manifest'), { recursive: true });
    await mkdir(join(installRoot, 'bad-json'), { recursive: true });
    await writeFile(join(installRoot, 'bad-json', 'plugin.json'), '{');
    await symlink(join(installRoot, 'no-manifest'), join(installRoot, 'linked'));
    await mkdir(join(installRoot, '.fixture.stage-dead', 'bundle'), { recursive: true });

    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    const findings = hostReport(report, 'cursor').inventory.findings;
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ entry: 'no-manifest', state: 'corrupt' }),
      expect.objectContaining({ entry: 'bad-json', state: 'corrupt' }),
      expect.objectContaining({ entry: 'linked', state: 'corrupt' }),
      expect.objectContaining({ entry: '.fixture.stage-dead', state: 'interrupted-install' }),
    ]));
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7304', severity: 'error' }),
      expect.objectContaining({ code: 'AB7305', severity: 'warning' }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('accepts valid installed and --from Cursor bytes without static findings', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'cursor');
    const destination = join(fixture.home, '.cursor', 'plugins', 'local', 'doctor-fixture');
    await mkdir(dirname(destination), { recursive: true });
    await cp(bundle, destination, { recursive: true });

    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['cursor'],
    });

    expect(hostReport(report, 'cursor').inventory.findings).toEqual([
      expect.objectContaining({ entry: 'doctor-fixture', state: 'installed' }),
    ]);
    expect(hostReport(report, 'cursor').bundle?.state).toBe('installed');
    expect(report.diagnostics.filter((entry) => staticDiagnosticCodes.has(entry.code))).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

it('marks an installed Cursor plugin corrupt when pinned-schema validation fails', async () => {
  const fixture = await temporaryDoctor();
  const pluginRoot = join(fixture.home, '.cursor', 'plugins', 'local', 'schema-invalid');
  try {
    await writeJson(join(pluginRoot, '.cursor-plugin/plugin.json'), {
      name: 'schema-invalid',
      surprise: true,
    });

    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });

    expect(hostReport(report, 'cursor').inventory.findings).toEqual([
      expect.objectContaining({ entry: 'schema-invalid', state: 'corrupt' }),
    ]);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB7320',
        message: expect.stringContaining('AB6027'),
        severity: 'error',
        target: 'cursor',
      }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('marks an installed Cursor plugin corrupt when a symlink escapes the local plugin root', async () => {
  const fixture = await temporaryDoctor();
  const pluginRoot = join(fixture.home, '.cursor', 'plugins', 'local', 'escaping-link');
  const outside = join(fixture.root, 'outside.txt');
  try {
    await writeJson(join(pluginRoot, '.cursor-plugin/plugin.json'), { name: 'escaping-link' });
    await writeFile(outside, 'outside\n');
    await symlink(outside, join(pluginRoot, 'outside-link'));

    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });

    expect(hostReport(report, 'cursor').inventory.findings).toEqual([
      expect.objectContaining({ entry: 'escaping-link', state: 'corrupt' }),
    ]);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB7320',
        message: expect.stringContaining('AB6028'),
        severity: 'error',
        target: 'cursor',
      }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('allows an installed Cursor plugin symlink to another entry inside the local plugin root', async () => {
  const fixture = await temporaryDoctor();
  const installRoot = join(fixture.home, '.cursor', 'plugins', 'local');
  const pluginRoot = join(installRoot, 'linked-inside');
  const siblingRoot = join(installRoot, 'shared-target');
  try {
    await Promise.all([
      writeJson(join(pluginRoot, 'plugin.json'), { name: 'linked-inside' }),
      writeJson(join(siblingRoot, '.cursor-plugin/plugin.json'), { name: 'shared-target' }),
    ]);
    await writeFile(join(siblingRoot, 'shared.txt'), 'shared\n');
    await symlink(join(siblingRoot, 'shared.txt'), join(pluginRoot, 'shared-link'));

    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });

    expect(hostReport(report, 'cursor').inventory.findings).toEqual([
      expect.objectContaining({ entry: 'linked-inside', state: 'installed' }),
      expect.objectContaining({ entry: 'shared-target', state: 'installed' }),
    ]);
    expect(report.diagnostics.filter((entry) =>
      entry.code === 'AB7320' && entry.severity === 'error')).toEqual([]);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB7320',
        message: expect.stringContaining('plugin.json'),
        severity: 'info',
      }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('reports invalid --from Cursor bytes and keeps deterministic validator order', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'cursor');
    await writeJson(join(bundle, '.cursor-plugin/plugin.json'), {
      description: '${CURSOR_PLUGIN_ROOT} is invalid here',
      name: 'doctor-fixture',
      surprise: true,
      version: '1.2.3',
    });

    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['cursor'],
    });
    const findings = report.diagnostics.filter((entry) => entry.code === 'AB7319');

    expect(hostReport(report, 'cursor').bundle?.state).toBe('corrupt');
    expect(findings.map((entry) => entry.message)).toEqual([
      expect.stringContaining('AB6027'),
      expect.stringContaining('AB6028'),
    ]);
  } finally {
    await fixture.cleanup();
  }
});

it('validates --from Codex bytes without running the live schema generator', async () => {
  const fixture = await temporaryDoctor();
  const calls: unknown[] = [];
  try {
    const bundle = await createBundle(fixture.root, 'codex');
    await writeJson(join(bundle, '.codex-plugin/plugin.json'), {
      name: 'Invalid Codex Name',
      version: '1.2.3',
    });

    const report = await runDoctor({
      commandRunner: async (request) => {
        calls.push(request);
        return commandResult({ stdout: 'codex 0.147.0\n' });
      },
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['codex'],
    });

    // Read-only inventory only: the version probe and the pinned `plugin list --json`, never the schema generator.
    expect(calls).toEqual([
      expect.objectContaining({ args: ['--version'], executable: 'codex' }),
      expect.objectContaining({ args: ['plugin', 'list', '--json'], cwd: bundle, executable: 'codex' }),
    ]);
    expect(hostReport(report, 'codex').bundle?.state).toBe('corrupt');
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB7319',
        message: expect.stringContaining('AB6032'),
        severity: 'error',
        target: 'codex',
      }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('validates --from Claude documents from pinned bytes without a new CLI proof', async () => {
  const fixture = await temporaryDoctor();
  const calls: unknown[] = [];
  try {
    const bundle = await createBundle(fixture.root, 'claude');
    await writeJson(join(bundle, '.claude-plugin/plugin.json'), {
      name: 'doctor-fixture',
      version: '1.2.3',
    });

    const report = await runDoctor({
      commandRunner: async (request) => {
        calls.push(request);
        return request.args[0] === '--version'
          ? commandResult({ stdout: 'claude 2.1.250\n' })
          : commandResult({ stdout: JSON.stringify([{ id: 'doctor-fixture@inline' }]) });
      },
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['claude'],
    });

    // Read-only proofs only: one version probe, installed inventory, inline registration proof, then the
    // developer validator over the bundle's two manifests (#476) — it reads files and writes nothing.
    // The pinned-bytes document check (AB7319) needs no CLI proof of its own.
    expect(calls).toEqual([
      expect.objectContaining({ args: ['--version'], executable: 'claude' }),
      expect.objectContaining({ args: ['plugin', 'list', '--json'], cwd: bundle, executable: 'claude' }),
      expect.objectContaining({
        args: ['--plugin-dir', bundle, 'plugin', 'list', '--json'],
        executable: 'claude',
      }),
      expect.objectContaining({
        args: ['plugin', 'validate', join(bundle, '.claude-plugin', 'plugin.json'), '--strict'],
        executable: 'claude',
      }),
      expect.objectContaining({
        args: ['plugin', 'validate', join(bundle, '.claude-plugin', 'marketplace.json'), '--strict'],
        executable: 'claude',
      }),
    ]);
    expect(hostReport(report, 'claude').bundle?.state).toBe('corrupt');
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB7319',
        message: expect.stringContaining('.claude-plugin/plugin.json'),
        severity: 'error',
        target: 'claude',
      }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('lists Claude plugins from the plugin root --from names, never from a directory nested under it (#555)', async () => {
  const fixture = await temporaryDoctor();
  const calls: { readonly args: readonly string[]; readonly cwd?: string }[] = [];
  try {
    // The root itself holds the manifest; Claude `project`/`local` rows are
    // keyed by the cwd the host verbs ran in, and install runs them from that
    // root — so must the listing, or such scopes read as absent. A `claude/`
    // directory nested under it (the pre-composite partition) is never probed.
    const artifactRoot = join(fixture.root, 'artifact');
    await mkdir(join(artifactRoot, 'claude'), { recursive: true });
    await writeJson(join(artifactRoot, 'claude', '.claude-plugin/plugin.json'), { name: 'nested-decoy', version: '0.0.0' });
    await writeFile(join(artifactRoot, 'payload.txt'), 'payload\n');
    await writeJson(join(artifactRoot, '.claude-plugin/plugin.json'), {
      author: { name: 'Doctor Fixture' },
      description: 'Doctor fixture plugin.',
      name: 'doctor-fixture',
      version: '1.2.3',
    });
    await writeJson(join(artifactRoot, '.claude-plugin/marketplace.json'), {
      name: 'doctor-fixture-marketplace',
      owner: { name: 'Doctor Fixture' },
      plugins: [{ name: 'doctor-fixture', source: './' }],
    });

    await runDoctor({
      commandRunner: async (request) => {
        calls.push({ args: request.args, ...(request.cwd === undefined ? {} : { cwd: request.cwd }) });
        return request.args[0] === '--version'
          ? commandResult({ stdout: 'claude 2.1.250\n' })
          : commandResult({ stdout: '[]' });
      },
      endpointDirectory: fixture.endpointDirectory,
      from: artifactRoot,
      home: fixture.home,
      hosts: ['claude'],
    });

    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: ['plugin', 'list', '--json'], cwd: artifactRoot }),
    ]));
    expect(calls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ args: ['plugin', 'list', '--json'], cwd: join(artifactRoot, 'claude') }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('skips static validation when Cursor home and --from are absent', async () => {
  const fixture = await temporaryDoctor();
  try {
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });

    expect(hostReport(report, 'cursor').probe.status).toBe('unavailable');
    expect(hostReport(report, 'cursor').inventory.status).toBe('skipped');
    expect(hostReport(report, 'cursor').bundle).toBeUndefined();
    expect(report.diagnostics.filter((entry) => staticDiagnosticCodes.has(entry.code))).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

it('reports unreadable Cursor local plugin directory as unknown inventory', async () => {
  const fixture = await temporaryDoctor();
  const installRoot = join(fixture.home, '.cursor', 'plugins', 'local');
  try {
    await mkdir(dirname(installRoot), { recursive: true });
    await writeFile(installRoot, 'not a directory');
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(hostReport(report, 'cursor').inventory.status).toBe('unknown');
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7304', severity: 'error' }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('reports an unreadable Cursor marketplace staging root as an AB7324 finding instead of aborting', async () => {
  const fixture = await temporaryDoctor();
  const stagingRoot = join(fixture.home, '.cursor', 'agent-bundle', 'marketplaces');
  try {
    await mkdir(dirname(stagingRoot), { recursive: true });
    await writeFile(stagingRoot, 'not a directory');
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(hostReport(report, 'cursor').inventory.findings).toEqual([]);
    const staging = report.diagnostics.filter((entry) => entry.code === 'AB7324');
    expect(staging).toEqual([expect.objectContaining({ severity: 'error' })]);
    expect(staging[0]?.message).toContain('could not be read');
  } finally {
    await fixture.cleanup();
  }
});

it('reports Claude and Codex inventories as honestly unknown when plugin list --json is unusable', async () => {
  const fixture = await temporaryDoctor();
  try {
    const report = await runDoctor({
      commandRunner: versionRunner,
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['claude', 'codex'],
    });
    expect(report.hosts.map((entry) => entry.inventory.status)).toEqual(['unknown', 'unknown']);
    expect(report.diagnostics.filter((entry) => entry.code === 'AB7303')).toHaveLength(2);
    expect(report.diagnostics.find((entry) => entry.code === 'AB7303')?.message).toContain('plugin list --json');
  } finally {
    await fixture.cleanup();
  }
});

it('inventories Claude and Codex installs from their pinned plugin list --json verbs', async () => {
  const fixture = await temporaryDoctor();
  try {
    const codexHome = join(fixture.root, 'codex-home');
    const runner: DoctorCommandRunner = async (request) => {
      if (request.args[0] === '--version') return commandResult({ stdout: `${request.executable} 1.2.3\n` });
      if (request.executable === 'claude') {
        return commandResult({ stdout: JSON.stringify([
          { enabled: true, id: 'alpha@alpha-marketplace', installPath: '/cache/alpha/1.0.0', scope: 'user', version: '1.0.0' },
          { enabled: true, id: 'alpha@alpha-marketplace', installPath: '/cache/alpha-project/1.0.0', scope: 'project', version: '1.0.0' },
        ]) });
      }
      return commandResult({ stdout: JSON.stringify({
        available: [],
        installed: [
          { enabled: true, installed: true, pluginId: 'beta@beta-marketplace', version: '2.0.0' },
          { enabled: false, installed: false, pluginId: 'gamma@beta-marketplace', version: '3.0.0' },
        ],
      }) });
    };
    const report = await runDoctor({
      commandRunner: runner,
      endpointDirectory: fixture.endpointDirectory,
      environment: { CODEX_HOME: codexHome },
      home: fixture.home,
      hosts: ['claude', 'codex'],
    });
    expect(report.diagnostics.some((entry) => entry.code === 'AB7303')).toBe(false);
    expect(hostReport(report, 'claude').inventory).toMatchObject({
      findings: [
        {
          enabled: true,
          entry: 'alpha@alpha-marketplace (user)',
          name: 'alpha',
          path: '/cache/alpha/1.0.0',
          state: 'installed',
          version: '1.0.0',
        },
        {
          enabled: true,
          entry: 'alpha@alpha-marketplace (project)',
          name: 'alpha',
          path: '/cache/alpha-project/1.0.0',
          state: 'installed',
          version: '1.0.0',
        },
      ],
      status: 'known',
    });
    expect(hostReport(report, 'codex').inventory).toMatchObject({
      findings: [{
        entry: 'beta@beta-marketplace',
        name: 'beta',
        path: join(codexHome, 'plugins', 'cache', 'beta-marketplace', 'beta', '2.0.0'),
        state: 'installed',
        version: '2.0.0',
      }],
      status: 'known',
    });
  } finally {
    await fixture.cleanup();
  }
});

it('reports a Claude listing with a malformed scope as unknown inventory (AB7303) instead of a partial known one', async () => {
  const fixture = await temporaryDoctor();
  try {
    const runner: DoctorCommandRunner = async (request) => {
      if (request.args[0] === '--version') return commandResult({ stdout: `${request.executable} 1.2.3\n` });
      return commandResult({ stdout: JSON.stringify([
        { enabled: true, id: 'alpha@alpha-marketplace', installPath: '/cache/alpha/1.0.0', scope: 'user', version: '1.0.0' },
        { enabled: true, id: 'alpha@alpha-marketplace', installPath: '/cache/alpha-project/1.0.0', version: '1.0.0' },
      ]) });
    };
    const report = await runDoctor({
      commandRunner: runner,
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['claude'],
    });
    expect(hostReport(report, 'claude').inventory).toEqual({ findings: [], status: 'unknown' });
    const unusable = report.diagnostics.filter((entry) => entry.code === 'AB7303');
    expect(unusable).toHaveLength(1);
    expect(unusable[0]?.message).toContain('a row lacks id, installPath, scope, or version');
  } finally {
    await fixture.cleanup();
  }
});

it('reports a malformed host bundle as a Doctor error', async () => {
  const fixture = await temporaryDoctor();
  try {
    const report = await runDoctor({
      commandRunner: versionRunner,
      endpointDirectory: fixture.endpointDirectory,
      from: join(fixture.root, 'missing-bundle'),
      home: fixture.home,
      hosts: ['claude'],
    });
    expect(hostReport(report, 'claude').bundle?.state).toBe('failed');
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7306', severity: 'error' }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('classifies Cursor bundle state as installed, missing, drifted, or conflicted', async () => {
  const cases = [
    { expected: 'installed', mutate: async (_destination: string): Promise<void> => {} },
    {
      expected: 'missing',
      mutate: async (destination: string): Promise<void> => rm(destination, { recursive: true }),
    },
    {
      expected: 'drifted',
      mutate: async (destination: string): Promise<void> =>
        writeFile(join(destination, 'payload.txt'), 'drift\n'),
    },
    {
      expected: 'conflicted',
      mutate: async (destination: string): Promise<void> =>
        writeJson(join(destination, '.cursor-plugin/plugin.json'), {
          name: 'doctor-fixture',
          version: '9.0.0',
        }),
    },
  ] as const;
  for (const testCase of cases) {
    const fixture = await temporaryDoctor();
    try {
      const bundle = await createBundle(fixture.root, 'cursor');
      const destination = join(fixture.home, '.cursor', 'plugins', 'local', 'doctor-fixture');
      await mkdir(dirname(destination), { recursive: true });
      await cp(bundle, destination, { recursive: true });
      await testCase.mutate(destination);
      const report = await runDoctor({
        endpointDirectory: fixture.endpointDirectory,
        from: bundle,
        home: fixture.home,
        hosts: ['cursor'],
      });
      expect(hostReport(report, 'cursor').bundle?.state).toBe(testCase.expected);
    } finally {
      await fixture.cleanup();
    }
  }
});

it('compares the installed Cursor copy against the artifact: current, stale, foreign, not installed', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'cursor');
    const destination = join(fixture.home, '.cursor', 'plugins', 'local', 'doctor-fixture');
    await mkdir(join(fixture.home, '.cursor'), { recursive: true });
    const doctor = () => runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['cursor'],
    });
    const artifactHash = (await treeInventory(bundle)).hash;

    const missing = hostReport(await doctor(), 'cursor');
    expect(missing.bundle).toMatchObject({
      comparison: { artifactContentHash: artifactHash, status: 'not-installed' },
      state: 'missing',
    });
    expect(missing.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7307', severity: 'info' }),
    ]));

    // Receipt-managed install: current, then stale after a same-version content change.
    await installBundle({ from: bundle, home: fixture.home, host: 'cursor', scope: 'user' });
    const current = hostReport(await doctor(), 'cursor');
    expect(current.bundle).toMatchObject({
      comparison: {
        artifactContentHash: artifactHash,
        installedContentHash: artifactHash,
        installedPath: destination,
        installedVersion: '1.2.3',
        ownership: 'receipt',
        status: 'current',
      },
      state: 'installed',
    });
    expect(current.diagnostics.filter((entry) => entry.severity !== 'info')).toEqual([]);

    await writeFile(join(bundle, 'payload.txt'), 'rebuilt\n');
    const rebuiltHash = (await treeInventory(bundle)).hash;
    const stale = hostReport(await doctor(), 'cursor');
    expect(stale.bundle).toMatchObject({
      comparison: {
        artifactContentHash: rebuiltHash,
        installedContentHash: artifactHash,
        ownership: 'receipt',
        status: 'stale',
      },
      state: 'drifted',
    });
    const staleDiagnostic = stale.diagnostics.find((entry) => entry.code === 'AB7308');
    expect(staleDiagnostic).toMatchObject({ severity: 'warning', target: 'cursor' });
    expect(staleDiagnostic?.message).toContain('stale (same version, different content)');
    expect(staleDiagnostic?.message).toContain(`content ${artifactHash.slice(0, 12)}`);
    expect(staleDiagnostic?.message).toContain(`content ${rebuiltHash.slice(0, 12)}`);
    expect(staleDiagnostic?.recovery).toContain('replaced automatically');

    // Legacy pre-receipt copy with different content: stale, recovery points at --replace.
    await rm(destination, { force: true, recursive: true });
    await cp(bundle, destination, { recursive: true });
    await writeFile(join(destination, 'payload.txt'), 'older\n');
    const legacy = hostReport(await doctor(), 'cursor');
    expect(legacy.bundle).toMatchObject({ comparison: { ownership: 'legacy', status: 'stale' }, state: 'drifted' });
    expect(legacy.diagnostics.find((entry) => entry.code === 'AB7308')?.recovery).toContain('--replace');

    // Foreign directory under the plugin name: no receipt, no install surface.
    await rm(destination, { force: true, recursive: true });
    await mkdir(destination, { recursive: true });
    await writeJson(join(destination, '.cursor-plugin/plugin.json'), { name: 'doctor-fixture', version: '1.2.3' });
    await writeFile(join(destination, 'payload.txt'), 'someone else\n');
    const foreignHash = (await treeInventory(destination)).hash;
    const foreign = hostReport(await doctor(), 'cursor');
    expect(foreign.bundle).toMatchObject({
      comparison: {
        artifactContentHash: rebuiltHash,
        installedContentHash: foreignHash,
        ownership: 'foreign',
        status: 'foreign',
      },
      state: 'conflicted',
    });
    const foreignDiagnostic = foreign.diagnostics.find((entry) => entry.code === 'AB7321');
    expect(foreignDiagnostic).toMatchObject({ severity: 'warning', target: 'cursor' });
    expect(foreignDiagnostic?.message).toContain('foreign install');
    expect(foreignDiagnostic?.message).toContain(`content ${foreignHash.slice(0, 12)}`);
    expect(foreignDiagnostic?.message).toContain(`content ${rebuiltHash.slice(0, 12)}`);
    expect(foreignDiagnostic?.message).toContain('same version, different content');
  } finally {
    await fixture.cleanup();
  }
});

it('treats a versionless Cursor destination as drifted rather than conflicted', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'cursor');
    const destination = join(fixture.home, '.cursor', 'plugins', 'local', 'doctor-fixture');
    await mkdir(dirname(destination), { recursive: true });
    await cp(bundle, destination, { recursive: true });
    await writeJson(join(destination, '.cursor-plugin/plugin.json'), { name: 'doctor-fixture' });
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(hostReport(report, 'cursor').bundle?.state).toBe('drifted');
    expect(report.diagnostics.some((entry) => entry.code === 'AB7309')).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

it('turns a symlink inside a Cursor bundle into a corrupt finding', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'cursor');
    await mkdir(join(fixture.home, '.cursor'), { recursive: true });
    await symlink('/tmp', join(bundle, 'unsafe'));
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(hostReport(report, 'cursor').bundle?.state).toBe('corrupt');
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7310', severity: 'error' }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('reports a Cursor destination without a valid manifest as a foreign install', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'cursor');
    const destination = join(fixture.home, '.cursor', 'plugins', 'local', 'doctor-fixture');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'payload.txt'), 'payload\n');
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['cursor'],
    });
    expect(hostReport(report, 'cursor').bundle).toMatchObject({
      comparison: { ownership: 'foreign', status: 'foreign' },
      state: 'conflicted',
    });
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7321', severity: 'warning' }),
    ]));
    expect(report.diagnostics.some((entry) => entry.code === 'AB7310')).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

it.each([
  {
    expectedCode: undefined,
    expectedState: 'registered',
    label: 'id@inline',
    registration: commandResult({ stdout: JSON.stringify([{ id: 'doctor-fixture@inline' }]) }),
  },
  {
    expectedCode: 'AB7311',
    expectedState: 'unregistered',
    label: 'name-only false positive',
    registration: commandResult({ stdout: JSON.stringify([{ name: 'doctor-fixture' }]) }),
  },
  {
    expectedCode: 'AB7311',
    expectedState: 'unregistered',
    label: 'other id',
    registration: commandResult({ stdout: JSON.stringify([{ id: 'other@inline' }]) }),
  },
  {
    expectedCode: 'AB7312',
    expectedState: 'failed',
    label: 'wrapped object shape',
    registration: commandResult({
      stdout: JSON.stringify({ plugins: [{ id: 'doctor-fixture@inline' }] }),
    }),
  },
  {
    expectedCode: 'AB7312',
    expectedState: 'failed',
    label: 'non-JSON',
    registration: commandResult({ stdout: 'not json' }),
  },
] as const)(
  'reports Claude registration proof as $expectedState ($label)',
  async ({ expectedCode, expectedState, registration }) => {
    const fixture = await temporaryDoctor();
    try {
      const bundle = await createBundle(fixture.root, 'claude');
      const runner: DoctorCommandRunner = async (request) =>
        request.args[0] === '--version'
          ? commandResult({ stdout: 'claude 2.1.250' })
          : registration;
      const report = await runDoctor({
        commandRunner: runner,
        endpointDirectory: fixture.endpointDirectory,
        from: bundle,
        home: fixture.home,
        hosts: ['claude'],
      });
      expect(hostReport(report, 'claude').bundle?.state).toBe(expectedState);
      if (expectedCode !== undefined) {
        expect(report.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: expectedCode, severity: 'error' }),
        ]));
      }
    } finally {
      await fixture.cleanup();
    }
  },
);

it('skips Claude registration when its binary is unavailable', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'claude');
    const report = await runDoctor({
      commandRunner: async () => { throw errno('ENOENT'); },
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['claude'],
    });
    expect(hostReport(report, 'claude').bundle?.state).toBe('skipped');
  } finally {
    await fixture.cleanup();
  }
});

it('reports Codex bundle registration as unknown', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'codex');
    const report = await runDoctor({
      commandRunner: versionRunner,
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['codex'],
    });
    expect(hostReport(report, 'codex').bundle?.state).toBe('unknown');
    expect(hostReport(report, 'codex').bundle?.comparison).toMatchObject({ status: 'unknown' });
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7313', severity: 'info' }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

const isInventoryRequest = (request: Parameters<DoctorCommandRunner>[0]): boolean =>
  request.args.join(' ') === 'plugin list --json';

it('compares the Claude cache copy reported by plugin list --json against the artifact', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'claude');
    const installed = join(fixture.root, 'claude-config', 'plugins', 'cache', 'doctor-fixture-marketplace', 'doctor-fixture', '1.2.3');
    await cp(bundle, installed, { recursive: true });
    const artifactHash = (await treeInventory(bundle)).hash;
    let inventory: readonly unknown[] = [];
    const runner: DoctorCommandRunner = async (request) => {
      if (request.args[0] === '--version') return commandResult({ stdout: 'claude 2.1.250' });
      if (isInventoryRequest(request)) return commandResult({ stdout: JSON.stringify(inventory) });
      return commandResult({ stdout: JSON.stringify([{ id: 'doctor-fixture@inline' }]) });
    };
    const doctor = () => runDoctor({
      commandRunner: runner,
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['claude'],
    });

    const missing = hostReport(await doctor(), 'claude');
    expect(missing.bundle).toMatchObject({ comparison: { status: 'not-installed' }, state: 'registered' });
    expect(missing.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7307', severity: 'info', target: 'claude' }),
    ]));

    inventory = [{ enabled: true, id: 'doctor-fixture@doctor-fixture-marketplace', installPath: installed, scope: 'user', version: '1.2.3' }];
    const current = hostReport(await doctor(), 'claude');
    expect(current.bundle).toMatchObject({
      comparison: {
        artifactContentHash: artifactHash,
        installedContentHash: artifactHash,
        installedPath: installed,
        installedVersion: '1.2.3',
        ownership: 'host',
        status: 'current',
      },
      state: 'registered',
    });
    expect(current.diagnostics.filter((entry) => entry.severity !== 'info')).toEqual([]);

    await writeFile(join(installed, 'payload.txt'), 'stale\n');
    const staleHash = (await treeInventory(installed)).hash;
    const stale = hostReport(await doctor(), 'claude');
    expect(stale.bundle).toMatchObject({
      comparison: { installedContentHash: staleHash, status: 'stale' },
      state: 'registered',
    });
    const staleDiagnostic = stale.diagnostics.find((entry) => entry.code === 'AB7308');
    expect(staleDiagnostic).toMatchObject({ severity: 'warning', target: 'claude' });
    expect(staleDiagnostic?.message).toContain('stale (same version, different content)');
    expect(staleDiagnostic?.message).toContain(`content ${staleHash.slice(0, 12)}`);
    expect(staleDiagnostic?.recovery).toContain('version-gated');

    inventory = [{ enabled: true, id: 'doctor-fixture@doctor-fixture-marketplace', installPath: installed, scope: 'user', version: '1.0.0' }];
    const mismatch = hostReport(await doctor(), 'claude');
    expect(mismatch.bundle?.comparison).toMatchObject({ installedVersion: '1.0.0', status: 'version-mismatch' });
    expect(mismatch.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7309', severity: 'warning', target: 'claude' }),
    ]));

    // A current user-scoped copy never masks a stale copy at another scope.
    const currentCache = join(fixture.root, 'claude-config', 'plugins', 'cache', 'doctor-fixture-marketplace', 'doctor-fixture', 'current');
    await cp(bundle, currentCache, { recursive: true });
    inventory = [
      { enabled: true, id: 'doctor-fixture@doctor-fixture-marketplace', installPath: currentCache, scope: 'user', version: '1.2.3' },
      { enabled: true, id: 'doctor-fixture@doctor-fixture-marketplace', installPath: installed, scope: 'project', version: '1.2.3' },
    ];
    const scoped = hostReport(await doctor(), 'claude');
    expect(scoped.bundle?.comparison).toMatchObject({ installedPath: installed, status: 'stale' });
    const scopedDiagnostic = scoped.diagnostics.find((entry) => entry.code === 'AB7308');
    expect(scopedDiagnostic?.message).toContain('(scope project)');
    expect(scopedDiagnostic?.recovery).toContain('--scope project');
  } finally {
    await fixture.cleanup();
  }
});

// Verbatim `claude plugin list --json` row (Claude Code 2.1.259) for a plugin Claude Code refused: the row
// keeps `enabled: true` and the load verdict lives only in `errors`. Healthy rows omit the key.
const claudeDuplicateHooksError = (installPath: string): string =>
  'Hook load failed: Duplicate hooks file detected: ./hooks/hooks.json resolves to already-loaded file ' +
  `${installPath}/hooks/hooks.json. The standard hooks/hooks.json is loaded automatically, so manifest.hooks ` +
  'should only reference additional hook files.';

it('reports a Claude copy the host refused to load as load-failed (AB7325) instead of current (#464)', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'claude');
    const installed = join(fixture.root, 'claude-config', 'plugins', 'cache', 'doctor-fixture-marketplace', 'doctor-fixture', '1.2.3');
    await cp(bundle, installed, { recursive: true });
    const artifactHash = (await treeInventory(bundle)).hash;
    const refusedRow = {
      enabled: true,
      errors: [claudeDuplicateHooksError(installed)],
      id: 'doctor-fixture@doctor-fixture-marketplace',
      installPath: installed,
      scope: 'user',
      version: '1.2.3',
    };
    const runner: DoctorCommandRunner = async (request) => {
      if (request.args[0] === '--version') return commandResult({ stdout: 'claude 2.1.259' });
      if (isInventoryRequest(request)) return commandResult({ stdout: JSON.stringify([refusedRow]) });
      return commandResult({ stdout: JSON.stringify([{ id: 'doctor-fixture@inline' }]) });
    };
    const host = hostReport(await runDoctor({
      commandRunner: runner,
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['claude'],
    }), 'claude');

    // Byte-identical copy, yet nothing of it reaches a session: the comparison must not say `current`.
    expect(host.bundle).toMatchObject({
      comparison: {
        artifactContentHash: artifactHash,
        errors: refusedRow.errors,
        installedPath: installed,
        installedVersion: '1.2.3',
        ownership: 'host',
        status: 'load-failed',
      },
      state: 'registered',
    });
    expect(host.bundle?.comparison).not.toHaveProperty('installedContentHash');
    expect(host.inventory).toMatchObject({
      findings: [{
        enabled: true,
        entry: 'doctor-fixture@doctor-fixture-marketplace (user)',
        errors: refusedRow.errors,
        name: 'doctor-fixture',
        path: installed,
        state: 'failed',
        version: '1.2.3',
      }],
      status: 'known',
    });
    const refused = host.diagnostics.filter((entry) => entry.code === 'AB7325');
    expect(refused).toEqual([expect.objectContaining({ severity: 'error', target: 'claude' })]);
    expect(refused[0]?.message).toContain('claude refused to load doctor-fixture@1.2.3');
    expect(refused[0]?.message).toContain('Duplicate hooks file detected');
    expect(refused[0]?.message).toContain('(scope user)');
    expect(refused[0]?.recovery).toContain('--scope user --replace');
    expect(host.diagnostics.some((entry) => entry.code === 'AB7308' || entry.code === 'AB7309')).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

it('reports an installed-but-disabled Claude copy as disabled (AB7327) with the enable command (#476)', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'claude');
    const installed = join(fixture.root, 'claude-config', 'plugins', 'cache', 'doctor-fixture-marketplace', 'doctor-fixture', '1.2.3');
    await cp(bundle, installed, { recursive: true });
    const artifactHash = (await treeInventory(bundle)).hash;
    const disabledRow = {
      enabled: false,
      id: 'doctor-fixture@doctor-fixture-marketplace',
      installPath: installed,
      scope: 'project',
      version: '1.2.3',
    };
    const runner: DoctorCommandRunner = async (request) => {
      if (request.args[0] === '--version') return commandResult({ stdout: 'claude 2.1.259' });
      if (isInventoryRequest(request)) return commandResult({ stdout: JSON.stringify([disabledRow]) });
      if (request.args[0] === '--plugin-dir') return commandResult({ stdout: JSON.stringify([{ id: 'doctor-fixture@inline' }]) });
      return commandResult({ stdout: JSON.stringify({ contents: [], manifest: { errors: [], notes: [], warnings: [] }, success: true }) });
    };
    const host = hostReport(await runDoctor({
      commandRunner: runner,
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['claude'],
    }), 'claude');

    // Byte-identical and current, yet switched off: the comparison still runs, the inventory says so.
    expect(host.bundle).toMatchObject({
      comparison: {
        artifactContentHash: artifactHash,
        enabled: false,
        installedContentHash: artifactHash,
        installedPath: installed,
        status: 'current',
      },
      state: 'registered',
    });
    expect(host.inventory).toMatchObject({
      findings: [{
        enabled: false,
        entry: 'doctor-fixture@doctor-fixture-marketplace (project)',
        name: 'doctor-fixture',
        path: installed,
        state: 'disabled',
        version: '1.2.3',
      }],
      status: 'known',
    });
    const disabled = host.diagnostics.filter((entry) => entry.code === 'AB7327');
    expect(disabled).toEqual([expect.objectContaining({ severity: 'warning', target: 'claude' })]);
    expect(disabled[0]?.message).toContain('as disabled (`enabled: false`)');
    expect(disabled[0]?.message).toContain('(scope project)');
    expect(disabled[0]?.recovery).toContain('claude plugin enable doctor-fixture@doctor-fixture-marketplace --scope project');
    expect(disabled[0]?.recovery).toContain('reinstalling does not enable');
    expect(host.diagnostics.some((entry) => entry.code === 'AB7308' || entry.code === 'AB7325')).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

it('runs the Claude developer validator over the bundle and every installed copy (#476)', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'claude');
    const installed = join(fixture.root, 'claude-config', 'plugins', 'cache', 'doctor-fixture-marketplace', 'doctor-fixture', '1.2.3');
    await cp(bundle, installed, { recursive: true });
    const recorded = (name: string, directory: string): Promise<string> =>
      readFile(new URL(`./fixtures/claude-plugin-validate/${name}`, import.meta.url), 'utf8')
        .then((text) => text.replaceAll('/bundle/claude', directory));
    const calls: string[][] = [];
    const runner: DoctorCommandRunner = async (request) => {
      calls.push([...request.args]);
      if (request.args[0] === '--version') return commandResult({ stdout: 'claude 2.1.259' });
      if (isInventoryRequest(request)) {
        return commandResult({ stdout: JSON.stringify([
          { enabled: true, id: 'doctor-fixture@doctor-fixture-marketplace', installPath: installed, scope: 'user', version: '1.2.3' },
        ]) });
      }
      if (request.args[0] === '--plugin-dir') return commandResult({ stdout: JSON.stringify([{ id: 'doctor-fixture@inline' }]) });
      const target = request.args[2] ?? '';
      // The bundle validates clean; the installed copy's plugin.json run carries the recorded warnings.
      const findings = target.startsWith(installed) && target.endsWith('plugin.json') && !target.endsWith('marketplace.json');
      return commandResult({
        exitCode: findings ? 1 : 0,
        stdout: await recorded(findings ? '2.1.259-plugin-strict-findings.json' : '2.1.259-plugin-strict-passed.json', dirname(dirname(target))),
      });
    };
    const host = hostReport(await runDoctor({
      commandRunner: runner,
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['claude'],
    }), 'claude');

    // One probe for the whole host; the validator never lists plugins again (Doctor holds the verdict).
    expect(calls.filter((call) => call[0] === '--version')).toHaveLength(1);
    expect(calls.filter((call) => call[0] === '--plugin-dir')).toHaveLength(1);
    expect(calls.filter((call) => call[0] === 'plugin' && call[1] === 'validate').map((call) => call[2])).toEqual([
      join(bundle, '.claude-plugin', 'plugin.json'),
      join(bundle, '.claude-plugin', 'marketplace.json'),
      join(installed, '.claude-plugin', 'plugin.json'),
      join(installed, '.claude-plugin', 'marketplace.json'),
    ]);
    expect(host.bundle?.hostValidation).toEqual([
      expect.objectContaining({ copy: 'bundle', diagnostics: [], pluginDirectory: bundle, status: 'passed', version: '2.1.259' }),
      expect.objectContaining({ copy: 'installed', pluginDirectory: installed, scope: 'user', status: 'warnings' }),
    ]);
    expect(host.bundle?.hostValidation?.[1]).not.toHaveProperty('load');
    const findings = host.diagnostics.filter((entry) => entry.code === 'AB6020');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((entry) => entry.severity === 'warning' && entry.target === 'claude')).toBe(true);
    expect(findings[0]?.message).toMatch(new RegExp(`^Installed copy at ${JSON.stringify(installed).replaceAll('\\', '\\\\')} \\(scope user\\): `, 'u'));
    expect(host.diagnostics.some((entry) => entry.message.startsWith('Bundle at'))).toBe(false);
    expect(host.bundle?.comparison?.status).toBe('current');
  } finally {
    await fixture.cleanup();
  }
});

it('fails the Claude registration proof when --plugin-dir plugin list --json carries errors for the bundle', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'claude');
    const runner: DoctorCommandRunner = async (request) => {
      if (request.args[0] === '--version') return commandResult({ stdout: 'claude 2.1.259' });
      if (isInventoryRequest(request)) return commandResult({ stdout: '[]' });
      return commandResult({ stdout: JSON.stringify([{
        enabled: true,
        errors: [claudeDuplicateHooksError(bundle)],
        id: 'doctor-fixture@inline',
        installPath: bundle,
        scope: 'user',
        version: '1.2.3',
      }]) });
    };
    const host = hostReport(await runDoctor({
      commandRunner: runner,
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['claude'],
    }), 'claude');
    expect(host.bundle).toMatchObject({
      errors: [expect.stringContaining('Duplicate hooks file detected')],
      state: 'failed',
    });
    const refused = host.diagnostics.filter((entry) => entry.code === 'AB7325');
    expect(refused).toEqual([expect.objectContaining({ severity: 'error', target: 'claude' })]);
    expect(refused[0]?.message).toContain(`claude refused to load doctor-fixture@1.2.3 from ${bundle}`);
    expect(host.diagnostics.some((entry) => entry.code === 'AB7311' || entry.code === 'AB7312')).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

it('compares the Codex cache copy against the artifact once plugin list --json names the install', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'codex');
    const codexHome = join(fixture.root, 'codex-home');
    const installed = join(codexHome, 'plugins', 'cache', 'doctor-fixture-marketplace', 'doctor-fixture', '1.2.3');
    await cp(bundle, installed, { recursive: true });
    await writeFile(join(installed, 'payload.txt'), 'stale\n');
    const artifactHash = (await treeInventory(bundle)).hash;
    const staleHash = (await treeInventory(installed)).hash;
    let installedRows: readonly unknown[] = [];
    const runner: DoctorCommandRunner = async (request) => {
      if (request.args[0] === '--version') return commandResult({ stdout: 'codex-cli 0.147.0' });
      if (isInventoryRequest(request)) return commandResult({ stdout: JSON.stringify({ available: [], installed: installedRows }) });
      return commandResult({ stdout: '' });
    };
    const doctor = () => runDoctor({
      commandRunner: runner,
      endpointDirectory: fixture.endpointDirectory,
      environment: { CODEX_HOME: codexHome },
      from: bundle,
      home: fixture.home,
      hosts: ['codex'],
    });

    const missing = hostReport(await doctor(), 'codex');
    expect(missing.bundle).toMatchObject({ comparison: { status: 'not-installed' }, state: 'missing' });
    expect(missing.diagnostics.some((entry) => entry.code === 'AB7313')).toBe(false);
    expect(missing.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7307', severity: 'info', target: 'codex' }),
    ]));

    installedRows = [{
      enabled: true,
      installed: true,
      marketplaceName: 'doctor-fixture-marketplace',
      name: 'doctor-fixture',
      pluginId: 'doctor-fixture@doctor-fixture-marketplace',
      version: '1.2.3',
    }];
    const stale = hostReport(await doctor(), 'codex');
    expect(stale.bundle).toMatchObject({
      comparison: {
        artifactContentHash: artifactHash,
        installedContentHash: staleHash,
        installedPath: installed,
        ownership: 'host',
        status: 'stale',
      },
      state: 'installed',
    });
    const staleDiagnostic = stale.diagnostics.find((entry) => entry.code === 'AB7308');
    expect(staleDiagnostic).toMatchObject({ severity: 'warning', target: 'codex' });
    expect(staleDiagnostic?.recovery).toContain('codex plugin remove');
  } finally {
    await fixture.cleanup();
  }
});

it('surfaces the placed → registered → enabled → active lifecycle per host, typing the unobservable stages unavailable', async () => {
  const fixture = await temporaryDoctor();
  try {
    const claudeBundle = await createBundle(fixture.root, 'claude');
    const installed = join(fixture.root, 'claude-config', 'plugins', 'cache', 'doctor-fixture-marketplace', 'doctor-fixture', '1.2.3');
    await cp(claudeBundle, installed, { recursive: true });
    let row: Record<string, unknown> | undefined;
    const runner: DoctorCommandRunner = async (request) => {
      if (request.args[0] === '--version') return commandResult({ stdout: 'claude 2.1.257' });
      if (isInventoryRequest(request)) return commandResult({ stdout: JSON.stringify(row === undefined ? [] : [row]) });
      return commandResult({ stdout: JSON.stringify([{ id: 'doctor-fixture@inline' }]) });
    };
    const doctor = () => runDoctor({
      commandRunner: runner,
      endpointDirectory: fixture.endpointDirectory,
      from: claudeBundle,
      home: fixture.home,
      hosts: ['claude'],
    });

    const absent = hostReport(await doctor(), 'claude');
    expect(absent.bundle?.lifecycle).toMatchObject({
      active: { status: 'unavailable' },
      enabled: { status: 'observed', value: false },
      placed: { status: 'observed', value: false },
      registered: { status: 'observed', value: false },
      stage: 'absent',
    });
    const absentLifecycle = absent.diagnostics.find((entry) => entry.code === 'AB7330');
    expect(absentLifecycle).toMatchObject({ severity: 'info', target: 'claude' });
    expect(absentLifecycle?.message).toContain('stage absent');
    expect(absentLifecycle?.message).toContain('active=unavailable'.replace('=', ' '));

    row = { enabled: false, id: 'doctor-fixture@doctor-fixture-marketplace', installPath: installed, scope: 'user', version: '1.2.3' };
    const disabled = hostReport(await doctor(), 'claude');
    expect(disabled.bundle?.lifecycle).toMatchObject({
      enabled: { status: 'observed', value: false },
      placed: { status: 'observed', value: true },
      registered: { status: 'observed', value: true },
      stage: 'registered',
    });
    expect(disabled.diagnostics.find((entry) => entry.code === 'AB7330')?.recovery).toContain('claude plugin enable');

    row = { ...row, enabled: true };
    const enabled = hostReport(await doctor(), 'claude');
    expect(enabled.bundle?.lifecycle).toMatchObject({
      active: { status: 'unavailable' },
      enabled: { status: 'observed', value: true },
      stage: 'enabled',
    });
    expect(enabled.diagnostics.find((entry) => entry.code === 'AB7330')?.message).toContain('Unavailable: active (Claude Code 2.1.257');

    // Several Claude scopes: the lifecycle aggregates every listed copy, and a stage holds only when it holds for
    // all of them — a disabled or unplaced copy at any scope is reported regardless of Claude's row order.
    let rows: Record<string, unknown>[] = [];
    const multiRunner: DoctorCommandRunner = async (request) => {
      if (request.args[0] === '--version') return commandResult({ stdout: 'claude 2.1.257' });
      if (isInventoryRequest(request)) return commandResult({ stdout: JSON.stringify(rows) });
      return commandResult({ stdout: JSON.stringify([{ id: 'doctor-fixture@inline' }]) });
    };
    const multiDoctor = () => runDoctor({
      commandRunner: multiRunner,
      endpointDirectory: fixture.endpointDirectory,
      from: claudeBundle,
      home: fixture.home,
      hosts: ['claude'],
    });
    const userRow = { enabled: true, id: 'doctor-fixture@doctor-fixture-marketplace', installPath: installed, scope: 'user', version: '1.2.3' };
    rows = [userRow, { ...userRow, enabled: false, scope: 'project' }];
    const mixed = hostReport(await multiDoctor(), 'claude');
    expect(mixed.bundle?.lifecycle).toMatchObject({
      enabled: { evidence: expect.stringContaining('enabled: false for scope project'), status: 'observed', value: false },
      registered: { evidence: expect.stringContaining('scope user, scope project'), status: 'observed', value: true },
      stage: 'registered',
    });
    rows = [{ ...userRow, scope: 'project', enabled: false }, userRow];
    expect(hostReport(await multiDoctor(), 'claude').bundle?.lifecycle).toMatchObject({ enabled: { value: false }, stage: 'registered' });
    rows = [userRow, { ...userRow, installPath: join(fixture.root, 'claude-config', 'nowhere'), scope: 'local' }];
    const unplaced = hostReport(await multiDoctor(), 'claude');
    expect(unplaced.bundle?.lifecycle).toMatchObject({
      placed: { evidence: expect.stringContaining('(scope local)'), status: 'observed', value: false },
      stage: 'absent',
    });
    rows = [userRow, { ...userRow, enabled: undefined, scope: 'project' }];
    expect(hostReport(await multiDoctor(), 'claude').bundle?.lifecycle).toMatchObject({
      enabled: { reason: expect.stringContaining('scope project'), status: 'unavailable' },
    });
    rows = [userRow, { ...userRow, scope: 'project' }];
    expect(hostReport(await multiDoctor(), 'claude').bundle?.lifecycle).toMatchObject({
      enabled: { evidence: expect.stringContaining('scope user, scope project'), status: 'observed', value: true },
      stage: 'enabled',
    });

    // Cursor: placement is registration; enabled and active have no pinned read-only surface.
    const cursorBundle = await createBundle(fixture.root, 'cursor');
    await mkdir(join(fixture.home, '.cursor'), { recursive: true });
    const cursorMissing = hostReport(await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      from: cursorBundle,
      home: fixture.home,
      hosts: ['cursor'],
    }), 'cursor');
    expect(cursorMissing.bundle?.lifecycle).toMatchObject({
      enabled: { status: 'unavailable' },
      placed: { status: 'observed', value: false },
      stage: 'absent',
    });
    await installBundle({ from: cursorBundle, home: fixture.home, host: 'cursor' });
    const cursorPlaced = hostReport(await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      from: cursorBundle,
      home: fixture.home,
      hosts: ['cursor'],
    }), 'cursor');
    expect(cursorPlaced.bundle?.lifecycle).toMatchObject({
      active: { status: 'unavailable' },
      enabled: { reason: expect.stringContaining('enable_cc_plugin_import'), status: 'unavailable' },
      placed: { status: 'observed', value: true },
      registered: { status: 'observed', value: true },
      stage: 'registered',
    });
    expect(cursorPlaced.bundle?.receipt).toMatchObject({ mode: 'local', scope: 'user' });
    expect(cursorPlaced.inventory.findings[0]?.receipt).toMatchObject({ mode: 'local' });
    expect(cursorPlaced.inventory.findings[0]?.durableState).toMatchObject({
      ownership: 'derived',
      purgeable: false,
      servers: ['default'],
    });
  } finally {
    await fixture.cleanup();
  }
});

it('inventories store receipts, diagnoses orphaned ones (AB7328), and reports pre-lifecycle receipts as migrated (AB7329)', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'claude');
    const claudeConfig = join(fixture.root, 'claude-config');
    const installed = join(claudeConfig, 'plugins', 'cache', 'doctor-fixture-marketplace', 'doctor-fixture', '1.2.3');
    await cp(bundle, installed, { recursive: true });
    let rows: readonly unknown[] = [];
    const doctorRunner: DoctorCommandRunner = async (request) => {
      if (request.args[0] === '--version') return commandResult({ stdout: 'claude 2.1.257' });
      if (isInventoryRequest(request)) return commandResult({ stdout: JSON.stringify(rows) });
      return commandResult({ stdout: JSON.stringify([{ id: 'doctor-fixture@inline' }]) });
    };
    const installRunner = {
      run: async (_command: string, args: readonly string[]) => ({
        code: 0,
        stderr: '',
        // No marketplace configured beforehand, so the install records (and owns) the marketplace registration.
        stdout: args.join(' ') === 'plugin list --json'
          ? JSON.stringify(rows)
          : args.join(' ') === 'plugin marketplace list --json' ? JSON.stringify([]) : '',
      }),
    };
    const doctor = () => runDoctor({
      commandRunner: doctorRunner,
      endpointDirectory: fixture.endpointDirectory,
      environment: { CLAUDE_CONFIG_DIR: claudeConfig },
      home: fixture.home,
      hosts: ['claude'],
    });
    expect(hostReport(await doctor(), 'claude').receipts).toEqual([]);

    const result = await installBundle({
      commandRunner: installRunner,
      environment: { CLAUDE_CONFIG_DIR: claudeConfig },
      from: bundle,
      home: fixture.home,
      host: 'claude',
    });
    rows = [{ enabled: true, id: 'doctor-fixture@doctor-fixture-marketplace', installPath: installed, scope: 'user', version: '1.2.3' }];
    const consistent = hostReport(await doctor(), 'claude');
    expect(consistent.receipts).toEqual([expect.objectContaining({
      mode: 'host-cli',
      path: result.receipt,
      plugin: 'doctor-fixture',
      registrations: [
        { kind: 'claude-marketplace', name: 'doctor-fixture-marketplace', scope: 'user' },
        { id: 'doctor-fixture@doctor-fixture-marketplace', kind: 'claude-plugin', scope: 'user' },
      ],
      scope: 'user',
      state: 'consistent',
    })]);
    expect(consistent.diagnostics.some((entry) => entry.code === 'AB7328')).toBe(false);

    // The host forgot the plugin (uninstalled behind agent-bundle's back): the receipt is orphaned.
    rows = [];
    const orphaned = hostReport(await doctor(), 'claude');
    expect(orphaned.receipts[0]?.state).toBe('orphaned');
    const orphanDiagnostic = orphaned.diagnostics.find((entry) => entry.code === 'AB7328');
    expect(orphanDiagnostic).toMatchObject({ severity: 'warning', target: 'claude' });
    expect(orphanDiagnostic?.recovery).toContain('agent-bundle uninstall claude');

    // An unusable listing leaves the receipt state unknown rather than orphaned.
    const unknownRunner: DoctorCommandRunner = async (request) => request.args[0] === '--version'
      ? commandResult({ stdout: 'claude 2.1.257' })
      : commandResult({ stdout: 'not json' });
    const unknown = hostReport(await runDoctor({
      commandRunner: unknownRunner,
      endpointDirectory: fixture.endpointDirectory,
      environment: { CLAUDE_CONFIG_DIR: claudeConfig },
      home: fixture.home,
      hosts: ['claude'],
    }), 'claude');
    expect(unknown.receipts[0]?.state).toBe('unknown');

    // A receipt file that is not a receipt is reported, never thrown.
    await writeFile(join(claudeConfig, 'agent-bundle', 'receipts', 'broken.user.json'), '{"format":"nope"}\n');
    const broken = hostReport(await doctor(), 'claude');
    expect(broken.diagnostics.filter((entry) => entry.code === 'AB7328').some((entry) => entry.message.includes('not a valid install receipt'))).toBe(true);

    // The host executable cannot be probed at all: the store is still inventoried from disk, so the
    // stored receipt (state unknown) and the malformed file are reported instead of hidden.
    const absentHost: DoctorCommandRunner = async () => commandResult({ exitCode: 127, stderr: 'claude: command not found' });
    const unprobed = hostReport(await runDoctor({
      commandRunner: absentHost,
      endpointDirectory: fixture.endpointDirectory,
      environment: { CLAUDE_CONFIG_DIR: claudeConfig },
      home: fixture.home,
      hosts: ['claude'],
    }), 'claude');
    expect(unprobed.probe.status).not.toBe('available');
    expect(unprobed.receipts).toEqual([expect.objectContaining({ path: result.receipt, state: 'unknown' })]);
    expect(unprobed.diagnostics.filter((entry) => entry.code === 'AB7328').some((entry) => entry.message.includes('not a valid install receipt'))).toBe(true);
    await rm(join(claudeConfig, 'agent-bundle', 'receipts', 'broken.user.json'));

    // A Cursor local copy whose receipt predates format/2 is diagnosed as migrated, never rewritten by Doctor.
    const cursorBundle = await createBundle(fixture.root, 'cursor');
    await mkdir(join(fixture.home, '.cursor'), { recursive: true });
    await installBundle({ from: cursorBundle, home: fixture.home, host: 'cursor' });
    const destination = join(fixture.home, '.cursor', 'plugins', 'local', 'doctor-fixture');
    const receiptPath = join(destination, '.agent-bundle-install.json');
    const written = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    const { hostDirectories: _h, mode: _m, registrations: _r, scope: _s, updatedAt: _u, ...legacy } = written;
    await writeFile(receiptPath, JSON.stringify({ ...legacy, format: 'agent-bundle-install-receipt/1' }));
    const migrated = hostReport(await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      from: cursorBundle,
      home: fixture.home,
      hosts: ['cursor'],
    }), 'cursor');
    expect(migrated.inventory.findings[0]?.receipt).toMatchObject({ format: 'agent-bundle-install-receipt/1', migratedFrom: 'agent-bundle-install-receipt/1' });
    expect(migrated.bundle).toMatchObject({ receipt: { migratedFrom: 'agent-bundle-install-receipt/1' }, state: 'installed' });
    const migration = migrated.diagnostics.filter((entry) => entry.code === 'AB7329');
    expect(migration).toHaveLength(1);
    expect(migration[0]).toMatchObject({ severity: 'info', target: 'cursor' });
    expect(migration[0]?.recovery).toContain('agent-bundle-install-receipt/2');
    expect(await readFile(receiptPath, 'utf8')).toContain('agent-bundle-install-receipt/1');
  } finally {
    await fixture.cleanup();
  }
});

it('cross-checks Claude project-scope receipts from their recorded project root, not the doctor cwd', async () => {
  const fixture = await temporaryDoctor();
  try {
    const claudeConfig = join(fixture.root, 'claude-config');
    const projectRoot = join(fixture.root, 'elsewhere-project');
    const goneRoot = join(fixture.root, 'gone-project');
    await mkdir(projectRoot, { recursive: true });
    const id = 'doctor-fixture@doctor-fixture-marketplace';
    const installed = join(claudeConfig, 'plugins', 'cache', 'doctor-fixture-marketplace', 'doctor-fixture', '1.2.3');
    const receipt = (root: string) => ({
      contentHash: emptyContentHash,
      directories: [],
      files: [],
      format: installReceiptFormat,
      host: 'claude',
      hostDirectories: [],
      installedAt: '2026-09-03T00:00:00.000Z',
      mode: 'host-cli',
      plugin: 'doctor-fixture',
      projectRoot: root,
      registrations: [{ id, kind: 'claude-plugin', scope: 'project' }],
      scope: 'project',
      updatedAt: '2026-09-03T00:00:00.000Z',
      version: '1.2.3',
    });
    const receipts = join(claudeConfig, 'agent-bundle', 'receipts');
    const elsewhere = join(receipts, `doctor-fixture.doctor-fixture-marketplace.${installReceiptScopeKey('project', projectRoot)}.json`);
    const gone = join(receipts, `doctor-fixture.doctor-fixture-marketplace.${installReceiptScopeKey('project', goneRoot)}.json`);
    await writeJson(elsewhere, receipt(projectRoot));
    await writeJson(gone, receipt(goneRoot));
    const inventoryCwds: string[] = [];
    // `plugin list --json` sees the project registration only from the project it belongs to; a root that
    // no longer exists cannot run the host at all.
    const doctorRunner: DoctorCommandRunner = async (request) => {
      if (request.args[0] === '--version') return commandResult({ stdout: 'claude 2.1.257' });
      if (isInventoryRequest(request)) {
        inventoryCwds.push(request.cwd);
        if (request.cwd === goneRoot) return commandResult({ exitCode: 1, stderr: `spawn claude ENOENT (cwd ${goneRoot})` });
        return commandResult({
          stdout: JSON.stringify(request.cwd === projectRoot
            ? [{ enabled: true, id, installPath: installed, scope: 'project', version: '1.2.3' }]
            : []),
        });
      }
      return commandResult({ stdout: '[]' });
    };
    const report = hostReport(await runDoctor({
      commandRunner: doctorRunner,
      endpointDirectory: fixture.endpointDirectory,
      environment: { CLAUDE_CONFIG_DIR: claudeConfig },
      home: fixture.home,
      hosts: ['claude'],
    }), 'claude');
    expect(report.receipts).toHaveLength(2);
    expect(report.receipts.find((entry) => entry.path === elsewhere)).toMatchObject({ scope: 'project', state: 'consistent' });
    expect(report.receipts.find((entry) => entry.path === gone)).toMatchObject({ scope: 'project', state: 'unknown' });
    expect(report.diagnostics.some((entry) => entry.code === 'AB7328')).toBe(false);
    // The doctor cwd (home) once, then one listing per recorded project root.
    expect(inventoryCwds[0]).toBe(fixture.home);
    expect(inventoryCwds.slice(1).sort()).toEqual([goneRoot, projectRoot].sort());
  } finally {
    await fixture.cleanup();
  }
});

it('explains a Cursor directory holding only preserved runtime state instead of calling it corrupt or foreign', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'cursor');
    await mkdir(join(fixture.home, '.cursor'), { recursive: true });
    const destination = join(fixture.home, '.cursor', 'plugins', 'local', 'doctor-fixture');
    await mkdir(join(destination, 'state'), { recursive: true });
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    const doctor = () => runDoctor({ endpointDirectory: fixture.endpointDirectory, from: bundle, home: fixture.home, hosts: ['cursor'] });

    // Without any receipt (a hand-cleaned directory), the state-only shell is still not foreign.
    const bare = hostReport(await doctor(), 'cursor');
    expect(bare.inventory.findings).toEqual([expect.objectContaining({ path: destination, state: 'missing' })]);
    expect(bare.bundle).toMatchObject({ comparison: { status: 'not-installed' }, state: 'missing' });
    expect(bare.diagnostics.filter((entry) => entry.severity !== 'info')).toEqual([]);
    expect(bare.diagnostics.filter((entry) => entry.code === 'AB7307').every((entry) => entry.message.includes('preserved runtime state'))).toBe(true);

    // With the remnant receipt `uninstall --keep-data` writes, Doctor names the plugin and the receipt too.
    await rm(destination, { force: true, recursive: true });
    await installBundle({ from: bundle, home: fixture.home, host: 'cursor' });
    await mkdir(join(destination, 'state'));
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    await uninstallBundle({ from: bundle, home: fixture.home, host: 'cursor' });
    const remnant = hostReport(await doctor(), 'cursor');
    expect(remnant.inventory.findings).toEqual([expect.objectContaining({
      legacyDurableState: expect.objectContaining({ summary: { bytes: 8, stores: 1 } }),
      name: 'doctor-fixture',
      path: destination,
      receipt: expect.objectContaining({ mode: 'local' }),
      state: 'missing',
    })]);
    expect(remnant.bundle).toMatchObject({ lifecycle: { stage: 'absent' }, state: 'missing' });
    expect(remnant.diagnostics.filter((entry) => entry.severity !== 'info')).toEqual([]);
    const remnantCodes = remnant.diagnostics.filter((entry) => entry.code === 'AB7307');
    expect(remnantCodes.length).toBeGreaterThan(0);
    expect(remnantCodes.every((entry) => entry.message.includes('holds only preserved runtime state'))).toBe(true);

    // A remnant receipt also guarding unowned entries the uninstall retained is not called state-only: Doctor
    // names the retained entries and points at removing them by hand, since `uninstall` never will. Both the
    // inventory finding and the exact-bundle (`--from`) finding check the directory contents, not just the receipt.
    await writeFile(join(destination, 'operator-notes.md'), 'mine\n');
    const withExtras = hostReport(await doctor(), 'cursor');
    expect(withExtras.inventory.findings).toEqual([expect.objectContaining({ path: destination, state: 'missing' })]);
    expect(withExtras.bundle).toMatchObject({ comparison: { status: 'not-installed' }, state: 'missing' });
    const extras = withExtras.diagnostics.filter((entry) => entry.code === 'AB7307');
    expect(extras.length).toBe(remnantCodes.length);
    for (const entry of extras) {
      expect(entry.message).toContain('retained the unowned entry "operator-notes.md" beside preserved runtime state');
      expect(entry.message).not.toContain('holds only preserved runtime state');
      expect(entry.recovery).toContain('never removes unowned entries');
    }

    // Without any state left, a remnant receipt over unowned entries is still not "state-only".
    await rm(join(destination, 'state'), { force: true, recursive: true });
    const noState = hostReport(await doctor(), 'cursor');
    for (const entry of noState.diagnostics.filter((item) => item.code === 'AB7307')) {
      expect(entry.message).toContain('retained the unowned entry "operator-notes.md"');
      expect(entry.message).not.toContain('beside preserved runtime state');
    }

    // A remnant receipt recording a PLUGIN_DATA expansion names that directory as preserved state only while it is
    // real: this home's `agent-bundle/plugin-data/<plugin>`, reached through real directories, existing and holding
    // something. Removed by hand, emptied, or recorded for another home, it is not preserved state — `uninstall`
    // would not touch it either — so AB7307 does not claim it.
    await rm(join(destination, 'operator-notes.md'));
    const pluginData = join(fixture.home, '.cursor', 'agent-bundle', 'plugin-data', 'doctor-fixture');
    const remnantReceipt = JSON.parse(await readFile(join(destination, installReceiptFile), 'utf8')) as Record<string, unknown>;
    const recordExpansion = async (recorded: string) => writeFile(join(destination, installReceiptFile), JSON.stringify({
      ...remnantReceipt,
      cursorExpansion: { documents: { 'mcp.json': '{}\n' }, pluginData: recorded, pluginRoot: destination },
    }));
    const remnantMessages = async () => hostReport(await doctor(), 'cursor').diagnostics
      .filter((entry) => entry.code === 'AB7307').map((entry) => entry.message);
    await recordExpansion(pluginData);
    await mkdir(pluginData, { recursive: true });
    await writeFile(join(pluginData, 'cache.sqlite'), 'durable\n');
    const withData = await remnantMessages();
    expect(withData.length).toBeGreaterThan(0);
    expect(withData.every((message) => message.includes(`holds only preserved runtime state (the PLUGIN_DATA directory ${pluginData})`))).toBe(true);
    // Emptied, removed, or foreign, the directory is not claimed — and with no state/ either, Doctor does not invent
    // one: the remnant is reported as exhausted, with the default `uninstall` that consumes it as the recovery.
    await rm(join(pluginData, 'cache.sqlite'));
    const exhausted = hostReport(await doctor(), 'cursor').diagnostics.filter((entry) => entry.code === 'AB7307');
    expect(exhausted.length).toBeGreaterThan(0);
    for (const entry of exhausted) {
      expect(entry.message).toContain('holds only the remnant receipt of an earlier `uninstall --keep-data` whose preserved runtime state has since been removed');
      expect(entry.message).not.toContain('state/');
      expect(entry.message).not.toContain('PLUGIN_DATA');
      expect(entry.recovery).toContain('to consume the remnant');
    }
    await rm(pluginData, { recursive: true });
    expect((await remnantMessages()).every((message) => !message.includes('PLUGIN_DATA') && !message.includes('state/'))).toBe(true);
    // An emptied state/ directory left behind is not preserved state either.
    await mkdir(join(destination, 'state'));
    expect((await remnantMessages()).every((message) => message.includes('whose preserved runtime state has since been removed'))).toBe(true);
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    expect((await remnantMessages()).every((message) => message.includes('holds only preserved runtime state (state/)'))).toBe(true);
    await rm(join(destination, 'state'), { recursive: true });
    const elsewhere = join(fixture.root, 'other-home', '.cursor', 'agent-bundle', 'plugin-data', 'doctor-fixture');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, 'cache.sqlite'), 'foreign\n');
    await recordExpansion(elsewhere);
    expect((await remnantMessages()).every((message) => !message.includes('PLUGIN_DATA'))).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

const serverSockets = new WeakMap<Server, Set<Socket>>();

const listen = async (path: string, response?: unknown): Promise<Server> => {
  await mkdir(dirname(path), { recursive: true });
  const server = createServer((socket) => {
    const sockets = serverSockets.get(server)!;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (response === undefined) return;
    socket.once('data', () => socket.end(`${JSON.stringify(response)}\n`));
  });
  serverSockets.set(server, new Set());
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(path, resolvePromise);
  });
  return server;
};

const close = (server: Server): Promise<void> => new Promise((resolvePromise, reject) => {
  for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  server.close((error) => {
    if (error === undefined) resolvePromise();
    else reject(error);
  });
});

const findDeadPid = (): Promise<number> => new Promise((resolvePromise, reject) => {
  const child: ChildProcess = spawn(process.execPath, ['--input-type=module', '-e', ''], { stdio: 'ignore' });
  const { pid } = child;
  if (pid === undefined) {
    reject(new Error('Unable to spawn a child process for a dead pid fixture.'));
    return;
  }
  child.once('error', reject);
  child.once('exit', () => { resolvePromise(pid); });
});

it('reports old live runtime sockets as unsupported without warnings', async () => {
  const fixture = await temporaryDoctor();
  const endpoint = join(fixture.endpointDirectory, 'event-live.sock');
  const server = await listen(endpoint, {
    artifactEpoch: 'epoch-old',
    code: 'invalid-message',
    message: 'Event runtime request does not match the wire schema.',
    protocolVersion: 1,
    status: 'error',
  });
  try {
    await writeFile(`${endpoint}.lock`, '');
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: [],
    });
    expect(report.endpoints.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: endpoint, runtime: { status: 'unsupported' }, state: 'live' }),
      expect.objectContaining({ path: `${endpoint}.lock`, state: 'live' }),
    ]));
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7317', severity: 'info' }),
    ]));
    expect(report.endpoints.summary).toMatchObject({ live: 1, staleLocks: 0, staleSockets: 0 });
  } finally {
    await close(server);
    await fixture.cleanup();
  }
});

it('reports runtime identity from a live status endpoint', async () => {
  const fixture = await temporaryDoctor();
  const endpoint = join(fixture.endpointDirectory, 'event-identity.sock');
  const server = await listen(endpoint, {
    kind: 'status',
    protocolVersion: 1,
    runtime: {
      artifactEpoch: 'epoch-a',
      availability: 'available',
      instanceId: 'runtime-a',
      pid: 1234,
    },
    status: 'ok',
  });
  try {
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: [],
    });
    expect(report.endpoints.findings).toEqual([
      expect.objectContaining({
        path: endpoint,
        runtime: {
          artifactEpoch: 'epoch-a',
          availability: 'available',
          instanceId: 'runtime-a',
          pid: 1234,
          status: 'available',
        },
        state: 'live',
      }),
    ]);
  } finally {
    await close(server);
    await fixture.cleanup();
  }
});

it('bounds a silent runtime status probe', async () => {
  const fixture = await temporaryDoctor();
  const endpoint = join(fixture.endpointDirectory, 'event-silent.sock');
  const server = await listen(endpoint);
  try {
    const started = Date.now();
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: [],
    });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(report.endpoints.findings).toEqual([
      expect.objectContaining({ runtime: { status: 'failed' }, state: 'live' }),
    ]);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7318', severity: 'error' }),
    ]));
  } finally {
    await close(server);
    await fixture.cleanup();
  }
});

it('bounds a directory of silent runtimes as a whole by probing endpoints concurrently', async () => {
  const fixture = await temporaryDoctor();
  // Twice the concurrency cap would still be far below the serial cost:
  // probed one at a time these would take at least `count` seconds.
  const count = 6;
  const endpoints = Array.from({ length: count }, (_, index) =>
    join(fixture.endpointDirectory, `event-silent-${String(index)}.sock`));
  const servers = await Promise.all(endpoints.map((endpoint) => listen(endpoint)));
  try {
    expect(count).toBeLessThanOrEqual(doctorEndpointProbeConcurrency);
    const started = Date.now();
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: [],
    });
    const elapsed = Date.now() - started;
    // One batch of 1 s status-probe timeouts plus slack, not N seconds.
    expect(elapsed).toBeLessThan(3_500);
    // Every silent endpoint is still reported, in directory order.
    expect(report.endpoints.findings.map((finding) => finding.path)).toEqual([...endpoints].sort((left, right) => left.localeCompare(right)));
    expect(report.endpoints.findings).toEqual(endpoints.map(() =>
      expect.objectContaining({ runtime: { status: 'failed' }, state: 'live' })));
    expect(report.diagnostics.filter((entry) => entry.code === 'AB7318')).toHaveLength(count);
    expect(report.endpoints.summary).toMatchObject({ live: count, staleLocks: 0, staleSockets: 0 });
  } finally {
    await Promise.all(servers.map((server) => close(server)));
    await fixture.cleanup();
  }
});

it('reports stale sockets and stale locks as warnings', async () => {
  const fixture = await temporaryDoctor();
  const staleSocket = join(fixture.endpointDirectory, 'event-stale.sock');
  const staleLock = join(fixture.endpointDirectory, 'event-claimed.sock.lock');
  try {
    await mkdir(fixture.endpointDirectory, { recursive: true });
    // Match event-ipc stale-endpoint fixtures: a regular file at the socket
    // path refuses connections and is classified as stale by Doctor.
    await writeFile(staleSocket, 'stale socket');
    await writeFile(staleLock, '');
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: [],
    });
    expect(report.endpoints.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: staleSocket, state: 'stale-socket' }),
      expect.objectContaining({ path: staleLock, state: 'stale-lock' }),
    ]));
    expect(report.endpoints.summary.staleLocks).toBe(1);
    expect(report.endpoints.summary.staleSockets).toBe(1);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB7314',
        message: expect.stringMatching(/no valid owner record/u),
        severity: 'warning',
      }),
      expect.objectContaining({
        code: 'AB7314',
        message: expect.stringMatching(/refuses connections and is stale/u),
        severity: 'warning',
      }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('reports a lock with a provably dead owner as a stale lock warning', async () => {
  const fixture = await temporaryDoctor();
  const staleLock = join(fixture.endpointDirectory, 'event-dead-claim.sock.lock');
  const deadPid = await findDeadPid();
  try {
    await mkdir(fixture.endpointDirectory, { recursive: true });
    await writeFile(staleLock, `${JSON.stringify({ pid: deadPid })}\n`);
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: [],
    });
    expect(report.endpoints.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: staleLock, state: 'stale-lock' }),
    ]));
    expect(report.endpoints.summary.staleLocks).toBe(1);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB7314',
        message: expect.stringMatching(new RegExp(`owner pid ${deadPid} is provably dead`, 'u')),
        severity: 'warning',
      }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('reports a lock held by a live owner as live with an info diagnostic', async () => {
  const fixture = await temporaryDoctor();
  const liveLock = join(fixture.endpointDirectory, 'event-live-claim.sock.lock');
  try {
    await mkdir(fixture.endpointDirectory, { recursive: true });
    await writeFile(liveLock, `${JSON.stringify({ pid: process.pid })}\n`);
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: [],
    });
    expect(report.endpoints.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: liveLock, state: 'live' }),
    ]));
    expect(report.endpoints.summary).toMatchObject({ staleLocks: 0 });
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB7314',
        message: expect.stringMatching(new RegExp(`held by pid ${process.pid}`, 'u')),
        severity: 'info',
      }),
    ]));
    expect(report.diagnostics.some((entry) => entry.severity === 'warning')).toBe(false);
    expect(report.diagnostics.some((entry) => entry.severity === 'error')).toBe(false);
    expect(report.summary).toMatchObject({ errors: 0, warnings: 0, infos: 1 });
  } finally {
    await fixture.cleanup();
  }
});

it('reports a lock with an invalid owner shape as a stale lock warning', async () => {
  const fixture = await temporaryDoctor();
  const invalidLock = join(fixture.endpointDirectory, 'event-invalid-claim.sock.lock');
  try {
    await mkdir(fixture.endpointDirectory, { recursive: true });
    await writeFile(invalidLock, `${JSON.stringify({ pid: -1 })}\n`);
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: [],
    });
    expect(report.endpoints.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: invalidLock, state: 'stale-lock' }),
    ]));
    expect(report.endpoints.summary.staleLocks).toBe(1);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB7314',
        message: expect.stringMatching(/no valid owner record/u),
        severity: 'warning',
      }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

it('treats an absent endpoint directory as a healthy empty scan', async () => {
  const fixture = await temporaryDoctor();
  try {
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: [],
    });
    expect(report.endpoints).toMatchObject({
      findings: [],
      status: 'healthy',
      summary: { live: 0, staleLocks: 0, staleSockets: 0 },
    });
  } finally {
    await fixture.cleanup();
  }
});

it('derives the same default endpoint directory as eventRuntimeEndpoint', () => {
  expect(doctorEndpointDirectory()).toBe(dirname(eventRuntimeEndpoint('probe')));
});

const cliReport = (
  diagnostics: DoctorReport['diagnostics'] = [],
  hosts: DoctorReport['hosts'] = [],
): DoctorReport => Object.freeze({
  diagnostics,
  endpoints: Object.freeze({
    diagnostics: Object.freeze([]),
    directory: '/tmp/endpoints',
    findings: Object.freeze([]),
    status: 'healthy',
    summary: Object.freeze({ live: 0, staleLocks: 0, staleSockets: 0 }),
  }),
  hosts,
  summary: Object.freeze({
    errors: diagnostics.filter((entry) => entry.severity === 'error').length,
    infos: diagnostics.filter((entry) => entry.severity === 'info').length,
    warnings: diagnostics.filter((entry) => entry.severity === 'warning').length,
  }),
});

it('prints human Doctor output and exits zero for warnings', async () => {
  const terminal = captureCliTerminal();
  const report = cliReport([{
    code: 'AB7314',
    message: 'Stale endpoint.',
    recovery: 'Remove it manually.',
    severity: 'warning',
  }], [{
    diagnostics: Object.freeze([]),
    host: 'cursor',
    inventory: Object.freeze({ findings: Object.freeze([]), status: 'known' }),
    probe: Object.freeze({ evidence: 'directory', status: 'available' }),
    receipts: Object.freeze([]),
  }]);
  const code = await runCli(['doctor'], terminal.output, { runDoctor: async () => report });
  expect(code).toBe(0);
  expect(terminal.stdout()).toContain('cursor: available (directory)');
  expect(terminal.stdout()).toContain('AB7314: Stale endpoint.');
  expect(terminal.stdout()).toContain('Recovery: Remove it manually.');
  expect(terminal.stdout()).toContain('Doctor summary: 0 error(s), 1 warning(s), 0 info(s)');
});

it('prints one stable JSON report, forwards filters, and gates only errors', async () => {
  const terminal = captureCliTerminal();
  const calls: unknown[] = [];
  const report = cliReport([{
    code: 'AB7301',
    message: 'Probe failed.',
    recovery: 'Repair the host CLI.',
    severity: 'error',
  }]);
  const code = await runCli(
    ['doctor', '--host', 'claude', '--host', 'cursor', '--from', '/bundle', '--json'],
    terminal.output,
    {
      runDoctor: async (options) => {
        calls.push(options);
        return report;
      },
    },
  );
  expect(code).toBe(1);
  expect(calls).toEqual([{ from: '/bundle', hosts: ['claude', 'cursor'] }]);
  expect(JSON.parse(terminal.stdout())).toEqual(report);
  expect(terminal.stdout().trim()).toBe(JSON.stringify(JSON.parse(terminal.stdout())));
});

it('rejects an invalid Doctor host as a usage error', async () => {
  const terminal = captureCliTerminal();
  const code = await runCli(['doctor', '--host', 'portable'], terminal.output);
  expect(code).toBe(2);
  expect(terminal.stderr()).toContain('Doctor host must be claude, codex, or cursor.');
});

const writeHookedCursorPlugin = async (pluginRoot: string, version = '1.2.3'): Promise<void> => {
  await writeJson(join(pluginRoot, '.cursor-plugin/plugin.json'), {
    description: 'Hooked doctor fixture.',
    hooks: './hooks/hooks.json',
    name: 'hooked-fixture',
    version,
  });
  await writeJson(join(pluginRoot, 'hooks/hooks.json'), {
    hooks: {
      postToolUse: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/after-tool.mjs"', matcher: '^Shell$' }],
      preToolUse: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/before-tool.mjs"', matcher: '^Shell$' }],
      stop: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/stop.mjs"' }],
    },
    version: 1,
  });
  await mkdir(join(pluginRoot, 'hooks'), { recursive: true });
  for (const script of ['after-tool.mjs', 'before-tool.mjs', 'stop.mjs']) {
    await writeFile(join(pluginRoot, 'hooks', script), 'export {};\n');
  }
};

it('proves plugin-scoped Cursor hook registration and flags stale, missing, and duplicate delivery', async () => {
  const fixture = await temporaryDoctor();
  const pluginRoot = join(fixture.home, '.cursor', 'plugins', 'local', 'hooked-fixture');
  const doctor = (options: { readonly platform?: NodeJS.Platform } = {}) =>
    runDoctor({ ...options, endpointDirectory: fixture.endpointDirectory, home: fixture.home, hosts: ['cursor'] });
  const hookDiagnostics = (report: DoctorReport) => report.diagnostics.filter((entry) => entry.code === 'AB7322' || entry.code === 'AB7323');
  try {
    await writeHookedCursorPlugin(pluginRoot);

    const registered = await doctor();
    expect(hostReport(registered, 'cursor').inventory.findings).toEqual([expect.objectContaining({
      entry: 'hooked-fixture',
      hooks: {
        commands: 3,
        duplicates: [],
        events: ['postToolUse', 'preToolUse', 'stop'],
        source: join(pluginRoot, 'hooks/hooks.json'),
        state: 'registered',
      },
      state: 'installed',
    })]);
    expect(hookDiagnostics(registered)).toEqual([expect.objectContaining({ code: 'AB7322', severity: 'info' })]);
    expect(hookDiagnostics(registered)[0]?.message).toContain('postToolUse, preToolUse, stop');

    // Prompt hooks are a valid pinned-schema shape; they register without a script-path check.
    await writeJson(join(pluginRoot, 'hooks/hooks.json'), {
      hooks: {
        postToolUse: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/after-tool.mjs"', matcher: '^Shell$' }],
        preToolUse: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/before-tool.mjs"', matcher: '^Shell$', type: 'command' }],
        stop: [{ prompt: 'Did the agent finish every task?', type: 'prompt' }],
      },
      version: 1,
    });
    const prompted = await doctor();
    expect(hostReport(prompted, 'cursor').inventory.findings[0]?.hooks).toMatchObject({
      commands: 2,
      events: ['postToolUse', 'preToolUse', 'stop'],
      state: 'registered',
    });
    expect(hookDiagnostics(prompted)).toEqual([expect.objectContaining({ code: 'AB7322', severity: 'info' })]);
    expect(hookDiagnostics(prompted)[0]?.message).toContain('2 command(s), 1 prompt hook(s)');
    await writeJson(join(pluginRoot, 'hooks/hooks.json'), {
      hooks: { stop: [{ type: 'prompt' }] },
      version: 1,
    });
    expect(hostReport(await doctor(), 'cursor').inventory.findings[0]?.hooks).toMatchObject({ state: 'stale' });
    // Shapes the pinned hooks.schema.json rejects (unknown event, extra entry property) never count as registered.
    await writeJson(join(pluginRoot, 'hooks/hooks.json'), {
      hooks: { onToolUse: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/after-tool.mjs"' }] },
      version: 1,
    });
    expect(hostReport(await doctor(), 'cursor').inventory.findings[0]?.hooks).toMatchObject({ state: 'stale' });
    await writeJson(join(pluginRoot, 'hooks/hooks.json'), {
      hooks: { stop: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/stop.mjs"', unexpected: true }] },
      version: 1,
    });
    expect(hostReport(await doctor(), 'cursor').inventory.findings[0]?.hooks).toMatchObject({ state: 'stale' });
    await writeHookedCursorPlugin(pluginRoot);

    // A sibling plugin whose path shares this plugin's path as a prefix must not count as duplicate delivery.
    await writeJson(join(fixture.home, '.cursor', 'hooks.json'), {
      hooks: { preToolUse: [{ command: `node ${pluginRoot}-tools/hooks/before-tool.mjs` }] },
      version: 1,
    });
    const sibling = await doctor();
    expect(hostReport(sibling, 'cursor').inventory.findings[0]?.hooks).toMatchObject({ duplicates: [], state: 'registered' });
    expect(hookDiagnostics(sibling).map((entry) => entry.code)).toEqual(['AB7322']);

    // User hooks run from ~/.cursor, so a relative command that lands inside the plugin is duplicate delivery too.
    await writeJson(join(fixture.home, '.cursor', 'hooks.json'), {
      hooks: { stop: [{ command: 'node ./plugins/local/hooked-fixture/hooks/stop.mjs' }] },
      version: 1,
    });
    const relative = await doctor();
    expect(hostReport(relative, 'cursor').inventory.findings[0]?.hooks).toMatchObject({
      duplicates: ['node ./plugins/local/hooked-fixture/hooks/stop.mjs'],
    });
    expect(hookDiagnostics(relative).map((entry) => entry.code)).toEqual(['AB7322', 'AB7323']);
    // Windows-relative spellings resolve the same way.
    await writeJson(join(fixture.home, '.cursor', 'hooks.json'), {
      hooks: { stop: [{ command: 'node .\\plugins\\local\\hooked-fixture\\hooks\\stop.mjs' }] },
      version: 1,
    });
    expect(hostReport(await doctor(), 'cursor').inventory.findings[0]?.hooks).toMatchObject({
      duplicates: ['node .\\plugins\\local\\hooked-fixture\\hooks\\stop.mjs'],
    });
    // A leading shell assignment is not the command word.
    await writeJson(join(fixture.home, '.cursor', 'hooks.json'), {
      hooks: { stop: [{ command: 'NODE_ENV=production node ./plugins/local/hooked-fixture/hooks/stop.mjs' }] },
      version: 1,
    });
    expect(hostReport(await doctor(), 'cursor').inventory.findings[0]?.hooks).toMatchObject({
      duplicates: ['NODE_ENV=production node ./plugins/local/hooked-fixture/hooks/stop.mjs'],
    });
    // On Windows the filesystem is case-insensitive, so a differently cased spelling still runs the plugin's file.
    const upperCased = `node ${join(pluginRoot, 'hooks/before-tool.mjs').toUpperCase()}`;
    await writeJson(join(fixture.home, '.cursor', 'hooks.json'), {
      hooks: { preToolUse: [{ command: upperCased }] },
      version: 1,
    });
    expect(hostReport(await doctor({ platform: 'win32' }), 'cursor').inventory.findings[0]?.hooks).toMatchObject({
      duplicates: [upperCased],
    });
    expect(hostReport(await doctor({ platform: 'linux' }), 'cursor').inventory.findings[0]?.hooks).toMatchObject({ duplicates: [] });
    // A plugin-local path passed as data to an unrelated script is not duplicate delivery.
    await writeJson(join(fixture.home, '.cursor', 'hooks.json'), {
      hooks: { stop: [{ command: 'node ./hooks/audit.mjs --output ./plugins/local/hooked-fixture/state/result.json' }] },
      version: 1,
    });
    const dataArgument = await doctor();
    expect(hostReport(dataArgument, 'cursor').inventory.findings[0]?.hooks).toMatchObject({ duplicates: [], state: 'registered' });
    expect(hookDiagnostics(dataArgument).map((entry) => entry.code)).toEqual(['AB7322']);

    await writeJson(join(fixture.home, '.cursor', 'hooks.json'), {
      hooks: { preToolUse: [{ command: `node ${join(pluginRoot, 'hooks/before-tool.mjs')}` }] },
      version: 1,
    });
    const duplicated = await doctor();
    expect(hostReport(duplicated, 'cursor').inventory.findings[0]?.hooks).toMatchObject({
      duplicates: [`node ${join(pluginRoot, 'hooks/before-tool.mjs')}`],
      state: 'registered',
    });
    expect(hookDiagnostics(duplicated).map((entry) => [entry.code, entry.severity])).toEqual([
      ['AB7322', 'info'],
      ['AB7323', 'warning'],
    ]);
    expect(hookDiagnostics(duplicated)[1]?.message).toContain('would run twice');

    await writeFile(join(fixture.home, '.cursor', 'hooks.json'), '{ not json');
    const unparsable = await doctor();
    expect(hookDiagnostics(unparsable)[1]).toMatchObject({ code: 'AB7323', severity: 'warning' });
    expect(hookDiagnostics(unparsable)[1]?.message).toContain('not a valid Cursor hooks document');
    await rm(join(fixture.home, '.cursor', 'hooks.json'));

    // Quoted paths containing whitespace stay one token.
    await mkdir(join(pluginRoot, 'hooks'), { recursive: true });
    await writeFile(join(pluginRoot, 'hooks', 'my hook.mjs'), 'export {};\n');
    await writeJson(join(pluginRoot, 'hooks/hooks.json'), {
      hooks: { stop: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/my hook.mjs" --quiet' }] },
      version: 1,
    });
    expect(hostReport(await doctor(), 'cursor').inventory.findings[0]?.hooks).toMatchObject({ commands: 1, state: 'registered' });

    // Relative scripts passed to an interpreter resolve against the plugin root and are checked too.
    await writeJson(join(pluginRoot, 'hooks/hooks.json'), {
      hooks: { stop: [{ command: 'node ./hooks/gone.mjs --flag' }] },
      version: 1,
    });
    const relativeArgument = await doctor();
    expect(hostReport(relativeArgument, 'cursor').inventory.findings[0]?.hooks).toMatchObject({ state: 'stale' });
    expect(hookDiagnostics(relativeArgument)[0]?.message).toContain(join(pluginRoot, 'hooks/gone.mjs'));

    // Only the executed script is probed: other plugin-relative operands (outputs, config) may not exist yet.
    await writeFile(join(pluginRoot, 'hooks', 'run.mjs'), 'export {};\n');
    await writeJson(join(pluginRoot, 'hooks/hooks.json'), {
      hooks: { stop: [{ command: 'node --no-warnings ./hooks/run.mjs --output ./state/result.json' }] },
      version: 1,
    });
    expect(hostReport(await doctor(), 'cursor').inventory.findings[0]?.hooks).toMatchObject({ commands: 1, state: 'registered' });

    // Value-taking interpreter options do not hide the entry script: the preload exists, the script does not.
    await writeFile(join(pluginRoot, 'hooks', 'preload.cjs'), 'module.exports = {};\n');
    await writeJson(join(pluginRoot, 'hooks/hooks.json'), {
      hooks: { stop: [{ command: 'node --require ./hooks/preload.cjs --title=hook ./hooks/gone.mjs' }] },
      version: 1,
    });
    const optionOperand = await doctor();
    expect(hostReport(optionOperand, 'cursor').inventory.findings[0]?.hooks).toMatchObject({ state: 'stale' });
    expect(hookDiagnostics(optionOperand)[0]?.message).toContain(join(pluginRoot, 'hooks/gone.mjs'));

    // Bare relative operands resolve against the plugin root too (pinned schema: relative to the hook source root),
    // and PowerShell's -File operand is the entry script.
    for (const command of [
      'node hooks/gone.mjs',
      'pwsh -NoProfile -File hooks/gone.mjs',
      'PowerShell.EXE -NoProfile -EXECUTIONPOLICY Bypass -File hooks/gone.mjs',
      '/usr/bin/env node ./hooks/gone.mjs',
      'NODE_ENV=production node hooks/gone.mjs',
      'A=1 B=2 /usr/bin/env node ./hooks/gone.mjs',
      'bun run "${CURSOR_PLUGIN_ROOT}/hooks/gone.mjs"',
      'deno run -A ./hooks/gone.mjs',
      'env FOO=1 -u BAR node hooks/gone.mjs',
      'Node.exe "${CURSOR_PLUGIN_ROOT}\\hooks\\gone.mjs"',
      'hooks/gone.mjs --flag',
    ]) {
      await writeJson(join(pluginRoot, 'hooks/hooks.json'), { hooks: { stop: [{ command }] }, version: 1 });
      const bareRelative = await doctor();
      expect(hostReport(bareRelative, 'cursor').inventory.findings[0]?.hooks).toMatchObject({ state: 'stale' });
      expect(hookDiagnostics(bareRelative)[0]?.message).toContain(join(pluginRoot, 'hooks/gone.mjs'));
    }
    // A bare executable word is a PATH lookup, not a plugin file.
    await writeJson(join(pluginRoot, 'hooks/hooks.json'), { hooks: { stop: [{ command: 'gone-tool --flag hooks/gone.mjs' }] }, version: 1 });
    expect(hostReport(await doctor(), 'cursor').inventory.findings[0]?.hooks).toMatchObject({ commands: 1, state: 'registered' });

    // Inline source runs no script file, so there is nothing under the plugin root to probe.
    for (const command of ['node -e "process.exit(0)" ./hooks/gone.mjs', 'PowerShell.EXE -COMMAND "Write-Output ok"']) {
      await writeJson(join(pluginRoot, 'hooks/hooks.json'), { hooks: { stop: [{ command }] }, version: 1 });
      expect(hostReport(await doctor(), 'cursor').inventory.findings[0]?.hooks).toMatchObject({ commands: 1, state: 'registered' });
    }

    // A hook target that traverses a regular file (ENOTDIR) is reported stale rather than aborting Doctor.
    await writeJson(join(pluginRoot, 'hooks/hooks.json'), {
      hooks: { stop: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/stop.mjs/child.mjs"' }] },
      version: 1,
    });
    const traversesFile = await doctor();
    expect(hostReport(traversesFile, 'cursor').inventory.findings[0]?.hooks).toMatchObject({ state: 'stale' });
    expect(hookDiagnostics(traversesFile)[0]?.message).toContain('stop.mjs/child.mjs');
    await writeHookedCursorPlugin(pluginRoot);

    await rm(join(pluginRoot, 'hooks', 'stop.mjs'));
    const stale = await doctor();
    expect(hostReport(stale, 'cursor').inventory.findings[0]?.hooks).toMatchObject({ state: 'stale' });
    expect(hookDiagnostics(stale)).toEqual([expect.objectContaining({ code: 'AB7322', severity: 'error' })]);
    expect(hookDiagnostics(stale)[0]?.message).toContain('stop.mjs');

    await rm(join(pluginRoot, 'hooks', 'hooks.json'));
    const missing = await doctor();
    expect(hostReport(missing, 'cursor').inventory.findings[0]?.hooks).toMatchObject({ commands: 0, events: [], state: 'missing' });
    expect(hookDiagnostics(missing)).toEqual([expect.objectContaining({ code: 'AB7322', severity: 'error' })]);
    expect(hookDiagnostics(missing)[0]?.message).toContain('is missing');

    // A hooks document that is not a regular file (a FIFO would block `readFile` forever) is stale, not a hang —
    // both at the pinned `hooks/hooks.json` path and at a manifest-declared custom path.
    if (process.platform !== 'win32') {
      const mkfifo = (path: string) => new Promise<void>((resolvePromise, reject) => {
        const child = spawn('mkfifo', [path], { stdio: 'ignore' });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`mkfifo exited ${code}`))));
      });
      await mkfifo(join(pluginRoot, 'hooks', 'hooks.json'));
      const fifo = await doctor();
      expect(hostReport(fifo, 'cursor').inventory.findings[0]?.hooks).toMatchObject({ commands: 0, state: 'stale' });
      expect(hookDiagnostics(fifo)).toEqual([expect.objectContaining({ code: 'AB7322', severity: 'error' })]);
      await rm(join(pluginRoot, 'hooks', 'hooks.json'));
      await writeJson(join(pluginRoot, '.cursor-plugin/plugin.json'), {
        description: 'Hooked doctor fixture.',
        hooks: 'custom-hooks.json',
        name: 'hooked-fixture',
        version: '1.2.3',
      });
      await mkfifo(join(pluginRoot, 'custom-hooks.json'));
      const customFifo = await doctor();
      expect(hostReport(customFifo, 'cursor').inventory.findings[0]?.hooks).toMatchObject({ commands: 0, state: 'stale' });
      expect(hookDiagnostics(customFifo)).toEqual([expect.objectContaining({ code: 'AB7322', severity: 'error' })]);
    }
  } finally {
    await fixture.cleanup();
  }
});

/**
 * The unified `plugin` target's Cursor view: `.cursor-plugin/plugin.json` points at the Cursor-format
 * `hooks/hooks-cursor.json` while the Claude/Codex-format `hooks/hooks.json` sits at Cursor's
 * folder-discovery default (#438).
 */
const writeUnifiedBundleCursorView = async (root: string): Promise<void> => {
  await writeJson(join(root, '.cursor-plugin/plugin.json'), {
    description: 'Unified bundle fixture.',
    hooks: './hooks/hooks-cursor.json',
    name: 'unified-fixture',
    version: '0.3.5',
  });
  await writeJson(join(root, '.claude-plugin/plugin.json'), {
    description: 'Unified bundle fixture.',
    name: 'unified-fixture',
    version: '0.3.5',
  });
  await writeJson(join(root, 'hooks/hooks.json'), {
    hooks: {
      PreToolUse: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/before-tool.mjs"', type: 'command' }], matcher: 'Bash' }],
      SessionStart: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"', type: 'command' }] }],
      Stop: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/stop.mjs"', type: 'command' }] }],
    },
  });
  await writeJson(join(root, 'hooks/hooks-cursor.json'), {
    hooks: {
      preToolUse: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/before-tool.cursor.mjs"', matcher: '^Shell$' }],
      sessionStart: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/session-start.cursor.mjs"' }],
      stop: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/stop.cursor.mjs"' }],
    },
    version: 1,
  });
  for (const script of ['before-tool', 'session-start', 'stop']) {
    await writeFile(join(root, 'hooks', `${script}.mjs`), 'export {};\n');
    await writeFile(join(root, 'hooks', `${script}.cursor.mjs`), 'export {};\n');
  }
};

it('validates the hooks document the Cursor manifest names for an installed unified bundle (#438)', async () => {
  const fixture = await temporaryDoctor();
  const pluginRoot = join(fixture.home, '.cursor', 'plugins', 'local', 'unified-fixture');
  try {
    await writeUnifiedBundleCursorView(pluginRoot);

    const report = await runDoctor({ endpointDirectory: fixture.endpointDirectory, home: fixture.home, hosts: ['cursor'] });

    expect(report.diagnostics.filter((entry) => entry.code === 'AB7320')).toEqual([]);
    expect(report.diagnostics.filter((entry) => entry.message.includes('AB6027'))).toEqual([]);
    expect(hostReport(report, 'cursor').inventory.findings).toEqual([expect.objectContaining({
      entry: 'unified-fixture',
      hooks: {
        commands: 3,
        duplicates: [],
        events: ['preToolUse', 'sessionStart', 'stop'],
        source: join(pluginRoot, 'hooks/hooks-cursor.json'),
        state: 'registered',
      },
      state: 'installed',
    })]);
    expect(report.diagnostics.filter((entry) => entry.code === 'AB7322')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('preToolUse, sessionStart, stop'), severity: 'info' }),
    ]);

    // The static validator and the registration proof agree on which file counts: breaking the named
    // document is reported under its own path, while the Claude-format default stays out of the report.
    await writeJson(join(pluginRoot, 'hooks/hooks-cursor.json'), { hooks: { Stop: [{ command: 'true' }] }, version: 1 });
    const broken = await runDoctor({ endpointDirectory: fixture.endpointDirectory, home: fixture.home, hosts: ['cursor'] });
    const staticErrors = broken.diagnostics.filter((entry) => entry.code === 'AB7320');
    expect(staticErrors.length).toBeGreaterThan(0);
    for (const entry of staticErrors) {
      expect(entry.message).toContain('AB6027: hooks/hooks-cursor.json');
      expect(entry.severity).toBe('error');
    }
    expect(hostReport(broken, 'cursor').inventory.findings).toEqual([expect.objectContaining({
      hooks: expect.objectContaining({ state: 'stale' }),
      state: 'corrupt',
    })]);
    expect(broken.diagnostics.filter((entry) => entry.code === 'AB7322')).toEqual([
      expect.objectContaining({ severity: 'error' }),
    ]);
  } finally {
    await fixture.cleanup();
  }
});

it('accepts --from unified bundle Cursor bytes whose manifest names hooks/hooks-cursor.json (#438)', async () => {
  const fixture = await temporaryDoctor();
  const bundle = join(fixture.root, 'bundle-plugin');
  try {
    await writeUnifiedBundleCursorView(bundle);

    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      from: bundle,
      home: fixture.home,
      hosts: ['cursor'],
    });

    expect(report.diagnostics.filter((entry) => entry.code === 'AB7319')).toEqual([]);
    expect(hostReport(report, 'cursor').bundle).toMatchObject({ name: 'unified-fixture', version: '0.3.5' });
    expect(hostReport(report, 'cursor').bundle?.state).not.toBe('corrupt');
  } finally {
    await fixture.cleanup();
  }
});

it('applies Cursor folder discovery of hooks/hooks.json only when the manifest declares no hooks field', async () => {
  const fixture = await temporaryDoctor();
  const pluginRoot = join(fixture.home, '.cursor', 'plugins', 'local', 'discovered-fixture');
  try {
    await writeJson(join(pluginRoot, '.cursor-plugin/plugin.json'), { name: 'discovered-fixture', version: '1.0.0' });
    await writeJson(join(pluginRoot, 'hooks/hooks.json'), {
      hooks: { stop: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/stop.mjs"' }] },
      version: 1,
    });
    await writeFile(join(pluginRoot, 'hooks', 'stop.mjs'), 'export {};\n');

    const report = await runDoctor({ endpointDirectory: fixture.endpointDirectory, home: fixture.home, hosts: ['cursor'] });

    expect(report.diagnostics.filter((entry) => entry.code === 'AB7320')).toEqual([]);
    expect(hostReport(report, 'cursor').inventory.findings[0]?.hooks).toEqual({
      commands: 1,
      duplicates: [],
      events: ['stop'],
      source: join(pluginRoot, 'hooks/hooks.json'),
      state: 'registered',
    });
    expect(report.diagnostics.filter((entry) => entry.code === 'AB7322')).toEqual([
      expect.objectContaining({ severity: 'info' }),
    ]);
  } finally {
    await fixture.cleanup();
  }
});

it('reports a plugin without declared hooks as having no hook registration', async () => {
  const fixture = await temporaryDoctor();
  try {
    const bundle = await createBundle(fixture.root, 'cursor');
    await cp(bundle, join(fixture.home, '.cursor', 'plugins', 'local', 'doctor-fixture'), { recursive: true });

    const report = await runDoctor({ endpointDirectory: fixture.endpointDirectory, home: fixture.home, hosts: ['cursor'] });

    expect(hostReport(report, 'cursor').inventory.findings[0]?.hooks).toEqual({
      commands: 0,
      duplicates: [],
      events: [],
      state: 'none',
    });
    expect(report.diagnostics.filter((entry) => entry.code === 'AB7322')).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

it('tracks staged Cursor marketplaces from staged to imported', async () => {
  const fixture = await temporaryDoctor();
  const repo = join(fixture.home, '.cursor', 'agent-bundle', 'marketplaces', 'doctor-fixture');
  const commit = 'a'.repeat(40);
  try {
    const bundle = await createBundle(fixture.root, 'cursor');
    await cp(bundle, join(repo, 'plugins', 'doctor-fixture'), { recursive: true });
    await writeJson(join(repo, '.cursor-plugin/marketplace.json'), {
      name: 'doctor-fixture-marketplace',
      owner: { name: 'doctor-fixture' },
      plugins: [{ name: 'doctor-fixture', source: 'plugins/doctor-fixture' }],
    });
    await mkdir(join(repo, '.git', 'refs', 'heads'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(repo, '.git', 'refs', 'heads', 'main'), `${commit}\n`);
    // Doctor verifies the staged repository through git (object exists, tree clean); the fixture is not a
    // real repository, so answer those read-only probes here.
    const gitState = { dirty: false, object: true };
    const gitCalls: string[][] = [];
    const fakeGit: DoctorCommandRunner = async (request) => {
      expect(request.executable).toBe('git');
      expect(request.cwd).toBe(repo);
      gitCalls.push([...request.args]);
      if (request.args[0] === 'cat-file') {
        expect(request.args).toEqual(['cat-file', '-e', `${commit}^{commit}`]);
        return commandResult(gitState.object ? {} : { exitCode: 128, stderr: 'fatal: Not a valid object name' });
      }
      expect(request.args).toEqual(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--ignored=matching']);
      return commandResult({ stdout: gitState.dirty ? '?? plugins/doctor-fixture/extra.txt\n' : '' });
    };
    const doctor = () => runDoctor({ commandRunner: fakeGit, endpointDirectory: fixture.endpointDirectory, from: bundle, home: fixture.home, hosts: ['cursor'] });

    const staged = await doctor();
    expect(gitCalls.map((args) => args.includes('cat-file') ? 'cat-file' : 'status')).toEqual(['cat-file', 'status', 'cat-file', 'status']);
    const stagedFinding = {
      commit,
      entry: 'doctor-fixture',
      manifest: '.cursor-plugin/marketplace.json',
      marketplace: 'doctor-fixture-marketplace',
      name: 'doctor-fixture',
      path: repo,
      version: '1.2.3',
    };
    expect(hostReport(staged, 'cursor').inventory.findings).toEqual([{ ...stagedFinding, state: 'unregistered' }]);
    expect(hostReport(staged, 'cursor').bundle).toMatchObject({ commit, marketplace: 'doctor-fixture-marketplace', path: repo, state: 'unregistered' });
    const stagedDiagnostics = staged.diagnostics.filter((entry) => entry.code === 'AB7324');
    expect(stagedDiagnostics.map((entry) => entry.severity)).toEqual(['warning', 'warning']);
    expect(stagedDiagnostics[0]?.recovery).toContain('Add Plugins from Local Repository');
    expect(staged.diagnostics.filter((entry) => entry.code === 'AB7307')).toEqual([]);

    // The same plugin cached from a different marketplace does not prove this staged repository was imported.
    await writeJson(
      join(fixture.home, '.cursor', 'plugins', 'cache', 'some-other-marketplace', 'doctor-fixture', commit, '.cursor-plugin', 'plugin.json'),
      { name: 'doctor-fixture', version: '1.2.3' },
    );
    const foreign = await doctor();
    expect(hostReport(foreign, 'cursor').inventory.findings).toEqual([{ ...stagedFinding, state: 'unregistered' }]);

    // A cache directory without Cursor's `.cache-complete` receipt is a half-written copy, not an import.
    const cacheRoot = join(fixture.home, '.cursor', 'plugins', 'cache', 'doctor-fixture-marketplace', 'doctor-fixture');
    const cached = join(cacheRoot, commit);
    await writeJson(join(cached, '.cursor-plugin', 'plugin.json'), { name: 'doctor-fixture', version: '1.2.3' });
    const incomplete = await doctor();
    expect(hostReport(incomplete, 'cursor').inventory.findings).toEqual([{ ...stagedFinding, state: 'unregistered' }]);

    // A receipted copy from an earlier staging commit, or a malformed cache entry, does not prove this commit was imported.
    const previous = join(cacheRoot, 'b'.repeat(40));
    await writeJson(join(previous, '.cursor-plugin', 'plugin.json'), { name: 'doctor-fixture', version: '1.2.3' });
    await writeFile(join(previous, '.cache-complete'), '');
    await writeFile(join(cacheRoot, 'not-a-directory'), 'stray');
    const staleReceipt = await doctor();
    expect(hostReport(staleReceipt, 'cursor').inventory.findings).toEqual([{ ...stagedFinding, state: 'unregistered' }]);

    await writeFile(join(cached, '.cache-complete'), '');
    const imported = await doctor();
    expect(hostReport(imported, 'cursor').inventory.findings).toEqual([{ ...stagedFinding, state: 'registered' }]);
    expect(hostReport(imported, 'cursor').bundle?.state).toBe('registered');
    expect(imported.diagnostics.filter((entry) => entry.code === 'AB7324').map((entry) => entry.severity)).toEqual(['info', 'info']);

    // A stray regular file in the staging root is not a staged marketplace and must not abort Doctor.
    await writeFile(join(fixture.home, '.cursor', 'agent-bundle', 'marketplaces', 'README.txt'), 'notes\n');
    expect(hostReport(await doctor(), 'cursor').inventory.findings).toEqual([{ ...stagedFinding, state: 'registered' }]);

    // Cursor imports the commit: a working tree that differs from HEAD (even when it matches the source bundle)
    // is corrupt for both the inventory and `--from`, never "registered".
    gitState.dirty = true;
    const dirty = await doctor();
    expect(hostReport(dirty, 'cursor').inventory.findings).toEqual([{ ...stagedFinding, state: 'corrupt' }]);
    expect(hostReport(dirty, 'cursor').bundle).toMatchObject({ path: repo, state: 'corrupt' });
    expect(dirty.diagnostics.filter((entry) => entry.code === 'AB7324')[0]?.message).toContain('differs from committed HEAD');
    gitState.dirty = false;

    // A well-formed HEAD SHA whose commit object is absent cannot be imported either.
    gitState.object = false;
    const missingObject = await doctor();
    expect(hostReport(missingObject, 'cursor').inventory.findings).toEqual([{ ...stagedFinding, state: 'corrupt' }]);
    expect(missingObject.diagnostics.filter((entry) => entry.code === 'AB7324')[0]?.message).toContain('commit object does not exist');
    gitState.object = true;
    expect(hostReport(await doctor(), 'cursor').inventory.findings).toEqual([{ ...stagedFinding, state: 'registered' }]);

    await writeFile(join(repo, 'plugins', 'doctor-fixture', 'payload.txt'), 'changed\n');
    const drifted = await doctor();
    expect(hostReport(drifted, 'cursor').bundle?.state).toBe('drifted');
    const driftedDiagnostic = drifted.diagnostics.filter((entry) => entry.code === 'AB7308')[0];
    expect(driftedDiagnostic?.message).toContain('Staged Cursor marketplace copy');
    // Cursor already imported this staging: drift of the staged bytes does not un-import the copy Cursor holds,
    // so the lifecycle stays registered, the message says the imported plugin is the older content, and the
    // recovery is the managed uninstall + reinstall + re-import, not a bare directory removal.
    expect(driftedDiagnostic?.message).toContain('Cursor has imported the staged copy');
    expect(driftedDiagnostic?.recovery).toContain('agent-bundle uninstall cursor --mode marketplace');
    expect(hostReport(drifted, 'cursor').bundle?.lifecycle?.registered).toMatchObject({ status: 'observed', value: true });

    // Without an imported copy the same drift is only a stale staging: not registered, remove and restage.
    await rm(cached, { recursive: true });
    const driftedUnimported = await doctor();
    expect(hostReport(driftedUnimported, 'cursor').bundle?.state).toBe('drifted');
    expect(hostReport(driftedUnimported, 'cursor').bundle?.lifecycle?.registered).toMatchObject({ status: 'observed', value: false });
    expect(driftedUnimported.diagnostics.filter((entry) => entry.code === 'AB7308')[0]?.recovery).toContain('Remove the staged marketplace directory');
    await writeJson(join(cached, '.cursor-plugin', 'plugin.json'), { name: 'doctor-fixture', version: '1.2.3' });
    await writeFile(join(cached, '.cache-complete'), '');

    // A parseable manifest that no longer lists the staged plugin is corrupt even when the cache matches.
    await writeJson(join(repo, '.cursor-plugin/marketplace.json'), {
      name: 'doctor-fixture-marketplace',
      owner: { name: 'doctor-fixture' },
      plugins: [{ name: 'other-plugin', source: 'plugins/other-plugin' }],
    });
    const unlisted = await doctor();
    expect(hostReport(unlisted, 'cursor').inventory.findings).toEqual([expect.objectContaining({ entry: 'doctor-fixture', state: 'corrupt' })]);
    expect(unlisted.diagnostics.filter((entry) => entry.code === 'AB7324')[0]?.message).toContain('not listing doctor-fixture at plugins/doctor-fixture');

    // `doctor --from` must surface the same corrupt state once the staged bytes match the bundle again.
    await cp(bundle, join(repo, 'plugins', 'doctor-fixture'), { force: true, recursive: true });
    const corruptBundle = await doctor();
    expect(hostReport(corruptBundle, 'cursor').bundle?.state).toBe('corrupt');

    // A plugin manifest naming a different plugin than the entry is corrupt even with a valid marketplace entry.
    await writeJson(join(repo, '.cursor-plugin/marketplace.json'), {
      name: 'doctor-fixture-marketplace',
      owner: { name: 'doctor-fixture' },
      plugins: [{ name: 'doctor-fixture', source: 'plugins/doctor-fixture' }],
    });
    const stagedManifest = await readFile(join(repo, 'plugins', 'doctor-fixture', '.cursor-plugin', 'plugin.json'), 'utf8');
    await writeJson(join(repo, 'plugins', 'doctor-fixture', '.cursor-plugin', 'plugin.json'), { name: 'someone-else', version: '1.2.3' });
    const misnamed = await doctor();
    expect(hostReport(misnamed, 'cursor').inventory.findings).toEqual([expect.objectContaining({ entry: 'doctor-fixture', state: 'corrupt' })]);
    expect(misnamed.diagnostics.filter((entry) => entry.code === 'AB7324')[0]?.message).toContain('not named doctor-fixture');
    await writeFile(join(repo, 'plugins', 'doctor-fixture', '.cursor-plugin', 'plugin.json'), stagedManifest);

    // Any other pinned-schema violation in marketplace.json (here an empty owner name) is corrupt too.
    await writeJson(join(repo, '.cursor-plugin/marketplace.json'), {
      name: 'doctor-fixture-marketplace',
      owner: { name: '' },
      plugins: [{ name: 'doctor-fixture', source: 'plugins/doctor-fixture' }],
    });
    const invalidManifest = await doctor();
    expect(hostReport(invalidManifest, 'cursor').inventory.findings).toEqual([expect.objectContaining({ entry: 'doctor-fixture', state: 'corrupt' })]);
    expect(invalidManifest.diagnostics.filter((entry) => entry.code === 'AB7324')[0]?.message).toContain('pinned marketplace schema');
    await writeJson(join(repo, '.cursor-plugin/marketplace.json'), {
      name: 'doctor-fixture-marketplace',
      owner: { name: 'doctor-fixture' },
      plugins: [{ name: 'doctor-fixture', source: 'plugins/doctor-fixture' }],
    });

    // A .git directory whose HEAD cannot be resolved to a commit is not an importable repository.
    await writeFile(join(repo, '.git', 'refs', 'heads', 'main'), 'not-a-sha\n');
    const unbornHead = await doctor();
    expect(hostReport(unbornHead, 'cursor').inventory.findings).toEqual([expect.objectContaining({ entry: 'doctor-fixture', state: 'corrupt' })]);
    expect(unbornHead.diagnostics.filter((entry) => entry.code === 'AB7324')[0]?.message).toContain('no committed Git HEAD');
    await writeFile(join(repo, '.git', 'refs', 'heads', 'main'), `${commit}\n`);
    expect(hostReport(await doctor(), 'cursor').inventory.findings).toEqual([{ ...stagedFinding, state: 'registered' }]);

    // A staged repository whose plugin copy was deleted is corrupt for `--from` too, not "missing".
    await rm(join(repo, 'plugins', 'doctor-fixture'), { recursive: true });
    const gonePlugin = await doctor();
    expect(hostReport(gonePlugin, 'cursor').bundle).toMatchObject({ marketplace: 'doctor-fixture-marketplace', path: repo, state: 'corrupt' });
    expect(gonePlugin.diagnostics.filter((entry) => entry.code === 'AB7307')).toEqual([]);
    expect(gonePlugin.diagnostics.filter((entry) => entry.code === 'AB7324').length).toBeGreaterThan(0);
    await cp(bundle, join(repo, 'plugins', 'doctor-fixture'), { recursive: true });

    await rm(join(repo, '.git'), { recursive: true });
    const corrupt = await doctor();
    expect(hostReport(corrupt, 'cursor').inventory.findings).toEqual([expect.objectContaining({ entry: 'doctor-fixture', state: 'corrupt' })]);
    expect(corrupt.diagnostics.filter((entry) => entry.code === 'AB7324')[0]).toMatchObject({ severity: 'error' });
  } finally {
    await fixture.cleanup();
  }
});
