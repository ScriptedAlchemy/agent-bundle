import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import { runCli } from '../src/cli.ts';
import { eventRuntimeEndpoint } from '../src/events/ipc.ts';
import {
  doctorEndpointDirectory,
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
      writeJson(join(bundle, '.claude-plugin/plugin.json'), { name: 'doctor-fixture', version }),
      writeJson(join(bundle, '.claude-plugin/marketplace.json'), {
        name: 'doctor-fixture-marketplace',
      }),
    ]);
  } else if (host === 'codex') {
    await Promise.all([
      writeJson(join(bundle, '.codex-plugin/plugin.json'), { name: 'doctor-fixture', version }),
      writeJson(join(bundle, '.agents/plugins/marketplace.json'), {
        name: 'doctor-fixture-marketplace',
      }),
    ]);
  } else {
    await writeJson(join(bundle, '.cursor-plugin/plugin.json'), { name: 'doctor-fixture', version });
  }
  return bundle;
};

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
  } finally {
    await fixture.cleanup();
  }
});

it('accepts a versionless Cursor inventory manifest as installed', async () => {
  const fixture = await temporaryDoctor();
  const installRoot = join(fixture.home, '.cursor', 'plugins', 'local');
  try {
    await writeJson(join(installRoot, 'versionless', 'plugin.json'), { name: 'versionless' });
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    const finding = hostReport(report, 'cursor').inventory.findings.find(
      (entry) => entry.entry === 'versionless',
    );
    expect(finding).toMatchObject({
      manifest: 'plugin.json',
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
  const stateRoot = join(pluginRoot, 'state');
  const store = 'project-tasks-0123456789abcdef.sqlite';
  try {
    await Promise.all([
      writeJson(join(pluginRoot, 'plugin.json'), { name: 'stateful', version: '1.0.0' }),
      mkdir(stateRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(stateRoot, store), 'database'),
      writeFile(join(stateRoot, `${store}-wal`), 'wal!'),
      writeFile(join(stateRoot, `${store}-shm`), 'shm'),
      writeFile(join(stateRoot, 'ignore.txt'), 'ignored'),
    ]);

    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: ['cursor'],
    });
    const finding = hostReport(report, 'cursor').inventory.findings.find(
      (entry) => entry.entry === 'stateful',
    );
    expect(finding?.durableState).toMatchObject({
      directory: stateRoot,
      findings: [{
        bytes: 15,
        file: store,
        mtime: expect.any(String),
        path: join(stateRoot, store),
      }],
      status: 'known',
      summary: { bytes: 15, stores: 1 },
    });

    const human: string[] = [];
    const humanCode = await runCli(
      ['doctor'],
      { stdout: { write: (chunk: string) => human.push(chunk) } },
      { runDoctor: async () => report },
    );
    expect(humanCode).toBe(0);
    expect(human.join('')).toContain('durable state: 1 store, 15 B');

    const json: string[] = [];
    await runCli(
      ['doctor', '--json'],
      { stdout: { write: (chunk: string) => json.push(chunk) } },
      { runDoctor: async () => report },
    );
    expect(JSON.parse(json.join('')).hosts[0].inventory.findings[0].durableState).toMatchObject({
      findings: [{ bytes: 15, file: store }],
      summary: { bytes: 15, stores: 1 },
    });
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
    await writeJson(join(pluginRoot, 'plugin.json'), { name: 'blocked-state', version: '1.0.0' });
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

it('reports host-owned Claude and Codex inventories as honestly unknown', async () => {
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

it('reports a Cursor destination without a valid manifest as corrupt', async () => {
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
    expect(hostReport(report, 'cursor').bundle?.state).toBe('corrupt');
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7310', severity: 'error' }),
    ]));
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
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7313', severity: 'info' }),
    ]));
  } finally {
    await fixture.cleanup();
  }
});

const listen = async (path: string): Promise<Server> => {
  await mkdir(dirname(path), { recursive: true });
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(path, resolvePromise);
  });
  return server;
};

const close = (server: Server): Promise<void> => new Promise((resolvePromise, reject) => {
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

it('scans live sockets and a lock with a live sibling without warnings', async () => {
  const fixture = await temporaryDoctor();
  const endpoint = join(fixture.endpointDirectory, 'event-live.sock');
  const server = await listen(endpoint);
  try {
    await writeFile(`${endpoint}.lock`, '');
    const report = await runDoctor({
      endpointDirectory: fixture.endpointDirectory,
      home: fixture.home,
      hosts: [],
    });
    expect(report.endpoints.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: endpoint, state: 'live' }),
      expect.objectContaining({ path: `${endpoint}.lock`, state: 'live' }),
    ]));
    expect(report.endpoints.summary).toMatchObject({ live: 1, staleLocks: 0, staleSockets: 0 });
  } finally {
    await close(server);
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
  const stdout: string[] = [];
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
  }]);
  const code = await runCli(
    ['doctor'],
    { stdout: { write: (chunk: string) => stdout.push(chunk) } },
    { runDoctor: async () => report },
  );
  expect(code).toBe(0);
  expect(stdout.join('')).toContain('cursor: available (directory)');
  expect(stdout.join('')).toContain('AB7314: Stale endpoint.');
  expect(stdout.join('')).toContain('Recovery: Remove it manually.');
  expect(stdout.join('')).toContain('Doctor summary: 0 error(s), 1 warning(s), 0 info(s)');
});

it('prints one stable JSON report, forwards filters, and gates only errors', async () => {
  const stdout: string[] = [];
  const calls: unknown[] = [];
  const report = cliReport([{
    code: 'AB7301',
    message: 'Probe failed.',
    recovery: 'Repair the host CLI.',
    severity: 'error',
  }]);
  const code = await runCli(
    ['doctor', '--host', 'claude', '--host', 'cursor', '--from', '/bundle', '--json'],
    { stdout: { write: (chunk: string) => stdout.push(chunk) } },
    {
      runDoctor: async (options) => {
        calls.push(options);
        return report;
      },
    },
  );
  expect(code).toBe(1);
  expect(calls).toEqual([{ from: '/bundle', hosts: ['claude', 'cursor'] }]);
  expect(JSON.parse(stdout.join(''))).toEqual(report);
  expect(stdout.join('').trim()).toBe(JSON.stringify(JSON.parse(stdout.join(''))));
});

it('rejects an invalid Doctor host as a usage error', async () => {
  const stderr: string[] = [];
  const code = await runCli(
    ['doctor', '--host', 'portable'],
    { stderr: { write: (chunk: string) => stderr.push(chunk) } },
  );
  expect(code).toBe(2);
  expect(stderr.join('')).toContain('Doctor host must be claude, codex, or cursor.');
});
