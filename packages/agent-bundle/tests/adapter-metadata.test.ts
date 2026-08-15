import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from '@rstest/core';

import { TargetRegistry, createDefaultRegistry } from '../src/adapters/registry.ts';

const sha256 = (contents: Uint8Array): string =>
  createHash('sha256').update(contents).digest('hex');

const validMetadata = () => ({
  adapterRevision: '1.0.0',
  capabilityRevision: '1.0.0',
  capabilitySha256: 'a'.repeat(64),
  observedVersion: '1.0.0',
  schemas: [
    { name: 'mcp', revision: '1.0.0', sha256: 'b'.repeat(64) },
    { name: 'plugin', revision: '1.0.0', sha256: 'c'.repeat(64) },
  ],
});

const validArtifactValidation = () => ({
  documents: [
    { path: 'mcp.json', required: false, schema: 'mcp' },
    { path: 'plugin.json', required: true, schema: 'plugin' },
  ],
  schemas: [
    { name: 'mcp', validate: () => [] },
    { name: 'plugin', validate: () => [] },
  ],
});

const adapter = (name: string, metadata: unknown = validMetadata(), extension?: string) => ({
  artifactValidation: validArtifactValidation(),
  capabilities: {},
  ...(extension === undefined ? {} : { configExtension: { key: extension } }),
  metadata: metadata as never,
  name,
  plan: () => ({ diagnostics: [], entries: [] }),
  validateModel: () => [],
});

const registryMetadata = (registry: TargetRegistry, name: string) =>
  (registry as unknown as {
    metadata(target: string): {
      readonly adapterRevision: string;
      readonly capabilityRevision: string;
      readonly capabilitySha256: string;
      readonly observedVersion: string;
      readonly schemas: readonly {
        readonly name: string;
        readonly revision: string;
        readonly sha256: string;
      }[];
    };
  }).metadata(name);

it('records exact immutable metadata for every built-in target', () => {
  const registry = createDefaultRegistry();

  expect(registry.supports('portable', 'sse')).toBe(true);
  expect(registryMetadata(registry, 'portable')).toEqual({
    adapterRevision: '1.0.0',
    capabilityRevision: '1.0.0',
    capabilitySha256: '84d75e50296ed0acf393742bd3934f90ff756bbd4fe5684a01b3fb4a284ee819',
    observedVersion: '1.0.0',
    schemas: [
      {
        name: 'mcp',
        revision: '1.0.0',
        sha256: '6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb',
      },
      {
        name: 'plugin',
        revision: '1.0.0',
        sha256: '0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883',
      },
    ],
  });
  expect(registryMetadata(registry, 'codex')).toEqual({
    adapterRevision: '1.0.0',
    capabilityRevision: '0.147.0',
    capabilitySha256: '1110ec8e35904d69f86ad8b9d5b886fa9fb4f0647876e6b79d4287aa4513e484',
    observedVersion: '0.147.0',
    schemas: [
      {
        name: 'hooks',
        revision: '0.147.0',
        sha256: 'e42eef736997b9abb8f28b2ee9262f5c7b1f7f11d8289e9c25da8cc94a504eff',
      },
      {
        name: 'marketplace',
        revision: '0.147.0',
        sha256: '1d43c5ed19de401fb7455c5912e4c21113f6e387aef4c28d2eca121f7554c4e8',
      },
      {
        name: 'mcp',
        revision: '0.147.0',
        sha256: '75bd50f9fcb85c2e8d43bc132d61c172a02f28ea8bb77389816ae77b14a4257e',
      },
      {
        name: 'plugin',
        revision: '0.147.0',
        sha256: 'f6e8e7d2ecb48c50ffa850d1a8190ad85ceffec705b8f0f39bb44a1d10aca0d9',
      },
    ],
  });
  expect(registryMetadata(registry, 'claude')).toEqual({
    adapterRevision: '1.0.0',
    capabilityRevision: '2.1.232',
    capabilitySha256: 'fcc2626922c9b65e971c42e1485a1970b55804832fafceac65b1ee1be057ed0b',
    observedVersion: '2.1.232',
    schemas: [
      {
        name: 'hooks',
        revision: '2.1.232',
        sha256: 'a122f0e3b83f8222186bfac6965795b75f8f50716c6d76b105864ac1a578306a',
      },
      {
        name: 'marketplace',
        revision: '2.1.232',
        sha256: 'eba6a3ab555d40926168adecf381f449d64f1b6a5635a53e67d730dd57d5faf7',
      },
      {
        name: 'mcp',
        revision: '2.1.232',
        sha256: '5c885bb78328a0f47e2bd769de653c6c9f4479ac79eba0dbcd4d4fdc011b4d17',
      },
      {
        name: 'plugin',
        revision: '2.1.232',
        sha256: '55f81e2b772afcdb4f9439b5ea09f0584257175d4ed953a0104261f1114d37cc',
      },
    ],
  });
});

