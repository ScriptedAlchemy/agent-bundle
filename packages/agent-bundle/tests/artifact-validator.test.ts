import { supportedCapabilities } from './support/adapter-capabilities.ts';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from '@rstest/core';

import { createDefaultRegistry, TargetRegistry } from '../src/adapters/registry.ts';
import { readStandardNativeHookCommands, type TargetHookContract } from '../src/adapters/hook-contract.ts';
import {
  validateModernMcpDocument,
  type TargetAdapter,
  type TargetArtifactDocumentValidator,
  type TargetArtifactWrite,
} from '../src/adapters/types.ts';
import { assembleArtifactManifest, type ArtifactManifest } from '../src/build/manifest.ts';
import { artifactDiagnosticRecoveries, validateArtifact, validateArtifactWithSnapshot } from '../src/build/validate-artifact.ts';
import { digest, sha256Hex } from '../src/core/digest.ts';
import { agentSkillsSchemaRevision } from '../src/schemas/agent-skills/contract.ts';
import { createMcpPathTokenResolver } from '../src/services/mcp-path-tokens.ts';
import { createTargetMcpRuntime } from '../src/services/mcp-runtime.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';

const hash = (value: string): string => sha256Hex(value);

const createFifo = async (path: string): Promise<void> => new Promise((resolvePromise, reject) => {
  execFile('mkfifo', [path], (error) => {
    if (error === null) resolvePromise();
    else reject(error);
  });
});

interface ArtifactFixtureFile {
  readonly contents: string;
  readonly kind: 'bundle' | 'copy' | 'generated';
  readonly mode?: number;
  readonly path: string;
}

const withHookIndex = (files: readonly ArtifactFixtureFile[]): readonly ArtifactFixtureFile[] =>
  files.some((file) => file.path === 'agent-bundle.hooks.json')
    ? files
    : [{ contents: '{"hooks":[]}\n', kind: 'generated', path: 'agent-bundle.hooks.json' }, ...files];

const manifestFor = (
  files: readonly ArtifactFixtureFile[],
  includeModes = true,
  targets: readonly ArtifactManifest['targets'][number][] = [],
): ArtifactManifest => {
  const configHash = hash('export default {};\n');
  const sourceInputs = [{ path: 'agent-bundle.config.ts', sha256: configHash }];
  return {
    agentSkills: agentSkillsSchemaRevision,
    files: files
      .map((file) => ({
        bytes: Buffer.byteLength(file.contents),
        kind: file.kind,
        ...(includeModes && file.mode !== undefined ? { mode: file.mode } : {}),
        path: file.path,
        sha256: hash(file.contents),
        sourceInputs: ['agent-bundle.config.ts'],
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    producer: { name: 'agent-bundle', version: '0.1.0' },
    project: {
      configDigest: configHash,
      configPath: 'agent-bundle.config.ts',
      modelDigest: 'b'.repeat(64),
      revision: digest({ inputs: sourceInputs }),
      sourceInputs,
    },
    runtime: { node: '22.12.0' },
    targets,
    validation: {
      artifact: { status: 'passed' },
      source: { status: 'passed' },
      targets: targets.map(({ name }) => ({ name, status: 'passed' })),
    },
  };
};

const writeArtifact = async (
  files: readonly ArtifactFixtureFile[],
  includeModes = true,
  targets: readonly ArtifactManifest['targets'][number][] = [],
  includeHookIndex = true,
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-validator-'));
  const artifactFiles = includeHookIndex ? withHookIndex(files) : files;
  for (const file of artifactFiles) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents);
    if (file.mode !== undefined) await chmod(path, file.mode);
  }
  await writeFile(
    join(root, 'agent-bundle.manifest.json'),
    assembleArtifactManifest(manifestFor(artifactFiles, includeModes, targets)).bytes,
  );
  return root;
};

const customTarget = 'custom';
const customMetadata = Object.freeze({
  adapterRevision: 'custom-adapter-v1',
  observedVersion: 'custom-observed-v1',
  schemas: Object.freeze([Object.freeze({
    name: 'document',
    revision: 'custom-schema-v1',
    sha256: 'b'.repeat(64),
  })]),
});

const customManifestTarget = Object.freeze({
  ...customMetadata,
  name: customTarget,
});

const coherenceTarget = 'coherent';
const coherenceMetadata = Object.freeze({
  adapterRevision: 'coherence-adapter-v1',
  observedVersion: 'coherence-observed-v1',
  schemas: Object.freeze([]),
});

const coherenceManifestTarget = Object.freeze({ ...coherenceMetadata, name: coherenceTarget });

const coherenceRegistry = (): TargetRegistry => new TargetRegistry().register({
  artifactLayout: { mcpEntries: { allowedSuffixes: ['.mjs'], directory: 'mcp' } },
  capabilities: supportedCapabilities('mcp'),
  mcpRuntime: createTargetMcpRuntime({
    manifestPath: 'native/servers.json',
    remoteTypes: ['streamable-http'],
    resolveValue: createMcpPathTokenResolver({ target: coherenceTarget, tokens: {} }),
  }),
  metadata: coherenceMetadata,
  name: coherenceTarget,
  plan: () => ({ diagnostics: [], entries: [] }),
} satisfies TargetAdapter);

const hookCoherenceTarget = 'hooked';
const hookCoherenceMetadata = Object.freeze({
  adapterRevision: 'hook-coherence-adapter-v1',
  observedVersion: 'hook-coherence-observed-v1',
  schemas: Object.freeze([]),
});

const hookCoherenceManifestTarget = Object.freeze({ ...hookCoherenceMetadata, name: hookCoherenceTarget });

const hookCoherenceContract = {
  commandRoot: '${HOOK_ROOT}',
  encodePlaygroundInput: (input: Readonly<Record<string, unknown>>) => input,
  encodePlaygroundOutput: (output: Readonly<Record<string, unknown>> | undefined) => output,
  eventNames: { afterTool: 'After', beforeTool: 'Before', sessionStart: 'Start', stop: 'Stop' },
  manifestPath: 'hooks/hooks.json',
  matchers: {},
  readNativeCommands: readStandardNativeHookCommands,
  wrapperPath: () => 'hooks/start.mjs',
  wrapperSource: () => 'export default undefined;\n',
} satisfies TargetHookContract;

const hookCoherenceRegistry = (): TargetRegistry => new TargetRegistry().register({
  artifactLayout: { hookWrappers: { allowedSuffixes: ['.mjs'], directory: 'hooks' } },
  capabilities: supportedCapabilities('hooks'),
  hookContract: hookCoherenceContract,
  metadata: hookCoherenceMetadata,
  name: hookCoherenceTarget,
  plan: () => ({ diagnostics: [], entries: [] }),
} satisfies TargetAdapter);

const validateCustomDocument: TargetArtifactDocumentValidator = (document) =>
  typeof document === 'object' && document !== null && (document as { readonly kind?: unknown }).kind === 'custom'
    ? []
    : [{ instancePath: '/kind', message: 'must equal "custom"' }];

const customRegistry = (validate = validateCustomDocument): TargetRegistry => new TargetRegistry().register({
  artifactValidation: {
    documents: [{ path: 'document.json', required: true, schema: 'document' }],
    schemas: [{ name: 'document', validate }],
  },
  artifactLayout: {
    assets: 'assets',
    commands: { allowedSuffixes: ['.md'], directory: 'commands' },
    rules: { allowedSuffixes: ['.mdc'], directory: 'rules' },
    scripts: { allowedSuffixes: ['.json', '.mjs', '.sh'], directory: 'scripts' },
    skills: 'skills',
  },
  capabilities: supportedCapabilities('commands', 'rules', 'skills'),
  metadata: customMetadata,
  name: customTarget,
  plan: () => ({ diagnostics: [], entries: [] }),
} satisfies TargetAdapter);

const targetFromRegistry = (registry: TargetRegistry, name: string): ArtifactManifest['targets'][number] => {
  const metadata = registry.metadata(name);
  return {
    ...metadata,
    name,
    schemas: [...metadata.schemas].sort((left, right) => left.name.localeCompare(right.name)),
  };
};

const skillMarkdown = (name: string, body: string): string => [
  '---',
  `name: ${name}`,
  'description: Validate an emitted Artifact Skill.',
  '---',
  body,
  '',
].join('\n');

const customSkillFiles = (body: string, resources: readonly ArtifactFixtureFile[] = []): readonly ArtifactFixtureFile[] => [
  { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  {
    contents: skillMarkdown('artifact-skill', body),
    kind: 'copy',
    path: 'custom/skills/artifact-skill/SKILL.md',
  },
  ...resources,
];

it('admits only direct .mdc files in a declared rules layout', async () => {
  const registry = customRegistry();
  const target = targetFromRegistry(registry, customTarget);
  const validRoot = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: '# Rule\n', kind: 'generated', path: 'custom/rules/review.mdc' },
  ], true, [target]);
  const invalidRoot = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: '# Rule\n', kind: 'generated', path: 'custom/rules/review.md' },
  ], true, [target]);

  try {
    expect(await validateArtifact({ artifactRoot: validRoot, registry })).toEqual([]);
    expect(await validateArtifact({ artifactRoot: invalidRoot, registry })).toContainEqual(
      expect.objectContaining({
        code: 'AB6014',
        generatedPath: 'custom/rules/review.md',
        target: customTarget,
      }),
    );
  } finally {
    await Promise.all([
      rm(validRoot, { force: true, recursive: true }),
      rm(invalidRoot, { force: true, recursive: true }),
    ]);
  }
});

