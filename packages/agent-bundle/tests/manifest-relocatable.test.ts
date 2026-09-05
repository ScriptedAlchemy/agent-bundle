import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { build, createDefaultRegistry } from '../src/api.ts';
import { readArtifactManifest } from '../src/build/manifest-file.ts';
import {
  resolveManifestHost,
  resolveManifestMcpDocument,
} from '../src/build/manifest-projection.ts';
import {
  artifactManifestName,
  parseArtifactManifest,
  type ArtifactManifest,
} from '../src/build/manifest.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { stableJson } from '../src/core/digest.ts';
import { readBundleIdentity, type BundleIdentityHost } from '../src/install/identity.ts';

/**
 * Relocatable-path proof for `agent-bundle.manifest.json` (#592 step 3 / #604
 * lane C): every path the writer emits is root-relative POSIX, the raw bytes
 * never encode the build machine, and moving the composite root keeps every
 * reader working.
 */

const fixtureName = 'relocatable-fixture';
const fixtureVersion = '1.0.0';
const hosts = ['claude', 'codex', 'cursor', 'portable'] as const;
const identityHosts = ['claude', 'codex', 'cursor'] as const satisfies readonly BundleIdentityHost[];
const pathValueKeys = new Set([
  'configPath',
  'entry',
  'hooks',
  'instructions',
  'marketplace',
  'mcp',
  'path',
  'plugin',
  'script',
  'worker',
]);

const roots: string[] = [];
let projectRoot: string;
let artifactRoot: string;
let manifestBytes: string;
let manifest: ArtifactManifest;

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

const isSafeRelativePosix = (value: string): boolean => {
  const segments = value.split('/');
  return (
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    !/^[a-z]:/iu.test(value) &&
    !isAbsolute(value) &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
};

const collectPathValues = (value: unknown, key?: string, into: string[] = []): string[] => {
  if (typeof value === 'string') {
    if (key !== undefined && pathValueKeys.has(key)) into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    if (key === 'sourceInputs') {
      for (const entry of value) {
        if (typeof entry === 'string') into.push(entry);
        else collectPathValues(entry, undefined, into);
      }
      return into;
    }
    for (const entry of value) collectPathValues(entry, undefined, into);
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectPathValues(child, childKey, into);
    }
  }
  return into;
};

const artifactRelativePaths = (document: ArtifactManifest): readonly string[] => {
  const paths: string[] = [
    ...document.files.map((file) => file.path),
    ...document.executables.bins.flatMap((bin) => [bin.path, ...(bin.worker === undefined ? [] : [bin.worker])]),
    ...document.executables.hooks.map((hook) => hook.path),
    ...document.executables.scripts.flatMap((script) => [
      script.path,
      ...(script.worker === undefined ? [] : [script.worker]),
    ]),
    ...document.executables.mcpServers.flatMap((server) => [
      ...(server.entry === undefined ? [] : [server.entry.path, ...(server.entry.worker === undefined ? [] : [server.entry.worker])]),
      ...server.apps.flatMap((app) => app.path === undefined ? [] : [app.path]),
    ]),
    ...document.projections.flatMap((projection) => Object.values(projection.documents)),
    ...(document.web?.apps ?? []).map((app) => app.entry),
  ];
  const install = document.distribution.install;
  if (install?.instructions !== undefined) paths.push(install.instructions);
  if (install?.script !== undefined) paths.push(install.script);
  return paths;
};

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-relocatable-proj-'));
  roots.push(projectRoot);
  artifactRoot = join(projectRoot, 'artifact');
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(projectRoot, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(projectRoot, 'package.json', `${JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        zod: '4.4.3',
      },
      name: fixtureName,
      type: 'module',
      version: fixtureVersion,
    })}\n`),
    writeProjectFile(projectRoot, 'agent-bundle.config.ts', [
      'export default {',
      '  marketplace: true,',
      "  hooks: { sessionStart: './src/hooks/session-start.ts' },",
      '  mcp: {',
      '    servers: {',
      '      echo: {',
      "        apps: { echo: { entry: './src/views/echo.ts', resourceUri: 'ui://relocatable/echo.html', template: './src/views/echo.html' } },",
      "        entry: './src/mcp/echo.ts',",
      '      },',
      '    },',
      '  },',
      `  plugin: { description: 'Proves manifest paths stay relocatable.', name: ${JSON.stringify(fixtureName)} },`,
      "  scripts: { greet: './src/scripts/greet.ts' },",
      `  targets: ${JSON.stringify(hosts)},`,
      "  web: { apps: ['echo/echo'] },",
      '};',
      '',
    ].join('\n')),
    writeProjectFile(
      projectRoot,
      'src/hooks/session-start.ts',
      "export default () => ({ outcome: 'continue' as const, additionalContext: 'started' });\n",
    ),
    writeProjectFile(
      projectRoot,
      'src/mcp/echo.ts',
      "process.stdin.on('data', (chunk) => process.stdout.write(chunk));\n",
    ),
    writeProjectFile(projectRoot, 'src/scripts/greet.ts', "console.log('hello');\n"),
    writeProjectFile(projectRoot, 'src/views/echo.ts', "document.body.dataset.ready = 'true';\n"),
    writeProjectFile(projectRoot, 'src/views/echo.html', '<!doctype html><main id="echo">Echo</main>\n'),
    writeProjectFile(projectRoot, 'src/cli/ping.ts', [
      "import { z } from 'zod';",
      '',
      "export const config = { description: 'Ping the fixture.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
      'export default async function ping() {',
      '  return { ok: true as const };',
      '}',
      '',
    ].join('\n')),
  ]);
  await build({ output: artifactRoot, root: projectRoot, targets: [...hosts] });
  manifestBytes = await readFile(join(artifactRoot, artifactManifestName), 'utf8');
  manifest = parseArtifactManifest(manifestBytes);
}, 180_000);

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

