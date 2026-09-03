import { get as httpGet, type IncomingMessage } from 'node:http';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from '@rstest/core';

import { startDevServer } from '../src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';
import {
  DEV_CONTRACT_SERVER,
  DEV_CONTRACT_TOOL_ROUTE,
  devContractFixtureSource as contractFixtureSource,
  devContractToolSource as toolSource,
  writeDevContractProject,
} from './support/dev-contract-project.ts';
import { replaceWatchedSource } from './support/watched-files.ts';

const cliEntry = join(import.meta.dirname, '..', 'bin', 'agent-bundle.js');

const within = async <Value>(
  promise: Promise<Value>,
  milliseconds = 30_000,
  phase = 'operation',
): Promise<Value> => Promise.race([
  promise,
  new Promise<Value>((_resolvePromise, rejectPromise) => {
    setTimeout(() => rejectPromise(new Error(`${phase} timed out after ${milliseconds}ms.`)), milliseconds);
  }),
]);

const writeProject = async (root: string, contracts: boolean): Promise<string> =>
  (await writeDevContractProject(root, { contracts })).toolSource;

const openProxy = async (root: string, url: string): Promise<Client> => {
  const transport = new StdioClientTransport({
    args: [cliEntry, 'dev', 'proxy', '--root', root, '--server', DEV_CONTRACT_SERVER, '--url', url],
    command: process.execPath,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'dev-contract-adoption-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
};

const versionOf = async (client: Client): Promise<unknown> => {
  const result = await client.callTool({ arguments: { token: 'live' }, name: 'version' });
  return (result.structuredContent as { readonly version?: unknown } | undefined)?.version;
};

const foregroundCookie = async (url: string): Promise<string> => {
  const response = await fetch(`${url}/api/project/session`, { headers: { origin: url } });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!response.ok || cookie === undefined) throw new Error('Could not open the project event stream.');
  return cookie;
};

const projectEvents = async (url: string): Promise<Readonly<{
  close(): void;
  opened: Promise<void>;
  until(marker: string): Promise<string>;
}>> => {
  const cookie = await foregroundCookie(url);
  let received = '';
  let response: IncomingMessage | undefined;
  let awaited: { readonly marker: string; readonly resolve: (value: string) => void } | undefined;
  const opened = Promise.withResolvers<void>();
  const request = httpGet(`${url}/api/project/events`, { headers: { cookie, origin: url } }, (stream) => {
    response = stream;
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      received += chunk;
      if (awaited !== undefined && received.includes(awaited.marker)) awaited.resolve(received);
    });
    opened.resolve();
  });
  request.once('error', opened.reject);
  return Object.freeze({
    close: () => {
      response?.destroy();
      request.destroy();
    },
    opened: opened.promise,
    until: (marker: string) => received.includes(marker)
      ? Promise.resolve(received)
      : new Promise<string>((resolve) => { awaited = { marker, resolve }; }),
  });
};

const waitFor = async (assertion: () => Promise<boolean>, milliseconds = 30_000): Promise<void> => within((async () => {
  while (!await assertion()) await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
})(), milliseconds);

const waitForActive = async (server: Awaited<ReturnType<typeof startDevServer>>): Promise<void> => waitFor(async () => {
  const status = server.status();
  if (status.build.state === 'failed') {
    throw new Error(`Initial development build failed: ${JSON.stringify(status.build.lastAttempt?.diagnostics)}`);
  }
  return status.artifact.state === 'active';
});

