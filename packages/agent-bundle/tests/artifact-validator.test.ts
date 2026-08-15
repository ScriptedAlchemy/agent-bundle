import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from '@rstest/core';

import { createDefaultRegistry, TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter, TargetArtifactDocumentValidator } from '../src/adapters/types.ts';
import { assembleArtifactManifest, type ArtifactManifestV2 } from '../src/build/manifest.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { digest } from '../src/core/digest.ts';
import { agentSkillsSchemaRevision } from '../src/schemas/agent-skills/contract.ts';

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
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-validator-'));
  for (const file of files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents);
    if (file.mode !== undefined) await chmod(path, file.mode);
  }
  await writeFile(
    join(root, 'agent-bundle.manifest.json'),
    assembleArtifactManifest(manifestFor(files, includeModes, targets)).bytes,
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

const validateCustomDocument: TargetArtifactDocumentValidator = (document) =>
  typeof document === 'object' && document !== null && (document as { readonly kind?: unknown }).kind === 'custom'
    ? []
    : [{ instancePath: '/kind', message: 'must equal "custom"' }];

const customRegistry = (validate = validateCustomDocument): TargetRegistry => new TargetRegistry().register({
  artifactValidation: {
    documents: [{ path: 'document.json', required: true, schema: 'document' }],
    schemas: [{ name: 'document', validate }],
  },
  artifactLayout: { skills: 'skills' },
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

    const canonical = assembleArtifactManifest(manifestFor([])).bytes;
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
      await writeFile(join(root, 'agent-bundle.manifest.json'), assembleArtifactManifest(manifestFor(files, true, [target])).bytes);
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
      assembleArtifactManifest(manifestFor(invalidFiles, true, [customManifestTarget])).bytes,
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
      assembleArtifactManifest(manifestFor(invalidFiles, true, [target])).bytes,
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
