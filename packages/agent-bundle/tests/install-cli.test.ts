import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, expect, it } from '@rstest/core';

import { registerLifecycleCommands, type LifecycleApi } from '../src/install/commands.ts';
import { runInstallCli } from '../src/install/index.ts';

const capture = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stderr: () => stderr.join(''),
    stdout: () => stdout.join(''),
    sinks: { stderr: (text: string) => void stderr.push(text), stdout: (text: string) => void stdout.push(text) },
  };
};

/** Drives the shared command declarations with a fake lifecycle and a pinned root, the way `runInstallCli` does. */
const runPinned = async (argv: readonly string[], api: Partial<LifecycleApi>) => {
  const out = capture();
  let exitCode = 0;
  const program = new Command().name('demo-install').exitOverride().configureOutput({
    writeErr: out.sinks.stderr,
    writeOut: out.sinks.stdout,
  });
  registerLifecycleCommands(program, {
    from: '/pkg',
    lifecycle: async () => api as LifecycleApi,
    machine: async (result) => out.sinks.stdout(`${JSON.stringify(result)}\n`),
    setExitCode: (code) => { exitCode = code; },
    show: async (text) => out.sinks.stdout(text),
  });
  const code = await program.parseAsync([...argv], { from: 'user' }).then(() => exitCode, (error: unknown) => error);
  return { code, ...out };
};

describe('package-bound lifecycle commands', () => {
  it('pins the bundle root and forwards install flags to installBundle', async () => {
    const calls: unknown[] = [];
    const { code, stdout } = await runPinned(
      ['install', 'cursor', '--mode', 'marketplace', '--scope', 'project', '--force', '--json'],
      {
        installBundle: async (options) => {
          calls.push(options);
          return { bundleRoot: options.from, host: options.host, plugin: 'demo', state: 'installed', version: '1.0.0' };
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([{ from: '/pkg', host: 'cursor', mode: 'marketplace', replace: true, scope: 'project' }]);
    expect(JSON.parse(stdout())).toMatchObject({ bundleRoot: '/pkg', state: 'installed' });
  });

  it('forwards uninstall --plan and the data policy flags to uninstallBundle', async () => {
    const calls: unknown[] = [];
    const { code } = await runPinned(
      ['uninstall', 'claude', '--plan', '--purge-data', '--confirm-purge', '--json'],
      {
        uninstallBundle: async (options) => {
          calls.push(options);
          return {
            data: { detail: '', outcome: 'planned', paths: [], policy: 'purge' },
            host: 'claude',
            mode: 'local',
            plugin: 'demo',
            receipt: { path: '/r', status: 'valid' },
            registrations: [],
            removed: { directories: [], files: [] },
            retained: [],
            state: 'planned',
            version: '1.0.0',
          } as never;
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([{
      confirmPurge: true, from: '/pkg', host: 'claude', plan: true, purgeData: true, scope: 'user',
    }]);
  });

  it('runs doctor against the pinned root and exits 1 on an error diagnostic', async () => {
    const calls: unknown[] = [];
    const { code, stdout } = await runPinned(['doctor', '--host', 'cursor', '--json'], {
      runDoctor: async (options) => {
        calls.push(options);
        return {
          diagnostics: [{ code: 'AB7300', message: 'boom', recovery: 'fix', severity: 'error' }],
          endpoints: { status: 'clean', summary: { live: 0, staleLocks: 0, staleSockets: 0 } },
          hosts: [],
          summary: { errors: 1, infos: 0, warnings: 0 },
        } as never;
      },
    });
    expect(code).toBe(1);
    expect(calls).toEqual([{ from: '/pkg', hosts: ['cursor'] }]);
    expect(JSON.parse(stdout())).toMatchObject({ summary: { errors: 1 } });
  });

  it('exposes no --from once the root is pinned', async () => {
    const { code, stderr } = await runPinned(['install', 'cursor', '--from', '/elsewhere'], {});
    expect(code).toMatchObject({ code: 'commander.unknownOption' });
    expect(stderr()).toContain("unknown option '--from'");
  });
});

describe('runInstallCli', () => {
  it('prints help with the bin name and exits 0', async () => {
    const out = capture();
    const code = await runInstallCli(['--help'], { from: '/pkg', name: 'demo-install', ...out.sinks });
    expect(code).toBe(0);
    expect(out.stdout()).toContain('Usage: demo-install');
    expect(out.stdout()).toContain('install [options] <host>');
    expect(out.stdout()).not.toContain('--from');
  });

  it('exits 2 on a usage error without touching the lifecycle', async () => {
    const out = capture();
    expect(await runInstallCli(['install', 'windsurf'], { from: '/pkg', ...out.sinks })).toBe(2);
    expect(out.stderr()).toContain('Install host must be claude, codex, or cursor.');
    expect(await runInstallCli([], { from: '/pkg', ...out.sinks })).toBe(2);
  });

  it('reports a failed install as one diagnostics line on stderr and exits 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-install-cli-'));
    try {
      const out = capture();
      const code = await runInstallCli(['install', 'cursor', '--json'], { from: join(root, 'missing'), ...out.sinks });
      expect(code).toBe(1);
      expect(out.stdout()).toBe('');
      const [diagnostic] = JSON.parse(out.stderr()) as { readonly code: string; readonly severity: string }[];
      expect(diagnostic).toMatchObject({ severity: 'error' });
      expect(diagnostic.code).toMatch(/^AB\d{4}$/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
