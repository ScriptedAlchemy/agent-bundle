import { expect, it } from '@rstest/core';

import type { ArtifactManifest as ApiArtifactManifest } from '../src/api.ts';
import {
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
  Object.freeze({ path: 'skills/review/SKILL.md', sha256: hash('b') }),
]);

const validManifest = (): ArtifactManifest => ({
  agentSkills: {
    schemaSha256: 'b9079c0c10b7930e8c6a20ff2bc10cda2a3343c55185120e3f1116a1a529b220',
    sourceRevision: '69ef37e9424c0a7ea9dd2293b559e43ec8176379',
    specification: 'https://raw.githubusercontent.com/agentskills/agentskills/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx',
  },
  files: [
    {
      bytes: 18,
      kind: 'generated',
      path: 'codex/config.json',
      sha256: hash('c'),
      sourceInputs: ['agent-bundle.config.ts'],
    },
    {
      bytes: 42,
      kind: 'bundle',
      mode: 0o755,
      path: 'codex/scripts/review.mjs',
      sha256: hash('d'),
      sourceInputs: ['agent-bundle.config.ts', 'skills/review/SKILL.md'],
    },
  ],
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
  runtime: { node: '22.12.0' },
  targets: [
    {
      adapterRevision: 'codex-adapter-v1',
      capabilityRevision: 'codex-cli-0.147.0',
      capabilitySha256: hash('f'),
      name: 'codex',
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
  validation: {
    artifact: { status: 'passed' },
    source: { status: 'passed' },
    targets: [{ name: 'codex', status: 'passed' }],
  },
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
  expect(Object.isFrozen(manifest.project.sourceInputs[0]!)).toBe(true);
  expect(Object.isFrozen(manifest.targets[0]!.schemas[0]!)).toBe(true);
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
    ['missing root key', (manifest) => { delete manifest.validation; }],
    ['extra Agent Skills key', (manifest) => { (manifest.agentSkills as Record<string, unknown>).extra = true; }],
    ['missing Agent Skills key', (manifest) => { delete (manifest.agentSkills as Record<string, unknown>).specification; }],
    ['extra file key', (manifest) => { ((manifest.files as Record<string, unknown>[])[0]!).extra = true; }],
    ['missing file key', (manifest) => { delete ((manifest.files as Record<string, unknown>[])[0]!).kind; }],
    ['extra producer key', (manifest) => { (manifest.producer as Record<string, unknown>).extra = true; }],
    ['missing producer key', (manifest) => { delete (manifest.producer as Record<string, unknown>).version; }],
    ['extra project key', (manifest) => { (manifest.project as Record<string, unknown>).extra = true; }],
    ['missing project key', (manifest) => { delete (manifest.project as Record<string, unknown>).modelDigest; }],
    ['extra runtime key', (manifest) => { (manifest.runtime as Record<string, unknown>).extra = true; }],
    ['missing runtime key', (manifest) => { delete (manifest.runtime as Record<string, unknown>).node; }],
    ['extra target key', (manifest) => { ((manifest.targets as Record<string, unknown>[])[0]!).extra = true; }],
    ['missing target key', (manifest) => { delete ((manifest.targets as Record<string, unknown>[])[0]!).observedVersion; }],
    ['extra schema key', (manifest) => { ((((manifest.targets as Record<string, unknown>[])[0]!).schemas as Record<string, unknown>[])[0]!).extra = true; }],
    ['missing schema key', (manifest) => { delete ((((manifest.targets as Record<string, unknown>[])[0]!).schemas as Record<string, unknown>[])[0]!).revision; }],
    ['extra validation key', (manifest) => { (manifest.validation as Record<string, unknown>).extra = true; }],
    ['missing validation key', (manifest) => { delete (manifest.validation as Record<string, unknown>).source; }],
    ['extra validation status key', (manifest) => { ((manifest.validation as { artifact: Record<string, unknown> }).artifact).extra = true; }],
    ['missing validation status', (manifest) => { delete ((manifest.validation as { source: Record<string, unknown> }).source).status; }],
  ];

  for (const [, mutate] of cases) {
    const manifest = clone() as unknown as Record<string, unknown>;
    mutate(manifest);
    expectInvalid(manifest, /keys|status/i);
  }

  const arrayManifest = clone() as unknown as Record<string, unknown>;
  arrayManifest.project = [];
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
    [(manifest) => { manifest.agentSkills.schemaSha256 = 'A'.repeat(64); }, /sha256/i],
    [(manifest) => { manifest.agentSkills.sourceRevision = ''; }, /non-empty string/i],
    [(manifest) => { manifest.producer.version = ''; }, /non-empty string/i],
    [(manifest) => { manifest.files[0]!.bytes = -1; }, /bytes/i],
    [(manifest) => { manifest.files[0]!.bytes = Number.MAX_SAFE_INTEGER + 1; }, /bytes/i],
    [(manifest) => { manifest.files[0]!.bytes = 1.5; }, /bytes/i],
    [(manifest) => { manifest.files[1]!.mode = 0o1000; }, /mode/i],
    [(manifest) => { manifest.files[1]!.mode = -1; }, /mode/i],
    [(manifest) => { manifest.files[1]!.mode = 1.5; }, /mode/i],
    [(manifest) => { manifest.files[0]!.kind = 'other' as 'bundle'; }, /kind/i],
    [(manifest) => { manifest.validation.source.status = 'failed' as 'passed'; }, /status/i],
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
  unsortedProjectInputs.project.sourceInputs.reverse();
  const unsortedFileInputs = clone();
  unsortedFileInputs.files[1]!.sourceInputs.reverse();
  const duplicateTarget = clone();
  duplicateTarget.targets.push(structuredClone(duplicateTarget.targets[0]!));
  const unsortedSchemas = clone();
  unsortedSchemas.targets[0]!.schemas.push({
    name: 'aaa',
    revision: 'schema-v2',
    sha256: hash('9'),
  });
  const duplicateValidationTarget = clone();
  duplicateValidationTarget.validation.targets.push({ name: 'codex', status: 'passed' });
  const missingInput = clone();
  missingInput.files[0]!.sourceInputs = ['missing.ts'];
  const mismatchedConfigDigest = clone();
  mismatchedConfigDigest.project.configDigest = hash('9');
  const mismatchedRevision = clone();
  mismatchedRevision.project.revision = hash('9');
  const mismatchedValidationTargets = clone();
  mismatchedValidationTargets.validation.targets[0]!.name = 'claude';

  for (const manifest of [
    unsortedProjectInputs,
    unsortedFileInputs,
    duplicateTarget,
    unsortedSchemas,
    duplicateValidationTarget,
  ]) {
    expectInvalid(manifest, /duplicate|sorted/i);
  }
  expectInvalid(missingInput, /source input/i);
  expectInvalid(mismatchedConfigDigest, /configDigest/i);
  expectInvalid(mismatchedRevision, /revision/i);
  expectInvalid(mismatchedValidationTargets, /validation target/i);
});

it('rejects whitespace, key-order drift, and trailing input outside the canonical bytes', () => {
  const bytes = serializeArtifactManifest(validManifest());
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(validManifest()).reverse())) + '\n';

  expect(() => parseArtifactManifest(bytes.replace(':', ': '))).toThrow(/canonical/i);
  expect(() => parseArtifactManifest(reordered)).toThrow(/canonical/i);
  expect(() => parseArtifactManifest(`${bytes} `)).toThrow(/canonical|JSON/i);
});
