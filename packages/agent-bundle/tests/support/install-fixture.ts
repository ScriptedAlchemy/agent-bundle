import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  artifactManifestName,
  assembleArtifactManifest,
  type ArtifactManifest,
  type ArtifactManifestProjection,
} from '../../src/build/manifest.ts';
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

export const writeInstallFixtureManifest = async (
  bundleRoot: string,
  application: { readonly name: string; readonly version: string },
  projections: readonly InstallFixtureProjection[],
): Promise<void> => {
  const sourceInputs = Object.freeze([Object.freeze({
    path: 'agent-bundle.config.ts',
    sha256: sha256Hex('install fixture config\n'),
  })]);
  const projectionRows: ArtifactManifestProjection[] = [];
  const documentPaths = new Set<string>();
  for (const projection of projections) {
    const plugin = pluginDocuments[projection.host];
    const marketplace = projection.host === 'cursor'
      ? undefined
      : marketplaceDocuments[projection.host];
    documentPaths.add(plugin);
    if (marketplace !== undefined) documentPaths.add(marketplace);
    if (projection.mcp !== undefined) documentPaths.add(projection.mcp);
    projectionRows.push({
      adapterRevision: `${projection.host}-fixture-v1`,
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
      observedVersion: 'fixture',
      schemas: [],
    });
  }
  projectionRows.sort((left, right) => left.host.localeCompare(right.host));
  const files = await Promise.all([...documentPaths].sort().map(async (path) => {
    const bytes = await readFile(join(bundleRoot, path));
    return {
      bytes: bytes.length,
      kind: 'generated' as const,
      path,
      sha256: sha256Hex(bytes),
      sourceInputs: ['agent-bundle.config.ts'],
    };
  }));
  const manifest: ArtifactManifest = {
    agentSkills: {
      schemaSha256: 'b9079c0c10b7930e8c6a20ff2bc10cda2a3343c55185120e3f1116a1a529b220',
      sourceRevision: '69ef37e9424c0a7ea9dd2293b559e43ec8176379',
      specification: 'https://raw.githubusercontent.com/agentskills/agentskills/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx',
    },
    application: {
      id: `application:${application.name}`,
      name: application.name,
      version: application.version,
    },
    distribution: { channels: ['local'] },
    executables: { bins: [], hooks: [], mcpServers: [], scripts: [] },
    files,
    manifestVersion: 2,
    producer: { name: 'agent-bundle', version: '0.1.0' },
    project: {
      configDigest: sourceInputs[0]!.sha256,
      configPath: sourceInputs[0]!.path,
      modelDigest: sha256Hex('install fixture model\n'),
      revision: digest({ inputs: sourceInputs }),
      sourceInputs,
    },
    projections: projectionRows,
    routes: {
      digest: sha256Hex('install fixture routes\n'),
      events: [],
      layouts: [],
      providers: [],
      scripts: [],
      servers: [],
    },
    runtime: { node: '22.12.0' },
    validation: {
      artifact: { status: 'passed' },
      projections: projectionRows.map(({ host }) => ({ host, status: 'passed' })),
      source: { status: 'passed' },
    },
  };
  await writeFile(join(bundleRoot, artifactManifestName), assembleArtifactManifest(manifest).bytes);
};