it('admits only direct .md files in a declared commands layout', async () => {
  const registry = customRegistry();
  const target = targetFromRegistry(registry, customTarget);
  const validRoot = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: '# Command\n', kind: 'generated', path: 'custom/commands/review.md' },
  ], true, [target]);
  const invalidRoot = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: '# Command\n', kind: 'generated', path: 'custom/commands/review.mdc' },
  ], true, [target]);

  try {
    expect(await validateArtifact({ artifactRoot: validRoot, registry })).toEqual([]);
    expect(await validateArtifact({ artifactRoot: invalidRoot, registry })).toContainEqual(
      expect.objectContaining({
        code: 'AB6014',
        generatedPath: 'custom/commands/review.mdc',
        target: customTarget,
      }),
    );
  } finally {
    await Promise.all([
      rm(validRoot, { force: true, recursive: true }),
      rm(invalidRoot, { force: true, recursive: true }),
    ]);
  }
});

it('reports every legacy SSE MCP issue in lexical order with escaped JSON Pointer paths', () => {
  let schemaCalls = 0;
  const validate = validateModernMcpDocument(() => {
    schemaCalls += 1;
    return [];
  });
  const unordered = validate({
    mcpServers: {
      zebra: { type: 'sse' },
      'a/b~c': { type: 'sse' },
      modern: { type: 'streamable-http' },
    },
  });
  const reordered = validate({
    mcpServers: {
      modern: { type: 'streamable-http' },
      'a/b~c': { type: 'sse' },
      zebra: { type: 'sse' },
    },
  });
  const expected = [
    {
      instancePath: '/mcpServers/a~1b~0c/type',
      message: 'legacy SSE MCP transport is not supported',
    },
    {
      instancePath: '/mcpServers/zebra/type',
      message: 'legacy SSE MCP transport is not supported',
    },
  ];

  expect(unordered).toEqual(expected);
  expect(reordered).toEqual(expected);
  expect(schemaCalls).toBe(0);
  expect(Object.isFrozen(unordered)).toBe(true);
  expect(Object.isFrozen(unordered[0])).toBe(true);
  expect(Object.isFrozen(unordered[1])).toBe(true);
});

it.each([
  { document: { mcpServers: null }, label: 'malformed MCP server collection' },
  { document: { mcpServers: { modern: { type: 'streamable-http' } } }, label: 'modern-only MCP document' },
])('delegates a $label to its pinned schema validator exactly once', ({ document }) => {
  const schemaIssues = Object.freeze([Object.freeze({ instancePath: '/schema', message: 'pinned schema result' })]);
  let schemaCalls = 0;
  const validate = validateModernMcpDocument(() => {
    schemaCalls += 1;
    return schemaIssues;
  });

  expect(validate(document)).toBe(schemaIssues);
  expect(schemaCalls).toBe(1);
});

it('passes one deeply frozen detached snapshot to the pinned schema', () => {
  const document = {
    mcpServers: { events: { headers: { accepted: ['application/json'] }, type: 'streamable-http' } },
  };
  let schemaCalls = 0;
  let retainedSnapshot: unknown;
  const validate = validateModernMcpDocument((value) => {
    schemaCalls += 1;
    const snapshot = value as {
      mcpServers: { events: { headers: { accepted: string[] }; type: string } };
    };
    retainedSnapshot = snapshot;
    expect(() => { snapshot.mcpServers.events.type = 'sse'; }).toThrow(TypeError);
    expect(() => { snapshot.mcpServers.events.headers.accepted.push('text/event-stream'); }).toThrow(TypeError);
    return [];
  });

  expect(validate(document)).toEqual([]);
  expect(schemaCalls).toBe(1);
  const snapshot = retainedSnapshot as {
    readonly mcpServers: { readonly events: { readonly headers: { readonly accepted: readonly string[] }; readonly type: string } };
  };
  expect(snapshot).not.toBe(document);
  expect(snapshot).toEqual(document);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.mcpServers)).toBe(true);
  expect(Object.isFrozen(snapshot.mcpServers.events)).toBe(true);
  expect(Object.isFrozen(snapshot.mcpServers.events.headers)).toBe(true);
  expect(Object.isFrozen(snapshot.mcpServers.events.headers.accepted)).toBe(true);
});

it('freezes detached branches independently when an MCP document repeats an object alias', () => {
  const server = { headers: { accepted: ['application/json'] }, type: 'streamable-http' };
  let retainedSnapshot: unknown;
  const validate = validateModernMcpDocument((value) => {
    retainedSnapshot = value;
    return [];
  });

  expect(validate({ mcpServers: { first: server, second: server } })).toEqual([]);
  const snapshot = retainedSnapshot as {
    readonly mcpServers: {
      readonly first: { readonly headers: { readonly accepted: readonly string[] } };
      readonly second: { readonly headers: { readonly accepted: readonly string[] } };
    };
  };
  expect(snapshot.mcpServers.first).not.toBe(snapshot.mcpServers.second);
  expect(Object.isFrozen(snapshot.mcpServers.first)).toBe(true);
  expect(Object.isFrozen(snapshot.mcpServers.first.headers.accepted)).toBe(true);
  expect(Object.isFrozen(snapshot.mcpServers.second)).toBe(true);
  expect(Object.isFrozen(snapshot.mcpServers.second.headers.accepted)).toBe(true);
});

it('returns one frozen policy issue for unsupported MCP document values without invoking the schema', () => {
  let accessorReads = 0;
  const accessorDocument = Object.defineProperty({}, 'mcpServers', {
    enumerable: true,
    get: () => {
      accessorReads += 1;
      return { events: { type: accessorReads === 1 ? 'streamable-http' : 'sse' } };
    },
  });
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const documents = [
    Object.create({ mcpServers: { events: { type: 'streamable-http' } } }),
    accessorDocument,
    new Proxy({}, { ownKeys: () => { throw new Error('unreadable document'); } }),
    Symbol('not-json'),
    cyclic,
    { mcpServers: { events: { timeout: Number.NaN, type: 'streamable-http' } } },
  ];
  const expected = [{
    instancePath: '',
    message: 'MCP document must be a detached finite JSON value.',
  }];
  let schemaCalls = 0;
  const validate = validateModernMcpDocument(() => {
    schemaCalls += 1;
    return [];
  });

  for (const document of documents) {
    const issues = validate(document);
    expect(issues).toEqual(expected);
    expect(Object.isFrozen(issues)).toBe(true);
    expect(Object.isFrozen(issues[0])).toBe(true);
  }
  expect(accessorReads).toBe(0);
  expect(schemaCalls).toBe(0);
});

