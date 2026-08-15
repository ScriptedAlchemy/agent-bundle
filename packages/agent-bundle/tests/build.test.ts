import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from '@rstest/core';
import { spawn } from 'node:child_process';

import { build } from '../src/build/build.ts';
import { publishArtifact } from '../src/build/emit.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import { TargetRegistry } from '../src/adapters/registry.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';

interface TestProject {
  readonly localModulePath: string;
  readonly outputRoot: string;
  readonly pythonScriptPath: string;
  readonly root: string;
  readonly shellScriptPath: string;
  readonly scriptPath: string;
}

interface FileDigest {
  readonly bytes: number;
  readonly mode: number;
  readonly path: string;
  readonly sha256: string;
}

const sha256 = (contents: Uint8Array): string =>
  createHash('sha256').update(contents).digest('hex');

const testAdapterMetadata = Object.freeze({
  adapterRevision: 'test',
  capabilityRevision: 'test',
  capabilitySha256: '0'.repeat(64),
  observedVersion: 'test',
  schemas: Object.freeze([]),
});

const skillFixture = {
  markdown: '---\nname: review\ndescription: Review changes\n---\n# Review\n\nSee [guide](references/guide.md).\n',
  module: "export const greeting = 'hello from skill bundle';\n",
  python: "#!/usr/bin/env python3\nprint('review python resource')\n",
  shell: "#!/bin/sh\nprintf 'review shell resource\\n'\n",
  source: [
    "import { greeting } from './local greeting module.ts';",
    'export const emittedGreeting = greeting;',
    'console.log(emittedGreeting);',
    '',
  ].join('\n'),
} as const;

const treeDigest = async (
  root: string,
  prefix = '',
): Promise<readonly FileDigest[]> => {
  const directory = await import('node:fs/promises').then(({ readdir }) =>
    readdir(join(root, prefix), { withFileTypes: true }),
  );
  const files: FileDigest[] = [];

  for (const entry of directory.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await treeDigest(root, path)));
      continue;
    }
    if (!entry.isFile()) continue;

    const absolutePath = join(root, path);
    const [contents, metadata] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath),
    ]);
    files.push({
      bytes: contents.byteLength,
      mode: metadata.mode & 0o777,
      path: path.replaceAll('\\', '/'),
      sha256: sha256(contents),
    });
  }

  return files;
};

const createProject = async (): Promise<TestProject> => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle build with spaces '));
  const skillRoot = join(root, 'skills', 'review');
  const skillScriptsRoot = join(skillRoot, 'scripts');
  const scriptPath = join(skillScriptsRoot, 'greeting script.ts');
  const localModulePath = join(skillScriptsRoot, 'local greeting module.ts');
  const shellScriptPath = join(skillScriptsRoot, 'review helper.sh');
  const pythonScriptPath = join(skillScriptsRoot, 'review helper.py');

  await Promise.all([
    mkdir(join(skillRoot, 'assets'), { recursive: true }),
    mkdir(join(skillRoot, 'references'), { recursive: true }),
    mkdir(skillScriptsRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(scriptPath, skillFixture.source),
    writeFile(join(root, 'package.json'), '{"name":"build-fixture","type":"module"}\n'),
    writeFile(localModulePath, skillFixture.module),
    writeFile(
      join(skillRoot, 'SKILL.md'),
      skillFixture.markdown,
    ),
    writeFile(join(skillRoot, 'references', 'guide.md'), '# Guide\n'),
    writeFile(join(skillRoot, 'assets', 'icon.bin'), Buffer.from([0, 1, 2, 255])),
    writeFile(shellScriptPath, skillFixture.shell),
    writeFile(pythonScriptPath, skillFixture.python),
  ]);
  await Promise.all([
    chmod(join(skillRoot, 'assets', 'icon.bin'), 0o751),
    chmod(shellScriptPath, 0o751),
    chmod(pythonScriptPath, 0o751),
  ]);

  return {
    localModulePath,
    outputRoot: join(root, 'dist'),
    pythonScriptPath,
    root,
    shellScriptPath,
    scriptPath,
  };
};

