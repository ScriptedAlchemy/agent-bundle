import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';

import { openStdioAppSession, sessionAuthorityFor } from '../src/web-host/session.ts';
import type { StdioAppSession } from '../src/web-host/session.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';

const serverSource = [
  "import { McpServer } from '@modelcontextprotocol/server';",
  "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
  '',
  "const server = new McpServer({ name: 'web-session-fixture', version: '1.0.0' });",
  "server.registerTool('ping', { description: 'Answer.' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));",
  'await server.connect(new StdioServerTransport());',
  '',
].join('\n');

const within = async <Value>(promise: Promise<Value>, milliseconds = 10_000): Promise<Value> => Promise.race([
  promise,
  new Promise<Value>((_resolvePromise, rejectPromise) => {
    setTimeout(() => rejectPromise(new Error(`Timed out after ${milliseconds}ms.`)), milliseconds);
  }),
]);

const settled = async (): Promise<void> => new Promise((resolvePromise) => { setImmediate(resolvePromise); });

let root: string;

const open = async (): Promise<StdioAppSession> => openStdioAppSession(
  { args: [join(root, 'server.mjs')], command: process.execPath, cwd: root, env: { PATH: process.env.PATH ?? '' } },
  { serverName: 'fixture', target: 'portable' },
  10_000,
);

beforeAll(async () => {
  root = (await createProjectFixture({ files: { 'server.mjs': serverSource, 'package.json': '{"type":"module"}\n' }, prefix: 'web-session-' })).root;
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(join(agentBundleNodeModules, '@modelcontextprotocol'), join(root, 'node_modules', '@modelcontextprotocol'), 'dir');
});

afterAll(async () => {
  await removeProjectFixture(root);
});

describe('web host stdio session teardown', () => {
  it('isolates every close listener from the ones that throw or reject', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const session = await open();
      const fired: string[] = [];
      session.watchClosed(() => { throw new Error('sync teardown failure'); });
      session.watchClosed(async () => { throw new Error('async teardown failure'); });
      session.watchClosed(() => { fired.push('plain'); });
      const unsubscribed = session.watchClosed(() => { fired.push('unsubscribed'); });
      unsubscribed();

      await within(session.close());
      await within(session.closed);
      await settled();
      expect(fired).toEqual(['plain']);

      // A listener registered after close is notified once, with the same isolation.
      session.watchClosed(() => { throw new Error('late teardown failure'); });
      session.watchClosed(() => { fired.push('late'); });
      await settled();
      expect(fired).toEqual(['plain', 'late']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('shields the session authority lease from a rejecting App teardown', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const session = await open();
      const lease = await sessionAuthorityFor(session).acquireAppLease(session.sessionId);
      const fired: string[] = [];
      const rejecting = lease.watchSessionClosed(async () => { throw new Error('binding teardown failure'); });
      const plain = lease.watchSessionClosed(() => { fired.push('plain'); });
      expect(rejecting.closed).toBe(false);
      expect(plain.closed).toBe(false);

      await within(session.close());
      await settled();
      expect(fired).toEqual(['plain']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