it('delegates one safe snapshot of null-prototype MCP objects with an own __proto__ key', () => {
  const servers = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(servers, '__proto__', {
    enumerable: true,
    value: Object.assign(Object.create(null), { type: 'streamable-http' }),
  });
  Object.defineProperty(servers, 'constructor', {
    enumerable: true,
    value: Object.assign(Object.create(null), { type: 'streamable-http' }),
  });
  const document = Object.assign(Object.create(null), { mcpServers: servers });
  let schemaCalls = 0;
  let schemaDocument: unknown;
  const validate = validateModernMcpDocument((value) => {
    schemaCalls += 1;
    schemaDocument = value;
    return [];
  });

  expect(validate(document)).toEqual([]);
  expect(schemaCalls).toBe(1);
  expect(schemaDocument).not.toBe(document);
  const snapshot = schemaDocument as { readonly mcpServers: Record<string, { readonly type: string }> };
  expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(snapshot.mcpServers)).toBe(Object.prototype);
  expect(Object.prototype.hasOwnProperty.call(snapshot.mcpServers, '__proto__')).toBe(true);
  expect(snapshot.mcpServers.__proto__).toEqual({ type: 'streamable-http' });
  expect(Object.prototype.hasOwnProperty.call(snapshot.mcpServers, 'constructor')).toBe(true);
  expect(snapshot.mcpServers.constructor).toEqual({ type: 'streamable-http' });
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.mcpServers)).toBe(true);
  expect(Object.isFrozen(snapshot.mcpServers.__proto__)).toBe(true);
  expect(Object.isFrozen(snapshot.mcpServers.constructor)).toBe(true);
});

it('validates an emitted Skill and copied resources from the artifact only', async () => {
  const files = customSkillFiles(
    '[inline resource](resources/with%20space.md?download=1#section)\n\n[unescaped space resource](resources/with space.md)\n\n[reference resource][guide]\n\n[guide]: <resources/with space.md>\n\n[shortcut]\n\n[shortcut]: resources/with space.md\n',
    [{
      contents: '# Resource\n',
      kind: 'copy',
      path: 'custom/skills/artifact-skill/resources/with space.md',
    }],
  );
  const root = await writeArtifact(files, true, [customManifestTarget]);

  try {
    expect(await validateArtifact({ artifactRoot: root, registry: customRegistry() })).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('returns frozen validated evidence without changing the diagnostics-only validator API', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  ], true, [customManifestTarget]);

  try {
    const result = await validateArtifactWithSnapshot({ artifactRoot: root, registry: customRegistry() });

    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot!.manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'agent-bundle.hooks.json' }),
    ]));
    expect(result.snapshot!.runtime).toEqual({ hooks: [], mcpServers: [] });
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.agentSkills)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.files)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.files[0]!)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.files[0]!.sourceInputs)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.producer)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.project)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.project.sourceInputs)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.project.sourceInputs[0]!)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.targets)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.targets[0]!)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.targets[0]!.schemas)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.targets[0]!.schemas[0]!)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.validation)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.validation.artifact)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.validation.source)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.validation.targets)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.validation.targets[0]!)).toBe(true);
    expect(await validateArtifact({ artifactRoot: root, registry: customRegistry() })).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a rehashed top-level artifact file outside declared target namespaces', async () => {
  const files = [
    { contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' },
    { contents: 'not compiler metadata\n', kind: 'generated' as const, path: 'top-level.txt' },
  ];
  const root = await writeArtifact(files, true, [customManifestTarget]);

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: customRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6014', generatedPath: 'top-level.txt' }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a rehashed file outside a declared target emitted layout', async () => {
  const files = [
    { contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' },
    { contents: 'not a compiler output\n', kind: 'generated' as const, path: 'custom/unexpected.txt' },
  ];
  const root = await writeArtifact(files, true, [customManifestTarget]);

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: customRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6014', generatedPath: 'custom/unexpected.txt', target: customTarget }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('accepts a manifested target asset emitted by the core build', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    {
      contents: '{"version":"1.0.0"}\n',
      kind: 'copy',
      path: 'custom/assets/release/release-manifest.json',
    },
  ], true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects malformed and unmanifested target asset paths', async () => {
  const malformedRoot = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: 'not an asset path\n', kind: 'copy', path: 'custom/assets' },
  ], true, [customManifestTarget]);
  const unmanifestedRoot = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  ], true, [customManifestTarget]);

  try {
    await mkdir(join(unmanifestedRoot, 'custom', 'assets', 'release'), { recursive: true });
    await writeFile(join(unmanifestedRoot, 'custom', 'assets', 'release', 'unmanifested.json'), '{}\n');

    const [malformedDiagnostics, unmanifestedDiagnostics] = await Promise.all([
      validateArtifact({ artifactRoot: malformedRoot, registry: customRegistry() }),
      validateArtifact({ artifactRoot: unmanifestedRoot, registry: customRegistry() }),
    ]);

    expect(malformedDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6014', generatedPath: 'custom/assets', target: customTarget }),
    ]));
    expect(unmanifestedDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(malformedRoot, { force: true, recursive: true });
    await rm(unmanifestedRoot, { force: true, recursive: true });
  }
});

