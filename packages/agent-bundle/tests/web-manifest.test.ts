import { expect, it } from '@rstest/core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseLaunch,
  parseWebManifest,
  readWebManifest,
  readWebManifestDocument,
  type ArtifactManifestLaunch,
  type WebManifest,
} from '../src/web-host/manifest.ts';

const validWeb = (): WebManifest => ({
  apps: [{
    allow: ['call-tool'],
    app: 'catalog/details',
    input: { sku: '42' },
    name: 'details',
    resourceUri: 'ui://catalog/details',
    server: 'catalog',
    tool: 'open-details',
  }],
  open: 'never',
});

const validLaunch = (): ArtifactManifestLaunch => ({
  args: [
    { kind: 'literal', value: '--config' },
    { kind: 'artifact', path: 'payload/config.json' },
    { kind: 'literal', value: 'agent-bundle:path:plugin-data/cache' },
  ],
  entry: 'mcp/mcp-catalog-01234567.mjs',
  env: { CATALOG_TOKEN: 'agent-bundle:path:plugin-data/token' },
  worker: 'mcp/mcp-catalog-01234567-flight.mjs',
});

it('parses and round-trips a strict web manifest section', () => {
  expect(parseWebManifest(JSON.parse(JSON.stringify(validWeb())))).toEqual(validWeb());
});

it('rejects exact-key, consent-vocabulary, and ordering violations', () => {
  expect(() => parseWebManifest({ ...validWeb(), extra: true }))
    .toThrow('agent-bundle.manifest.json is invalid: web must have exactly the keys apps, open; found apps, open, extra.');
  expect(() => parseWebManifest({
    ...validWeb(),
    apps: [{ ...validWeb().apps[0], allow: ['camera'] }],
  })).toThrow(/App-initiated consent capability/u);
  expect(() => parseWebManifest({
    ...validWeb(),
    apps: [{ ...validWeb().apps[0], entry: 'mcp/mcp-catalog-01234567.mjs' }],
  })).toThrow('web.apps[0] must have exactly the keys allow, app, name, resourceUri, server, input?, tool?; found allow, app, input, name, resourceUri, server, tool, entry.');
  expect(() => parseWebManifest({
    ...validWeb(),
    apps: [
      { ...validWeb().apps[0], app: 'z/app' },
      { ...validWeb().apps[0], app: 'a/app' },
    ],
  })).toThrow(/sorted by app/u);
});

it('parses and round-trips a launch record, keeping the artifact/literal split', () => {
  expect(parseLaunch(JSON.parse(JSON.stringify(validLaunch())), 'executables.mcpServers[0].launch')).toEqual(validLaunch());
  const { worker: _worker, ...withoutWorker } = validLaunch();
  expect(parseLaunch(withoutWorker, 'launch')).toEqual(withoutWorker);
});

it('rejects a launch record with unknown keys, an unsafe path, or an unknown argument kind', () => {
  const location = 'executables.mcpServers[0].launch';
  expect(() => parseLaunch({ ...validLaunch(), cwd: '.' }, location))
    .toThrow(`${location} must have exactly the keys args, entry, env, worker?; found args, entry, env, worker, cwd.`);
  expect(() => parseLaunch({ ...validLaunch(), entry: '../outside.mjs' }, location))
    .toThrow(`${location}.entry must be a safe relative POSIX path.`);
  expect(() => parseLaunch({ ...validLaunch(), args: [{ kind: 'artifact', path: '/etc/passwd' }] }, location))
    .toThrow(`${location}.args[0].path must be a safe relative POSIX path.`);
  expect(() => parseLaunch({ ...validLaunch(), args: [{ kind: 'literal', value: 1 }] }, location))
    .toThrow(`${location}.args[0].value must be a string.`);
  expect(() => parseLaunch({ ...validLaunch(), args: [{ kind: 'artifact', value: 'x' }] }, location))
    .toThrow(`${location}.args[0] must have exactly the keys kind, path; found kind, value.`);
  expect(() => parseLaunch({ ...validLaunch(), args: ['--flag'] }, location))
    .toThrow(`${location}.args[0] must be a plain object.`);
  expect(() => parseLaunch({ ...validLaunch(), args: [{ kind: 'cwd', value: '.' }] }, location))
    .toThrow(`${location}.args[0].kind must be "artifact" or "literal".`);
  expect(() => parseLaunch({ ...validLaunch(), env: { TOKEN: 1 } }, location))
    .toThrow(`${location}.env.TOKEN must be a string.`);
});

it('reads the optional section and returns undefined when absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-web-manifest-'));
  const path = join(root, 'agent-bundle.manifest.json');
  try {
    await writeFile(path, JSON.stringify({ producer: {}, web: validWeb() }));
    await expect(readWebManifest(path)).resolves.toEqual(validWeb());
    await writeFile(path, JSON.stringify({ producer: {} }));
    await expect(readWebManifest(path)).resolves.toBeUndefined();
    await writeFile(path, JSON.stringify({ web: { apps: [], open: 'sometimes' } }));
    await expect(readWebManifest(path)).rejects.toThrow(
      new RegExp(`Unable to read web section from ${path.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}: .*open must`, 'u'),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reads the projection hosts and the compiled and prebuilt servers\' launch records beside the web section', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-web-manifest-'));
  const path = join(root, 'agent-bundle.manifest.json');
  const prebuiltLaunch: ArtifactManifestLaunch = { args: [], entry: 'runtime/mcp/server.js', env: {} };
  try {
    await writeFile(path, JSON.stringify({
      executables: {
        mcpServers: [
          { apps: [], hosts: ['claude'], id: 'mcp:catalog', kind: 'compiled', launch: validLaunch(), name: 'catalog', transport: 'stdio' },
          { apps: [], hosts: ['claude'], id: 'mcp:timeline', kind: 'prebuilt', launch: prebuiltLaunch, name: 'timeline', transport: 'stdio' },
          { apps: [], hosts: ['claude'], id: 'mcp:remote', kind: 'remote', name: 'remote', transport: 'streamable-http' },
        ],
      },
      projections: [{ host: 'claude' }, { host: 'codex' }],
      web: validWeb(),
    }));
    const document = await readWebManifestDocument(path);
    expect(document.hosts).toEqual(['claude', 'codex']);
    expect([...document.launches]).toEqual([['catalog', validLaunch()], ['timeline', prebuiltLaunch]]);
    expect(document.web).toEqual(validWeb());

    await writeFile(path, JSON.stringify({ producer: {} }));
    const empty = await readWebManifestDocument(path);
    expect(empty.hosts).toEqual([]);
    expect(empty.launches.size).toBe(0);
    expect(empty.web).toBeUndefined();

    await writeFile(path, JSON.stringify({
      executables: { mcpServers: [{ id: 'mcp:catalog', kind: 'compiled', launch: { ...validLaunch(), entry: '../x.mjs' }, name: 'catalog' }] },
    }));
    await expect(readWebManifestDocument(path)).rejects.toThrow('executables.mcpServers[0].launch.entry must be a safe relative POSIX path.');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