it('keeps failed epochs inactive and adopts the next passing epoch on one live host connection', async () => {
  const project = await createProjectFixture({ config: 'export default {};\n', files: {} });
  let client: Client | undefined;
  let events: Awaited<ReturnType<typeof projectEvents>> | undefined;
  let lateClient: Client | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    const source = await writeProject(project.root, true);
    server = await startDevServer({
      open: false,
      port: 0,
      root: project.root,
    });
    await waitForActive(server);
    client = await openProxy(project.root, server.url);
    events = await projectEvents(server.url);
    await events.opened;
    await within(events.until('"summary":"Development contract matrix passed."'), 30_000, 'initial matrix');

    expect(await versionOf(client)).toBe('v1');
    let listChanged = 0;
    client.setNotificationHandler('notifications/tools/list_changed', async () => { listChanged += 1; });

    const initialEpoch = server.status().artifact;
    if (initialEpoch.state !== 'active') throw new Error('Expected an initial active epoch.');
    await replaceWatchedSource(
      project.root,
      join(project.root, 'contract-fixtures.ts'),
      contractFixtureSource('tool:fixture/unknown'),
    );
    await waitFor(async () => {
      const artifact = server?.status().artifact;
      return artifact?.state === 'active' && artifact.activeEpoch.id !== initialEpoch.activeEpoch.id;
    });
    const failedEpoch = server.status().artifact;
    if (failedEpoch.state !== 'active') throw new Error('Expected the failed-contract build to publish an artifact.');
    const failedWire = await within(events.until('"summary":"Development contract matrix reported'), 30_000, 'failed matrix');

    expect(failedWire).toContain('event: dev.contract.status');
    expect(failedWire).toContain('"state":"failed"');
    expect(failedWire).toContain('"routeId":"tool:fixture/unknown"');
    expect(failedWire).toContain('"checks":["coverage"]');
    expect(listChanged).toBe(0);
    expect(await versionOf(client)).toBe('v1');
    lateClient = await openProxy(project.root, server.url);
    expect(await versionOf(lateClient)).toBe('v1');
    expect(server.status().hostAdoption).toEqual({
      adoptedEpochId: initialEpoch.activeEpoch.id,
      contracts: {
        diagnostics: [expect.objectContaining({ code: 'AB7211', severity: 'error', target: failedEpoch.activeEpoch.id })],
        epochId: failedEpoch.activeEpoch.id,
        failures: [
          { checks: ['coverage'], routeId: 'tool:fixture/unknown' },
          { checks: ['coverage'], routeId: DEV_CONTRACT_TOOL_ROUTE },
        ],
        state: 'failed',
        summary: 'Development contract matrix reported 2 violation(s).',
      },
      mode: 'gated',
    });

    const changed = Promise.withResolvers<void>();
    client.setNotificationHandler('notifications/tools/list_changed', async () => {
      listChanged += 1;
      changed.resolve();
    });
    await Promise.all([
      replaceWatchedSource(project.root, source, toolSource('v3', project.root)),
      replaceWatchedSource(
        project.root,
        join(project.root, 'contract-fixtures.ts'),
        contractFixtureSource(DEV_CONTRACT_TOOL_ROUTE),
      ),
    ]);
    await within(changed.promise, 30_000, 'changed notification');
    expect(await versionOf(client)).toBe('v3');
    const passingEpoch = server.status().artifact;
    if (passingEpoch.state !== 'active') throw new Error('Expected the repaired build to publish an artifact.');
    const passingWire = await within(
      events.until(`"epochId":"${passingEpoch.activeEpoch.id}","failures":[],"state":"passed"`),
      30_000,
      'passing matrix',
    );
    expect(passingWire).toContain('"state":"passed"');
    expect(listChanged).toBe(1);
    expect(server.status().hostAdoption).toMatchObject({
      adoptedEpochId: passingEpoch.activeEpoch.id,
      contracts: { epochId: passingEpoch.activeEpoch.id, failures: [], state: 'passed' },
      mode: 'gated',
    });
  } finally {
    events?.close();
    await lateClient?.close().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await removeProjectFixture(project.root);
  }
}, 180_000);

it('adopts artifact.available directly when development contracts are not declared', async () => {
  const project = await createProjectFixture({ config: 'export default {};\n', files: {} });
  let client: Client | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    const source = await writeProject(project.root, false);
    server = await startDevServer({ open: false, port: 0, root: project.root });
    await waitForActive(server);
    client = await openProxy(project.root, server.url);
    expect(await versionOf(client)).toBe('v1');
    const changed = Promise.withResolvers<void>();
    client.setNotificationHandler('notifications/tools/list_changed', async () => changed.resolve());

    await replaceWatchedSource(project.root, source, toolSource('v3', project.root));
    await within(changed.promise);

    expect(await versionOf(client)).toBe('v3');
    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected the rebuilt artifact to be active.');
    expect(server.status().hostAdoption).toEqual({ adoptedEpochId: artifact.activeEpoch.id, mode: 'direct' });
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await removeProjectFixture(project.root);
  }
}, 120_000);