it('rejects an artifact symlink even when the manifest remains self-consistent', async () => {
  const files = [{ contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' }];
  const root = await writeArtifact(files, true, [customManifestTarget]);

  try {
    await symlink(join(root, 'custom', 'document.json'), join(root, 'custom', 'unexpected-link.json'));
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: customRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6013', generatedPath: 'custom/unexpected-link.json' }),
    ]));
    expect(diagnostics.filter((entry) => entry.code === 'AB6013' && entry.generatedPath === 'custom/unexpected-link.json')).toHaveLength(1);
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a special manifest without following its symlink target', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  ], true, [customManifestTarget]);
  const outside = await mkdtemp(join(tmpdir(), 'agent-bundle-outside-manifest-'));

  try {
    await writeFile(join(outside, 'forged.json'), '{');
    await rm(join(root, 'agent-bundle.manifest.json'));
    await symlink(join(outside, 'forged.json'), join(root, 'agent-bundle.manifest.json'));

    const diagnostics = await validateArtifact({ artifactRoot: root, registry: customRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6013', generatedPath: 'agent-bundle.manifest.json' }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6001' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

it('rejects a canonical manifest whose runtime is below the generated floor', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  ], true, [customManifestTarget]);

  try {
    const manifestPath = join(root, 'agent-bundle.manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { runtime: { node: string } };
    manifest.runtime.node = '22.11.9';
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    expect(await validateArtifact({ artifactRoot: root, registry: customRegistry() })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6001', generatedPath: 'agent-bundle.manifest.json' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('settles promptly when the artifact manifest is a FIFO', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  ], true, [customManifestTarget]);

  try {
    await rm(join(root, 'agent-bundle.manifest.json'));
    await createFifo(join(root, 'agent-bundle.manifest.json'));
    const result = await Promise.race([
      validateArtifact({ artifactRoot: root, registry: customRegistry() }),
      new Promise<readonly unknown[]>((resolvePromise) => {
        setTimeout(() => resolvePromise([]), 500);
      }),
    ]);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6013', generatedPath: 'agent-bundle.manifest.json' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects empty declared and undeclared target directories independently of manifest hashes', async () => {
  const emptyRoot = await writeArtifact([], true, [customManifestTarget]);
  const declaredRoot = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  ], true, [customManifestTarget]);

  try {
    await mkdir(join(emptyRoot, customTarget));
    await mkdir(join(declaredRoot, 'undeclared'));

    const [emptyDiagnostics, undeclaredDiagnostics] = await Promise.all([
      validateArtifact({ artifactRoot: emptyRoot, registry: customRegistry() }),
      validateArtifact({ artifactRoot: declaredRoot, registry: customRegistry() }),
    ]);

    expect(emptyDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6014', generatedPath: customTarget, target: customTarget }),
    ]));
    expect(undeclaredDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6014', generatedPath: 'undeclared' }),
    ]));
    expect([...emptyDiagnostics, ...undeclaredDiagnostics]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(emptyRoot, { force: true, recursive: true });
    await rm(declaredRoot, { force: true, recursive: true });
  }
});

it('rejects a nested empty directory under an otherwise valid target namespace', async () => {
  const files = [{ contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' }];
  const root = await writeArtifact(files, true, [customManifestTarget]);

  try {
    await mkdir(join(root, 'custom', 'skills', 'orphan'), { recursive: true });

    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AB6014', generatedPath: 'custom/skills/orphan', target: customTarget }),
      ]),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects forged hook output for a target without a hook contract', async () => {
  const registry = createDefaultRegistry();
  const portable = targetFromRegistry(registry, 'portable');
  const files = [
    { contents: '# Install portable-test\n', kind: 'generated' as const, path: 'portable/INSTALL.md' },
    { contents: 'export {};\n', kind: 'generated' as const, path: 'portable/install.mjs' },
    {
      contents: '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","description":"Valid portable plugin.","name":"portable-test","version":"1.0.0"}\n',
      kind: 'generated' as const,
      path: 'portable/plugin.json',
    },
    { contents: 'forged hook\n', kind: 'generated' as const, path: 'portable/hooks/junk.txt' },
  ];
  const root = await writeArtifact(files, true, [portable]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6014', generatedPath: 'portable/hooks/junk.txt', target: 'portable' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a canonically rehashed script with an unsupported extension', async () => {
  const registry = createDefaultRegistry();
  const portable = targetFromRegistry(registry, 'portable');
  const files = [
    {
      contents: '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","description":"Valid portable plugin.","name":"portable-test","version":"1.0.0"}\n',
      kind: 'generated' as const,
      path: 'portable/plugin.json',
    },
    { contents: 'forged script\n', kind: 'copy' as const, path: 'portable/scripts/junk.exe' },
  ];
  const root = await writeArtifact(files, true, [portable]);

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6014', generatedPath: 'portable/scripts/junk.exe', target: 'portable' }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('admits nested project assets in the target-owned recursive asset namespace', async () => {
  const registry = createDefaultRegistry();
  const portable = targetFromRegistry(registry, 'portable');
  const files = [
    { contents: '# Install portable-test\n', kind: 'generated' as const, path: 'portable/INSTALL.md' },
    { contents: 'export {};\n', kind: 'generated' as const, path: 'portable/install.mjs' },
    {
      contents: '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","description":"Valid portable plugin.","name":"portable-test","version":"1.0.0"}\n',
      kind: 'generated' as const,
      path: 'portable/plugin.json',
    },
    { contents: '<svg/>\n', kind: 'copy' as const, path: 'portable/assets/branding/logo.svg' },
  ];
  const root = await writeArtifact(files, true, [portable]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry })).resolves.toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each([
  ['a missing copied resource', '[missing resource](references/missing.md)'],
  ['a percent-encoded path that escapes the Skill root', '[escape resource](..%2Fdocument.json)'],
])('rejects emitted Skill Markdown with %s', async (_name, body) => {
  const root = await writeArtifact(customSkillFiles(body), true, [customManifestTarget]);

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: customRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB6016',
        generatedPath: 'custom/skills/artifact-skill/SKILL.md',
        recovery: artifactDiagnosticRecoveries.AB6016,
        target: customTarget,
      }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('validates emitted Skill frontmatter against the pinned contract and directory name', async () => {
  const files = [
    { contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' },
    {
      contents: skillMarkdown('wrong-name', ''),
      kind: 'copy' as const,
      path: 'custom/skills/artifact-skill/SKILL.md',
    },
  ];
  const root = await writeArtifact(files, true, [customManifestTarget]);

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: customRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB6015',
        generatedPath: 'custom/skills/artifact-skill/SKILL.md',
        recovery: artifactDiagnosticRecoveries.AB6015,
        target: customTarget,
      }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects noncanonical and duplicate-key manifests as strict parse failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-manifest-validator-'));

  try {
    const canonical = assembleArtifactManifest(manifestFor(withHookIndex([]))).bytes;
    for (const bytes of [
      JSON.stringify(JSON.parse(canonical), null, 2),
      canonical.replace(
        '"runtime":{"node":"22.12.0"}',
        '"runtime":{"node":"22.12.0"},"runtime":{"node":"22.12.0"}',
      ),
    ]) {
      await writeFile(join(root, 'agent-bundle.manifest.json'), bytes);
      expect(await validateArtifact({ artifactRoot: root })).toEqual([
        expect.objectContaining({ code: 'AB6001', generatedPath: 'agent-bundle.manifest.json' }),
      ]);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('matches a canonical nested manifest file table by path instead of directory traversal position', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: skillMarkdown('table', ''), kind: 'copy', path: 'custom/skills/table/SKILL.md' },
    { contents: '{}\n', kind: 'copy', path: 'custom/skills/table/resources/entry.json' },
  ], true, [customManifestTarget]);

  try {
    expect(await validateArtifact({ artifactRoot: root, registry: customRegistry() })).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a canonical manifest that omits an executable file mode', async () => {
  const root = await writeArtifact([
    { contents: 'export const executable = true;\n', kind: 'bundle', mode: 0o755, path: 'bin/tool.mjs' },
  ], false);

  try {
    expect(await validateArtifact({ artifactRoot: root })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004', generatedPath: 'agent-bundle.manifest.json' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('preserves structural artifact diagnostics after a strict manifest passes', async () => {
  const files = [
    { contents: 'export const broken = ;\n', kind: 'bundle' as const, path: 'broken.mjs' },
    { contents: '{', kind: 'generated' as const, path: 'invalid.json' },
    { contents: '{"mcpServers":{"local":{"args":["mcp/mcp-local-deadbeef.mjs"]}}}', kind: 'generated' as const, path: 'mcp.json' },
  ];
  const root = await writeArtifact(files);

  try {
    await writeFile(join(root, 'mcp.json'), '{"mcpServers":{"local":{"args":["mcp/mcp-local-deadbeef.mjs"]}}}\n');
    await writeFile(join(root, 'invalid.json'), '{');
    await writeFile(join(root, 'broken.mjs'), 'export const broken = ;\n');
    const diagnostics = await validateArtifact({ artifactRoot: root });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6005', generatedPath: 'broken.mjs' }),
      expect.objectContaining({ code: 'AB6006', generatedPath: 'invalid.json' }),
      expect.objectContaining({ code: 'AB6007', generatedPath: 'mcp.json' }),
    ]));

    await writeFile(join(root, 'broken.mjs'), 'export const repaired = true;\n');
    expect(await validateArtifact({ artifactRoot: root })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004', generatedPath: 'agent-bundle.manifest.json' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports an orphan compiler MCP output after the artifact is rehashed', async () => {
  const files = [
    {
      contents: '{"mcpServers":{"server":{"args":["mcp/mcp-server-deadbeef.mjs"],"command":"node","type":"stdio"}}}\n',
      kind: 'generated' as const,
      path: 'coherent/native/servers.json',
    },
    { contents: 'export const server = true;\n', kind: 'bundle' as const, path: 'coherent/mcp/mcp-server-deadbeef.mjs' },
    { contents: 'export const orphan = true;\n', kind: 'bundle' as const, path: 'coherent/mcp/mcp-junk-deadbeef.mjs' },
    { contents: 'export const orphanWorker = true;\n', kind: 'bundle' as const, path: 'coherent/mcp/mcp-junk-deadbeef-flight.mjs' },
  ];
  const root = await writeArtifact(files, true, [coherenceManifestTarget]);

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: coherenceRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6017', generatedPath: 'coherent/mcp/mcp-junk-deadbeef.mjs', target: coherenceTarget }),
      expect.objectContaining({ code: 'AB6017', generatedPath: 'coherent/mcp/mcp-junk-deadbeef-flight.mjs', target: coherenceTarget }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not attribute compiler MCP outputs to an equal-length sibling target', async () => {
  const siblingTarget = 'neighbor';
  const siblingMetadata = Object.freeze({
    adapterRevision: 'neighbor-adapter-v1',
    observedVersion: 'neighbor-observed-v1',
    schemas: Object.freeze([]),
  });
  const registry = coherenceRegistry().register({
    artifactLayout: { mcpEntries: { allowedSuffixes: ['.mjs'], directory: 'mcp' } },
    capabilities: supportedCapabilities('mcp'),
    mcpRuntime: createTargetMcpRuntime({
      manifestPath: 'native/servers.json',
      remoteTypes: ['streamable-http'],
      resolveValue: createMcpPathTokenResolver({ target: siblingTarget, tokens: {} }),
    }),
    metadata: siblingMetadata,
    name: siblingTarget,
    plan: () => ({ diagnostics: [], entries: [] }),
  } satisfies TargetAdapter);
  const root = await writeArtifact([
    {
      contents: '{"mcpServers":{"server":{"args":["mcp/mcp-server-deadbeef.mjs"],"command":"node","type":"stdio"}}}\n',
      kind: 'generated',
      path: 'coherent/native/servers.json',
    },
    { contents: 'export const coherent = true;\n', kind: 'bundle', path: 'coherent/mcp/mcp-server-deadbeef.mjs' },
    {
      contents: '{"mcpServers":{"server":{"args":["mcp/mcp-server-deadbeef.mjs"],"command":"node","type":"stdio"}}}\n',
      kind: 'generated',
      path: 'neighbor/native/servers.json',
    },
    { contents: 'export const neighbor = true;\n', kind: 'bundle', path: 'neighbor/mcp/mcp-server-deadbeef.mjs' },
  ], true, [coherenceManifestTarget, Object.freeze({ ...siblingMetadata, name: siblingTarget })]);

  try {
    expect(coherenceTarget).toHaveLength(siblingTarget.length);
    expect(await validateArtifact({ artifactRoot: root, registry })).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6017' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each([
  ['backslash local path', 'scripts\\missing.mjs', true],
  ['local option assignment', '--config=./scripts/missing.mjs', true],
  ['HTTPS URL', 'https://mcp.example.test/resource?query=value#fragment', false],
  ['URL option assignment', '--url=https://mcp.example.test/resource?query=value#fragment', false],
  ['Windows drive escape', 'C:\\outside\\tool.mjs', true],
  ['UNC escape', '\\\\server\\share\\tool.mjs', true],
])('classifies MCP %s deterministically', async (_name, argument, expectsDiagnostic) => {
  const root = await writeArtifact([{
    contents: `${JSON.stringify({
      mcpServers: { server: { args: [argument], command: 'node', type: 'stdio' } },
    })}\n`,
    kind: 'generated',
    path: 'coherent/native/servers.json',
  }], true, [coherenceManifestTarget]);

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: coherenceRegistry() });
    const matching = diagnostics.some((entry) => entry.code === 'AB6017' && entry.generatedPath === 'coherent/native/servers.json');
    expect(matching).toBe(expectsDiagnostic);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a target-local file URL argument that is absent from the artifact', async () => {
  const nativePath = 'coherent/native/servers.json';
  const root = await writeArtifact([{
    contents: '{"mcpServers":{}}\n',
    kind: 'generated',
    path: nativePath,
  }], true, [coherenceManifestTarget]);

  try {
    const argument = `--config=${pathToFileURL(join(root, 'coherent', 'mcp', 'missing space.mjs')).href}`;
    const nativeContents = `${JSON.stringify({
      mcpServers: { server: { args: [argument], command: 'node', type: 'stdio' } },
    })}\n`;
    const files = [{ contents: nativeContents, kind: 'generated' as const, path: nativePath }];
    await writeFile(join(root, nativePath), nativeContents);
    await writeFile(
      join(root, 'agent-bundle.manifest.json'),
      assembleArtifactManifest(manifestFor(withHookIndex(files), true, [coherenceManifestTarget])).bytes,
    );

    expect(await validateArtifact({ artifactRoot: root, registry: coherenceRegistry() })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6017', generatedPath: nativePath, target: coherenceTarget }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each([
  ['one server twice', {
    server: { args: ['mcp/mcp-server-deadbeef.mjs', 'mcp/mcp-server-deadbeef.mjs'], command: 'node', type: 'stdio' },
  }],
  ['two servers once each', {
    first: { args: ['mcp/mcp-server-deadbeef.mjs'], command: 'node', type: 'stdio' },
    second: { args: ['mcp/mcp-server-deadbeef.mjs'], command: 'node', type: 'stdio' },
  }],
])('counts exact MCP reference occurrences for %s', async (_name, mcpServers) => {
  const root = await writeArtifact([
    {
      contents: `${JSON.stringify({ mcpServers })}\n`,
      kind: 'generated',
      path: 'coherent/native/servers.json',
    },
    { contents: 'export const server = true;\n', kind: 'bundle', path: 'coherent/mcp/mcp-server-deadbeef.mjs' },
  ], true, [coherenceManifestTarget]);

  try {
    expect(await validateArtifact({ artifactRoot: root, registry: coherenceRegistry() })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6017', generatedPath: 'coherent/mcp/mcp-server-deadbeef.mjs', target: coherenceTarget }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects duplicate keys in a canonically manifested native MCP document', async () => {
  const server = '{"args":[],"command":"node","type":"stdio"}';
  const root = await writeArtifact([{
    contents: `{"mcpServers":{"server":${server},"server":${server}}}\n`,
    kind: 'generated',
    path: 'coherent/native/servers.json',
  }], true, [coherenceManifestTarget]);

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: coherenceRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6017', generatedPath: 'coherent/native/servers.json', target: coherenceTarget }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('requires the canonical hook index when native hook metadata is present', async () => {
  const root = await writeArtifact([
    {
      contents: `${JSON.stringify({
        hooks: { Start: [{ hooks: [{ command: 'node "${HOOK_ROOT}/hooks/start.mjs"', type: 'command' }] }] },
      })}\n`,
      kind: 'generated',
      path: 'hooked/hooks/hooks.json',
    },
    { contents: 'export const start = true;\n', kind: 'bundle', path: 'hooked/hooks/start.mjs' },
  ], true, [hookCoherenceManifestTarget], false);

  try {
    expect(await validateArtifact({ artifactRoot: root, registry: hookCoherenceRegistry() })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6018', generatedPath: 'agent-bundle.hooks.json', target: 'artifact' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports a compiler-pattern native hook command that is not indexed', async () => {
  const files = [
    { contents: '{"hooks":[]}\n', kind: 'generated' as const, path: 'agent-bundle.hooks.json' },
    {
      contents: `${JSON.stringify({
        hooks: { Start: [{ hooks: [{ command: 'node "${HOOK_ROOT}/hooks/start.mjs"', type: 'command' }] }] },
      })}\n`,
      kind: 'generated' as const,
      path: 'hooked/hooks/hooks.json',
    },
    { contents: 'export const start = true;\n', kind: 'bundle' as const, path: 'hooked/hooks/start.mjs' },
  ];
  const root = await writeArtifact(files, true, [hookCoherenceManifestTarget]);

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: hookCoherenceRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6018', generatedPath: 'hooked/hooks/hooks.json', target: hookCoherenceTarget }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each([
  ['a missing static import', "import './missing.mjs';\n"],
  ['a missing literal dynamic import', "await import('./missing.mjs');\n"],
  ['a missing deferred literal dynamic import', "const load = () => import('./missing.mjs');\nexport { load };\n"],
])('rejects generated JavaScript with %s', async (_name, contents) => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents, kind: 'bundle', path: 'custom/scripts/missing-dependency.mjs' },
  ], true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AB6005',
          generatedPath: 'custom/scripts/missing-dependency.mjs',
          recovery: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
        }),
      ]),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('accepts inert top-level throws, rejections, and never-settling awaits', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: 'throw new Error("top-level artifact failure");\n', kind: 'bundle', path: 'custom/scripts/throws.mjs' },
    { contents: 'await Promise.reject(new Error("top-level artifact rejection"));\n', kind: 'bundle', path: 'custom/scripts/rejects.mjs' },
    { contents: 'await new Promise(() => undefined);\n', kind: 'bundle', path: 'custom/scripts/never-settles.mjs' },
  ], true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each([
  ['a data URL', 'data:text/javascript,export default undefined'],
  ['an HTTP URL', 'https://example.test/dependency.mjs'],
  ['an unbundled bare package', 'unbundled-package'],
])('rejects generated JavaScript with %s import specifiers', async (_name, specifier) => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: `import ${JSON.stringify(specifier)};\n`, kind: 'bundle', path: 'custom/scripts/unsupported.mjs' },
  ], true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AB6005',
          generatedPath: 'custom/scripts/unsupported.mjs',
          recovery: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
        }),
      ]),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('allows Node builtins and manifest-listed JSON terminal imports', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    {
      contents: [
        "import fs from 'node:fs';",
        "import process from 'process';",
        "import data from './data.json';",
        'export { data, fs, process };',
        '',
      ].join('\n'),
      kind: 'bundle',
      path: 'custom/scripts/builtins.mjs',
    },
    { contents: '{"kind":"artifact"}\n', kind: 'generated', path: 'custom/scripts/data.json' },
  ], true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects non-literal dynamic imports', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: 'const specifier = "./known.mjs";\nawait import(specifier);\n', kind: 'bundle', path: 'custom/scripts/non-literal.mjs' },
  ], true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AB6005',
          generatedPath: 'custom/scripts/non-literal.mjs',
          recovery: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
        }),
      ]),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('imports a self-contained generated module at a path with spaces', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: 'export const artifact = "self-contained";\n', kind: 'bundle', path: 'custom/scripts/with space.mjs' },
  ], true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects generated JavaScript that resolves a dependency outside the artifact root', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-validator-outside-'));
  const outsideModule = join(outside, 'source-tree-dependency.mjs');
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    {
      contents: `import ${JSON.stringify(pathToFileURL(outsideModule).href)};\n`,
      kind: 'bundle',
      path: 'custom/scripts/external-dependency.mjs',
    },
  ], true, [customManifestTarget]);

  try {
    await writeFile(outsideModule, 'export const sourceTreeDependency = true;\n');
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AB6005',
          generatedPath: 'custom/scripts/external-dependency.mjs',
          recovery: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
        }),
      ]),
    );
  } finally {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(outside, { force: true, recursive: true }),
    ]);
  }
});

