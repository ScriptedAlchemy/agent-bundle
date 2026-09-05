import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import {
  artifactManifestName,
  assembleArtifactManifest,
  parseArtifactManifest,
  type ArtifactManifest,
  type ArtifactManifestMcpServer,
  type ArtifactManifestProjection,
} from '../src/build/manifest.ts';
import { validateArtifactManifestSchema } from '../src/build/manifest-schema.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import type { Diagnostic } from '../src/core/diagnostics.ts';
import { sha256Hex, stableJson } from '../src/core/digest.ts';

/**
 * The manifest coherence lane (AB6039/AB6040, #592 step 3) over one real
 * composite root: every built-in host projects into it, the MCP surface has
 * one server of each row kind (`echo` compiles from its conventional
 * `src/mcp/echo.ts` entry, `tools` is a host-run command, `docs` a remote
 * URL), and every host that can register a marketplace does. Each case copies
 * the built artifact and forges one disagreement, re-hashing the manifest's
 * `files[]` row so the file table still matches and AB6004 stays silent —
 * the lane is proven to fire on its own, not on top of drift noise.
 */

const fixtureName = 'manifest-coherence-fixture';
const fixtureVersion = '1.2.3';
const hosts = ['claude', 'codex', 'cursor', 'portable'] as const;

const roots: string[] = [];
let artifactRoot: string;

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-manifest-coherence-'));
  roots.push(root);
  await Promise.all([
    writeProjectFile(root, 'package.json', `${JSON.stringify({
      name: fixtureName,
      type: 'module',
      version: fixtureVersion,
    })}\n`),
    // `marketplace: true` makes Cursor register a marketplace too; Claude and
    // Codex always do. The version derives from package.json.
    writeProjectFile(root, 'agent-bundle.config.ts', [
      'export default {',
      '  marketplace: true,',
      '  mcp: {',
      '    servers: {',
      "      docs: { transport: 'streamable-http', url: 'https://example.com/mcp' },",
      '      echo: {},',
      "      tools: { args: ['--stdio'], command: 'fixture-tools' },",
      '    },',
      '  },',
      `  plugin: { description: 'Proves the manifest against its host documents.', name: ${JSON.stringify(fixtureName)} },`,
      `  targets: ${JSON.stringify(hosts)},`,
      '};',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/echo.ts', [
      "process.stdin.on('data', (chunk) => process.stdout.write(chunk));",
      '',
    ].join('\n')),
  ]);
  artifactRoot = join(root, 'artifact');
  await build({ output: artifactRoot, root, targets: [...hosts] });
}, 180_000);

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** A private copy of the built artifact for one case to forge. */
const copyArtifact = async (): Promise<string> => {
  const copy = await mkdtemp(join(tmpdir(), 'agent-bundle-manifest-coherence-copy-'));
  roots.push(copy);
  await cp(artifactRoot, copy, { recursive: true });
  return copy;
};

const readManifest = async (root: string): Promise<ArtifactManifest> =>
  parseArtifactManifest(await readFile(join(root, artifactManifestName), 'utf8'));

const readJsonDocument = async (root: string, path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(root, path), 'utf8')) as Record<string, unknown>;

/**
 * Rewrites the manifest through the real serializer, so every forged
 * manifest is still a strict canonical document (AB6001 stays silent) and
 * only the intended disagreement remains.
 */
const rewriteManifest = async (
  root: string,
  edit: (manifest: ArtifactManifest) => ArtifactManifest,
): Promise<void> => {
  const manifest = await readManifest(root);
  await writeFile(join(root, artifactManifestName), assembleArtifactManifest(edit(manifest)).bytes);
};

/**
 * Rewrites one host document and re-hashes its `files[]` row, so the file
 * table still matches the tree (AB6004 stays silent) and the document alone
 * disagrees with the manifest.
 */
const rewriteDocument = async (
  root: string,
  path: string,
  document: Record<string, unknown>,
  edit: (manifest: ArtifactManifest) => ArtifactManifest = (manifest) => manifest,
): Promise<void> => {
  const contents = `${stableJson(document)}\n`;
  await writeFile(join(root, path), contents);
  await rewriteManifest(root, (manifest) => edit({
    ...manifest,
    files: manifest.files.map((file) => file.path === path
      ? { ...file, bytes: Buffer.byteLength(contents), sha256: sha256Hex(contents) }
      : file),
  }));
};

const projectionFor = (manifest: ArtifactManifest, host: string): ArtifactManifestProjection => {
  const projection = manifest.projections.find((candidate) => candidate.host === host);
  if (projection === undefined) throw new Error(`Fixture lacks the ${host} projection.`);
  return projection;
};

