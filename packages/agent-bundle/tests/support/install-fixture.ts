import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  artifactCompilerRecordVersion,
  artifactManifestName,
  assembleArtifactManifest,
  type ArtifactManifest,
  type ArtifactManifestCompilerAdapter,
  type ArtifactManifestMcpServer,
  type ArtifactManifestProjection,
} from '../../src/build/manifest.ts';
import type { WebManifest } from '../../src/web-host/manifest.ts';
import { digest, sha256Hex } from '../../src/core/digest.ts';
import type { InstallHost } from '../../src/install/install.ts';

const pluginDocuments: Readonly<Record<InstallHost, string>> = Object.freeze({
  claude: '.claude-plugin/plugin.json',
  codex: '.codex-plugin/plugin.json',
  cursor: '.cursor-plugin/plugin.json',
});

const marketplaceDocuments: Readonly<Record<Exclude<InstallHost, 'cursor'>, string>> = Object.freeze({
  claude: '.claude-plugin/marketplace.json',
  codex: '.agents/plugins/marketplace.json',
});

export interface InstallFixtureProjection {
  readonly host: InstallHost;
  readonly marketplace?: string;
  /** Root-relative host MCP document to point `documents.mcp` at; it must already exist under the bundle root. */
  readonly mcp?: string;
}

const fixtureFiles = async (root: string, relative = ''): Promise<readonly string[]> => {
  const files: string[] = [];
  for (const name of await readdir(join(root, relative))) {
    const path = relative === '' ? name : `${relative}/${name}`;
    if (
      path === artifactManifestName ||
      (relative === '' && (name === '.env' || name === '.env.local' || name === 'state'))
    ) {
      continue;
    }
    const metadata = await lstat(join(root, path));
    if (metadata.isDirectory()) files.push(...await fixtureFiles(root, path));
    else if (metadata.isFile()) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right));
};

export const writeInstallFixtureManifest = async (
  bundleRoot: string,
  application: { readonly name: string; readonly version: string },
  projections: readonly InstallFixtureProjection[],
  web?: WebManifest,
): Promise<void> => {
  const sourceInputs = Object.freeze([Object.freeze({
    path: 'agent-bundle.config.ts',
    sha256: sha256Hex('install fixture config\n'),
  })]);
  const projectionRows: ArtifactManifestProjection[] = [];
  const adapterRows: ArtifactManifestCompilerAdapter[] = [];
  for (const projection of projections) {
    const plugin = pluginDocuments[projection.host];
    const marketplace = projection.host === 'cursor'
      ? undefined
      : marketplaceDocuments[projection.host];
    projectionRows.push({
      // The fixture hosts are the shipped adapters, so identity and name coincide.
      builtInHost: projection.host,
      documents: {
        ...(marketplace === undefined ? {} : { marketplace }),
        ...(projection.mcp === undefined ? {} : { mcp: projection.mcp }),
        plugin,
      },
      host: projection.host,
      ...(projection.marketplace === undefined
        ? {}
        : { marketplace: { name: projection.marketplace } }),
    });
    adapterRows.push({
      adapterRevision: `${projection.host}-fixture-v1`,
      host: projection.host,
      observedVersion: 'fixture',
      schemas: [],
    });
  }
  projectionRows.sort((left, right) => left.host.localeCompare(right.host));
  adapterRows.sort((left, right) => left.host.localeCompare(right.host));
  // Every exposed App names a compiled server whose launch record the fixture
  // roots at `mcp/<server>.mjs`; callers write that file beside the manifest.
  const mcpServers: ArtifactManifestMcpServer[] = [...new Set((web?.apps ?? []).map((app) => app.server))]
    .sort((left, right) => left.localeCompare(right))
    .map((server) => ({
      apps: [],
      hosts: projectionRows.map(({ host }) => host),
      id: `mcp:${server}`,
      kind: 'compiled',
      launch: { args: [], entry: `mcp/${server}.mjs`, env: {} },
      name: server,
      transport: 'stdio',
    }));
  const files = await Promise.all((await fixtureFiles(bundleRoot)).map(async (path) => {
    const bytes = await readFile(join(bundleRoot, path));
    return {
      bytes: bytes.length,
      kind: 'generated' as const,
      path,
      sha256: sha256Hex(bytes),
    };
  }));
  const manifest: ArtifactManifest = {
    application: {
      id: `application:${application.name}`,
      name: application.name,
      version: application.version,
    },
    compiler: {
      adapters: adapterRows,
      agentSkills: {
        schemaSha256: 'b9079c0c10b7930e8c6a20ff2bc10cda2a3343c55185120e3f1116a1a529b220',
        sourceRevision: '69ef37e9424c0a7ea9dd2293b559e43ec8176379',
        specification: 'https://raw.githubusercontent.com/agentskills/agentskills/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx',
      },
      producer: { name: 'agent-bundle', version: '0.1.0' },
      project: {
        configDigest: sourceInputs[0]!.sha256,
        configPath: sourceInputs[0]!.path,
        modelDigest: sha256Hex('install fixture model\n'),
        revision: digest({ inputs: sourceInputs }),
        sourceInputs,
      },
      provenance: files.map((file) => ({
        path: file.path,
        sourceInputs: ['agent-bundle.config.ts'],
      })),
      recordVersion: artifactCompilerRecordVersion,
      validation: {
        artifact: { status: 'passed' },
        projections: projectionRows.map(({ host }) => ({ host, status: 'passed' })),
        source: { status: 'passed' },
      },
    },
    distribution: { channels: ['local'], payloads: [] },
    executables: { bins: [], hooks: [], mcpServers, scripts: [] },
    files,
    manifestVersion: 2,
    projections: projectionRows,
    ...(web === undefined ? {} : { web }),
    routes: {
      digest: sha256Hex('install fixture routes\n'),
      events: [],
      layouts: [],
      providers: [],
      scripts: [],
      servers: [],
    },
    runtime: { node: '22.12.0' },
  };
  await writeFile(join(bundleRoot, artifactManifestName), assembleArtifactManifest(manifest).bytes);
};