it('rejects an existing JavaScript dependency omitted from the manifest', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: "import './omitted.mjs';\n", kind: 'bundle', path: 'custom/scripts/importer.mjs' },
  ], true, [customManifestTarget]);

  try {
    await writeFile(join(root, 'custom', 'scripts', 'omitted.mjs'), 'export const omitted = true;\n');
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6005', generatedPath: 'custom/scripts/importer.mjs' }),
      expect.objectContaining({ code: 'AB6004', generatedPath: 'agent-bundle.manifest.json' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('accepts deterministic cycles between manifested JavaScript modules', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: "import './cycle-b.mjs';\nexport const cycleA = true;\n", kind: 'bundle', path: 'custom/scripts/cycle-a.mjs' },
    { contents: "import './cycle-a.mjs';\nexport const cycleB = true;\n", kind: 'bundle', path: 'custom/scripts/cycle-b.mjs' },
  ], true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not execute artifact JavaScript while validating deferred imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-validator-inert-'));
  const filesystemSentinel = join(root, 'filesystem-sentinel');
  const childSentinel = join(root, 'child-sentinel');
  const loaderSentinel = join(root, 'loader-sentinel');
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end('unexpected artifact request');
  });

  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a local HTTP server port.');
    const loader = `data:text/javascript,${encodeURIComponent([
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(loaderSentinel)}, 'executed');`,
      'export async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); }',
      '',
    ].join('\n'))}`;
    const files = [
      { contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' },
      { contents: "process.exit(0);\nconst deferred = () => import('./missing-exit.mjs');\nexport { deferred };\n", kind: 'bundle' as const, path: 'custom/scripts/process-exit.mjs' },
      {
        contents: [
          "import { writeFile } from 'node:fs/promises';",
          `await writeFile(${JSON.stringify(filesystemSentinel)}, 'executed');`,
          "const deferred = () => import('./missing-filesystem.mjs');",
          'export { deferred };',
          '',
        ].join('\n'),
        kind: 'bundle' as const,
        path: 'custom/scripts/filesystem.mjs',
      },
      {
        contents: `await fetch(${JSON.stringify(`http://127.0.0.1:${address.port}/artifact`)});\nconst deferred = () => import('./missing-network.mjs');\nexport { deferred };\n`,
        kind: 'bundle' as const,
        path: 'custom/scripts/network.mjs',
      },
      {
        contents: [
          "import { spawn } from 'node:child_process';",
          `spawn(process.execPath, ['--eval', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(childSentinel)}, 'executed')`)}], { stdio: 'ignore' });`,
          "const deferred = () => import('./missing-child.mjs');",
          'export { deferred };',
          '',
        ].join('\n'),
        kind: 'bundle' as const,
        path: 'custom/scripts/child.mjs',
      },
      {
        contents: [
          "import { register } from 'node:module';",
          `register(${JSON.stringify(loader)}, import.meta.url);`,
          "const deferred = () => import('./missing-loader.mjs');",
          'export { deferred };',
          '',
        ].join('\n'),
        kind: 'bundle' as const,
        path: 'custom/scripts/loader.mjs',
      },
      { contents: 'await new Promise(() => undefined);\n', kind: 'bundle' as const, path: 'custom/scripts/top-level-await.mjs' },
    ];
    for (const file of files) {
      const path = join(root, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents);
    }
    await writeFile(join(root, 'agent-bundle.manifest.json'), assembleArtifactManifest(manifestFor(withHookIndex(files), true, [customManifestTarget])).bytes);

    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6005', generatedPath: 'custom/scripts/process-exit.mjs' }),
      expect.objectContaining({ code: 'AB6005', generatedPath: 'custom/scripts/filesystem.mjs' }),
      expect.objectContaining({ code: 'AB6005', generatedPath: 'custom/scripts/network.mjs' }),
      expect.objectContaining({ code: 'AB6005', generatedPath: 'custom/scripts/child.mjs' }),
      expect.objectContaining({ code: 'AB6005', generatedPath: 'custom/scripts/loader.mjs' }),
    ]));
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 100); });
    await expect(access(filesystemSentinel)).rejects.toThrow();
    await expect(access(childSentinel)).rejects.toThrow();
    await expect(access(loaderSentinel)).rejects.toThrow();
    expect(requests).toBe(0);
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
    await rm(root, { force: true, recursive: true });
  }
});

