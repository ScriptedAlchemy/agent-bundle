import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import type { HostDiscoveryReport } from '../src/contracts/discovery.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import type { DoctorCommandRunner, DoctorCommandResult } from '../src/install/doctor.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';

const successfulCommand = (stdout: string): DoctorCommandResult => Object.freeze({
  exitCode: 0,
  signal: null,
  stderr: '',
  stdout,
});

const unavailableCommand = (executable: string): NodeJS.ErrnoException => {
  const error = new Error(`spawn ${executable} ENOENT`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  error.errno = -2;
  error.path = executable;
  error.syscall = `spawn ${executable}`;
  return error;
};

it('serves authenticated host discovery from the real dev server', { timeout: 30_000 }, async () => {
  const project = await createProjectFixture({
    config: [
      'export default {',
      "  plugin: { name: 'host-discovery-dev-server', version: '1.0.0' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'),
    files: { 'package.json': '{"type":"module"}\n' },
    prefix: 'agent-bundle-host-discovery-dev-server-',
  });
  const assetsRoot = join(project.root, 'workbench');
  const endpointDirectory = join(project.root, 'doctor-endpoints');
  const home = join(project.root, 'doctor-home');
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  const commandRunner: DoctorCommandRunner = async (request) => {
    if (request.executable === 'codex') throw unavailableCommand(request.executable);
    if (request.executable !== 'claude') {
      throw new Error(`Unexpected Doctor command ${JSON.stringify(request.executable)}.`);
    }
    return successfulCommand(request.args[0] === '--version' ? 'Claude Code 1.2.3\n' : '[]\n');
  };

  await Promise.all([
    mkdir(assetsRoot, { recursive: true }),
    mkdir(endpointDirectory, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);
  await Promise.all([
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Host discovery</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
      testing: {
        hostDiscoveryOptions: {
          doctorOptions: {
            commandRunner,
            endpointDirectory,
            home,
            platform: 'linux',
          },
        },
      },
    });

    const unauthenticated = await fetch(`${server.url}/api/discovery`, {
      headers: { origin: server.url },
    });
    expect(unauthenticated.status).toBe(403);
    await expect(unauthenticated.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8004',
        message: 'A valid same-session token is required.',
      },
    });

    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(bootstrap.status).toBe(200);
    const { token } = await bootstrap.json() as { readonly token: string };
    const response = await fetch(`${server.url}/api/discovery`, {
      headers: {
        origin: server.url,
        'x-agent-bundle-session': token,
      },
    });
    expect(response.status).toBe(200);
    const report = await response.json() as HostDiscoveryReport;

    expect(report).toEqual({
      bundleSource: expect.stringMatching(/\/dist$/u),
      diagnostics: expect.any(Array),
      endpoints: {
        diagnostics: [],
        directory: endpointDirectory,
        findings: [],
        status: 'healthy',
        summary: { live: 0, staleLocks: 0, staleSockets: 0 },
      },
      generatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      hosts: expect.any(Array),
      manifestDigest: expect.any(String),
      summary: {
        errors: expect.any(Number),
        infos: expect.any(Number),
        warnings: expect.any(Number),
      },
    });
    expect(report.bundleSource).toBe(join(project.root, 'dist'));
    expect(report.manifestDigest).not.toBe('');
    expect(report.hosts).toHaveLength(3);
    for (const host of report.hosts) {
      expect(Object.keys(host).sort()).toEqual(['bundle', 'diagnostics', 'host', 'inventory', 'probe']);
    }
    expect(report.hosts.find((host) => host.host === 'claude')?.probe).toEqual({
      status: 'available',
      version: '1.2.3',
    });
    expect(report.hosts.find((host) => host.host === 'codex')?.probe).toEqual({
      status: 'unavailable',
    });
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});
