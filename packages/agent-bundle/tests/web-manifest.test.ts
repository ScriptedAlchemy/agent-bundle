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

const catalogRow = (kind: 'compiled' | 'prebuilt' = 'compiled') => ({
  apps: [], hosts: ['claude'], id: 'mcp:catalog', kind, launch: validLaunch(), name: 'catalog', transport: 'stdio',
});

const document = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  application: { id: 'application:fixture', name: 'fixture', version: '1.0.0' },
  executables: { mcpServers: [catalogRow()] },
  manifestVersion: 2,
  projections: [{ host: 'claude' }],
  web: validWeb(),
  ...overrides,
});

const withDocument = async (
  run: (path: string, write: (value: unknown) => Promise<void>) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-web-manifest-'));
  const path = join(root, 'agent-bundle.manifest.json');
  try {
    await run(path, (value) => writeFile(path, JSON.stringify(value)));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

it('reads the optional section and returns undefined when absent', () => withDocument(async (path, write) => {
  await write(document());
  await expect(readWebManifest(path)).resolves.toEqual(validWeb());
  await write(document({ web: undefined }));
  await expect(readWebManifest(path)).resolves.toBeUndefined();
  await write(document({ web: { apps: [], open: 'sometimes' } }));
  await expect(readWebManifest(path)).rejects.toThrow(
    new RegExp(`Unable to read web section from ${path.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}: .*open must`, 'u'),
  );
}));

it('refuses every manifestVersion but the one it was built for, before reading any section', () => withDocument(async (path, write) => {
  // Every other slice is well-formed and familiar: the version alone decides.
  for (const manifestVersion of [undefined, 1, 3, '2']) {
    await write(document({ manifestVersion }));
    await expect(readWebManifestDocument(path)).rejects.toThrow(/manifestVersion must be 2\./u);
  }
}));

it('reads the projection hosts and the compiled and prebuilt servers\' launch records beside the web section', () => withDocument(async (path, write) => {
  const prebuiltLaunch: ArtifactManifestLaunch = { args: [], entry: 'runtime/mcp/server.js', env: {} };
  await write(document({
    executables: {
      mcpServers: [
        catalogRow(),
        { apps: [], hosts: ['claude'], id: 'mcp:timeline', kind: 'prebuilt', launch: prebuiltLaunch, name: 'timeline', transport: 'stdio' },
        { apps: [], hosts: ['claude'], id: 'mcp:remote', kind: 'remote', name: 'remote', transport: 'streamable-http' },
      ],
    },
    projections: [{ host: 'claude' }, { host: 'codex' }],
  }));
  const read = await readWebManifestDocument(path);
  expect(read.hosts).toEqual(['claude', 'codex']);
  expect([...read.launches]).toEqual([['catalog', validLaunch()], ['timeline', prebuiltLaunch]]);
  expect(read.web).toEqual(validWeb());

  await write(document({ executables: { mcpServers: [] }, projections: [], web: undefined }));
  const empty = await readWebManifestDocument(path);
  expect(empty.hosts).toEqual([]);
  expect(empty.launches.size).toBe(0);
  expect(empty.web).toBeUndefined();
}));

it('refuses two executable rows of one server name instead of letting the later one win', () => withDocument(async (path, write) => {
  const shadow = { ...catalogRow('prebuilt'), id: 'mcp:catalog-2', launch: { args: [], entry: 'other/server.js', env: {} } };
  await write(document({ executables: { mcpServers: [catalogRow(), shadow] } }));
  await expect(readWebManifestDocument(path)).rejects.toThrow('executables.mcpServers declares server "catalog" twice.');
}));

it('refuses malformed launch references instead of skipping the row', () => withDocument(async (path, write) => {
  const cases: readonly [unknown, string][] = [
    [{ mcpServers: [{ ...catalogRow(), launch: { ...validLaunch(), entry: '../x.mjs' } }] }, 'executables.mcpServers[0].launch.entry must be a safe relative POSIX path.'],
    [{ mcpServers: [{ ...catalogRow(), launch: undefined }] }, 'executables.mcpServers[0].launch is present exactly for compiled and prebuilt servers.'],
    [{ mcpServers: [{ ...catalogRow(), kind: 'command' }] }, 'executables.mcpServers[0].launch is present exactly for compiled and prebuilt servers.'],
    [{ mcpServers: [{ ...catalogRow(), kind: 'native' }] }, 'executables.mcpServers[0].kind must be one of command, compiled, prebuilt, remote.'],
    [{ mcpServers: [{ ...catalogRow(), name: '' }] }, 'executables.mcpServers[0].name must be a non-empty string.'],
    [{ mcpServers: ['catalog'] }, 'executables.mcpServers[0] must be a plain object.'],
    [{ mcpServers: {} }, 'executables.mcpServers must be an array.'],
    [undefined, 'executables must be a plain object.'],
  ];
  for (const [executables, message] of cases) {
    await write(document({ executables }));
    await expect(readWebManifestDocument(path)).rejects.toThrow(message);
  }
}));

it('refuses an exposed App whose server has no launch record', () => withDocument(async (path, write) => {
  const missing = 'web.apps[catalog/details].server names "catalog", which is not an MCP server with a launch record.';
  await write(document({ executables: { mcpServers: [] } }));
  await expect(readWebManifestDocument(path)).rejects.toThrow(missing);
  await write(document({ executables: { mcpServers: [{ ...catalogRow(), kind: 'command', launch: undefined }] } }));
  await expect(readWebManifestDocument(path)).rejects.toThrow(missing);
}));

it('refuses malformed projection rows instead of dropping them', () => withDocument(async (path, write) => {
  const cases: readonly [unknown, string][] = [
    [[{ host: 'claude' }, { host: 'claude' }], 'projections declares host "claude" twice.'],
    [[{ host: '' }], 'projections[0].host must be a non-empty string.'],
    [[{ documents: {} }], 'projections[0].host must be a non-empty string.'],
    [['claude'], 'projections[0] must be a plain object.'],
    [{ claude: {} }, 'projections must be an array.'],
    [undefined, 'projections must be an array.'],
  ];
  for (const [projections, message] of cases) {
    await write(document({ projections }));
    await expect(readWebManifestDocument(path)).rejects.toThrow(message);
  }
}));
