import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { EpochStore, type CreateStagingEpochOptions, type EpochStaging, type StagingValidator } from '../src/dev/epoch-store.ts';
import { build, type BuildOptions } from '../src/build/build.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { DiagnosticError, type Diagnostic } from '../src/core/diagnostics.ts';
import { ArtifactService } from '../src/dev/index.ts';
import { NativePlaygroundService } from '../src/dev/playground/native-playground-service.ts';
import { ProjectService } from '../src/dev/project-service.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';
import { seedEvalProject, writeEvalSuite } from './support/eval-project.ts';
import { writeFixtureManifest } from './support/manifest.ts';

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-service-'));
  await mkdir(join(root, 'src', 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'artifact-service-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(root, 'src', 'skills', 'review', 'SKILL.md'),
      [
        '---',
        'name: review',
        'description: Reviews changes',
        '---',
        'Review the changed files.',
        '',
      ].join('\n'),
    ),
  ]);
  return root;
};

class RejectingStagingCloseStore extends EpochStore {
  override async createStagingEpoch(options: CreateStagingEpochOptions): Promise<EpochStaging> {
    const staging = await super.createStagingEpoch(options);
    return Object.freeze({
      close: async () => {
        await staging.close();
        throw new Error('staging cleanup rejected');
      },
      publish: async (validate: StagingValidator) => staging.publish(validate),
      root: staging.root,
    });
  }
}

