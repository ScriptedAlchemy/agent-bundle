import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const requiredArtifacts = ['package', 'checksums', 'sbom'] as const;

interface ReleaseArtifact {
  readonly name?: unknown;
  readonly path?: unknown;
  readonly status?: unknown;
}

interface ReleaseManifest {
  readonly artifacts?: readonly ReleaseArtifact[];
  readonly changelog?: unknown;
  readonly version?: unknown;
}

const manifestPath = join(process.cwd(), 'release', 'release-manifest.json');

const readManifest = async (): Promise<ReleaseManifest> => JSON.parse(await readFile(manifestPath, 'utf8')) as ReleaseManifest;

const validationErrors = (manifest: ReleaseManifest): readonly string[] => {
  const errors: string[] = [];
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    errors.push('version must use major.minor.patch format');
  }
  if (typeof manifest.changelog !== 'string' || manifest.changelog.trim().length === 0) {
    errors.push('changelog must identify the release notes');
  }
  for (const name of requiredArtifacts) {
    const artifact = manifest.artifacts?.find((candidate) => candidate.name === name);
    if (artifact === undefined || typeof artifact.path !== 'string' || artifact.path.trim().length === 0 || artifact.status !== 'ready') {
      errors.push(`${name} artifact must have a ready path`);
    }
  }
  return errors;
};

try {
  const manifest = await readManifest();
  const errors = validationErrors(manifest);
  if (errors.length > 0) {
    process.stderr.write(`Release manifest is incomplete:\n${errors.map((error) => `- ${error}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Release ${manifest.version} is ready for packaging.\n`);
  }
} catch (error) {
  process.stderr.write(`Unable to verify release manifest: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
