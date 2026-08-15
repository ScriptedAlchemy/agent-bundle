import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { expect, it } from '@rstest/core';

import { containedPathComponents } from '../src/dev/project-service.ts';
import { validate } from '../src/api.ts';
import { digest } from '../src/core/digest.ts';
import {
  DiagnosticService,
  createProjectContext,
  ProjectService,
  snapshotProjectSource,
  type RslintEngine,
} from '../src/dev/index.ts';

it('rejects an absolute Windows path outside its project', () => {
  expect(containedPathComponents('C:\\project', 'C:\\outside', win32)).toBeUndefined();
});

it('splits a nested Windows path inside its project', () => {
  expect(containedPathComponents('C:\\project', 'C:\\project\\output\\artifact', win32)).toEqual([
    'output',
    'artifact',
  ]);
});

it('rejects a Windows path on a different drive', () => {
  expect(containedPathComponents('C:\\project', 'D:\\project\\artifact', win32)).toBeUndefined();
});

const createProject = async (skillMarkdown: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dev-service-'));
  await mkdir(join(root, 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'dev-service-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'skills', 'review', 'SKILL.md'), skillMarkdown),
  ]);
  return root;
};

const createRuntimeProject = async (options: Readonly<{
  readonly appMeta?: string;
  readonly appDeclaration?: string;
  readonly configSetup?: (metadataSentinel: string) => string;
  readonly provider?: string;
}> = {}): Promise<{
  readonly metadataSentinel: string;
  readonly root: string;
  readonly sentinel: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dev-runtime-'));
  const metadataSentinel = join(root, 'metadata-accessed');
  const sentinel = join(root, 'provider-imported');
  const appDeclaration = options.appDeclaration ?? (
    '{ _meta: ' + (options.appMeta ?? "{ ui: { preferred: 'compact' }, labels: ['one', 'two'] }") +
    ", entry: './src/app.ts', resourceUri: 'ui://timeline/v1/dashboard', targets: ['portable'], template: './src/shell.html' }"
  );
  await mkdir(join(root, 'skills', 'review'), { recursive: true });
  await mkdir(join(root, 'src', 'dev'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'skills', 'review', 'SKILL.md'), [
      '---',
      'name: review',
      'description: Reviews changes',
      '---',
      'Review the changed files.',
      '',
    ].join('\n')),
    writeFile(join(root, 'src', 'server.ts'), 'export const server = true;\n'),
    writeFile(join(root, 'src', 'app.ts'), 'export const app = true;\n'),
    writeFile(join(root, 'src', 'shell.html'), '<main>fixture</main>\n'),
    writeFile(join(root, 'src', 'dev', 'provider.ts'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(sentinel)}, 'imported');`,
      "export const createDevRuntimeProvider = () => ({ descriptor: { environmentVariables: [], id: 'fixture-runtime', label: 'Fixture runtime', schemaVersion: 1 }, start: async () => ({}) });",
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      options.configSetup?.(metadataSentinel) ?? '',
      'export default {',
      "  dev: { runtime: { provider: " + JSON.stringify(options.provider ?? './src/dev/provider.ts') + ' } },',
      "  mcp: { servers: { timeline: { apps: { dashboard: " + appDeclaration + " }, entry: './src/server.ts', targets: ['portable'] } } },",
      "  plugin: { name: 'dev-runtime-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n')),
  ]);
  return { metadataSentinel, root, sentinel };
};

it('prepares a frozen server-only runtime declaration only for development callers', async () => {
  const { root, sentinel } = await createRuntimeProject();
  try {
    const ordinary = await new ProjectService({ includeDevRuntime: false, mode: 'development', root }).prepare('build');
    const runtime = await new ProjectService({ includeDevRuntime: true, mode: 'development', root }).prepare('build');

    expect(ordinary.devRuntime).toBeUndefined();
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runtime.source.state).toBe('ready');
    expect(runtime.devRuntime).toEqual({
      apps: [{
        _meta: { labels: ['one', 'two'], ui: { preferred: 'compact' } },
        id: 'mcp-app:timeline:dashboard',
        name: 'dashboard',
        resourceUri: 'ui://timeline/v1/dashboard',
        serverId: 'mcp:timeline',
        serverName: 'timeline',
        source: join(root, 'src', 'app.ts'),
        targets: ['portable'],
        template: join(root, 'src', 'shell.html'),
      }],
      provider: './src/dev/provider.ts',
      servers: [expect.objectContaining({
        id: 'mcp:timeline',
        name: 'timeline',
        source: join(root, 'src', 'server.ts'),
        targets: ['portable'],
        transport: 'stdio',
      })],
      sourceRevision: runtime.source.revision,
    });
    expect(Object.isFrozen(runtime.devRuntime)).toBe(true);
    expect(Object.isFrozen(runtime.devRuntime?.apps)).toBe(true);
    expect(Object.isFrozen(runtime.devRuntime?.apps[0]!._meta)).toBe(true);
    expect(Object.isFrozen(runtime.devRuntime?.apps[0]!._meta?.labels)).toBe(true);
    expect('provenance' in runtime.devRuntime!.apps[0]!).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps supplemental runtime declaration and App metadata failures out of the artifact source lane', async () => {
  const malformedDeclaration = await createRuntimeProject({ provider: '  ' });
  const nonfiniteMetadata = await createRuntimeProject({ appMeta: '{ count: Number.NaN }' });
  try {
    const declaration = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: malformedDeclaration.root }).prepare('build');
    const metadata = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: nonfiniteMetadata.root }).prepare('build');

    expect(declaration.source.state).toBe('ready');
    expect(declaration.devRuntime).toBeUndefined();
    expect(declaration.devRuntimeDiagnostic).toMatchObject({ code: 'AB8200' });
    expect(metadata.source.state).toBe('ready');
    expect(metadata.devRuntime).toBeUndefined();
    expect(metadata.devRuntimeDiagnostic).toMatchObject({ code: 'AB8200' });
  } finally {
    await Promise.all([
      rm(malformedDeclaration.root, { force: true, recursive: true }),
      rm(nonfiniteMetadata.root, { force: true, recursive: true }),
    ]);
  }
});

it('sanitizes top-level MCP App metadata accessors before source validation without evaluating them', async () => {
  const accessorProject = (behavior: 'return' | 'throw') => createRuntimeProject({
    appDeclaration: 'dashboard',
    configSetup: (metadataSentinel) => [
      "import { writeFileSync } from 'node:fs';",
      "const dashboard = { entry: './src/app.ts', resourceUri: 'ui://timeline/v1/dashboard', targets: ['portable'], template: './src/shell.html' };",
      "Object.defineProperty(dashboard, '_meta', { enumerable: true, get: () => {",
      `  writeFileSync(${JSON.stringify(metadataSentinel)}, 'evaluated');`,
      behavior === 'return'
        ? "  return { token: 'metadata-accessor-secret' };"
        : "  throw new Error('metadata-accessor-secret');",
      '} });',
      '',
    ].join('\n'),
  });
  const returned = await accessorProject('return');
  const thrown = await accessorProject('throw');
  try {
    for (const project of [returned, thrown]) {
      const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: project.root }).prepare('build');
      expect(prepared.source.state).toBe('ready');
      expect(prepared.devRuntime).toBeUndefined();
      expect(prepared.devRuntimeDiagnostic).toMatchObject({ code: 'AB8200' });
      expect(prepared.devRuntimeDiagnostic?.message).not.toContain('metadata-accessor-secret');
      await expect(readFile(project.metadataSentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    await Promise.all([
      rm(returned.root, { force: true, recursive: true }),
      rm(thrown.root, { force: true, recursive: true }),
    ]);
  }
});

it('does not let supplemental metadata sanitization suppress unrelated source diagnostics', async () => {
  const project = await createRuntimeProject({ appMeta: '{ count: Number.NaN }' });
  try {
    await writeFile(join(project.root, 'skills', 'review', 'SKILL.md'), '# Missing frontmatter\n');
    const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: project.root }).prepare('build');

    expect(prepared.source).toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'AB3001' })]),
      state: 'invalid',
    });
    expect(prepared.model).toBeUndefined();
  } finally {
    await rm(project.root, { force: true, recursive: true });
  }
});

it('stops the shared project pipeline on source errors with a frozen structured status', async () => {
  const root = await createProject('# Missing frontmatter\n');
  try {
    const prepared = await new ProjectService({ root }).prepare('build');

    expect(prepared.source.state).toBe('invalid');
    expect(prepared.source.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB3001',
        sourcePath: join(root, 'skills', 'review', 'SKILL.md'),
      }),
    ]));
    expect(prepared.model).toBeUndefined();
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.diagnostics)).toBe(true);
    expect(Object.isFrozen(prepared.source)).toBe(true);
    expect(Object.isFrozen(prepared.source.diagnostics)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('returns a frozen source diagnostic when configuration loading fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dev-missing-config-'));
  try {
    const prepared = await new ProjectService({ root }).prepare('inspect');

    expect(prepared).toMatchObject({
      source: {
        diagnostics: [{ code: 'AB7000', sourcePath: join(root, 'agent-bundle.config.ts') }],
        state: 'invalid',
      },
    });
    expect(prepared.model).toBeUndefined();
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.source.diagnostics[0])).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('retains the resolved configuration path in the prepared project', async () => {
  const root = await createProject([
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    'Review the changed files.',
    '',
  ].join('\n'));
  try {
    const prepared = await new ProjectService({ root }).prepare('build');

    expect(Object.getOwnPropertyDescriptor(prepared, 'configPath')?.value).toBe(
      join(root, 'agent-bundle.config.ts'),
    );
    expect(prepared.projectContext?.configDigest).toBe(
      createHash('sha256').update(await readFile(join(root, 'agent-bundle.config.ts'))).digest('hex'),
    );
    expect(prepared.projectContext?.sourceInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'agent-bundle.config.ts' }),
      expect.objectContaining({ path: 'skills/review/SKILL.md' }),
    ]));
    expect(Object.isFrozen(prepared.projectContext?.sourceInputs)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('creates an exact deeply frozen root-independent project context', async () => {
  const skillMarkdown = [
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    'Review the changed files.',
    '',
  ].join('\n');
  const leftRoot = await createProject(skillMarkdown);
  const rightRoot = await createProject(skillMarkdown);
  try {
    await Promise.all([
      writeFile(join(leftRoot, 'z-last.txt'), 'z\n'),
      writeFile(join(leftRoot, 'a-first.txt'), 'a\n'),
      writeFile(join(rightRoot, 'z-last.txt'), 'z\n'),
      writeFile(join(rightRoot, 'a-first.txt'), 'a\n'),
    ]);
    const [left, right] = await Promise.all([
      new ProjectService({ root: leftRoot }).prepare('build'),
      new ProjectService({ root: rightRoot }).prepare('build'),
    ]);

    expect(left.projectContext).toEqual(right.projectContext);
    expect(left.projectContext).toBeDefined();
    expect(Object.keys(left.projectContext ?? {})).toEqual([
      'configDigest',
      'configPath',
      'modelDigest',
      'revision',
      'sourceInputs',
    ]);
    expect(left.projectContext?.configPath).toBe('agent-bundle.config.ts');
    expect(left.projectContext?.revision).toBe(digest({ inputs: left.projectContext?.sourceInputs }));
    expect(left.projectContext?.sourceInputs.map((input) => input.path)).toEqual([
      'a-first.txt',
      'agent-bundle.config.ts',
      'skills/review/SKILL.md',
      'z-last.txt',
    ]);
    expect(Object.isFrozen(left.projectContext)).toBe(true);
    expect(Object.isFrozen(left.projectContext?.sourceInputs)).toBe(true);
    expect(Object.isFrozen(left.projectContext?.sourceInputs[0])).toBe(true);
    expect(Object.keys(left.projectContext?.sourceInputs[0] ?? {})).toEqual(['path', 'sha256']);
    expect(JSON.stringify(left.projectContext)).not.toContain(leftRoot);
    expect(JSON.stringify(right.projectContext)).not.toContain(rightRoot);

    const model = left.model;
    if (model === undefined) throw new Error('Expected a normalized project model.');
    await expect(Promise.resolve().then(() => createProjectContext({
      configPath: left.configPath,
      model,
      root: leftRoot,
      sourceInputs: [{ error: 'EACCES', path: 'agent-bundle.config.ts' }],
    }))).rejects.toThrow(/SHA-256 digest/i);
    for (const sourceInput of [
      { path: 'skills\\review\\SKILL.md', sha256: 'a'.repeat(64) },
      { path: 'scratch/../source.ts', sha256: 'a'.repeat(64) },
      { path: 'source.txt', sha256: 'A'.repeat(64) },
    ]) {
      expect(() => createProjectContext({
        configPath: left.configPath,
        model,
        root: leftRoot,
        sourceInputs: [...(left.projectContext?.sourceInputs ?? []), sourceInput],
      })).toThrow(/(?:canonical POSIX path|lowercase SHA-256)/i);
    }
    const externalSource = `${leftRoot}-external-source.ts`;
    const escapedSourceLink = join(leftRoot, 'escaped-source.ts');
    await writeFile(externalSource, 'export const outside = true;\n');
    await symlink(externalSource, escapedSourceLink);
    expect(() => createProjectContext({
      configPath: left.configPath,
      model,
      root: leftRoot,
      sourceInputs: [
        ...(left.projectContext?.sourceInputs ?? []),
        { path: 'escaped-source.ts', sha256: 'a'.repeat(64) },
      ],
    })).toThrow(/outside project root/i);
    expect(() => createProjectContext({
      configPath: left.configPath,
      model: {
        ...model,
        metadata: {
          ...model.metadata,
          provenance: { ...model.metadata.provenance, sourcePath: join(leftRoot, '..', 'outside.ts') },
        },
      },
      root: leftRoot,
      sourceInputs: left.projectContext?.sourceInputs ?? [],
    })).toThrow(/outside project root/i);

    const extensionValue = { nested: { enabled: true } };
    const frontmatter = { ...model.skills[0]!.frontmatter, custom: { enabled: true } };
    const modelTargets = [...model.targets];
    const skillTargets = [...model.skills[0]!.targets];
    const mutableModel = {
      ...model,
      extensions: {
        fixture: {
          id: 'extension:fixture',
          key: 'fixture',
          provenance: { ...model.metadata.provenance },
          target: 'portable',
          value: extensionValue,
        },
      },
      skills: model.skills.map((skill) => ({ ...skill, frontmatter, targets: skillTargets })),
      targets: modelTargets,
    };
    const mutableContext = createProjectContext({
      configPath: left.configPath,
      model: mutableModel,
      root: leftRoot,
      sourceInputs: left.projectContext?.sourceInputs ?? [],
    });
    expect(Object.isFrozen(extensionValue)).toBe(false);
    expect(Object.isFrozen(extensionValue.nested)).toBe(false);
    expect(Object.isFrozen(frontmatter)).toBe(false);
    expect(Object.isFrozen(modelTargets)).toBe(false);
    expect(Object.isFrozen(skillTargets)).toBe(false);
    extensionValue.nested.enabled = false;
    expect(createProjectContext({
      configPath: left.configPath,
      model: mutableModel,
      root: leftRoot,
      sourceInputs: left.projectContext?.sourceInputs ?? [],
    }).modelDigest).not.toBe(mutableContext.modelDigest);
    const cyclicValue: { self?: unknown } = {};
    cyclicValue.self = cyclicValue;
    for (const value of [new Date(), cyclicValue]) {
      expect(() => createProjectContext({
        configPath: left.configPath,
        model: {
          ...mutableModel,
          extensions: {
            fixture: { ...mutableModel.extensions.fixture, value },
          },
        },
        root: leftRoot,
        sourceInputs: left.projectContext?.sourceInputs ?? [],
      })).toThrow(/(?:JSON values|cyclic values|plain JSON objects)/i);
    }
  } finally {
    await Promise.all([
      rm(leftRoot, { force: true, recursive: true }),
      rm(rightRoot, { force: true, recursive: true }),
      rm(`${leftRoot}-external-source.ts`, { force: true }),
    ]);
  }
});

it('prepares a symlinked project root from its canonical filesystem identity', async () => {
  const root = await createProject([
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    'Review the changed files.',
    '',
  ].join('\n'));
  const linkedRoot = `${root}-link`;
  try {
    await symlink(root, linkedRoot, 'dir');
    const prepared = await new ProjectService({ root: linkedRoot }).prepare('build');

    expect(prepared.source.state).toBe('ready');
    expect(prepared.projectContext).toBeDefined();
    expect(prepared.configPath).toBe(join(root, 'agent-bundle.config.ts'));
    expect(JSON.stringify(prepared.projectContext)).not.toContain(linkedRoot);
    expect(JSON.stringify(prepared.projectContext)).not.toContain(root);
  } finally {
    await Promise.all([
      rm(linkedRoot, { force: true, recursive: true }),
      rm(root, { force: true, recursive: true }),
    ]);
  }
});

it('excludes configured output trees from project identity and reports unsafe output roots', async () => {
  const root = await createProject([
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    'Review the changed files.',
    '',
  ].join('\n'));
  const output = join(root, 'custom-output');
  try {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'generated.js'), 'first\n');
    const initial = await new ProjectService({ outputRoots: [output], root }).prepare('build');
    await writeFile(join(output, 'generated.js'), 'second\n');
    const changed = await new ProjectService({ outputRoots: [output], root }).prepare('build');

    expect(changed.projectContext).toEqual(initial.projectContext);
    expect(changed.projectContext?.sourceInputs.map((input) => input.path)).not.toContain(
      'custom-output/generated.js',
    );
    await expect(snapshotProjectSource(root, join(root, '..', 'outside.ts')))
      .rejects.toThrow(/outside project root/i);
    const invalid = await new ProjectService({ outputRoots: [root], root }).prepare('build');
    expect(invalid).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB7002', recovery: expect.any(String) })],
      source: { state: 'invalid' },
    });
    expect(invalid.model).toBeUndefined();
    expect(invalid.projectContext).toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports external configuration symlinks without exposing the underlying path error', async () => {
  const root = await createProject([
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    'Review the changed files.',
    '',
  ].join('\n'));
  const externalConfig = join(root, '..', 'external-agent-bundle.config.ts');
  const configPath = join(root, 'agent-bundle.config.ts');
  try {
    await writeFile(externalConfig, [
      'export default {',
      "  plugin: { name: 'external-config', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'));
    await rm(configPath);
    await symlink(externalConfig, configPath);

    const prepared = await new ProjectService({ root }).prepare('inspect');

    expect(prepared).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB7000', recovery: expect.any(String) })],
      source: { state: 'invalid' },
    });
    expect(JSON.stringify(prepared)).not.toContain('outside project root');
    expect(prepared.model).toBeUndefined();
    expect(prepared.projectContext).toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(externalConfig, { force: true });
  }
});

it('reports snapshot failures as frozen preparation diagnostics', async () => {
  const root = await createProject([
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    'Review the changed files.',
    '',
  ].join('\n'));
  const output = join(root, 'snapshot-output');
  const externalOutput = join(root, '..', 'snapshot-output-external');
  try {
    await mkdir(externalOutput);
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { symlinkSync } from 'node:fs';",
      'export default ({ projectRoot }) => {',
      `  symlinkSync(${JSON.stringify(externalOutput)}, \`${'${projectRoot}'}/snapshot-output\`);`,
      '  return {',
      "    plugin: { name: 'snapshot-failure', version: '1.0.0' },",
      "    targets: ['portable'],",
      '  };',
      '};',
      '',
    ].join('\n'));

    const prepared = await new ProjectService({ outputRoots: [output], root }).prepare('inspect');

    expect(prepared).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB7003', recovery: expect.any(String) })],
      source: { state: 'invalid' },
    });
    expect(prepared.model).toBeUndefined();
    expect(prepared.projectContext).toBeUndefined();
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.diagnostics[0])).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(externalOutput, { force: true, recursive: true });
  }
});