const withProjection = (
  manifest: ArtifactManifest,
  host: string,
  edit: (projection: ArtifactManifestProjection) => ArtifactManifestProjection,
): ArtifactManifest => ({
  ...manifest,
  projections: manifest.projections.map((projection) => projection.host === host ? edit(projection) : projection),
});

const withMcpServers = (
  manifest: ArtifactManifest,
  edit: (servers: readonly ArtifactManifestMcpServer[]) => readonly ArtifactManifestMcpServer[],
): ArtifactManifest => ({
  ...manifest,
  executables: { ...manifest.executables, mcpServers: edit(manifest.executables.mcpServers) },
});

const echoRow = (manifest: ArtifactManifest): ArtifactManifestMcpServer => {
  const row = manifest.executables.mcpServers.find((server) => server.id === 'mcp:echo');
  if (row === undefined) throw new Error('Fixture lacks the mcp:echo row.');
  return row;
};

const codes = (diagnostics: readonly Diagnostic[]): readonly string[] => diagnostics.map((entry) => entry.code);

const expectOnly = (diagnostics: readonly Diagnostic[], code: 'AB6039' | 'AB6040'): void => {
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(new Set(codes(diagnostics))).toEqual(new Set([code]));
  for (const entry of diagnostics) {
    expect(entry.severity).toBe('error');
    expect(entry.recovery).toBe(code === 'AB6039'
      ? 'Rebuild the artifact; do not edit agent-bundle.manifest.json by hand.'
      : "Rebuild the artifact so the host documents are regenerated from the manifest's model.");
  }
};

it('a clean composite root of every built-in host raises neither AB6039 nor AB6040', async () => {
  const manifest = await readManifest(artifactRoot);
  expect(manifest.application).toMatchObject({ name: fixtureName, version: fixtureVersion });
  expect(manifest.projections.map((projection) => projection.host)).toEqual([...hosts]);
  expect(manifest.executables.mcpServers).toEqual([
    expect.objectContaining({ hosts: [...hosts], id: 'mcp:docs', kind: 'remote', transport: 'streamable-http' }),
    expect.objectContaining({
      entry: { path: expect.stringMatching(/^mcp\/[^/]+\.mjs$/u) },
      hosts: [...hosts],
      id: 'mcp:echo',
      kind: 'compiled',
      transport: 'stdio',
    }),
    expect.objectContaining({ hosts: [...hosts], id: 'mcp:tools', kind: 'command', transport: 'stdio' }),
  ]);
  expect(manifest.executables.mcpServers.filter((server) => server.kind !== 'compiled').every((server) => server.entry === undefined)).toBe(true);
  for (const host of hosts) {
    expect(projectionFor(manifest, host).documents.plugin).toBeDefined();
    expect(projectionFor(manifest, host).documents.mcp).toBeDefined();
  }
  expect(projectionFor(manifest, 'claude').marketplace).toEqual({ name: `${fixtureName}-marketplace` });

  const copy = await copyArtifact();
  await expect(validateArtifact({ artifactRoot: copy })).resolves.toEqual([]);
});

it('the writer\'s manifest validates against the shipped JSON Schema', async () => {
  const bytes = await readFile(join(artifactRoot, artifactManifestName), 'utf8');
  expect(validateArtifactManifestSchema(JSON.parse(bytes))).toEqual([]);
});

it('AB6040 names the host plugin manifest whose version disagrees with application.version, without AB6004', async () => {
  const root = await copyArtifact();
  const path = projectionFor(await readManifest(root), 'claude').documents.plugin!;
  await rewriteDocument(root, path, { ...await readJsonDocument(root, path), version: '9.9.9' });

  const diagnostics = await validateArtifact({ artifactRoot: root });
  expectOnly(diagnostics, 'AB6040');
  expect(diagnostics).toEqual([expect.objectContaining({
    generatedPath: path,
    message: `Host document ${JSON.stringify(path)} declares version "9.9.9", but the manifest application.version is "1.2.3".`,
    target: 'claude',
  })]);
});

it('AB6040 names the host plugin manifest whose name disagrees with application.name', async () => {
  const root = await copyArtifact();
  const path = projectionFor(await readManifest(root), 'portable').documents.plugin!;
  await rewriteDocument(root, path, { ...await readJsonDocument(root, path), name: 'someone-else' });

  const diagnostics = await validateArtifact({ artifactRoot: root });
  expectOnly(diagnostics, 'AB6040');
  expect(diagnostics).toEqual([expect.objectContaining({
    generatedPath: path,
    message: `Host document ${JSON.stringify(path)} declares name "someone-else", but the manifest application.name is ${JSON.stringify(fixtureName)}.`,
    target: 'portable',
  })]);
});

