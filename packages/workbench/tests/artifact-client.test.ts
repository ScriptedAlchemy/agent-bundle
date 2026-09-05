import { expect, it } from '@rstest/core';

import { ArtifactClient } from '../src/artifacts/artifact-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { recordingFetch, response, type RecordedRequest } from './support/recording-fetch.ts';

const inspection = {
  application: {
    distribution: { channels: ['local'], payloads: [] },
    events: [],
    hooks: [],
    hosts: [{
      builtIn: true,
      documents: [{ kind: 'plugin', path: '.claude-plugin/plugin.json' }],
      host: 'claude',
    }],
    identity: { id: 'application:fixture', name: 'fixture', version: '1.2.3' },
    scripts: [],
    servers: [],
  },
  epochId: 'epoch-1',
  files: [{
    bytes: 512,
    kind: 'generated',
    mode: 0o755,
    path: 'hooks/session-start.mjs',
    sha256: 'a'.repeat(64),
    sourceInputs: [{ path: 'hooks/session-start.ts', sha256: 'b'.repeat(64) }],
  }],
  project: {
    configDigest: 'config-digest',
    configPath: '/workspace/agent-bundle.config.ts',
    modelDigest: 'model-digest',
    revision: 'revision-9',
    sourceInputs: [{ path: 'hooks/session-start.ts', sha256: 'b'.repeat(64) }],
  },
  provenance: [{
    outputPath: 'hooks/session-start.mjs',
    sourceInputs: [{ path: 'hooks/session-start.ts', sha256: 'b'.repeat(64) }],
  }],
  projections: [{
    documents: { plugin: '.claude-plugin/plugin.json' },
    host: 'claude',
    tree: { children: [], kind: 'directory', name: 'claude', path: 'claude' },
  }],
  runtime: { bins: [], executables: [], hooks: [], mcpServers: [], scripts: [] },
};

const diff = {
  added: [{
    after: { bytes: 512, kind: 'generated', path: 'hooks/stop.mjs', sha256: 'c'.repeat(64), sourceInputs: [] },
    path: 'hooks/stop.mjs',
  }],
  baseEpochId: 'epoch-1',
  candidateEpochId: 'epoch-2',
  changed: [],
  removed: [],
  unchanged: [],
};

const foreground = (fetch: typeof globalThis.fetch): ForegroundRouteClient => new ForegroundRouteClient({ fetch });

it('reads one epoch inspection over the same foreground session', async () => {
  const calls: RecordedRequest[] = [];
  const client = new ArtifactClient({ foreground: foreground(recordingFetch(calls, () => response({ inspection }))) });

  await expect(client.inspect('epoch-1')).resolves.toMatchObject({ epochId: 'epoch-1' });
  expect(calls).toEqual([{ method: 'GET', token: 'foreground-token', url: '/api/artifacts/epochs/epoch-1' }]);
});

it('encodes the requested epoch id into the inspection path', async () => {
  const calls: RecordedRequest[] = [];
  const client = new ArtifactClient({ foreground: foreground(recordingFetch(calls, () => response({ inspection }))) });

  await client.inspect('epoch 1+2');

  expect(calls[0]?.url).toBe('/api/artifacts/epochs/epoch%201%2B2');
});

it('freezes the decoded inspection so no page can mutate epoch facts', async () => {
  const client = new ArtifactClient({ foreground: foreground(recordingFetch([], () => response({ inspection }))) });

  const decoded = await client.inspect('epoch-1');

  expect(Object.isFrozen(decoded)).toBe(true);
  expect(Object.isFrozen(decoded.files)).toBe(true);
  expect(Object.isFrozen(decoded.files[0])).toBe(true);
});

it('compares two epochs through the base and candidate query parameters', async () => {
  const calls: RecordedRequest[] = [];
  const client = new ArtifactClient({ foreground: foreground(recordingFetch(calls, () => response({ diff }))) });

  await expect(client.diff('epoch-1', 'epoch-2')).resolves.toMatchObject({
    baseEpochId: 'epoch-1',
    candidateEpochId: 'epoch-2',
  });
  expect(calls).toEqual([{
    method: 'GET',
    token: 'foreground-token',
    url: '/api/artifacts/diff?base=epoch-1&candidate=epoch-2',
  }]);
});

it('decodes a route diagnostic body into a coded client error', async () => {
  const client = new ArtifactClient({
    foreground: foreground(recordingFetch([], () => response({
      diagnostic: { code: 'AB8062', message: 'Artifact request has an invalid shape.' },
    }, 400))),
  });

  await expect(client.diff('epoch-1', 'epoch-2')).rejects.toMatchObject({
    code: 'AB8062',
    diagnostics: [],
    message: 'Artifact request has an invalid shape.',
  });
});

it('carries artifact validation diagnostics on the thrown client error', async () => {
  const client = new ArtifactClient({
    foreground: foreground(recordingFetch([], () => response({
      diagnostic: { code: 'AB8064', message: 'Artifact epoch failed validation.' },
      diagnostics: [{
        code: 'AB4301',
        message: 'MCP server "review" declares an entry path that is not emitted.',
        recovery: 'Correct the MCP server configuration and referenced source files, then inspect again.',
        severity: 'error',
        target: 'claude',
      }],
    }, 422))),
  });

  await expect(client.inspect('epoch-1')).rejects.toMatchObject({
    code: 'AB8064',
    diagnostics: [{ code: 'AB4301', severity: 'error', target: 'claude' }],
  });
});

it('reports an unrecognised failure body with the transport status', async () => {
  const client = new ArtifactClient({ foreground: foreground(recordingFetch([], () => response({}, 503))) });

  await expect(client.inspect('epoch-1')).rejects.toMatchObject({
    code: 'AB8063',
    message: 'Artifact inspection request failed with HTTP 503.',
  });
});

it('rejects a success body that is not an artifact inspection or diff', async () => {
  const client = new ArtifactClient({ foreground: foreground(recordingFetch([], () => response({ inspection: 'epoch-1' }))) });

  await expect(client.inspect('epoch-1')).rejects.toMatchObject({
    code: 'AB8063',
    message: 'Artifact route returned an invalid response.',
  });
});

it.each([
  {
    body: { inspection, schemaVersion: 1 },
    name: 'an inspection envelope schemaVersion',
    read: (client: ArtifactClient): Promise<unknown> => client.inspect('epoch-1'),
  },
  {
    body: { inspection: { ...inspection, version: 1 } },
    name: 'an inspection version',
    read: (client: ArtifactClient): Promise<unknown> => client.inspect('epoch-1'),
  },
  {
    body: { diff: { ...diff, version: 1 } },
    name: 'a diff version',
    read: (client: ArtifactClient): Promise<unknown> => client.diff('epoch-1', 'epoch-2'),
  },
  {
    body: {
      diff: {
        ...diff,
        added: [{ ...diff.added[0]!, after: { ...diff.added[0]!.after, schemaVersion: 1 } }],
      },
    },
    name: 'a nested diff file schemaVersion',
    read: (client: ArtifactClient): Promise<unknown> => client.diff('epoch-1', 'epoch-2'),
  },
])('rejects $name that is not part of the canonical artifact wire DTO', async ({ body, read }) => {
  const client = new ArtifactClient({ foreground: foreground(recordingFetch([], () => response(body))) });

  await expect(read(client)).rejects.toMatchObject({
    code: 'AB8063',
    message: 'Artifact route returned an invalid response.',
  });
});
