import { readFile } from 'node:fs/promises';
import { expect, it } from '@rstest/core';

import { TargetRegistry, createDefaultRegistry } from '../src/adapters/registry.ts';
import { createDraft7AdapterValidator } from '../src/adapters/types.ts';
import { sha256Hex } from '../src/core/digest.ts';

const validMetadata = () => ({
  adapterRevision: '1.0.0',
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
});

const registryMetadata = (registry: TargetRegistry, name: string) =>
  (registry as unknown as {
    metadata(target: string): {
      readonly adapterRevision: string;
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

  expect(registryMetadata(registry, 'portable')).toEqual({
    adapterRevision: '1.2.0',
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
    adapterRevision: '1.2.0',
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
    adapterRevision: '1.7.0',
    observedVersion: '2.1.250',
    schemas: [
      {
        name: 'hooks',
        revision: '2.1.250',
        sha256: '3c6f3e4391f3dca939d75bd0b200ea88e68db939a2cb885d46f0b143293efb84',
      },
      {
        name: 'lsp',
        revision: '2.1.250',
        sha256: 'c81fd2f57c410f70f8e5c3f84483f5ec1b575ee02802b424977826f757dccd8e',
      },
      {
        name: 'marketplace',
        revision: '2.1.250',
        sha256: '5a08f241f9e856bb59489a265d9bf4db9c905e874d720f46def59fdb6f3ca257',
      },
      {
        name: 'mcp',
        revision: '2.1.250',
        sha256: '76ccf02c7bfe2d57945ba18e84da8d655529bd68b4d692f72bce28238c99067e',
      },
      {
        name: 'plugin',
        revision: '2.1.250',
        sha256: 'f0c503ec8bc11c2ebeade8e8feed37a6c920525b0534438c37210cc50aa66a62',
      },
      {
        name: 'settings',
        revision: '2.1.250',
        sha256: '9e86d8c5e4053e8de0e468d349e2c3dde5834d22d6769372b88570e301700073',
      },
    ],
  });
  expect(registryMetadata(registry, 'cursor')).toEqual({
    adapterRevision: '1.5.0',
    observedVersion: '2026-08-28',
    schemas: [
      {
        name: 'hooks',
        revision: '2026-08-28',
        sha256: '06154b7afa0861df462130b988912b897e7ccf962b8dd20c09193100bcde5d81',
      },
      {
        name: 'marketplace',
        revision: '2026-08-28',
        sha256: '1aae96a24c2796419933bc8bfe3a1255394e7199c35740b36325e0ce6dbc253d',
      },
      {
        name: 'mcp',
        revision: '2026-08-28',
        sha256: 'f3fa4615afefe004c4fbcc09e635d890df0f1ec0cb39540feab72cbd3a31d844',
      },
      {
        name: 'plugin',
        revision: '2026-08-28',
        sha256: 'a393b758901803fcf5cfe0d77bda8a83e987d32c3377dfce2d9edf445af884ed',
      },
    ],
  });
  expect(registryMetadata(registry, 'plugin').adapterRevision).toBe('1.6.0');
});

it('records observed capability versions and rehashes schema snapshots against pinned provenance', async () => {
  const registry = createDefaultRegistry();
  const targets = [
    { capabilityFile: 'portable-1.0.0.json', provenanceFile: 'portable/PROVENANCE.json', target: 'portable', versionKey: 'version' },
    { capabilityFile: 'codex-0.147.0.json', provenanceFile: 'codex/PROVENANCE.json', target: 'codex', versionKey: 'observedCliVersion' },
    { capabilityFile: 'claude-2.1.250.json', provenanceFile: 'claude/PROVENANCE.json', target: 'claude', versionKey: 'observedCliVersion' },
    { capabilityFile: 'cursor-2026-08-28.json', provenanceFile: 'cursor/PROVENANCE.json', target: 'cursor', versionKey: 'observedCliVersion' },
  ] as const;

  for (const { capabilityFile, provenanceFile, target, versionKey } of targets) {
    const metadata = registryMetadata(registry, target);
    const [capability, provenanceText] = await Promise.all([
      readFile(new URL(`../src/adapters/capabilities/${capabilityFile}`, import.meta.url)),
      readFile(new URL(`../src/adapters/schemas/${provenanceFile}`, import.meta.url), 'utf8'),
    ]);
    const capabilityTable = JSON.parse(capability.toString()) as Record<string, unknown>;
    expect((capabilityTable.mcp as Record<string, unknown>).sse).toBeUndefined();
    const provenance = JSON.parse(provenanceText) as {
      readonly schemas: Record<string, { readonly sha256: string }>;
      readonly [key: string]: unknown;
    };

    expect(metadata.observedVersion).toBe(capabilityTable.observedCliVersion ?? capabilityTable.observedSpecificationVersion);
    expect(metadata.observedVersion).toBe(provenance[versionKey]);
    expect(metadata.schemas.map((schema) => schema.name)).toEqual(
      [...metadata.schemas].map((schema) => schema.name).sort(),
    );

    for (const schema of metadata.schemas) {
      const fileName = `${schema.name}.schema.json`;
      const content = await readFile(new URL(`../src/adapters/schemas/${target}/${fileName}`, import.meta.url));
      expect(schema.sha256).toBe(sha256Hex(content));
      expect(schema.sha256).toBe(provenance.schemas[fileName]?.sha256);
      expect(schema.revision).toBe(metadata.observedVersion);
    }

    if (target === 'cursor') {
      const pluginSchema = JSON.parse(await readFile(
        new URL('../src/adapters/schemas/cursor/plugin.schema.json', import.meta.url),
        'utf8',
      )) as { readonly properties: { readonly logo?: unknown } };
      expect(pluginSchema.properties.logo).toEqual({
        description: 'Path to a logo image (relative to the plugin root) or an absolute URL.',
        type: 'string',
      });
    }
  }
});

it('pins and validates the Codex 0.147.0 subagent wire schemas', async () => {
  const schemas = [
    {
      fixture: 'codex-subagent-start.json',
      name: 'subagent-start.command.input.schema.json',
      sha256: 'ce7dc9b5ae8826d1e0c59ffcea793e558aebceb7917a2eb9bb2edd8a7ac37aa9',
    },
    {
      name: 'subagent-start.command.output.schema.json',
      output: {
        hookSpecificOutput: {
          additionalContext: 'Review the repository test conventions first.',
          hookEventName: 'SubagentStart',
        },
      },
      sha256: '34e8ec95393d2aa930d7932a34c3fb29a5e5f90c264fdbcc581393c5838b4660',
    },
    {
      fixture: 'codex-subagent-stop.json',
      name: 'subagent-stop.command.input.schema.json',
      sha256: '94dc8df29f4691195ac2338ae6de876230e5100a10b94ef48df4e732424b5df5',
    },
    {
      name: 'subagent-stop.command.output.schema.json',
      output: { decision: 'block', reason: 'Run one more focused pass.' },
      sha256: '8ba2cd7899ae4544193764e67e988235edebe984abe5788634d123bbf13e3e3a',
    },
  ] as const;
  const validator = createDraft7AdapterValidator();

  for (const schema of schemas) {
    const bytes = await readFile(new URL(`../src/adapters/schemas/codex/generated/${schema.name}`, import.meta.url));
    // Repository text files carry one POSIX trailing newline; the pinned
    // upstream generated files do not. Hash the byte-identical upstream body.
    expect(bytes.at(-1)).toBe(10);
    expect(sha256Hex(bytes.subarray(0, -1))).toBe(schema.sha256);
    const validate = validator.compile(JSON.parse(bytes.toString()));
    const value = 'fixture' in schema
      ? JSON.parse(await readFile(new URL(`./fixtures/events/${schema.fixture}`, import.meta.url), 'utf8'))
      : schema.output;
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
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

it('snapshots canonical immutable artifact output suffixes and recursive namespaces and rejects malformed layouts', () => {
  const allowedSuffixes = ['.mjs', '.sh'];
  const registered = adapter('custom');
  const registry = new TargetRegistry().register({
    ...registered,
    artifactLayout: { bin: 'bin', scripts: { allowedSuffixes, directory: 'scripts' } },
  });
  const layout = registry.artifactLayout('custom');

  allowedSuffixes.push('.py');
  expect(layout).toEqual({
    bin: 'bin',
    scripts: { allowedSuffixes: ['.mjs', '.sh'], directory: 'scripts' },
  });
  expect(Object.isFrozen(layout)).toBe(true);
  expect(Object.isFrozen(layout.scripts)).toBe(true);
  expect(Object.isFrozen(layout.scripts?.allowedSuffixes)).toBe(true);

  const accessorSuffixes = ['.mjs'];
  Object.defineProperty(accessorSuffixes, '0', {
    enumerable: true,
    get: () => {
      throw new Error('suffix accessor must not be read');
    },
  });
  const malformedLayouts = [
    { scripts: { allowedSuffixes: [], directory: 'scripts' } },
    { scripts: { allowedSuffixes: ['mjs'], directory: 'scripts' } },
    { scripts: { allowedSuffixes: ['.sh', '.mjs'], directory: 'scripts' } },
    { scripts: { allowedSuffixes: ['.mjs', '.mjs'], directory: 'scripts' } },
    { scripts: { allowedSuffixes: accessorSuffixes, directory: 'scripts' } },
    { scripts: { allowedSuffixes: Object.setPrototypeOf(['.mjs'], null), directory: 'scripts' } },
  ];
  for (const [index, artifactLayout] of malformedLayouts.entries()) {
    expect(() => registry.register({
      ...adapter(`invalid-layout-${index}`),
      artifactLayout,
    })).toThrow(/allowed suffixes/i);
    expect(registry.names()).toEqual(['custom']);
  }
});

it('rejects malformed metadata atomically and preserves existing collision behavior', () => {
  const malformed = [
    { ...validMetadata(), adapterRevision: '' },
    { ...validMetadata(), observedVersion: '' },
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

it('rejects accessor, inherited, and prototype-backed artifact contract records atomically', () => {
  const registry = new TargetRegistry().register(adapter('existing'));
  const prototypeBackedSchema = Object.assign(Object.create({}), {
    name: 'mcp',
    validate: () => [],
  });
  const accessorSchema = Object.defineProperties({ validate: () => [] }, {
    name: {
      enumerable: true,
      get: () => {
        throw new Error('schema accessor must not be read');
      },
    },
  });
  const accessorDocument = Object.defineProperties({ path: 'mcp.json', schema: 'mcp' }, {
    required: {
      enumerable: true,
      get: () => {
        throw new Error('document accessor must not be read');
      },
    },
  });
  const inheritedRequiredDocument = Object.assign(Object.create({ required: true }), {
    path: 'mcp.json',
    schema: 'mcp',
  });
  const contract = (schemas: readonly unknown[], documents: readonly unknown[]) => ({
    documents: documents as never,
    schemas: schemas as never,
  });

  for (const [name, artifactValidation] of [
    ['prototype-schema', contract([prototypeBackedSchema, validArtifactValidation().schemas[1]!], validArtifactValidation().documents)],
    ['accessor-schema', contract([accessorSchema, validArtifactValidation().schemas[1]!], validArtifactValidation().documents)],
    ['accessor-document', contract(validArtifactValidation().schemas, [accessorDocument, validArtifactValidation().documents[1]!])],
    ['inherited-required-document', contract(validArtifactValidation().schemas, [inheritedRequiredDocument, validArtifactValidation().documents[1]!])],
  ] as const) {
    expect(() => registry.register({ ...adapter(name), artifactValidation })).toThrow(/artifact (schema contracts|documents) must contain records/i);
    expect(registry.names()).toEqual(['existing']);
  }
});