it('emits a relocatable manifest that survives moving the composite root', async () => {
  expect(manifest.executables.hooks.length).toBeGreaterThan(0);
  expect(manifest.executables.scripts.length).toBeGreaterThan(0);
  expect(manifest.executables.bins.length).toBeGreaterThan(0);
  const compiled = manifest.executables.mcpServers.find((server) => server.entry !== undefined);
  expect(compiled?.entry?.path).toBeDefined();
  expect(manifest.web?.apps.map((app) => app.entry)).toEqual([compiled?.entry?.path]);

  const machineAbsolutes = [projectRoot, artifactRoot, tmpdir(), process.cwd()];
  for (const leaked of machineAbsolutes) {
    expect(manifestBytes.includes(leaked)).toBe(false);
  }

  const pathValues = collectPathValues(manifest);
  expect(pathValues.length).toBeGreaterThan(0);
  for (const path of pathValues) {
    expect(isSafeRelativePosix(path)).toBe(true);
  }

  const relativeFiles = new Set(manifest.files.map((file) => file.path));
  for (const path of artifactRelativePaths(manifest)) {
    expect(isSafeRelativePosix(path)).toBe(true);
    expect(relativeFiles.has(path)).toBe(true);
    const resolved = resolve(artifactRoot, path);
    expect(relative(artifactRoot, resolved).startsWith('..')).toBe(false);
    await access(resolved);
  }

  const destParent = await mkdtemp(join(tmpdir(), 'agent-bundle-relocatable-dst-'));
  roots.push(destParent);
  const moved = join(destParent, 'nested', 'moved-artifact');
  await mkdir(dirname(moved), { recursive: true });
  await rename(artifactRoot, moved);

  expect(await validateArtifact({ artifactRoot: moved })).toEqual([]);
  const read = await readArtifactManifest(moved);
  expect(read.status).toBe('ok');
  if (read.status !== 'ok') throw new Error('expected a valid relocated manifest');
  expect(read.manifest).toEqual(manifest);
  expect(await readFile(read.path, 'utf8')).toBe(manifestBytes);

  const registry = createDefaultRegistry();
  for (const host of identityHosts) {
    const identity = await readBundleIdentity(moved, host);
    expect(identity.bundleRoot).toBe(moved);
    for (const document of Object.values(identity.documents)) {
      expect(isSafeRelativePosix(document)).toBe(true);
      const resolved = resolve(moved, document);
      expect(relative(moved, resolved).startsWith('..')).toBe(false);
      await access(resolved);
    }
  }

  const originalPointers = Object.freeze(hosts.flatMap((host) => {
    if (!registry.supports(host, 'mcp')) return [];
    return [{
      document: resolveManifestMcpDocument(manifest, host, 'echo', registry),
      host: resolveManifestHost(manifest, { capability: 'mcp', requested: host, server: 'echo' }, registry),
    }];
  }));
  const movedPointers = Object.freeze(hosts.flatMap((host) => {
    if (!registry.supports(host, 'mcp')) return [];
    return [{
      document: resolveManifestMcpDocument(read.manifest, host, 'echo', registry),
      host: resolveManifestHost(read.manifest, { capability: 'mcp', requested: host, server: 'echo' }, registry),
    }];
  }));
  expect(movedPointers).toEqual(originalPointers);
  for (const pointer of movedPointers) {
    expect(isSafeRelativePosix(pointer.document)).toBe(true);
    await access(resolve(moved, pointer.document));
  }

  const forge = (): {
    executables: { mcpServers: { entry?: { path: string } }[] };
    web: { apps: { entry: string }[] };
  } => JSON.parse(manifestBytes);
  const forged = forge();
  const entry = forged.executables.mcpServers.find((server) => server.entry !== undefined)?.entry;
  if (entry === undefined) throw new Error('expected a compiled MCP entry to forge');
  entry.path = resolve(moved, entry.path);
  expect(() => parseArtifactManifest(`${stableJson(forged)}\n`)).toThrow(
    /executables\.mcpServers\[\d+\]\.entry\.path must be a safe relative POSIX path/u,
  );

  const absoluteWebEntry = forge();
  absoluteWebEntry.web.apps[0]!.entry = resolve(moved, absoluteWebEntry.web.apps[0]!.entry);
  expect(() => parseArtifactManifest(`${stableJson(absoluteWebEntry)}\n`)).toThrow(
    /web\.apps\[echo\/echo\]\.entry must be a safe relative POSIX path/u,
  );

  const unlistedWebEntry = forge();
  unlistedWebEntry.web.apps[0]!.entry = 'mcp/not-a-file.mjs';
  expect(() => parseArtifactManifest(`${stableJson(unlistedWebEntry)}\n`)).toThrow(/web\.apps\[echo\/echo\]\.entry/u);
}, 180_000);
