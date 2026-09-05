import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createDefaultRegistry } from '../../src/adapters/registry.ts';
import { listArtifactFiles, writeManifest } from '../../src/build/emit.ts';
import { artifactManifestVersion, type ArtifactManifest } from '../../src/build/manifest.ts';
import { digest } from '../../src/core/digest.ts';
import { agentSkillsSchemaRevision } from '../../src/schemas/agent-skills/contract.ts';
import { deepFreeze } from '../../src/core/freeze.ts';

const fixtureConfigDigest = 'a'.repeat(64);
const fixtureSourceInputs = deepFreeze([{
  path: 'agent-bundle.config.ts',
  sha256: fixtureConfigDigest,
}]);

export const writeFixtureManifest = async (options: {
  readonly artifactRoot: string;
  readonly targets: readonly string[];
}): Promise<ArtifactManifest> => {
  const registry = createDefaultRegistry();
  const projectionMetadata = options.targets
    .map((host) => {
      const metadata = registry.metadata(host);
      const builtInHost = registry.builtInHost(host);
      return {
        adapterRevision: metadata.adapterRevision,
        ...(builtInHost === undefined ? {} : { builtInHost }),
        host,
        observedVersion: metadata.observedVersion,
        schemas: [...metadata.schemas].sort((left, right) => left.name.localeCompare(right.name)),
      };
    })
    .sort((left, right) => left.host.localeCompare(right.host));
  const files = (await listArtifactFiles(options.artifactRoot))
    .map((file) => ({
      bytes: file.bytes,
      kind: 'generated' as const,
      ...((file.mode & 0o111) === 0 ? {} : { mode: file.mode }),
      path: file.path,
      sha256: file.sha256,
      sourceInputs: ['agent-bundle.config.ts'],
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const pluginPaths: Readonly<Record<string, string>> = {
    claude: '.claude-plugin/plugin.json',
    codex: '.codex-plugin/plugin.json',
    cursor: '.cursor-plugin/plugin.json',
    portable: 'plugin.json',
  };
  const filePaths = new Set(files.map(({ path }) => path));
  const projections = projectionMetadata.map((projection) => {
    const plugin = pluginPaths[projection.host];
    return {
      ...projection,
      documents: plugin !== undefined && filePaths.has(plugin) ? { plugin } : {},
    };
  });
  const applicationDocumentPath = projections
    .map(({ documents }) => documents.plugin)
    .find((path): path is string => path !== undefined);
  const plugin = applicationDocumentPath === undefined
    ? undefined
    : JSON.parse(await readFile(join(options.artifactRoot, applicationDocumentPath), 'utf8')) as {
        readonly description?: string;
        readonly name: string;
        readonly version: string;
      };
  return writeManifest({
    artifactRoot: options.artifactRoot,
    manifest: {
      agentSkills: agentSkillsSchemaRevision,
      application: {
        ...(plugin?.description === undefined ? {} : { description: plugin.description }),
        id: `plugin:${plugin?.name ?? 'fixture'}`,
        name: plugin?.name ?? 'fixture',
        version: plugin?.version ?? '1.0.0',
      },
      distribution: { channels: ['local'] },
      executables: {
        bins: [],
        hooks: [],
        mcpServers: [],
        scripts: [],
      },
      files,
      manifestVersion: artifactManifestVersion,
      producer: { name: 'agent-bundle', version: '0.1.0' },
      project: {
        configDigest: fixtureConfigDigest,
        configPath: 'agent-bundle.config.ts',
        modelDigest: 'b'.repeat(64),
        revision: digest({ inputs: fixtureSourceInputs }),
        sourceInputs: fixtureSourceInputs,
      },
      projections,
      routes: {
        digest: 'c'.repeat(64),
        events: [],
        layouts: [],
        providers: [],
        scripts: [],
        servers: [],
      },
      runtime: { node: '22.12.0' },
      validation: {
        artifact: { status: 'passed' },
        projections: projections.map(({ host }) => ({ host, status: 'passed' as const })),
        source: { status: 'passed' },
      },
    },
  });
};
