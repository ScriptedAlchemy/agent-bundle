import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { expect, it } from '@rstest/core';

import { installBundle, type InstallCommandRunner } from '../src/install/install.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';
import { runCli } from '../src/cli.ts';

interface CommandCall {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
}

const recordingRunner = (): {
  readonly calls: CommandCall[];
  readonly runner: InstallCommandRunner;
} => {
  const calls: CommandCall[] = [];
  return {
    calls,
    runner: {
      run: async (command, args, options) => {
        calls.push({ args: [...args], command, cwd: options.cwd });
        return { code: 0, stderr: '', stdout: '' };
      },
    },
  };
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
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

    expect(result).toMatchObject({ host, plugin: 'install-fixture', state: 'installed' });
    expect(calls).toEqual(expected.map((call) => ({ ...call, args: call.args.map((arg) =>
      arg === resolve('/bundle') ? fixture.bundleRoot : arg), cwd: fixture.bundleRoot })));
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
    const first = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    const second = await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });

    expect(first).toMatchObject({ destination, host: 'cursor', state: 'installed' });
    expect(second).toMatchObject({ destination, host: 'cursor', state: 'already-installed' });
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('payload\n');
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

it('refuses Cursor version and content collisions', async () => {
  const fixture = await createHostBundle('cursor');
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'));
  await mkdir(join(home, '.cursor'));
  const destination = join(home, '.cursor', 'plugins', 'local', 'install-fixture');
  try {
    await installBundle({ from: fixture.from, home, host: 'cursor', scope: 'user' });
    await writeFile(join(destination, 'payload.txt'), 'changed\n');
    const contentError = await installBundle({
      from: fixture.from,
      home,
      host: 'cursor',
      scope: 'user',
    }).catch((failure: unknown) => failure);
    expect(contentError).toBeInstanceOf(DiagnosticError);
    expect((contentError as DiagnosticError).diagnostics).toMatchObject([{ code: 'AB7005' }]);

    await writeJson(join(destination, '.cursor-plugin/plugin.json'), {
      name: 'install-fixture',
      version: '9.0.0',
    });
    const versionError = await installBundle({
      from: fixture.from,
      home,
      host: 'cursor',
      scope: 'user',
    }).catch((failure: unknown) => failure);
    expect(versionError).toBeInstanceOf(DiagnosticError);
    expect((versionError as DiagnosticError).diagnostics[0]?.message).toContain('version collision');
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
    ['install', 'claude', '--from', '/tmp/example bundle', '--scope', 'project', '--json'],
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
    scope: 'project',
  }]);
  expect(JSON.parse(stdout.join(''))).toMatchObject({
    host: 'claude',
    plugin: 'fixture',
    state: 'installed',
  });
});