it('routes API validation through the project service for configuration failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dev-api-config-'));
  try {
    const prepared = await new ProjectService({ root }).prepare('validate');
    const result = await validate({ root });

    expect(result).toEqual({ diagnostics: prepared.diagnostics });
    expect(Object.isFrozen(result)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('derives source revisions from authored bytes, including resources and invalid Skill content', async () => {
  const skillMarkdown = [
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    '[Guide](guide.txt)',
    '',
  ].join('\n');
  const root = await createProject(skillMarkdown);
  const equivalentRoot = await createProject(skillMarkdown);
  const invalidRoot = await createProject('# First invalid skill\n');
  try {
    await Promise.all([
      writeFile(join(root, 'skills', 'review', 'guide.txt'), 'one'),
      writeFile(join(equivalentRoot, 'skills', 'review', 'guide.txt'), 'one'),
    ]);
    const initial = await new ProjectService({ root }).prepare('build');
    const equivalentInitial = await new ProjectService({ root: equivalentRoot }).prepare('build');
    await writeFile(join(root, 'skills', 'review', 'guide.txt'), 'two');
    const resourceChanged = await new ProjectService({ root }).prepare('build');
    await writeFile(join(equivalentRoot, 'skills', 'review', 'guide.txt'), 'two');
    const equivalentChanged = await new ProjectService({ root: equivalentRoot }).prepare('build');

    const invalidInitial = await new ProjectService({ root: invalidRoot }).prepare('build');
    await writeFile(join(invalidRoot, 'skills', 'review', 'SKILL.md'), '# Second invalid skill\n');
    const invalidChanged = await new ProjectService({ root: invalidRoot }).prepare('build');

    expect(initial.source.revision).toBe(equivalentInitial.source.revision);
    expect(resourceChanged.source.revision).toBe(equivalentChanged.source.revision);
    expect(resourceChanged.source.revision).not.toBe(initial.source.revision);
    expect(invalidInitial.source.state).toBe('invalid');
    expect(invalidChanged.source.state).toBe('invalid');
    expect(invalidChanged.source.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      invalidInitial.source.diagnostics.map((diagnostic) => diagnostic.code),
    );
    expect(invalidChanged.source.revision).not.toBe(invalidInitial.source.revision);
  } finally {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(equivalentRoot, { force: true, recursive: true }),
      rm(invalidRoot, { force: true, recursive: true }),
    ]);
  }
});