it('AB6040 names a marketplace document whose name disagrees with the projection', async () => {
  const root = await copyArtifact();
  const path = projectionFor(await readManifest(root), 'claude').documents.marketplace!;
  await rewriteDocument(root, path, { ...await readJsonDocument(root, path), name: 'another-marketplace' });

  const diagnostics = await validateArtifact({ artifactRoot: root });
  expectOnly(diagnostics, 'AB6040');
  expect(diagnostics).toEqual([expect.objectContaining({
    generatedPath: path,
    message: `Host document ${JSON.stringify(path)} declares name "another-marketplace", but the manifest projections[claude].marketplace.name is ${JSON.stringify(`${fixtureName}-marketplace`)}.`,
    target: 'claude',
  })]);
});

it('AB6040 names a marketplace document the projection does not record', async () => {
  const root = await copyArtifact();
  const path = projectionFor(await readManifest(root), 'codex').documents.marketplace!;
  await rewriteManifest(root, (manifest) => withProjection(manifest, 'codex', ({ marketplace: _dropped, ...projection }) => projection));

  const diagnostics = await validateArtifact({ artifactRoot: root });
  expectOnly(diagnostics, 'AB6040');
  expect(diagnostics).toEqual([expect.objectContaining({
    generatedPath: path,
    message: `Host document ${JSON.stringify(path)} registers a marketplace, but the manifest records none for projection "codex" (projections[codex].marketplace is absent).`,
    target: 'codex',
  })]);
});

it('AB6040 refuses a plugin manifest it cannot read as a strict JSON object', async () => {
  const root = await copyArtifact();
  const path = projectionFor(await readManifest(root), 'cursor').documents.plugin!;
  const document = await readJsonDocument(root, path);
  // A duplicate key parses leniently (so AB6006 stays silent) but has no single identity to prove.
  const contents = `${stableJson(document).slice(0, -1)},"name":${JSON.stringify(fixtureName)}}\n`;
  await writeFile(join(root, path), contents);
  await rewriteManifest(root, (manifest) => ({
    ...manifest,
    files: manifest.files.map((file) => file.path === path
      ? { ...file, bytes: Buffer.byteLength(contents), sha256: sha256Hex(contents) }
      : file),
  }));

  const diagnostics = await validateArtifact({ artifactRoot: root });
  expectOnly(diagnostics, 'AB6040');
  expect(diagnostics).toEqual([expect.objectContaining({
    generatedPath: path,
    message: `Host document ${JSON.stringify(path)} is not a strict JSON object, so the application identity it declares for projection "cursor" cannot be proven against the manifest.`,
  })]);
});

it('AB6039 names every host MCP document declaring a server that has no executables.mcpServers row', async () => {
  const root = await copyArtifact();
  const manifest = await readManifest(root);
  await rewriteManifest(root, (current) => withMcpServers(current, (servers) => servers.filter((server) => server.id !== 'mcp:echo')));

  const diagnostics = await validateArtifact({ artifactRoot: root });
  expectOnly(diagnostics, 'AB6039');
  expect(diagnostics).toEqual(hosts.map((host) => expect.objectContaining({
    generatedPath: projectionFor(manifest, host).documents.mcp,
    message: `Manifest executables.mcpServers has no row listing host ${JSON.stringify(host)} for MCP server "echo" (${JSON.stringify(projectionFor(manifest, host).documents.mcp)} declares it).`,
    target: host,
  })));
});

it('AB6039 names a row listing a host whose MCP document lacks the server', async () => {
  const root = await copyArtifact();
  const path = projectionFor(await readManifest(root), 'codex').documents.mcp!;
  const document = await readJsonDocument(root, path);
  const { echo: _dropped, ...servers } = document['mcpServers'] as Record<string, unknown>;
  await rewriteDocument(root, path, { ...document, mcpServers: servers });

  const diagnostics = await validateArtifact({ artifactRoot: root });
  expectOnly(diagnostics, 'AB6039');
  expect(diagnostics).toEqual([expect.objectContaining({
    generatedPath: path,
    message: `Manifest executables.mcpServers[mcp:echo] lists host "codex", whose MCP document lacks server "echo" (${JSON.stringify(path)}).`,
    target: 'codex',
  })]);
});

it('AB6039 names a row whose transport disagrees with the host MCP document', async () => {
  const root = await copyArtifact();
  await rewriteManifest(root, (manifest) => withMcpServers(manifest, (servers) => servers.map((server) =>
    server.id === 'mcp:echo' ? { ...server, transport: 'streamable-http' } : server)));

  const diagnostics = await validateArtifact({ artifactRoot: root });
  expectOnly(diagnostics, 'AB6039');
  expect(diagnostics).toHaveLength(hosts.length);
  expect(diagnostics[0]?.message).toBe(
    'Manifest executables.mcpServers[mcp:echo] records transport "streamable-http", but host "claude" runs "echo" as "stdio" (".mcp.json").',
  );
});