const modelFor = (project: TestProject): NormalizedPlugin => ({
  extensions: {},
  hooks: [],
  mcpServers: [],
  metadata: {
    id: 'plugin:review-tools',
    name: 'review-tools',
    provenance: { kind: 'config', sourcePath: join(project.root, 'agent-bundle.config.ts') },
    version: '1.0.0',
  },
  scripts: [
    {
      id: 'script:greeting',
      mode: 'bundle',
      name: 'greeting',
      provenance: { kind: 'explicit', sourcePath: project.scriptPath },
      source: project.scriptPath,
      targets: ['portable'],
    },
  ],
  skills: [
    {
      body: '# Review\n\nSee [guide](references/guide.md).\n',
      description: 'Review changes',
      dir: join(project.root, 'skills', 'review'),
      frontmatter: { description: 'Review changes', name: 'review' },
      id: 'skill:review',
      name: 'review',
      provenance: { kind: 'conventional', sourcePath: join(project.root, 'skills', 'review', 'SKILL.md') },
      resources: [
        {
          bytes: Buffer.byteLength(skillFixture.markdown),
          relativePath: 'SKILL.md',
          source: join(project.root, 'skills', 'review', 'SKILL.md'),
        },
        {
          bytes: 4,
          relativePath: 'assets/icon.bin',
          source: join(project.root, 'skills', 'review', 'assets', 'icon.bin'),
        },
        {
          bytes: 8,
          relativePath: 'references/guide.md',
          source: join(project.root, 'skills', 'review', 'references', 'guide.md'),
        },
        {
          bytes: Buffer.byteLength(skillFixture.source),
          relativePath: 'scripts/greeting script.ts',
          source: project.scriptPath,
        },
        {
          bytes: Buffer.byteLength(skillFixture.module),
          relativePath: 'scripts/local greeting module.ts',
          source: project.localModulePath,
        },
        {
          bytes: Buffer.byteLength(skillFixture.shell),
          relativePath: 'scripts/review helper.sh',
          source: project.shellScriptPath,
        },
        {
          bytes: Buffer.byteLength(skillFixture.python),
          relativePath: 'scripts/review helper.py',
          source: project.pythonScriptPath,
        },
      ],
      source: join(project.root, 'skills', 'review', 'SKILL.md'),
      targets: ['portable'],
    },
  ],
  targets: [
    {
      id: 'target:portable',
      name: 'portable',
      provenance: { kind: 'config', sourcePath: join(project.root, 'agent-bundle.config.ts') },
    },
  ],
});