it('reports one structural change for a file mutation during validation', async () => {
  const files = [
    { contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' },
    { contents: 'export const original = true;\n', kind: 'bundle' as const, mode: 0o755, path: 'custom/scripts/mutable.mjs' },
  ];
  const root = await writeArtifact(files, true, [customManifestTarget]);
  const mutableModule = join(root, 'custom', 'scripts', 'mutable.mjs');
  let mutated = false;
  const registry = customRegistry(() => {
    writeFileSync(mutableModule, 'export const changed = true;\n');
    chmodSync(mutableModule, 0o644);
    mutated = true;
    return [];
  });

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry });
    expect(diagnostics.filter((entry) => entry.code === 'AB6004' && entry.generatedPath === 'custom/scripts/mutable.mjs')).toHaveLength(1);
    expect(mutated).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a special entry added during validation without returning a snapshot', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  ], true, [customManifestTarget]);
  const linkPath = join(root, 'custom', 'late-link.json');
  const registry = customRegistry(() => {
    symlinkSync(join(root, 'custom', 'document.json'), linkPath);
    return [];
  });

  try {
    const result = await validateArtifactWithSnapshot({ artifactRoot: root, registry });

    expect(result.diagnostics.filter((entry) => entry.code === 'AB6013' && entry.generatedPath === 'custom/late-link.json')).toHaveLength(1);
    expect(result.snapshot).toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects an empty directory added during validation without returning a snapshot', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  ], true, [customManifestTarget]);
  const emptyDirectory = join(root, 'custom', 'late-empty');
  const registry = customRegistry(() => {
    mkdirSync(emptyDirectory);
    return [];
  });

  try {
    const result = await validateArtifactWithSnapshot({ artifactRoot: root, registry });

    expect(result.diagnostics.filter((entry) => entry.code === 'AB6014' && entry.generatedPath === 'custom/late-empty')).toHaveLength(1);
    expect(result.snapshot).toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not re-enter artifact validation after taking final evidence snapshots', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  ], true, [customManifestTarget]);
  const manifestPath = join(root, 'agent-bundle.manifest.json');
  const initialManifest = readFileSync(manifestPath);
  const registry = customRegistry();
  const artifactValidation = registry.artifactValidation.bind(registry);
  let artifactValidationCalls = 0;
  registry.artifactValidation = (target) => {
    artifactValidationCalls += 1;
    if (artifactValidationCalls === 3) writeFileSync(manifestPath, '{"invalid":true}\n');
    return artifactValidation(target);
  };

  try {
    const result = await validateArtifactWithSnapshot({ artifactRoot: root, registry });

    expect(artifactValidationCalls).toBe(2);
    expect(readFileSync(manifestPath)).toEqual(initialManifest);
    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot).toBeDefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not allow a late registry re-entry to create an unvalidated empty directory', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  ], true, [customManifestTarget]);
  const emptyDirectory = join(root, 'custom', 'too-late-empty');
  const registry = customRegistry();
  const artifactValidation = registry.artifactValidation.bind(registry);
  let artifactValidationCalls = 0;
  registry.artifactValidation = (target) => {
    artifactValidationCalls += 1;
    if (artifactValidationCalls === 3) mkdirSync(emptyDirectory);
    return artifactValidation(target);
  };

  try {
    const result = await validateArtifactWithSnapshot({ artifactRoot: root, registry });

    expect(artifactValidationCalls).toBe(2);
    await expect(access(emptyDirectory)).rejects.toThrow();
    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot).toBeDefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each([
  ['rewritten', (manifestPath: string) => { writeFileSync(manifestPath, '{"invalid":true}\n'); }],
  ['replaced with identical bytes', (manifestPath: string) => {
    const replacementPath = `${manifestPath}.replacement`;
    writeFileSync(replacementPath, readFileSync(manifestPath));
    renameSync(replacementPath, manifestPath);
  }],
  ['removed', (manifestPath: string) => { rmSync(manifestPath); }],
])('rejects a manifest %s during a synchronous schema callback', async (_name, mutateManifest) => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
  ], true, [customManifestTarget]);
  const manifestPath = join(root, 'agent-bundle.manifest.json');
  const registry = customRegistry(() => {
    mutateManifest(manifestPath);
    return [];
  });

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry });
    expect(diagnostics.filter((entry) => entry.code === 'AB6001' && entry.generatedPath === 'agent-bundle.manifest.json')).toHaveLength(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not repeat JavaScript diagnostics after a validation-side mutation', async () => {
  const files = [
    { contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' },
    { contents: 'export const valid = true;\n', kind: 'bundle' as const, path: 'custom/scripts/mutable.mjs' },
  ];
  const root = await writeArtifact(files, true, [customManifestTarget]);
  const modulePath = join(root, 'custom', 'scripts', 'mutable.mjs');
  const registry = customRegistry(() => {
    writeFileSync(modulePath, 'export const broken = ;\n');
    return [];
  });

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry });
    expect(diagnostics.filter((entry) => entry.code === 'AB6005' && entry.generatedPath === 'custom/scripts/mutable.mjs')).toHaveLength(1);
    expect(diagnostics.filter((entry) => entry.code === 'AB6004' && entry.generatedPath === 'custom/scripts/mutable.mjs')).toHaveLength(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not import copied non-JavaScript resources', async () => {
  const root = await writeArtifact([
    { contents: '{"kind":"custom"}\n', kind: 'generated', path: 'custom/document.json' },
    { contents: 'this is not JavaScript\n', kind: 'copy', path: 'custom/scripts/not-a-module.sh' },
  ], true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('fails closed when Agent Skills provenance does not equal the pinned contract', async () => {
  const root = await writeArtifact([]);

  try {
    const manifest = manifestFor([]);
    for (const agentSkills of [
      { ...manifest.agentSkills, schemaSha256: '0'.repeat(64) },
      { ...manifest.agentSkills, sourceRevision: '0'.repeat(40) },
      { ...manifest.agentSkills, specification: 'https://example.test/forged-specification.mdx' },
    ]) {
      await writeFile(join(root, 'agent-bundle.manifest.json'), assembleArtifactManifest({
        ...manifest,
        agentSkills,
      }).bytes);

      await expect(validateArtifact({ artifactRoot: root })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'AB6008', generatedPath: 'agent-bundle.manifest.json' }),
      ]));
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('requires manifest target metadata to match the supplied registry exactly', async () => {
  const files = [{ contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' }];
  const root = await writeArtifact(files, true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6009', target: customTarget }),
    ]));
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual([]);

    for (const target of [
      { ...customManifestTarget, adapterRevision: 'different-adapter' },
      { ...customManifestTarget, observedVersion: 'different-observed-version' },
      { ...customManifestTarget, schemas: [{ ...customMetadata.schemas[0]!, sha256: 'c'.repeat(64) }] },
      {
        ...customManifestTarget,
        schemas: [
          ...customMetadata.schemas,
          { name: 'unexpected', revision: 'custom-schema-v1', sha256: 'c'.repeat(64) },
        ],
      },
    ]) {
      await writeFile(join(root, 'agent-bundle.manifest.json'), assembleArtifactManifest(manifestFor(withHookIndex(files), true, [target])).bytes);
      await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'AB6010', target: customTarget }),
      ]));
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('requires registered target-native documents and validates their pinned schema contracts', async () => {
  const root = await writeArtifact([], true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6011', generatedPath: 'custom/document.json', target: customTarget }),
    ]));

    const invalidFiles = [{ contents: '{"kind":"invalid"}\n', kind: 'generated' as const, path: 'custom/document.json' }];
    await mkdir(join(root, 'custom'), { recursive: true });
    await writeFile(join(root, 'custom', 'document.json'), invalidFiles[0]!.contents);
    await writeFile(
      join(root, 'agent-bundle.manifest.json'),
      assembleArtifactManifest(manifestFor(withHookIndex(invalidFiles), true, [customManifestTarget])).bytes,
    );
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6012', generatedPath: 'custom/document.json', target: customTarget }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each([
  {
    mcp: {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { events: { type: 'sse', url: 'https://mcp.example.test/events' } },
    },
    plugin: {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'portable-sse-artifact',
      version: '1.0.0',
    },
    target: 'portable' as const,
    mcpPath: 'portable/mcp.json',
    pluginPath: 'portable/plugin.json',
  },
  {
    mcp: { mcpServers: { events: { type: 'sse', url: 'https://mcp.example.test/events' } } },
    plugin: {
      author: { name: 'Agent Bundle' },
      description: 'Artifact validation fixture.',
      name: 'claude-sse-artifact',
      version: '1.0.0',
    },
    target: 'claude' as const,
    mcpPath: 'claude/.mcp.json',
    pluginPath: 'claude/.claude-plugin/plugin.json',
  },
])('rejects a self-consistent $target artifact containing an SSE MCP document', async ({ mcp, mcpPath, plugin, pluginPath, target }) => {
  const registry = createDefaultRegistry();
  const manifestTarget = targetFromRegistry(registry, target);
  const files = [
    { contents: `${JSON.stringify(mcp)}\n`, kind: 'generated' as const, path: mcpPath },
    { contents: `${JSON.stringify(plugin)}\n`, kind: 'generated' as const, path: pluginPath },
  ];
  const root = await writeArtifact(files, true, [manifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6012', generatedPath: mcpPath, target }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('validates a canonically rehashed Codex marketplace at its emitted path', async () => {
  const registry = createDefaultRegistry();
  const target = targetFromRegistry(registry, 'codex');
  const plugin = {
    author: { name: 'Codex test' },
    description: 'Valid Codex plugin.',
    interface: {
      capabilities: [],
      category: 'Productivity',
      defaultPrompt: ['Help with this test.'],
      developerName: 'Agent Bundle',
      displayName: 'Codex test',
      longDescription: 'A valid plugin document for artifact validation.',
      shortDescription: 'Valid artifact test plugin.',
    },
    name: 'codex-test',
    skills: './skills/',
    version: '1.0.0',
  };
  const marketplace = {
    interface: { displayName: 'Codex test marketplace' },
    name: 'codex-test-marketplace',
    plugins: [{
      category: 'Productivity',
      name: 'codex-test',
      policy: { authentication: 'ON_INSTALL', installation: 'AVAILABLE' },
      source: { path: './', source: 'local' },
    }],
  };
  const validFiles = [
    { contents: '# Install codex-test\n', kind: 'generated' as const, path: 'codex/INSTALL.md' },
    { contents: `${JSON.stringify(plugin)}\n`, kind: 'generated' as const, path: 'codex/.codex-plugin/plugin.json' },
    { contents: `${JSON.stringify(marketplace)}\n`, kind: 'generated' as const, path: 'codex/.agents/plugins/marketplace.json' },
  ];
  const root = await writeArtifact(validFiles, true, [target]);

  try {
    expect(await validateArtifact({ artifactRoot: root, registry })).toEqual([]);

    const invalidFiles = [
      validFiles[0]!,
      validFiles[1]!,
      { contents: '{}\n', kind: 'generated' as const, path: 'codex/.agents/plugins/marketplace.json' },
    ];
    await writeFile(join(root, 'codex', '.agents', 'plugins', 'marketplace.json'), '{}\n');
    await writeFile(
      join(root, 'agent-bundle.manifest.json'),
      assembleArtifactManifest(manifestFor(withHookIndex(invalidFiles), true, [target])).bytes,
    );

    const diagnostics = await validateArtifact({ artifactRoot: root, registry });
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB6012',
        generatedPath: 'codex/.agents/plugins/marketplace.json',
        target: 'codex',
      }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

const malformedValidator = (callback: () => unknown): TargetArtifactDocumentValidator => callback as never;

const throwingArrayElement = (): unknown => {
  const issues: unknown[] = [];
  Object.defineProperty(issues, '0', {
    enumerable: true,
    get: (): never => {
      throw new Error('issue element getter must not escape validation');
    },
  });
  issues.length = 1;
  return issues;
};

const throwingIssueProperty = (): unknown => Object.defineProperties({}, {
  instancePath: {
    enumerable: true,
    get: () => {
      throw new Error('instance path getter must not escape validation');
    },
  },
  message: {
    enumerable: true,
    get: () => {
      throw new Error('message getter must not escape validation');
    },
  },
});

const thenableArray = (): unknown => Object.assign([], { then: (): undefined => undefined });

const malformedValidatorCases = [
  ['a null callback result', () => null],
  ['an array-like callback result', () => ({ 0: {}, length: 1 })],
  ['a thenable callback result', () => ({ then: () => undefined })],
  ['a thenable array callback result', thenableArray],
  ['a prototype-backed issue', () => [Object.assign(Object.create({}), { instancePath: '/', message: 'invalid' })]],
  ['an inherited issue field', () => [Object.create({ instancePath: '/', message: 'invalid' })]],
  ['an accessor issue field', () => [throwingIssueProperty()]],
  ['a throwing issue array element', throwingArrayElement],
  ['a throwing callback', () => {
    throw new Error('validator callback must not escape artifact validation');
  }],
] as const satisfies readonly (readonly [string, () => unknown])[];

it.each(malformedValidatorCases)('reports $0 through the stable schema diagnostic', async (_name, callback) => {
  const files = [{ contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' }];
  const root = await writeArtifact(files, true, [customManifestTarget]);

  try {
    await expect(validateArtifact({
      artifactRoot: root,
      registry: customRegistry(malformedValidator(callback)),
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB6012',
        generatedPath: 'custom/document.json',
        message: expect.stringContaining('schema validation failed.'),
        target: customTarget,
      }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('documents recovery for every stable artifact diagnostic code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-recovery-'));
  try {
    const diagnostics = await validateArtifact({ artifactRoot: root });

    expect(Object.keys(artifactDiagnosticRecoveries).sort()).toEqual([
      'AB6000', 'AB6001', 'AB6002', 'AB6003', 'AB6004', 'AB6005', 'AB6006',
      'AB6007', 'AB6008', 'AB6009', 'AB6010', 'AB6011', 'AB6012', 'AB6013',
      'AB6014', 'AB6015', 'AB6016', 'AB6017', 'AB6018', 'AB6019', 'AB6020',
      'AB6021', 'AB6022', 'AB6023', 'AB6024',
    ]);
    expect(Object.values(artifactDiagnosticRecoveries).every((recovery) => recovery.trim().length > 0)).toBe(true);
    expect(artifactDiagnosticRecoveries.AB6015).not.toBe(artifactDiagnosticRecoveries.AB6016);
    expect(diagnostics).toEqual([expect.objectContaining({
      code: 'AB6000',
      recovery: artifactDiagnosticRecoveries.AB6000,
    })]);
    expect(diagnostics.every((diagnostic) =>
      diagnostic.recovery !== undefined && diagnostic.recovery.trim().length > 0,
    )).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

const installSurfaceModel = (target: string): NormalizedPlugin => ({
  extensions: {},
  hooks: [],
  mcpServers: [],
  metadata: {
    id: 'plugin:artifact-install',
    name: 'artifact-install',
    provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
    version: '1.0.0',
  },
  runtime: { node: '22.19.0' },
  scripts: [],
  skills: [],
  targets: [{
    id: `target:${target}`,
    name: target,
    provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
  }],
});

const installSurfaceArtifact = async (
  target: 'claude' | 'codex' | 'cursor' | 'plugin' | 'portable',
  omitted: string,
): Promise<string> => {
  const registry = createDefaultRegistry();
  const files = registry.get(target).plan(installSurfaceModel(target)).entries
    .filter((entry): entry is TargetArtifactWrite => entry.kind === 'write')
    .filter((entry) => entry.relativePath !== omitted)
    .map((entry) => ({
      contents: entry.content,
      kind: 'generated' as const,
      path: `${target}/${entry.relativePath}`,
    }));
  return writeArtifact(files, true, [targetFromRegistry(registry, target)]);
};

it.each(['claude', 'codex', 'cursor', 'plugin', 'portable'] as const)(
  'rejects a %s artifact without INSTALL.md',
  async (target) => {
    const root = await installSurfaceArtifact(target, 'INSTALL.md');
    try {
      await expect(validateArtifact({ artifactRoot: root })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'AB6023',
          generatedPath: `${target}/INSTALL.md`,
          target,
        }),
      ]));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

it.each(['cursor', 'plugin', 'portable'] as const)(
  'rejects a %s fallback artifact without install.mjs',
  async (target) => {
    const root = await installSurfaceArtifact(target, 'install.mjs');
    try {
      await expect(validateArtifact({ artifactRoot: root })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'AB6024',
          generatedPath: `${target}/install.mjs`,
          target,
        }),
      ]));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

it.each(['claude', 'codex'] as const)(
  'does not require a fallback script for the %s public CLI target',
  async (target) => {
    const root = await installSurfaceArtifact(target, 'install.mjs');
    try {
      await expect(validateArtifact({ artifactRoot: root })).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);