it('publishes one validated prepared project as an immutable epoch and removes its build attempt', async () => {
  const root = await createProject();
  const attemptRoot = join(root, '.agent-bundle', 'test-attempt');
  const store = new EpochStore({ projectRoot: root });
  const removedAttempts: string[] = [];

  try {
    const prepared = await new ProjectService({ root }).prepare('build');
    const service = new ArtifactService({
      createAttempt: async () => {
        await mkdir(attemptRoot, { recursive: true });
        return attemptRoot;
      },
      createEpochId: () => 'epoch-one',
      epochStore: store,
      now: () => new Date('2026-08-14T12:00:00.000Z'),
      removeAttempt: async (path) => {
        removedAttempts.push(path);
        await rm(path, { force: true, recursive: true });
      },
    });

    const result = await service.build(prepared);
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') {
      throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    }

    expect(result).toMatchObject({
      epoch: {
        createdAt: '2026-08-14T12:00:00.000Z',
        id: 'epoch-one',
        projectRevision: prepared.source.revision,
      },
      outcome: 'succeeded',
    });
    expect(prepared.projectContext).toBeDefined();
    expect(result.epoch.configDigest).toBe(prepared.projectContext?.configDigest);
    expect(result.epoch.modelDigest).toBe(prepared.projectContext?.modelDigest);
    expect(result.epoch.projectRevision).toBe(prepared.projectContext?.revision);
    expect(result.epoch.configDigest).toBe(sha256(await readFile(join(root, 'agent-bundle.config.ts'))));
    expect(result.epoch.targetDigests.portable).toMatch(/^[a-f0-9]{64}$/);
    expect(result.epoch.manifestPath).toBe(
      join(root, '.agent-bundle', 'epochs', 'epoch-one', 'agent-bundle.manifest.json'),
    );
    expect(await store.readActiveEpoch()).toEqual(result.epoch);
    await expect(readFile(join(root, '.agent-bundle', 'epochs', 'epoch-one', 'portable', 'plugin.json'), 'utf8'))
      .resolves.toContain('artifact-service-fixture');
    await expect(readFile(join(root, '.agent-bundle', 'epochs', '.metadata', 'native-playground', 'epoch-one.json'), 'utf8'))
      .resolves.toBe('{"epochId":"epoch-one","selections":[]}\n');
    expect(removedAttempts).toEqual([attemptRoot]);
    await expect(readFile(attemptRoot, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports active-metadata durability uncertainty as a committed build warning', async () => {
  const root = await createProject();
  const durabilityFailure = new Error('active metadata directory sync failed');
  let failed = false;
  try {
    const controlledOpen: typeof open = async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (String(path) !== join(root, '.agent-bundle')) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') {
            return async () => {
              if (!failed) {
                failed = true;
                throw durabilityFailure;
              }
              await target.sync();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const store = new EpochStore({
      durabilityStorage: Object.freeze({ open: controlledOpen, remove: rm }),
      projectRoot: root,
    });
    const prepared = await new ProjectService({ root }).prepare('build');
    const result = await new ArtifactService({
      createEpochId: () => 'epoch-post-commit-durability',
      epochStore: store,
    }).build(prepared);

    if (result.outcome === 'failed') {
      throw new Error(result.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('\n'));
    }
    expect(failed).toBe(true);
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') throw new Error('Committed epoch was reported as failed.');
    expect(result.epoch.id).toBe('epoch-post-commit-durability');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB7102',
        message: expect.stringContaining('active metadata durability could not be confirmed'),
        severity: 'warning',
      }),
    ]));
    await expect(store.readActiveEpoch()).resolves.toEqual(result.epoch);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('publishes a marker-free active epoch that real native catalog inspection accepts', async () => {
  const project = await createProjectFixture();
  const store = new EpochStore({ projectRoot: project.root });
  try {
    await seedEvalProject(project.root, { marketplace: true, targets: ['claude'] });
    await writeEvalSuite(project.root, 'native-catalog.eval.ts', {
      cases: [{ hosts: { claude: { model: 'claude-sonnet-4-5' } }, id: 'native-catalog', kind: 'pass' }],
      name: 'native-catalog',
    });
    const prepared = await new ProjectService({ root: project.root }).prepare('build');
    const result = await new ArtifactService({
      createEpochId: () => 'epoch-native-catalog',
      epochStore: store,
    }).build(prepared);

    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    const reference = await store.acquireActiveEpochReference();
    const native = new NativePlaygroundService({ projectRoot: project.root });
    try {
      await expect(readFile(join(reference.root, '.agent-bundle-epoch-stage.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(native.catalog(reference)).resolves.toMatchObject({
        epochId: result.epoch.id,
        selections: [expect.objectContaining({ host: 'claude' })],
      });
      await expect(store.readActiveEpoch()).resolves.toEqual(result.epoch);
    } finally {
      await native.close();
      await reference.close();
    }
  } finally {
    await removeProjectFixture(project.root);
  }
}, 30_000);

it('allows only an exact epoch store marker as an extra staged artifact file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-staged-artifact-validation-'));
  const marker = '.agent-bundle-epoch-stage.json';
  try {
    await mkdir(join(root, 'portable'), { recursive: true });
    await writeFile(
      join(root, 'portable', 'plugin.json'),
      '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","description":"Valid staged plugin.","name":"valid","version":"1.0.0"}\n',
    );
    await Promise.all([
      writeFile(join(root, 'portable', 'INSTALL.md'), '# Install valid\n'),
      writeFile(join(root, 'portable', 'install.mjs'), 'export {};\n'),
    ]);
    await writeFixtureManifest({ artifactRoot: root, targets: ['portable'] });
    await writeFile(join(root, marker), '{"token":"8f2aa8b7-bdd2-4065-8cd3-5184c6bd9f74"}\n');

    const allowedContext: Readonly<{ readonly allowEpochStagingMarker: true; readonly artifactRoot: string }> = {
      allowEpochStagingMarker: true,
      artifactRoot: root,
    };
    expect(await validateArtifact(allowedContext)).toEqual([]);

    await writeFile(join(root, 'unexpected.txt'), 'tampered\n');
    expect(await validateArtifact(allowedContext)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
    await rm(join(root, 'unexpected.txt'));
    await writeFile(join(root, marker), '{"token":"not-a-uuid","version":1}\n');
    expect(await validateArtifact(allowedContext)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each(['added', 'changed', 'removed'] as const)(
  'rejects publication when an authored source is $0 after compiling',
  async (mutation) => {
    const root = await createProject();
    const store = new EpochStore({ projectRoot: root });
    const deletedSource = join(root, 'src', 'skills', 'review', 'guide.txt');
    const attempts: string[] = [];
    try {
      if (mutation === 'removed') await writeFile(deletedSource, 'Guide before removal.\n');
      const prepared = await new ProjectService({ root }).prepare('build');
      await mkdir(join(root, '.agent-bundle'), { recursive: true });
      const service = new ArtifactService({
        compile: async (options) => {
          const result = await build(options);
          if (mutation === 'added') {
            await mkdir(join(root, 'src'), { recursive: true });
            await writeFile(join(root, 'src', 'added.ts'), 'export const added = true;\n');
          } else if (mutation === 'changed') {
            await writeFile(join(root, 'src', 'skills', 'review', 'SKILL.md'), [
              '---',
              'name: review',
              'description: Reviews changed source',
              '---',
              'Review the changed files.',
              '',
            ].join('\n'));
          } else {
            await rm(deletedSource);
          }
          return result;
        },
        createAttempt: async () => {
          const attempt = await mkdtemp(join(root, '.agent-bundle', 'binding-attempt-'));
          attempts.push(attempt);
          return attempt;
        },
        createEpochId: () => `epoch-binding-${mutation}`,
        epochStore: store,
      });
      const result = await service.build(prepared);
      expect(result).toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'AB7101' })],
        outcome: 'failed',
      });
      await expect(store.readActiveEpoch()).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

it('rejects publication when an executable source loses its execute bit after compiling', async () => {
  const root = await createProject();
  const executable = join(root, 'src', 'skills', 'review', 'SKILL.md');
  const store = new EpochStore({ projectRoot: root });
  try {
    await chmod(executable, 0o755);
    const prepared = await new ProjectService({ root }).prepare('build');
    const result = await new ArtifactService({
      compile: async (options) => {
        const built = await build(options);
        await chmod(executable, 0o644);
        return built;
      },
      createEpochId: () => 'epoch-executable-drift',
      epochStore: store,
    }).build(prepared);

    expect(result).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB7101' })],
      outcome: 'failed',
    });
    await expect(store.readActiveEpoch()).resolves.toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('uses the prepared output exclusions when checking source changes after compilation', async () => {
  const root = await createProject();
  const output = join(root, 'custom-artifact');
  const store = new EpochStore({ projectRoot: root });
  try {
    const prepared = await new ProjectService({ outputRoots: [output], root }).prepare('build');
    const service = new ArtifactService({
      compile: async (options) => {
        const result = await build(options);
        await mkdir(output, { recursive: true });
        await writeFile(join(output, 'generated.js'), 'changed after preparation\n');
        return result;
      },
      createEpochId: () => 'epoch-custom-output',
      epochStore: store,
    });

    const result = await service.build(prepared);

    expect(result.outcome).toBe('succeeded');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('compiles in development mode and carries MCP App compile advisories onto the published epoch', async () => {
  const root = await createProject();
  const store = new EpochStore({ projectRoot: root });
  const advisory: Diagnostic = {
    code: 'AB4772',
    message: 'MCP App "status" compiled to 1.3 MiB (412.0 KiB gzip), above the 1 MiB advisory bound; largest modules: node_modules/zod/index.js (300.0 KiB)',
    severity: 'warning',
    sourcePath: join(root, 'views', 'status.ts'),
  };
  const compileOptions: BuildOptions[] = [];
  try {
    const prepared = await new ProjectService({ root }).prepare('build');
    const result = await new ArtifactService({
      compile: async (options) => {
        compileOptions.push(options);
        const built = await build(options);
        return { ...built, diagnostics: [advisory] };
      },
      createEpochId: () => 'epoch-compile-advisory',
      epochStore: store,
    }).build(prepared);

    expect(compileOptions.map((options) => options.mode)).toEqual(['development']);
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    expect(result.diagnostics).toContainEqual(advisory);
    expect(result.epoch.diagnostics).toEqual({ errors: 0, infos: 0, warnings: 1 });
    await expect(store.readActiveEpoch()).resolves.toEqual(result.epoch);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports a failed MCP App compile as the compiler\'s own AB4770 diagnostics, not AB7100', async () => {
  const root = await createProject();
  const store = new EpochStore({ projectRoot: root });
  const compileError: Diagnostic = {
    code: 'AB4770',
    message: 'MCP App "status" failed to compile: views/status.ts:1:10: Syntax Error: Expression expected',
    severity: 'error',
    sourcePath: join(root, 'views', 'status.ts'),
  };
  try {
    const prepared = await new ProjectService({ root }).prepare('build');
    const result = await new ArtifactService({
      compile: async () => { throw new DiagnosticError([compileError]); },
      epochStore: store,
    }).build(prepared);

    expect(result).toEqual({ diagnostics: [compileError], outcome: 'failed' });
    await expect(store.readActiveEpoch()).resolves.toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps AB7100 for compiler throws that carry no diagnostics', async () => {
  const root = await createProject();
  const store = new EpochStore({ projectRoot: root });
  try {
    const prepared = await new ProjectService({ root }).prepare('build');
    const result = await new ArtifactService({
      compile: async () => { throw new Error('Rspack build failed.'); },
      epochStore: store,
    }).build(prepared);

    expect(result).toEqual({
      diagnostics: [{
        code: 'AB7100',
        message: 'Unable to compile the build: Rspack build failed.',
        severity: 'error',
        sourcePath: prepared.configPath,
      }],
      outcome: 'failed',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('uses a root-independent digest for equivalent normalized project models', async () => {
  const leftRoot = await createProject();
  const rightRoot = await createProject();
  try {
    const [leftPrepared, rightPrepared] = await Promise.all([
      new ProjectService({ root: leftRoot }).prepare('build'),
      new ProjectService({ root: rightRoot }).prepare('build'),
    ]);
    const [left, right] = await Promise.all([
      new ArtifactService({ createEpochId: () => 'epoch-left', epochStore: new EpochStore({ projectRoot: leftRoot }) })
        .build(leftPrepared),
      new ArtifactService({ createEpochId: () => 'epoch-right', epochStore: new EpochStore({ projectRoot: rightRoot }) })
        .build(rightPrepared),
    ]);

    expect(left.outcome).toBe('succeeded');
    expect(right.outcome).toBe('succeeded');
    if (left.outcome !== 'succeeded' || right.outcome !== 'succeeded') throw new Error('Equivalent projects did not build.');
    expect(left.epoch.modelDigest).toBe(right.epoch.modelDigest);
  } finally {
    await Promise.all([
      rm(leftRoot, { force: true, recursive: true }),
      rm(rightRoot, { force: true, recursive: true }),
    ]);
  }
});

it('changes the canonical model digest when a registered extension changes', async () => {
  const leftRoot = await createProject();
  const rightRoot = await createProject();
  try {
    await Promise.all([
      writeFile(join(leftRoot, 'agent-bundle.config.ts'), [
        'export default {',
        "  plugin: { name: 'extension-identity', version: '1.0.0' },",
        "  targets: ['portable'],",
        "  portable: { compatibility: 'v1' },",
        '};',
        '',
      ].join('\n')),
      writeFile(join(rightRoot, 'agent-bundle.config.ts'), [
        'export default {',
        "  plugin: { name: 'extension-identity', version: '1.0.0' },",
        "  targets: ['portable'],",
        "  portable: { compatibility: 'v2' },",
        '};',
        '',
      ].join('\n')),
    ]);
    const [leftPrepared, rightPrepared] = await Promise.all([
      new ProjectService({ root: leftRoot }).prepare('build'),
      new ProjectService({ root: rightRoot }).prepare('build'),
    ]);
    const [left, right] = await Promise.all([
      new ArtifactService({ createEpochId: () => 'epoch-left-extension', epochStore: new EpochStore({ projectRoot: leftRoot }) })
        .build(leftPrepared),
      new ArtifactService({ createEpochId: () => 'epoch-right-extension', epochStore: new EpochStore({ projectRoot: rightRoot }) })
        .build(rightPrepared),
    ]);

    expect(left.outcome).toBe('succeeded');
    expect(right.outcome).toBe('succeeded');
    if (left.outcome !== 'succeeded' || right.outcome !== 'succeeded') throw new Error('Extension fixtures did not build.');
    expect(left.epoch.modelDigest).not.toBe(right.epoch.modelDigest);
  } finally {
    await Promise.all([
      rm(leftRoot, { force: true, recursive: true }),
      rm(rightRoot, { force: true, recursive: true }),
    ]);
  }
});

it('rejects a tampered staging transfer, retains the last good epoch, and cleans the failed attempt', async () => {
  const root = await createProject();
  const store = new EpochStore({ projectRoot: root });
  const attempts: string[] = [];
  const removedAttempts: string[] = [];
  const epochIds = ['epoch-good', 'epoch-tampered'];
  let tamperTransfer = false;

  try {
    await mkdir(join(root, '.agent-bundle'), { recursive: true });
    const prepared = await new ProjectService({ root }).prepare('build');
    const service = new ArtifactService({
      createAttempt: async () => {
        const attempt = await mkdtemp(join(root, '.agent-bundle', 'test-attempt-'));
        attempts.push(attempt);
        return attempt;
      },
      createEpochId: () => epochIds.shift() ?? 'unexpected-epoch',
      epochStore: store,
      move: async (source, destination) => {
        await rename(source, destination);
        if (tamperTransfer && source.endsWith('agent-bundle.manifest.json')) {
          await writeFile(join(destination, '..', 'unexpected.txt'), 'tampered\n');
        }
      },
      removeAttempt: async (path) => {
        removedAttempts.push(path);
        await rm(path, { force: true, recursive: true });
      },
    });

    const first = await service.build(prepared);
    tamperTransfer = true;
    const failed = await service.build(prepared);

    expect(first.outcome).toBe('succeeded');
    expect(failed).toMatchObject({ outcome: 'failed' });
    expect(failed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004' }),
      expect.objectContaining({ code: 'AB6014', generatedPath: 'unexpected.txt' }),
    ]));
    if (first.outcome === 'succeeded') {
      expect(await store.readActiveEpoch()).toEqual(first.epoch);
    }
    expect(removedAttempts).toEqual(attempts);
    await expect(readFile(join(root, '.agent-bundle', 'epochs', 'epoch-tampered', 'portable', 'plugin.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('settles staging and attempt cleanup failures into diagnostics without masking the build failure', async () => {
  const root = await createProject();
  const attemptRoot = join(root, '.agent-bundle', 'cleanup-attempt');
  const removedAttempts: string[] = [];
  const store = new RejectingStagingCloseStore({ projectRoot: root });

  try {
    await mkdir(join(root, '.agent-bundle'), { recursive: true });
    const prepared = await new ProjectService({ root }).prepare('build');
    const service = new ArtifactService({
      createAttempt: async () => {
        await mkdir(attemptRoot, { recursive: true });
        return attemptRoot;
      },
      epochStore: store,
      move: async () => { throw new Error('transfer failed'); },
      removeAttempt: async (path) => {
        removedAttempts.push(path);
        await rm(path, { force: true, recursive: true });
        throw new Error('attempt cleanup rejected');
      },
    });

    const result = await service.build(prepared);
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('transfer failed') }),
      expect.objectContaining({ message: expect.stringContaining('staging cleanup rejected'), severity: 'error' }),
      expect.objectContaining({ message: expect.stringContaining('attempt cleanup rejected'), severity: 'error' }),
    ]));
    expect(removedAttempts).toEqual([attemptRoot]);
    await expect(readFile(attemptRoot, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('retains a published epoch and reports attempt cleanup failure as a warning', async () => {
  const root = await createProject();
  const attemptRoot = join(root, '.agent-bundle', 'published-cleanup-attempt');
  const store = new EpochStore({ projectRoot: root });

  try {
    await mkdir(join(root, '.agent-bundle'), { recursive: true });
    const prepared = await new ProjectService({ root }).prepare('build');
    const service = new ArtifactService({
      createAttempt: async () => {
        await mkdir(attemptRoot, { recursive: true });
        return attemptRoot;
      },
      createEpochId: () => 'epoch-cleanup-warning',
      epochStore: store,
      removeAttempt: async (path) => {
        await rm(path, { force: true, recursive: true });
        throw new Error('published attempt cleanup rejected');
      },
    });

    const result = await service.build(prepared);
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') throw new Error('Published epoch was reported as failed.');
    expect(await store.readActiveEpoch()).toEqual(result.epoch);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining('published attempt cleanup rejected'),
        severity: 'warning',
      }),
    ]));
    await expect(readFile(attemptRoot, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