it('AB6039 names a compiled entry outside the MCP entry layout of its hosts', async () => {
  const root = await copyArtifact();
  const manifest = await readManifest(root);
  const entryPath = echoRow(manifest).entry?.path;
  const entryFile = manifest.files.find((file) => file.path === entryPath);
  if (entryPath === undefined || entryFile === undefined) throw new Error('Fixture lacks the compiled echo entry.');
  // `assets/` is a recursive namespace every built-in host owns, so the
  // misplaced copy is not an AB6014 ownership finding; only the row's
  // pointer leaves the `mcp/` layout.
  await mkdir(join(root, 'assets'), { recursive: true });
  await cp(join(root, entryPath), join(root, 'assets', 'echo.mjs'));
  await rewriteManifest(root, (current) => withMcpServers({
    ...current,
    files: [...current.files, { ...entryFile, path: 'assets/echo.mjs' }].sort((left, right) => left.path.localeCompare(right.path)),
  }, (servers) => servers.map((server) =>
    server.id === 'mcp:echo' ? { ...server, entry: { path: 'assets/echo.mjs' } } : server)));

  const diagnostics = await validateArtifact({ artifactRoot: root });
  expectOnly(diagnostics, 'AB6039');
  expect(diagnostics).toEqual(hosts.map((host) => expect.objectContaining({
    generatedPath: 'assets/echo.mjs',
    message: `Manifest executables.mcpServers[mcp:echo].entry.path lies outside the MCP entry layout of host ${JSON.stringify(host)} ("assets/echo.mjs" is not mcp/*.mjs).`,
    target: host,
  })));
});

it('AB6039 names a documents.mcp pointer the host never reads', async () => {
  const root = await copyArtifact();
  const manifest = await readManifest(root);
  const codexDocument = projectionFor(manifest, 'codex').documents.mcp!;
  await rewriteManifest(root, (current) => withProjection(current, 'claude', (projection) => ({
    ...projection,
    documents: { ...projection.documents, mcp: codexDocument },
  })));

  const diagnostics = await validateArtifact({ artifactRoot: root });
  expectOnly(diagnostics, 'AB6039');
  expect(diagnostics).toEqual([expect.objectContaining({
    generatedPath: codexDocument,
    message: `Manifest projections[claude].documents.mcp names ${JSON.stringify(codexDocument)}, which host "claude" never reads (its MCP document is ".mcp.json").`,
    target: 'claude',
  })]);
});

it('AB6039 names a route-generated server whose row is not compiled', async () => {
  const root = await copyArtifact();
  await rewriteManifest(root, (manifest) => withMcpServers({
    ...manifest,
    routes: {
      ...manifest.routes,
      servers: [{
        id: 'mcp:echo',
        mode: 'generated',
        name: 'echo',
        routes: [{
          id: 'tool:echo/ping',
          kind: 'tool',
          provenance: { kind: 'conventional' },
          serverId: 'mcp:echo',
          source: 'src/mcp/echo/tools/ping.tsx',
        }],
      }],
    },
  }, (servers) => servers.map((server) => {
    if (server.id !== 'mcp:echo') return server;
    const { entry: _entry, ...row } = server;
    return { ...row, kind: 'command' as const };
  })));

  const diagnostics = await validateArtifact({ artifactRoot: root });
  expectOnly(diagnostics, 'AB6039');
  expect(diagnostics).toEqual([expect.objectContaining({
    generatedPath: artifactManifestName,
    message: 'Manifest executables.mcpServers[mcp:echo] is a command server, but routes.servers[mcp:echo] is a generated server (generated servers compile to an entry the artifact starts).',
  })]);
});

it('a compiled row without an entry never reaches AB6039: the parser rejects it as AB6001', async () => {
  const root = await copyArtifact();
  const manifest = await readManifest(root);
  const forged = withMcpServers(manifest, (servers) => servers.map(({ entry: _entry, ...server }) => server));
  expect(() => assembleArtifactManifest(forged)).toThrow(/entry is present exactly for compiled servers/u);
  await writeFile(join(root, artifactManifestName), `${stableJson(forged)}\n`);

  expect(codes(await validateArtifact({ artifactRoot: root }))).toEqual(['AB6001']);
});

it('the lane stays silent over a tree the file table already disagrees with (AB6004)', async () => {
  const root = await copyArtifact();
  const path = projectionFor(await readManifest(root), 'claude').documents.plugin!;
  await writeFile(join(root, path), `${stableJson({ ...await readJsonDocument(root, path), version: '9.9.9' })}\n`);

  const found = codes(await validateArtifact({ artifactRoot: root }));
  expect(found).toContain('AB6004');
  expect(found).not.toContain('AB6039');
  expect(found).not.toContain('AB6040');
});
