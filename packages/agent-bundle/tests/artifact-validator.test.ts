import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from '@rstest/core';

import { createDefaultRegistry, TargetRegistry } from '../src/adapters/registry.ts';
import { readStandardNativeHookCommands, type TargetHookContract } from '../src/adapters/hook-contract.ts';
import type { TargetAdapter, TargetArtifactDocumentValidator } from '../src/adapters/types.ts';
import { assembleArtifactManifest, type ArtifactManifestV2 } from '../src/build/manifest.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { digest } from '../src/core/digest.ts';
import { agentSkillsSchemaRevision } from '../src/schemas/agent-skills/contract.ts';
import { createMcpPathTokenResolver } from '../src/services/mcp-path-tokens.ts';
import { createTargetMcpRuntime } from '../src/services/mcp-runtime.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

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
    : [{ contents: '{"hooks":[],"version":1}\n', kind: 'generated', path: 'agent-bundle.hooks.json' }, ...files];

const manifestFor = (
  files: readonly ArtifactFixtureFile[],
  includeModes = true,
  targets: readonly ArtifactManifestV2['targets'][number][] = [],
): ArtifactManifestV2 => {
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
    targets,
    validation: {
      artifact: { status: 'passed' },
      source: { status: 'passed' },
      targets: targets.map(({ name }) => ({ name, status: 'passed' })),
    },
    version: 2,
  };
};

const writeArtifact = async (
  files: readonly ArtifactFixtureFile[],
  includeModes = true,
  targets: readonly ArtifactManifestV2['targets'][number][] = [],
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
  capabilityRevision: 'custom-capabilities-v1',
  capabilitySha256: 'a'.repeat(64),
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
  capabilityRevision: 'coherence-capabilities-v1',
  capabilitySha256: 'c'.repeat(64),
  observedVersion: 'coherence-observed-v1',
  schemas: Object.freeze([]),
});

const coherenceManifestTarget = Object.freeze({ ...coherenceMetadata, name: coherenceTarget });

const coherenceRegistry = (): TargetRegistry => new TargetRegistry().register({
  artifactLayout: { mcpEntries: { allowedSuffixes: ['.mjs'], directory: 'mcp' } },
  capabilities: { mcp: true },
  mcpRuntime: createTargetMcpRuntime({
    manifestPath: 'native/servers.json',
    remoteTypes: ['streamable-http'],
    resolveValue: createMcpPathTokenResolver({ target: coherenceTarget, tokens: {} }),
  }),
  metadata: coherenceMetadata,
  name: coherenceTarget,
  plan: () => ({ diagnostics: [], entries: [] }),
  validateModel: () => [],
} satisfies TargetAdapter);

const hookCoherenceTarget = 'hooked';
const hookCoherenceMetadata = Object.freeze({
  adapterRevision: 'hook-coherence-adapter-v1',
  capabilityRevision: 'hook-coherence-capabilities-v1',
  capabilitySha256: 'd'.repeat(64),
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
  capabilities: { hooks: true },
  hookContract: hookCoherenceContract,
  metadata: hookCoherenceMetadata,
  name: hookCoherenceTarget,
  plan: () => ({ diagnostics: [], entries: [] }),
  validateModel: () => [],
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
    scripts: { allowedSuffixes: ['.json', '.mjs', '.sh'], directory: 'scripts' },
    skills: 'skills',
  },
  capabilities: { skills: true },
  metadata: customMetadata,
  name: customTarget,
  plan: () => ({ diagnostics: [], entries: [] }),
  validateModel: () => [],
} satisfies TargetAdapter);

const targetFromRegistry = (registry: TargetRegistry, name: string): ArtifactManifestV2['targets'][number] => {
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

it('rejects an artifact symlink even when the manifest remains self-consistent', async () => {
  const files = [{ contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' }];
  const root = await writeArtifact(files, true, [customManifestTarget]);

  try {
    await symlink(join(root, 'custom', 'document.json'), join(root, 'custom', 'unexpected-link.json'));
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: customRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6013', generatedPath: 'custom/unexpected-link.json' }),
    ]));
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

it.each([
  ['a missing copied resource', '[missing resource](references/missing.md)'],
  ['a percent-encoded path that escapes the Skill root', '[escape resource](..%2Fdocument.json)'],
])('rejects emitted Skill Markdown with %s', async (_name, body) => {
  const root = await writeArtifact(customSkillFiles(body), true, [customManifestTarget]);

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: customRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6016', generatedPath: 'custom/skills/artifact-skill/SKILL.md', target: customTarget }),
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
      expect.objectContaining({ code: 'AB6015', generatedPath: 'custom/skills/artifact-skill/SKILL.md', target: customTarget }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects legacy, noncanonical, and duplicate-key manifests as strict v2 parse failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-v1-validator-'));

  try {
    await writeFile(join(root, 'agent-bundle.manifest.json'), '{"files":[],"targets":[],"version":1}\n');
    expect(await validateArtifact({ artifactRoot: root })).toEqual([
      expect.objectContaining({ code: 'AB6001', generatedPath: 'agent-bundle.manifest.json' }),
    ]);

    const canonical = assembleArtifactManifest(manifestFor(withHookIndex([]))).bytes;
    for (const bytes of [JSON.stringify(JSON.parse(canonical), null, 2), canonical.replace(',"version":2', ',"version":2,"version":2')]) {
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

it('preserves structural artifact diagnostics after a strict v2 manifest passes', async () => {
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
  ];
  const root = await writeArtifact(files, true, [coherenceManifestTarget]);

  try {
    const diagnostics = await validateArtifact({ artifactRoot: root, registry: coherenceRegistry() });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6017', generatedPath: 'coherent/mcp/mcp-junk-deadbeef.mjs', target: coherenceTarget }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
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
    { contents: '{"hooks":[],"version":1}\n', kind: 'generated' as const, path: 'agent-bundle.hooks.json' },
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
      { ...customManifestTarget, capabilityRevision: 'different-capabilities' },
      { ...customManifestTarget, capabilitySha256: 'c'.repeat(64) },
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
    { contents: `${JSON.stringify(plugin)}\n`, kind: 'generated' as const, path: 'codex/.codex-plugin/plugin.json' },
    { contents: `${JSON.stringify(marketplace)}\n`, kind: 'generated' as const, path: 'codex/.agents/plugins/marketplace.json' },
  ];
  const root = await writeArtifact(validFiles, true, [target]);

  try {
    expect(await validateArtifact({ artifactRoot: root, registry })).toEqual([]);

    const invalidFiles = [
      validFiles[0]!,
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
    get: () => {
      throw new Error('issue element getter must not escape validation');
    },
  });
  issues.length = 1;
  return issues;
};

const throwingIssueProperty = (): object => Object.defineProperties({}, {
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

const thenableArray = (): unknown => Object.assign([], { then: () => undefined });

const malformedValidatorCases: readonly (readonly [string, () => unknown])[] = [
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
];

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
