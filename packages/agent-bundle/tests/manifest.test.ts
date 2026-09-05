import { expect, it } from '@rstest/core';

import type { ArtifactManifest as ApiArtifactManifest } from '../src/api.ts';
import {
  artifactCompilerRecordVersion,
  artifactManifestVersion,
  assembleArtifactManifest,
  parseArtifactManifest,
  serializeArtifactManifest,
  type ArtifactManifest,
} from '../src/build/manifest.ts';
import { digest, stableJson } from '../src/core/digest.ts';
import { evalTargetDigests } from '../src/eval/artifact.ts';
import type { ArtifactManifest as PublicArtifactManifest } from '../src/index.ts';

const hash = (character: string): string => character.repeat(64);

const sourceInputs = Object.freeze([
  Object.freeze({ path: 'agent-bundle.config.ts', sha256: hash('a') }),
  Object.freeze({ executable: true, path: 'src/skills/review/SKILL.md', sha256: hash('b') }),
]);

const validManifest = (): ArtifactManifest => ({
  application: {
    id: 'plugin:review-tools',
    name: 'review-tools',
    version: '1.0.0',
  },
  compiler: {
    adapters: [
      {
        adapterRevision: 'codex-adapter-v1',
        host: 'codex',
        observedVersion: '0.147.0',
        schemas: [
          {
            name: 'agent-skills-frontmatter',
            revision: '69ef37e9424c0a7ea9dd2293b559e43ec8176379',
            sha256: 'b9079c0c10b7930e8c6a20ff2bc10cda2a3343c55185120e3f1116a1a529b220',
          },
        ],
      },
    ],
    agentSkills: {
      schemaSha256: 'b9079c0c10b7930e8c6a20ff2bc10cda2a3343c55185120e3f1116a1a529b220',
      sourceRevision: '69ef37e9424c0a7ea9dd2293b559e43ec8176379',
      specification: 'https://raw.githubusercontent.com/agentskills/agentskills/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx',
    },
    producer: {
      name: 'agent-bundle',
      version: '0.1.0',
    },
    project: {
      configDigest: hash('a'),
      configPath: 'agent-bundle.config.ts',
      modelDigest: hash('e'),
      revision: digest({ inputs: sourceInputs }),
      sourceInputs,
    },
    provenance: [
      { path: 'codex/config.json', sourceInputs: ['agent-bundle.config.ts'] },
      {
        path: 'codex/scripts/review.mjs',
        sourceInputs: ['agent-bundle.config.ts', 'src/skills/review/SKILL.md'],
      },
    ],
    recordVersion: artifactCompilerRecordVersion,
    validation: {
      artifact: { status: 'passed' },
      projections: [{ host: 'codex', status: 'passed' }],
      source: { status: 'passed' },
    },
  },
  distribution: { channels: ['local'] },
  executables: {
    bins: [],
    hooks: [{
      event: 'sessionStart',
      host: 'codex',
      id: 'hook:review',
      kind: 'config',
      name: 'review',
      path: 'codex/scripts/review.mjs',
    }],
    mcpServers: [],
    scripts: [],
  },
  files: [
    {
      bytes: 18,
      kind: 'generated',
      path: 'codex/config.json',
      sha256: hash('c'),
    },
    {
      bytes: 42,
      kind: 'bundle',
      mode: 0o755,
      path: 'codex/scripts/review.mjs',
      sha256: hash('d'),
    },
  ],
  manifestVersion: artifactManifestVersion,
  projections: [
    {
      documents: {},
      host: 'codex',
    },
  ],
  routes: {
    digest: hash('f'),
    events: [],
    layouts: [],
    providers: [],
    scripts: [],
    servers: [],
  },
  runtime: { node: '22.12.0' },
});

const canonicalBytes = (manifest: unknown): string => `${stableJson(manifest)}\n`;

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;

type MutableArtifactManifest = Mutable<ArtifactManifest>;

const expectInvalid = (manifest: unknown, message?: RegExp): void => {
  const bytes = canonicalBytes(manifest);
  expect(() => parseArtifactManifest(bytes)).toThrow(message ?? /manifest/i);
};

const clone = (): MutableArtifactManifest =>
  structuredClone(validManifest()) as unknown as MutableArtifactManifest;

it('serializes the exact canonical fixture and accepts its Agent Skills and adapter records', () => {
  const manifest = validManifest();
  const expected = `${stableJson(manifest)}\n`;

  expect(serializeArtifactManifest(manifest)).toBe(expected);
  expect(parseArtifactManifest(expected)).toEqual(manifest);
  expect(assembleArtifactManifest(manifest)).toEqual(Object.freeze({
    bytes: expected,
    manifest: parseArtifactManifest(expected),
  }));
});

