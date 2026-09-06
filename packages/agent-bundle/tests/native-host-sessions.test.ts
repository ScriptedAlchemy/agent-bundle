import { spawnSync } from 'node:child_process';

import { expect, it } from '@rstest/core';

import type { HostSession, HostSessionHost } from '../src/contracts/host-sessions.ts';
import type { TraceEntry, TraceReplay } from '../src/contracts/trace.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import { copyExample } from '../../workbench/tests/support/example-acceptance.ts';

const prompt = 'Call the search_audible tool with query "dune" and explain the result.';
const hosts = ['claude', 'codex'] as const;

const enabled = (host: HostSessionHost): boolean =>
  process.env.AGENT_BUNDLE_NATIVE_HOST_CONTRACTS === '1'
  && spawnSync(host, ['--version'], { stdio: 'ignore', timeout: 5_000, windowsHide: true }).status === 0;

const request = async <Body>(
  origin: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Body> => {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      'x-agent-bundle-session': token,
    },
  });
  const body = await response.json() as Body;
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} returned ${String(response.status)}: ${JSON.stringify(body)}`);
  return body;
};

for (const host of hosts) {
  const hostIt = enabled(host) ? it : it.skip;
  hostIt(`correlates a real ${host} host session with its tools/call trace`, async () => {
    const project = await copyExample('audiobook-curator');
    const server = await startDevServer({ installHosts: [host], open: false, port: 0, root: project.root });
    let created: HostSession | undefined;
    let token: string | undefined;
    try {
      const authenticatedToken = await fetch(`${server.url}/api/project/session`)
        .then((response) => response.json())
        .then((body: { readonly token: string }) => body.token);
      token = authenticatedToken;
      const launched = (await request<{ readonly session: HostSession }>(server.url, authenticatedToken, '/api/sessions', {
        body: JSON.stringify({ cols: 100, host, prompt, rows: 30 }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })).session;
      created = launched;

      await expect.poll(async () => {
        const [sessionBody, trace] = await Promise.all([
          request<{ readonly session: HostSession }>(server.url, authenticatedToken, `/api/sessions/${launched.id}`),
          request<TraceReplay>(server.url, authenticatedToken, '/api/trace?after=0'),
        ]);
        const traceSessionId = sessionBody.session.traceSessionId ?? launched.id;
        return trace.entries.some((entry: TraceEntry) =>
          entry.kind === 'mcp.request'
          && entry.summary.includes('tools/call')
          && entry.correlation.sessionId === traceSessionId);
      }, { interval: 500, timeout: 120_000 }).toBe(true);
    } finally {
      if (created !== undefined && token !== undefined) {
        await request(server.url, token, `/api/sessions/${created.id}/terminate`, {
          body: '{}',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }).catch(() => undefined);
      }
      await server.close();
      await project.release();
    }
  }, 120_000);
}
