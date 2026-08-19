import { createDefaultRegistry } from '../../src/adapters/registry.ts';
import { listArtifactFiles, writeHookIndex, writeManifest } from '../../src/build/emit.ts';
import type { ArtifactManifest } from '../../src/build/manifest.ts';
import { digest } from '../../src/core/digest.ts';
import { agentSkillsSchemaRevision } from '../../src/schemas/agent-skills/contract.ts';

const fixtureConfigDigest = 'a'.repeat(64);
const fixtureSourceInputs = Object.freeze([Object.freeze({
  path: 'agent-bundle.config.ts',
  sha256: fixtureConfigDigest,
})]);

export const writeFixtureManifest = async (options: {
  readonly artifactRoot: string;
  readonly targets: readonly string[];
}): Promise<ArtifactManifest> => {
  const registry = createDefaultRegistry();
  const targets = options.targets
    .map((name) => {
      const metadata = registry.metadata(name);
      return {
        adapterRevision: metadata.adapterRevision,
        capabilityRevision: metadata.capabilityRevision,
        capabilitySha256: metadata.capabilitySha256,
        name,
        observedVersion: metadata.observedVersion,
        schemas: [...metadata.schemas].sort((left, right) => left.name.localeCompare(right.name)),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  await writeHookIndex({ artifactRoot: options.artifactRoot, hooks: [] });
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
  return writeManifest({
    artifactRoot: options.artifactRoot,
    manifest: {
      agentSkills: agentSkillsSchemaRevision,
      files,
      producer: { name: 'agent-bundle', version: '0.1.0' },
      project: {
        configDigest: fixtureConfigDigest,
        configPath: 'agent-bundle.config.ts',
        modelDigest: 'b'.repeat(64),
        revision: digest({ inputs: fixtureSourceInputs }),
        sourceInputs: fixtureSourceInputs,
      },
      runtime: { node: '22.12.0' },
      targets,
      validation: {
        artifact: { status: 'passed' },
        source: { status: 'passed' },
        targets: targets.map(({ name }) => ({ name, status: 'passed' as const })),
      },
    },
  });
};