it('returns a deeply frozen manifest and exports the public manifest type', () => {
  const manifest = parseArtifactManifest(serializeArtifactManifest(validManifest()));
  const apiManifest: ApiArtifactManifest = manifest;
  const publicManifest: PublicArtifactManifest = manifest;

  expect(apiManifest).toBe(publicManifest);
  expect(Object.isFrozen(manifest)).toBe(true);
  expect(Object.isFrozen(manifest.files)).toBe(true);
  expect(Object.isFrozen(manifest.files[0]!)).toBe(true);
  expect(Object.isFrozen(manifest.compiler.project.sourceInputs[0]!)).toBe(true);
  expect(Object.isFrozen(manifest.compiler.adapters[0]!.schemas[0]!)).toBe(true);
  expect(() => {
    (manifest.files as unknown as { push(value: unknown): void }).push({});
  }).toThrow(TypeError);
});

it('produces root-independent canonical bytes without silently sorting caller arrays', () => {
  const first = assembleArtifactManifest(validManifest());
  const second = assembleArtifactManifest(structuredClone(validManifest()));
  const unsorted = clone();
  unsorted.files.reverse();

  expect(first.bytes).toBe(second.bytes);
  expect(() => assembleArtifactManifest(unsorted)).toThrow(/sorted/i);
});

it('rejects object shapes, JSON containers, and duplicate JSON keys strictly', () => {
  const cases: readonly [string, (manifest: Record<string, unknown>) => void][] = [
    ['extra root key', (manifest) => { manifest.extra = true; }],
    ['missing root key', (manifest) => { delete manifest.compiler; }],
    ['extra Agent Skills key', (manifest) => { ((manifest.compiler as { agentSkills: Record<string, unknown> }).agentSkills).extra = true; }],
    ['missing Agent Skills key', (manifest) => { delete ((manifest.compiler as { agentSkills: Record<string, unknown> }).agentSkills).specification; }],
    ['extra file key', (manifest) => { ((manifest.files as Record<string, unknown>[])[0]!).extra = true; }],
    ['missing file key', (manifest) => { delete ((manifest.files as Record<string, unknown>[])[0]!).kind; }],
    ['extra producer key', (manifest) => { ((manifest.compiler as { producer: Record<string, unknown> }).producer).extra = true; }],
    ['missing producer key', (manifest) => { delete ((manifest.compiler as { producer: Record<string, unknown> }).producer).version; }],
    ['extra project key', (manifest) => { ((manifest.compiler as { project: Record<string, unknown> }).project).extra = true; }],
    ['missing project key', (manifest) => { delete ((manifest.compiler as { project: Record<string, unknown> }).project).modelDigest; }],
    ['extra runtime key', (manifest) => { (manifest.runtime as Record<string, unknown>).extra = true; }],
    ['missing runtime key', (manifest) => { delete (manifest.runtime as Record<string, unknown>).node; }],
    ['extra projection key', (manifest) => { ((manifest.projections as Record<string, unknown>[])[0]!).extra = true; }],
    ['missing projection key', (manifest) => { delete ((manifest.projections as Record<string, unknown>[])[0]!).host; }],
    ['extra schema key', (manifest) => { (((((manifest.compiler as { adapters: { schemas: Record<string, unknown>[] }[] }).adapters)[0]!).schemas as Record<string, unknown>[])[0]!).extra = true; }],
    ['missing schema key', (manifest) => { delete (((((manifest.compiler as { adapters: { schemas: Record<string, unknown>[] }[] }).adapters)[0]!).schemas as Record<string, unknown>[])[0]!).revision; }],
    ['extra validation key', (manifest) => { ((manifest.compiler as { validation: Record<string, unknown> }).validation).extra = true; }],
    ['missing validation key', (manifest) => { delete ((manifest.compiler as { validation: Record<string, unknown> }).validation).source; }],
    ['extra validation status key', (manifest) => { ((manifest.compiler as { validation: { artifact: Record<string, unknown> } }).validation.artifact).extra = true; }],
    ['missing validation status', (manifest) => { delete ((manifest.compiler as { validation: { source: Record<string, unknown> } }).validation.source).status; }],
  ];

  for (const [, mutate] of cases) {
    const manifest = clone() as unknown as Record<string, unknown>;
    mutate(manifest);
    expectInvalid(manifest, /keys|status/i);
  }

  const arrayManifest = clone() as unknown as Record<string, unknown>;
  (arrayManifest.compiler as { project: unknown }).project = [];
  expectInvalid(arrayManifest, /object/i);
  expect(() => assembleArtifactManifest(new (class {})() as ArtifactManifest)).toThrow(/plain object/i);
  const duplicateKey = 'private-key';
  let duplicateError: unknown;
  try {
    parseArtifactManifest(`{"${duplicateKey}":true,"${duplicateKey}":false}`);
  } catch (error) {
    duplicateError = error;
  }
  expect(duplicateError).toBeInstanceOf(SyntaxError);
  expect((duplicateError as Error).message).toBe('Artifact manifest contains a duplicate JSON key.');
  expect((duplicateError as Error).message).not.toContain(duplicateKey);
  expect((duplicateError as Error & { readonly cause: Error }).cause.message).toBe('Artifact manifest JSON parsing failed.');
  expect((duplicateError as Error & { readonly cause: Error }).cause.message).not.toContain(duplicateKey);
  expect(() => parseArtifactManifest('{')).toThrow('Artifact manifest is not valid JSON.');
});