it('derives source revisions from the broad authored project graph while excluding generated and dependency trees', async () => {
  const root = await createProject([
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    'Review the changed files.',
    '',
  ].join('\n'));
  try {
    await Promise.all([
      mkdir(join(root, 'src'), { recursive: true }),
      mkdir(join(root, 'dist'), { recursive: true }),
      mkdir(join(root, 'node_modules', 'dependency'), { recursive: true }),
      mkdir(join(root, '.agent-bundle'), { recursive: true }),
      mkdir(join(root, '.git'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, 'src', 'entry.ts'), "import { value } from './shared.ts';\nexport { value };\n"),
      writeFile(join(root, 'src', 'shared.ts'), 'export const value = 1;\n'),
      writeFile(join(root, 'dist', 'generated.js'), 'first\n'),
      writeFile(join(root, 'node_modules', 'dependency', 'index.js'), 'first\n'),
      writeFile(join(root, '.agent-bundle', 'active-epoch.json'), 'first\n'),
      writeFile(join(root, '.git', 'HEAD'), 'first\n'),
    ]);

    const initial = await new ProjectService({ root }).prepare('build');
    await writeFile(join(root, 'src', 'shared.ts'), 'export const value = 2;\n');
    const importedSourceChanged = await new ProjectService({ root }).prepare('build');
    await Promise.all([
      writeFile(join(root, 'dist', 'generated.js'), 'second\n'),
      writeFile(join(root, 'node_modules', 'dependency', 'index.js'), 'second\n'),
      writeFile(join(root, '.agent-bundle', 'active-epoch.json'), 'second\n'),
      writeFile(join(root, '.git', 'HEAD'), 'second\n'),
    ]);
    const excludedOnlyChanged = await new ProjectService({ root }).prepare('build');

    expect(importedSourceChanged.source.revision).not.toBe(initial.source.revision);
    expect(excludedOnlyChanged.source.revision).toBe(importedSourceChanged.source.revision);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reuses one resident Rslint engine and closes it idempotently', async () => {
  const root = '/workspace/project';
  const lintCalls: string[][] = [];
  let created = 0;
  let closed = 0;
  const engine: RslintEngine = {
    close: async () => {
      closed += 1;
    },
    lintFiles: async (paths) => {
      lintCalls.push([...paths]);
      return [{
        filePath: join(root, 'src', 'entry.ts'),
        messages: [{
          column: 7,
          line: 3,
          message: 'Unexpected console statement.',
          ruleId: 'no-console',
          severity: 2,
        }],
      }];
    },
  };
  const service = new DiagnosticService({
    createRslint: () => {
      created += 1;
      return engine;
    },
    root,
  });

  const first = await service.lint(['src/entry.ts']);
  const second = await service.lint(['src/other.ts']);
  await service.close();
  await service.close();

  expect(first).toEqual({
    diagnostics: [{
      code: 'RSLINT/no-console',
      message: 'Unexpected console statement. (3:7)',
      severity: 'error',
      sourcePath: join(root, 'src', 'entry.ts'),
    }],
    paths: [join(root, 'src', 'entry.ts')],
  });
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.diagnostics)).toBe(true);
  expect(created).toBe(1);
  expect(lintCalls).toEqual([
    [join(root, 'src', 'entry.ts')],
    [join(root, 'src', 'other.ts')],
  ]);
  expect(closed).toBe(1);
  expect(second.paths).toEqual([join(root, 'src', 'other.ts')]);
});

it('shares a failed engine close with concurrent and later callers', async () => {
  const failure = new Error('engine shutdown failed');
  let closeCalls = 0;
  let rejectClose: (reason: Error) => void = () => undefined;
  const engine: RslintEngine = {
    close: () => {
      closeCalls += 1;
      return new Promise<void>((_resolve, reject) => {
        rejectClose = reject as (reason: Error) => void;
      });
    },
    lintFiles: async () => [],
  };
  const service = new DiagnosticService({
    createRslint: () => engine,
    root: '/workspace/project',
  });
  await service.lint(['src/entry.ts']);

  const first = service.close();
  const second = service.close();
  rejectClose(failure);
  const observed = await Promise.all([
    first.then(() => undefined, (error: unknown) => error),
    second.then(() => undefined, (error: unknown) => error),
  ]);
  const later = service.close();
  const laterError = await later.then(() => undefined, (error: unknown) => error);

  expect(closeCalls).toBe(1);
  expect(first).toBe(second);
  expect(later).toBe(first);
  expect(observed).toEqual([failure, failure]);
  expect(laterError).toBe(failure);
});