const runModule = async (modulePath: string, cwd: string): Promise<{ readonly code: number | null; readonly output: string }> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(modulePath).href)});`],
      { cwd, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, output }));
  });

const cleanupProject = async (project: TestProject): Promise<void> => {
  await rm(project.root, { force: true, recursive: true });
};

it('builds a configured TypeScript Skill script from paths with spaces without repository dependencies', async () => {
  const project = await createProject();
  const model = modelFor(project);

  try {
    const result = await build({
      model,
      outputRoot: project.outputRoot,
      projectRoot: project.root,
      registry: new TargetRegistry().register((await import('../src/adapters/portable.ts')).portableAdapter, { default: true }),
    });

    const emittedScript = join(project.outputRoot, 'portable', 'scripts', 'greeting.mjs');
    expect(result.compiledEntries).toMatchObject([
      { name: 'greeting', output: emittedScript, source: project.scriptPath },
    ]);
    await expect(readFile(result.compiledEntries[0]!.output, 'utf8')).resolves.toContain(
      'hello from skill bundle',
    );
    const cleanDirectory = join(project.root, 'clean consumer');
    await mkdir(cleanDirectory);
    await expect(runModule(emittedScript, cleanDirectory)).resolves.toEqual({
      code: 0,
      output: 'hello from skill bundle\n',
    });
    await expect(readFile(emittedScript, 'utf8')).resolves.not.toMatch(
      /from\s+['"]agent-bundle(?:\/[^'"]*)?['"]/,
    );

    const manifest = JSON.parse(
      await readFile(join(project.outputRoot, 'agent-bundle.manifest.json'), 'utf8'),
    ) as {
      readonly files: readonly {
        readonly bytes: number;
        readonly mode?: number;
        readonly path: string;
        readonly sha256: string;
      }[];
      readonly targets: readonly string[];
      readonly version: number;
    };
    const files = (await treeDigest(project.outputRoot)).filter(
      (entry) => entry.path !== 'agent-bundle.manifest.json',
    );
    expect(manifest).toMatchObject({
      files: files.map(({ bytes, path, sha256 }) => ({ bytes, path, sha256 })),
      targets: ['portable'],
      version: 1,
    });
    for (const file of files.filter((entry) => entry.path.endsWith('.json'))) {
      expect(JSON.parse(await readFile(join(project.outputRoot, file.path), 'utf8'))).toBeDefined();
    }
    await expect(readFile(join(project.outputRoot, 'portable', 'skills', 'review', 'assets', 'icon.bin'))).resolves.toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    await expect(stat(join(project.outputRoot, 'portable', 'skills', 'review', 'assets', 'icon.bin'))).resolves.toMatchObject({
      mode: expect.any(Number),
    });
    expect(
      (await stat(join(project.outputRoot, 'portable', 'skills', 'review', 'assets', 'icon.bin'))).mode & 0o777,
    ).toBe(0o751);
    for (const resource of model.skills[0]!.resources) {
      await expect(
        readFile(join(project.outputRoot, 'portable', 'skills', 'review', resource.relativePath)),
      ).resolves.toEqual(await readFile(resource.source));
    }

    const copiedScriptResources = [
      {
        path: 'portable/skills/review/scripts/review helper.sh',
        source: project.shellScriptPath,
      },
      {
        path: 'portable/skills/review/scripts/review helper.py',
        source: project.pythonScriptPath,
      },
    ] as const;
    for (const resource of copiedScriptResources) {
      const emittedResource = join(project.outputRoot, resource.path);
      const contents = await readFile(resource.source);
      await expect(readFile(emittedResource)).resolves.toEqual(contents);
      expect((await stat(emittedResource)).mode & 0o777).toBe(0o751);
      expect(manifest.files).toContainEqual({
        bytes: contents.byteLength,
        mode: 0o751,
        path: resource.path,
        sha256: sha256(contents),
      });
    }
  } finally {
    await cleanupProject(project);
  }
});

it('embeds a script dynamic import in its single planned output file', async () => {
  const project = await createProject();
  const registry = new TargetRegistry().register(
    (await import('../src/adapters/portable.ts')).portableAdapter,
    { default: true },
  );

  try {
    const dynamicImportSource = [
      "export const loadGreeting = async () => (await import('./local greeting module.ts')).greeting;",
      'console.log(await loadGreeting());',
      '',
    ].join('\n');
    await writeFile(project.scriptPath, dynamicImportSource);
    const model = modelFor(project);
    await build({
      model: {
        ...model,
        skills: model.skills.map((skill) => ({
          ...skill,
          resources: skill.resources.map((resource) =>
            resource.source === project.scriptPath
              ? { ...resource, bytes: Buffer.byteLength(dynamicImportSource) }
              : resource,
          ),
        })),
      },
      outputRoot: project.outputRoot,
      projectRoot: project.root,
      registry,
    });

    await expect(runModule(join(project.outputRoot, 'portable', 'scripts', 'greeting.mjs'), project.root)).resolves.toEqual({
      code: 0,
      output: 'hello from skill bundle\n',
    });
    expect(await readdir(join(project.outputRoot, 'portable', 'scripts'))).toEqual(['greeting.mjs']);
  } finally {
    await cleanupProject(project);
  }
});

it('reports complete immutable output provenance for a Skill copy and bundled script', async () => {
  const project = await createProject();
  const model = modelFor(project);

  try {
    const result = await build({
      model,
      outputRoot: project.outputRoot,
      projectRoot: project.root,
      registry: new TargetRegistry().register((await import('../src/adapters/portable.ts')).portableAdapter, { default: true }),
    });
    const provenance = result.outputProvenance;
    const artifactPaths = (await treeDigest(project.outputRoot))
      .map((entry) => entry.path)
      .filter((path) => path !== 'agent-bundle.manifest.json');

    expect(provenance.map((record) => record.path)).toEqual(artifactPaths);
    expect(provenance).toContainEqual({
      kind: 'bundle',
      path: 'portable/scripts/greeting.mjs',
      sourceInputs: [
        'skills/review/scripts/greeting script.ts',
        'skills/review/scripts/local greeting module.ts',
      ],
    });
    expect(provenance).toContainEqual({
      kind: 'copy',
      path: 'portable/skills/review/scripts/review helper.sh',
      sourceInputs: [
        'skills/review/scripts/review helper.sh',
        'skills/review/SKILL.md',
      ],
    });
    expect(provenance).toContainEqual({
      kind: 'generated',
      path: 'agent-bundle.hooks.json',
      sourceInputs: ['agent-bundle.config.ts'],
    });
    expect(provenance.every((record) => !record.path.includes(project.outputRoot))).toBe(true);
    expect(provenance.every((record) => record.sourceInputs.every((input) => !input.startsWith('/')))).toBe(true);
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(provenance.every((record) => Object.isFrozen(record) && Object.isFrozen(record.sourceInputs))).toBe(true);
  } finally {
    await cleanupProject(project);
  }
});

it('rejects an adapter artifact with no provenance inputs before replacing a prior artifact', async () => {
  const project = await createProject();
  const adapter: TargetAdapter = {
    capabilities: {},
    metadata: testAdapterMetadata,
    name: 'portable',
    plan: () => ({
      diagnostics: [],
      entries: [{
        content: '{"provenance":"missing"}\n',
        kind: 'write',
        relativePath: 'plugin.json',
        sourceInputs: [],
      }],
    }),
    validateModel: () => [],
  };

  try {
    await mkdir(project.outputRoot, { recursive: true });
    await writeFile(join(project.outputRoot, 'previous.txt'), 'previous\n');

    await expect(build({
      model: { ...modelFor(project), scripts: [] },
      outputRoot: project.outputRoot,
      projectRoot: project.root,
      registry: new TargetRegistry().register(adapter, { default: true }),
    })).rejects.toThrow(/source inputs/i);
    await expect(readFile(join(project.outputRoot, 'previous.txt'), 'utf8')).resolves.toBe('previous\n');
  } finally {
    await cleanupProject(project);
  }
});

it('rejects an authored bundled dependency outside the project and preserves the prior artifact', async () => {
  const project = await createProject();
  const outside = join(dirname(project.root), 'agent-bundle-provenance-outside.ts');
  const registry = new TargetRegistry().register(
    (await import('../src/adapters/portable.ts')).portableAdapter,
    { default: true },
  );

  try {
    const model = modelFor(project);
    const options = {
      model,
      outputRoot: project.outputRoot,
      projectRoot: project.root,
      registry,
    };
    await build(options);
    const prior = await treeDigest(project.outputRoot);
    await writeFile(outside, "export const outside = 'outside';\n");
    const importPath = relative(dirname(project.scriptPath), outside).replaceAll('\\', '/');
    const changedSource = [
      `import { outside } from ${JSON.stringify(importPath)};`,
      'console.log(outside);',
      '',
    ].join('\n');
    await writeFile(project.scriptPath, changedSource);
    const changedModel: NormalizedPlugin = {
      ...model,
      skills: model.skills.map((skill) => ({
        ...skill,
        resources: skill.resources.map((resource) => resource.source === project.scriptPath
          ? { ...resource, bytes: Buffer.byteLength(changedSource) }
          : resource),
      })),
    };

    await expect(build({ ...options, model: changedModel })).rejects.toThrow(/outside/i);
    expect(await treeDigest(project.outputRoot)).toEqual(prior);
  } finally {
    await rm(outside, { force: true });
    await cleanupProject(project);
  }
});

it('emits a configured Skill script deterministically and preserves the prior artifact after a failed staged rebuild', async () => {
  const project = await createProject();
  const registry = new TargetRegistry().register(
    (await import('../src/adapters/portable.ts')).portableAdapter,
    { default: true },
  );

  try {
    const model = modelFor(project);
    const options = {
      model,
      outputRoot: project.outputRoot,
      projectRoot: project.root,
      registry,
    };
    await build(options);
    const first = await treeDigest(project.outputRoot);
    await build(options);
    expect(await treeDigest(project.outputRoot)).toEqual(first);

    const brokenSource = 'export const = broken;\n';
    await writeFile(project.scriptPath, brokenSource);
    const brokenOptions = {
      ...options,
      model: {
        ...model,
        skills: model.skills.map((skill) => ({
          ...skill,
          resources: skill.resources.map((resource) =>
            resource.source === project.scriptPath
              ? { ...resource, bytes: Buffer.byteLength(brokenSource) }
              : resource,
          ),
        })),
      },
    };
    await expect(build(brokenOptions)).rejects.toThrow(/(Rslib|Rspack|SyntaxError)/iu);
    expect(await treeDigest(project.outputRoot)).toEqual(first);
  } finally {
    await cleanupProject(project);
  }
});

it('rejects duplicate planned destinations before replacing an existing artifact', async () => {
  const project = await createProject();
  const duplicateAdapter: TargetAdapter = {
    capabilities: {},
    metadata: testAdapterMetadata,
    name: 'portable',
    plan: () => ({
      diagnostics: [],
      entries: [
        { content: 'first\n', kind: 'write', relativePath: 'plugin.json', sourceInputs: [] },
        { content: 'second\n', kind: 'write', relativePath: 'plugin.json', sourceInputs: [] },
      ],
      hookEntries: [],
    }),
    validateModel: () => [],
  };
  const registry = new TargetRegistry().register(duplicateAdapter, { default: true });

  try {
    await mkdir(project.outputRoot, { recursive: true });
    await writeFile(join(project.outputRoot, 'previous.txt'), 'previous\n');

    await expect(
      build({
        model: { ...modelFor(project), scripts: [] },
        outputRoot: project.outputRoot,
        projectRoot: project.root,
        registry,
      }),
    ).rejects.toThrow(/duplicate/i);
    await expect(readFile(join(project.outputRoot, 'previous.txt'), 'utf8')).resolves.toBe('previous\n');
  } finally {
    await cleanupProject(project);
  }
});

it('rejects an escaped target name before it can write outside the staging artifact', async () => {
  const project = await createProject();
  const targetName = '../escaped-target';
  const adapter: TargetAdapter = {
    capabilities: {},
    metadata: testAdapterMetadata,
    name: targetName,
    plan: () => ({
      diagnostics: [],
      entries: [{ content: 'escaped\n', kind: 'write', relativePath: 'plugin.json', sourceInputs: [] }],
      hookEntries: [],
    }),
    validateModel: () => [],
  };

  try {
    await mkdir(project.outputRoot, { recursive: true });
    await writeFile(join(project.outputRoot, 'previous.txt'), 'previous\n');

    await expect(
      build({
        model: {
          ...modelFor(project),
          scripts: [],
          targets: [{ ...modelFor(project).targets[0]!, name: targetName }],
        },
        outputRoot: project.outputRoot,
        projectRoot: project.root,
        registry: new TargetRegistry().register(adapter, { default: true }),
      }),
    ).rejects.toThrow(/outside/i);
    await expect(readFile(join(project.outputRoot, 'previous.txt'), 'utf8')).resolves.toBe('previous\n');
    await expect(readFile(join(project.root, 'escaped-target', 'plugin.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await cleanupProject(project);
  }
});

it('rejects an escaped script name before Rslib receives an unsafe output destination', async () => {
  const project = await createProject();

  try {
    await mkdir(project.outputRoot, { recursive: true });
    await writeFile(join(project.outputRoot, 'previous.txt'), 'previous\n');
    const model = modelFor(project);

    await expect(
      build({
        model: {
          ...model,
          scripts: [{ ...model.scripts[0]!, name: '../../../leaked' }],
        },
        outputRoot: project.outputRoot,
        projectRoot: project.root,
        registry: new TargetRegistry().register(
          (await import('../src/adapters/portable.ts')).portableAdapter,
          { default: true },
        ),
      }),
    ).rejects.toThrow(/outside/i);
    await expect(readFile(join(project.outputRoot, 'previous.txt'), 'utf8')).resolves.toBe('previous\n');
    await expect(readFile(join(project.root, 'leaked.mjs'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await cleanupProject(project);
  }
});

it('rejects a script name that exits its target scripts directory', async () => {
  const project = await createProject();

  try {
    await mkdir(project.outputRoot, { recursive: true });
    await writeFile(join(project.outputRoot, 'previous.txt'), 'previous\n');
    const model = modelFor(project);

    await expect(
      build({
        model: {
          ...model,
          scripts: [{ ...model.scripts[0]!, name: '../leaked' }],
        },
        outputRoot: project.outputRoot,
        projectRoot: project.root,
        registry: new TargetRegistry().register(
          (await import('../src/adapters/portable.ts')).portableAdapter,
          { default: true },
        ),
      }),
    ).rejects.toThrow(/outside/i);
    await expect(readFile(join(project.outputRoot, 'previous.txt'), 'utf8')).resolves.toBe('previous\n');
    await expect(readFile(join(project.outputRoot, 'portable', 'leaked.mjs'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await cleanupProject(project);
  }
});

it('rejects canonical aliases and adapter/root-script collisions before emission', async () => {
  const project = await createProject();
  const aliasesAdapter: TargetAdapter = {
    capabilities: {},
    metadata: testAdapterMetadata,
    name: 'portable',
    plan: () => ({
      diagnostics: [],
      entries: [
        { content: 'first\n', kind: 'write', relativePath: 'same.txt', sourceInputs: [] },
        { content: 'second\n', kind: 'write', relativePath: 'dir/../same.txt', sourceInputs: [] },
      ],
      hookEntries: [],
    }),
    validateModel: () => [],
  };
  const scriptCollisionAdapter: TargetAdapter = {
    capabilities: {},
    metadata: testAdapterMetadata,
    name: 'portable',
    plan: () => ({
      diagnostics: [],
      entries: [
        { content: 'adapter output\n', kind: 'write', relativePath: 'scripts/greeting.mjs', sourceInputs: [] },
      ],
      hookEntries: [],
    }),
    validateModel: () => [],
  };

  try {
    await mkdir(project.outputRoot, { recursive: true });
    await writeFile(join(project.outputRoot, 'previous.txt'), 'previous\n');
    const model = modelFor(project);
    const options = {
      outputRoot: project.outputRoot,
      projectRoot: project.root,
    };

    await expect(
      build({
        ...options,
        model: { ...model, scripts: [] },
        registry: new TargetRegistry().register(aliasesAdapter, { default: true }),
      }),
    ).rejects.toThrow(/duplicate/i);
    await expect(
      build({
        ...options,
        model,
        registry: new TargetRegistry().register(scriptCollisionAdapter, { default: true }),
      }),
    ).rejects.toThrow(/duplicate/i);
    await expect(readFile(join(project.outputRoot, 'previous.txt'), 'utf8')).resolves.toBe('previous\n');
  } finally {
    await cleanupProject(project);
  }
});

it('restores the existing artifact when publication fails after backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle publish rollback '));
  const outputRoot = join(root, 'dist');
  const stageRoot = join(root, 'stage');

  try {
    await Promise.all([
      mkdir(outputRoot, { recursive: true }),
      mkdir(stageRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(outputRoot, 'artifact.txt'), 'previous\n'),
      writeFile(join(stageRoot, 'artifact.txt'), 'replacement\n'),
    ]);

    await expect(
      publishArtifact({
        outputRoot,
        rename: async (source, destination) => {
          if (source === stageRoot && destination === outputRoot) {
            throw new Error('injected publication failure');
          }
          await rename(source, destination);
        },
        stageRoot,
      }),
    ).rejects.toThrow('injected publication failure');
    await expect(readFile(join(outputRoot, 'artifact.txt'), 'utf8')).resolves.toBe('previous\n');
    expect((await readdir(root)).sort()).toEqual(['dist']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