it('rejects malformed scalar fields, unsafe paths, and manifest self-listing', () => {
  const mutations: readonly [(manifest: MutableArtifactManifest) => void, RegExp][] = [
    [(manifest) => { manifest.compiler.agentSkills.schemaSha256 = 'A'.repeat(64); }, /sha256/i],
    [(manifest) => { manifest.compiler.agentSkills.sourceRevision = ''; }, /non-empty string/i],
    [(manifest) => { manifest.compiler.producer.version = ''; }, /non-empty string/i],
    [(manifest) => { manifest.files[0]!.bytes = -1; }, /bytes/i],
    [(manifest) => { manifest.files[0]!.bytes = Number.MAX_SAFE_INTEGER + 1; }, /bytes/i],
    [(manifest) => { manifest.files[0]!.bytes = 1.5; }, /bytes/i],
    [(manifest) => { manifest.files[1]!.mode = 0o1000; }, /mode/i],
    [(manifest) => { manifest.files[1]!.mode = -1; }, /mode/i],
    [(manifest) => { manifest.files[1]!.mode = 1.5; }, /mode/i],
    [(manifest) => { manifest.compiler.project.sourceInputs[1]!.executable = 'yes' as unknown as boolean; }, /executable.*boolean/i],
    [(manifest) => { manifest.files[0]!.kind = 'other' as 'bundle'; }, /kind/i],
    [(manifest) => { manifest.compiler.validation.source.status = 'failed' as 'passed'; }, /status/i],
    [(manifest) => { manifest.files[0]!.path = ''; }, /path/i],
    [(manifest) => { manifest.files[0]!.path = '.'; }, /path/i],
    [(manifest) => { manifest.files[0]!.path = './file'; }, /path/i],
    [(manifest) => { manifest.files[0]!.path = '/file'; }, /path/i],
    [(manifest) => { manifest.files[0]!.path = '../file'; }, /path/i],
    [(manifest) => { manifest.files[0]!.path = 'folder\\file'; }, /path/i],
    [(manifest) => { manifest.files[0]!.path = 'agent-bundle.manifest.json'; }, /manifest/i],
    [(manifest) => { manifest.runtime.node = ''; }, /non-empty string/i],
    [(manifest) => { manifest.runtime.node = '22.12'; }, /major\.minor\.patch/i],
    [(manifest) => { manifest.runtime.node = 'v22.12.0'; }, /major\.minor\.patch/i],
    [(manifest) => { manifest.runtime.node = '22.012.0'; }, /major\.minor\.patch/i],
    [(manifest) => { manifest.runtime.node = '22.11.9'; }, /runtime floor/i],
  ];

  for (const [mutate, message] of mutations) {
    const manifest = clone();
    mutate(manifest);
    expectInvalid(manifest, message);
  }
});

it('records a raised generated-executable runtime floor exactly as selected', () => {
  const raised = clone();
  raised.runtime.node = '24.3.1';

  const manifest = parseArtifactManifest(canonicalBytes(raised));
  expect(manifest.runtime).toEqual({ node: '24.3.1' });
  expect(Object.isFrozen(manifest.runtime)).toBe(true);
});

it('includes the generated runtime floor in Eval target identity', () => {
  const baseline = validManifest();
  const raised = structuredClone(baseline) as MutableArtifactManifest;
  raised.runtime.node = '24.3.1';

  expect(evalTargetDigests(baseline).codex).not.toBe(evalTargetDigests(raised).codex);
});