it('rehashes every declared capability and schema snapshot against its pinned provenance', async () => {
  const registry = createDefaultRegistry();
  const targets = [
    { capabilityFile: 'portable-1.0.0.json', provenanceFile: 'portable/PROVENANCE.json', target: 'portable', versionKey: 'version' },
    { capabilityFile: 'codex-0.147.0.json', provenanceFile: 'codex/PROVENANCE.json', target: 'codex', versionKey: 'observedCliVersion' },
    { capabilityFile: 'claude-2.1.232.json', provenanceFile: 'claude/PROVENANCE.json', target: 'claude', versionKey: 'observedCliVersion' },
  ] as const;

  for (const { capabilityFile, provenanceFile, target, versionKey } of targets) {
    const metadata = registryMetadata(registry, target);
    const [capability, provenanceText] = await Promise.all([
      readFile(new URL(`../src/adapters/capabilities/${capabilityFile}`, import.meta.url)),
      readFile(new URL(`../src/adapters/schemas/${provenanceFile}`, import.meta.url), 'utf8'),
    ]);
    const capabilityTable = JSON.parse(capability.toString()) as Record<string, unknown>;
    const provenance = JSON.parse(provenanceText) as {
      readonly schemas: Record<string, { readonly sha256: string }>;
      readonly [key: string]: unknown;
    };

    expect(metadata.capabilitySha256).toBe(sha256(capability));
    expect(metadata.observedVersion).toBe(capabilityTable.observedCliVersion ?? capabilityTable.observedSpecificationVersion);
    expect(metadata.observedVersion).toBe(provenance[versionKey]);
    expect(metadata.schemas.map((schema) => schema.name)).toEqual(
      [...metadata.schemas].map((schema) => schema.name).sort(),
    );

    for (const schema of metadata.schemas) {
      const fileName = `${schema.name}.schema.json`;
      const content = await readFile(new URL(`../src/adapters/schemas/${target}/${fileName}`, import.meta.url));
      expect(schema.sha256).toBe(sha256(content));
      expect(schema.sha256).toBe(provenance.schemas[fileName]?.sha256);
      expect(schema.revision).toBe(metadata.observedVersion);
    }
  }
});

it('returns frozen, detached metadata snapshots while retaining the original adapter methods', () => {
  const metadata = validMetadata();
  const registered = adapter('custom', metadata);
  const registry = new TargetRegistry().register(registered);
  const snapshot = registryMetadata(registry, 'custom');

  metadata.adapterRevision = 'changed';
  metadata.schemas[0]!.name = 'changed';
  expect(snapshot).toEqual(validMetadata());
  expect(registry.get('custom')).toBe(registered);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.schemas)).toBe(true);
  expect(Object.isFrozen(snapshot.schemas[0])).toBe(true);
  expect(() => (snapshot as { adapterRevision: string }).adapterRevision = 'changed').toThrow();
  expect(() => (snapshot.schemas as unknown as { push(value: unknown): number }).push({})).toThrow();
  expect(() => (snapshot.schemas[0] as { name: string }).name = 'changed').toThrow();
});

it('rejects malformed metadata atomically and preserves existing collision behavior', () => {
  const malformed = [
    { ...validMetadata(), adapterRevision: '' },
    { ...validMetadata(), capabilityRevision: '  ' },
    { ...validMetadata(), observedVersion: '' },
    { ...validMetadata(), capabilitySha256: 'A'.repeat(64) },
    { ...validMetadata(), schemas: [{ ...validMetadata().schemas[0]!, sha256: 'not-a-hash' }] },
    { ...validMetadata(), schemas: [{ ...validMetadata().schemas[0]!, name: '' }] },
    { ...validMetadata(), schemas: [{ ...validMetadata().schemas[0]!, revision: '' }] },
    { ...validMetadata(), schemas: [validMetadata().schemas[0]!, validMetadata().schemas[0]!] },
    null,
  ];
  const registry = new TargetRegistry().register(adapter('existing', validMetadata(), 'example'));

  for (const [index, metadata] of malformed.entries()) {
    expect(() => registry.register(adapter(`invalid-${index}`, metadata))).toThrow();
    expect(registry.names()).toEqual(['existing']);
    expect(registryMetadata(registry, 'existing')).toEqual(validMetadata());
  }
  expect(() => registry.register({
    capabilities: {},
    name: 'missing-metadata',
    plan: () => ({ diagnostics: [], entries: [] }),
    validateModel: () => [],
  } as never)).toThrow();
  expect(registry.names()).toEqual(['existing']);
  expect(() => registryMetadata(registry, 'missing')).toThrow('Unknown target adapter "missing"');
  expect(() => registry.register(adapter('other', validMetadata(), 'example'))).toThrow('example');
  expect(() => registry.register(adapter('existing', validMetadata()))).toThrow('already registered');
});

it('requires a complete, uniquely owned artifact schema and document contract atomically', () => {
  const registry = new TargetRegistry().register(adapter('existing'));

  expect(() => registry.register({
    ...adapter('missing-schema'),
    artifactValidation: {
      ...validArtifactValidation(),
      schemas: [{ name: 'plugin', validate: () => [] }],
    },
  })).toThrow(/schema.*metadata|metadata.*schema/i);
  expect(registry.names()).toEqual(['existing']);

  expect(() => registry.register({
    ...adapter('duplicate-path'),
    artifactValidation: {
      ...validArtifactValidation(),
      documents: [
        { path: 'plugin.json', required: true, schema: 'mcp' },
        { path: 'plugin.json', required: true, schema: 'plugin' },
      ],
    },
  })).toThrow(/document path.*already declared/i);
  expect(registry.names()).toEqual(['existing']);
});