it('rejects duplicate or unsorted arrays and cross-record inconsistencies', () => {
  const unsortedProjectInputs = clone();
  unsortedProjectInputs.compiler.project.sourceInputs.reverse();
  const unsortedFileInputs = clone();
  unsortedFileInputs.compiler.provenance[1]!.sourceInputs.reverse();
  const duplicateProjection = clone();
  duplicateProjection.projections.push(structuredClone(duplicateProjection.projections[0]!));
  duplicateProjection.compiler.adapters.push(structuredClone(duplicateProjection.compiler.adapters[0]!));
  const unsortedSchemas = clone();
  unsortedSchemas.compiler.adapters[0]!.schemas.push({
    name: 'aaa',
    revision: 'schema-v2',
    sha256: hash('9'),
  });
  const duplicateValidationProjection = clone();
  duplicateValidationProjection.compiler.validation.projections.push({ host: 'codex', status: 'passed' });
  const missingInput = clone();
  missingInput.compiler.provenance[0]!.sourceInputs = ['missing.ts'];
  const mismatchedConfigDigest = clone();
  mismatchedConfigDigest.compiler.project.configDigest = hash('9');
  const mismatchedRevision = clone();
  mismatchedRevision.compiler.project.revision = hash('9');
  const mismatchedValidationProjections = clone();
  mismatchedValidationProjections.compiler.validation.projections[0]!.host = 'claude';

  for (const manifest of [
    unsortedProjectInputs,
    unsortedFileInputs,
    duplicateProjection,
    unsortedSchemas,
    duplicateValidationProjection,
  ]) {
    expectInvalid(manifest, /duplicate|sorted/i);
  }
  expectInvalid(missingInput, /source input/i);
  expectInvalid(mismatchedConfigDigest, /configDigest/i);
  expectInvalid(mismatchedRevision, /revision/i);
  expectInvalid(mismatchedValidationProjections, /compiler\.validation\.projections/i);
});

it('rejects whitespace, key-order drift, and trailing input outside the canonical bytes', () => {
  const bytes = serializeArtifactManifest(validManifest());
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(validManifest()).reverse())) + '\n';

  expect(() => parseArtifactManifest(bytes.replace(':', ': '))).toThrow(/canonical/i);
  expect(() => parseArtifactManifest(reordered)).toThrow(/canonical/i);
  expect(() => parseArtifactManifest(`${bytes} `)).toThrow(/canonical|JSON/i);
});

it('round-trips the optional package identity axes distinctly', () => {
  const manifest = validManifest();
  (manifest.compiler.project as { packageName?: string }).packageName = '@agent-bundle-example/audiobook-curator';
  (manifest.compiler.project as { packageVersion?: string }).packageVersion = '1.0.0';
  (manifest.distribution as { channels: ('local' | 'npm')[] }).channels.push('npm');
  const assembled = assembleArtifactManifest(manifest);
  expect(assembled.manifest.compiler.project.packageName).toBe('@agent-bundle-example/audiobook-curator');
  expect(assembled.manifest.compiler.project.packageVersion).toBe('1.0.0');
  expect(parseArtifactManifest(assembled.bytes).compiler.project).toMatchObject({
    packageName: '@agent-bundle-example/audiobook-curator',
    packageVersion: '1.0.0',
  });
});

it('round-trips and deeply freezes the optional web section', () => {
  const source: ArtifactManifest = {
    ...validManifest(),
    web: {
      apps: [{
        allow: ['call-tool'],
        app: 'catalog/details',
        args: [],
        entry: 'mcp/mcp-catalog-01234567.mjs',
        env: { TOKEN: 'agent-bundle:path:plugin-data/token' },
        name: 'details',
        resourceUri: 'ui://catalog/details',
        server: 'catalog',
      }],
      open: 'never',
    },
  };
  const manifest = parseArtifactManifest(serializeArtifactManifest(source));

  expect(manifest.web).toEqual(source.web);
  expect(Object.isFrozen(manifest.web)).toBe(true);
  expect(Object.isFrozen(manifest.web?.apps[0])).toBe(true);
});

it('accepts a project without package identity and rejects invalid identity values', () => {
  const withoutIdentity = assembleArtifactManifest(validManifest());
  expect(withoutIdentity.manifest.compiler.project.packageName).toBeUndefined();
  expect(withoutIdentity.manifest.compiler.project.packageVersion).toBeUndefined();

  const invalidName = validManifest();
  (invalidName.compiler.project as { packageName?: string }).packageName = 'Not A Valid Name';
  expect(() => serializeArtifactManifest(invalidName))
    .toThrow('compiler.project.packageName must be a valid npm package name.');

  const invalidVersion = validManifest();
  (invalidVersion.compiler.project as { packageVersion?: string }).packageVersion = 'v1.0.0';
  expect(() => serializeArtifactManifest(invalidVersion))
    .toThrow('compiler.project.packageVersion must be a valid semantic version.');
});
