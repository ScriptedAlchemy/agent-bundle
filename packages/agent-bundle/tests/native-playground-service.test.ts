import { link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { digest } from '../src/core/digest.ts';
import {
  NativePlaygroundService,
  publishNativePlaygroundCatalogSnapshot,
  type NativePlaygroundCatalogStorage,
  type NativePlaygroundEpochReference,
} from '../src/dev/native-playground-service.ts';
import { expectExitCode } from '../src/eval/assertions.ts';
import type { DiscoveredEvalSuite } from '../src/eval/discovery.ts';
import type { EvalFixturePlan } from '../src/eval/fixtures.ts';
import { defineEvalSuite } from '../src/eval/suite.ts';

const epoch = (id: string, root: string, target = 'claude') => Object.freeze({
  close: async () => undefined,
  epoch: Object.freeze({
    configDigest: `config-${id}`,
    createdAt: '2026-08-18T00:00:00.000Z',
    diagnostics: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
    id,
    manifestPath: 'agent-bundle.manifest.json',
    modelDigest: `model-${id}`,
    projectRevision: `revision-${id}`,
    targetDigests: Object.freeze({ [target]: `target-${id}` }),
  }),
  root,
});

const suite = (): readonly DiscoveredEvalSuite[] => Object.freeze([Object.freeze({
  sourcePath: '/project/evals/review.eval.ts',
  suite: defineEvalSuite({
    cases: [{
      assertions: [expectExitCode(0)],
      fixture: { git: false, include: ['**/*'], path: './fixture' },
      hosts: { claude: { model: 'author-pinned-model' } },
      id: 'review-case',
      invocation: { mode: 'automatic' },
      prompt: 'Original authored prompt.',
      trials: 1,
    }],
    name: 'review',
  }),
})]);

const fixturePlan: EvalFixturePlan = Object.freeze({
  digest: digest({ entries: [], git: false }),
  entries: Object.freeze([]),
  git: false,
  sourcePath: '/project/evals/fixture',
});

let catalogDirectoryIndex = 0;
const testCatalogDirectory = (): string => join(tmpdir(), `agent-bundle-native-playground-catalog-${process.pid}-${catalogDirectoryIndex++}`);

const claudeStream = [
  '{"type":"system","subtype":"init","plugins":[{"name":"review"}],"mcp_servers":[{"name":"project"}]}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"sk-proj-1234567890abcdef /private/native/activation"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__project__status","input":{}}]}}',
  '{"type":"system","hook_event_name":"session-start"}',
  '{"type":"result","subtype":"success","is_error":false,"result":"token=sk-proj-1234567890abcdef at /private/native/response"}',
  '',
].join('\n');

const nativeSuite = (host: 'claude' | 'codex', sourcePath: string): readonly DiscoveredEvalSuite[] => Object.freeze([Object.freeze({
  sourcePath,
  suite: defineEvalSuite({
    cases: [{
      assertions: [expectExitCode(0)],
      fixture: { git: false, include: ['**/*'], path: './fixture' },
      hosts: { [host]: { model: `pinned-${host}-model` } },
      id: `${host}-case`,
      invocation: { mode: 'automatic' },
      prompt: 'Original authored prompt.',
      trials: 1,
    }],
    name: `${host}-review`,
  }),
})]);

const dualHostSuite = (sourcePath: string): readonly DiscoveredEvalSuite[] => Object.freeze([Object.freeze({
  sourcePath,
  suite: defineEvalSuite({
    cases: [{
      assertions: [expectExitCode(0)],
      fixture: { git: false, include: ['**/*'], path: './fixture' },
      hosts: {
        claude: { model: 'pinned-claude-model' },
        codex: { model: 'pinned-codex-model' },
      },
      id: 'dual-host-case',
      invocation: { mode: 'automatic' },
      prompt: 'Original authored prompt.',
      trials: 1,
    }],
    name: 'dual-host-review',
  }),
})]);

it('pins opaque native catalog selections to their catalog epoch and never resolves them across epochs', async () => {
  const service = new NativePlaygroundService({
    catalogDirectory: testCatalogDirectory(),
    discover: async () => suite(),
    inspectArtifact: async (reference) => Object.freeze({
      binding: Object.freeze({ manifestPath: `${reference.root}/agent-bundle.manifest.json`, source: 'explicit' as const, targetDigests: reference.epoch.targetDigests }),
      manifest: Object.freeze({}),
      root: reference.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  const catalogA = await service.catalog(epoch('epoch-a', '/epochs/a'));
  const catalogB = await service.catalog(epoch('epoch-b', '/epochs/b'));
  const selectedA = {
    caseId: catalogA.cases[0]!.id,
    fixtureId: catalogA.fixtures[0]!.id,
    host: 'claude' as const,
    modelPinId: catalogA.modelPins[0]!.id,
    operation: 'native.prompt' as const,
    prompt: 'Browser prompt.',
    target: 'claude',
  };

  await expect(service.prepare(epoch('epoch-a', '/epochs/a'), selectedA)).resolves.toMatchObject({
    epochId: 'epoch-a',
    prompt: 'Browser prompt.',
  });
  await expect(service.prepare(epoch('epoch-b', '/epochs/b'), selectedA)).rejects.toThrow('catalog selection');
  expect(catalogA.cases[0]!.id).not.toBe(catalogB.cases[0]!.id);
  await service.close();
});

it('advertises and resolves every exact native case/fixture/host/model tuple without host overwrite', async () => {
  const service = new NativePlaygroundService({
    catalogDirectory: testCatalogDirectory(),
    discover: async () => dualHostSuite('/project/evals/review.eval.ts'),
    inspectArtifact: async (reference) => Object.freeze({
      binding: Object.freeze({ manifestPath: `${reference.root}/agent-bundle.manifest.json`, source: 'explicit' as const, targetDigests: reference.epoch.targetDigests }),
      manifest: Object.freeze({}),
      root: reference.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  const reference = Object.freeze({
    ...epoch('epoch-dual-host', '/epochs/dual-host'),
    epoch: Object.freeze({ ...epoch('epoch-dual-host', '/epochs/dual-host').epoch, targetDigests: Object.freeze({ claude: 'target-claude', codex: 'target-codex' }) }),
  });
  const catalog = await service.catalog(reference);
  const selections = (catalog as typeof catalog & { readonly selections?: readonly { readonly caseId: string; readonly fixtureId: string; readonly host: 'claude' | 'codex'; readonly modelPinId: string }[] }).selections;
  expect(selections).toEqual(expect.arrayContaining([
    expect.objectContaining({ host: 'claude' }),
    expect.objectContaining({ host: 'codex' }),
  ]));
  for (const host of ['claude', 'codex'] as const) {
    const modelPin = catalog.modelPins.find((candidate) => candidate.host === host);
    await expect(service.prepare(reference, {
      caseId: catalog.cases[0]!.id,
      fixtureId: catalog.fixtures[0]!.id,
      host,
      modelPinId: modelPin!.id,
      operation: 'native.prompt',
      prompt: 'Browser prompt.',
      target: host,
    })).resolves.toMatchObject({ host });
  }
  await service.close();
});

it('retains an exact epoch catalog across service restart after fixture source changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-restart-'));
  try {
    const epochRoot = join(root, '.agent-bundle', 'epochs', 'epoch-retained');
    const suiteDir = join(root, 'evals');
    const fixtureFile = join(suiteDir, 'fixture', 'input.txt');
    await mkdir(join(epochRoot, 'claude', '.claude-plugin'), { recursive: true });
    await mkdir(join(suiteDir, 'fixture'), { recursive: true });
    await writeFile(join(epochRoot, 'claude', '.claude-plugin', 'plugin.json'), '{"name":"review"}\n');
    await writeFile(fixtureFile, 'first fixture bytes\n');
    const reference = epoch('epoch-retained', epochRoot);
    let discoveryCalls = 0;
    let sourceChanged = false;
    const options = {
      discover: async () => {
        discoveryCalls += 1;
        return sourceChanged
          ? dualHostSuite(join(suiteDir, 'review.eval.ts'))
          : nativeSuite('claude', join(suiteDir, 'review.eval.ts'));
      },
      inspectArtifact: async (candidate: NativePlaygroundEpochReference) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
        root: candidate.root,
      }),
      native: {
        claudeRun: async (request: Readonly<{ readonly args: readonly string[] }>) => request.args[0] === '--version'
          ? Object.freeze({ exitCode: 0, stderr: '', stdout: '2.1.232\n' })
          : Object.freeze({ exitCode: 0, stderr: '', stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\n' }),
      },
      projectRoot: root,
    } as const;
    const first = new NativePlaygroundService(options);
    const catalogA = await first.catalog(reference);
    await first.close();
    await writeFile(fixtureFile, 'second fixture bytes after retained epoch\n');
    sourceChanged = true;
    const restarted = new NativePlaygroundService(options);
    const catalogB = await restarted.catalog(reference);
    expect(catalogB).toEqual(catalogA);
    expect(discoveryCalls).toBe(1);
    const prepared = await restarted.prepare(reference, {
      caseId: catalogB.cases[0]!.id,
      fixtureId: catalogB.fixtures[0]!.id,
      host: 'claude',
      modelPinId: catalogB.modelPins[0]!.id,
      operation: 'native.prompt',
      prompt: 'Review the fixture.',
      target: 'claude',
    });
    const result = await restarted.run(prepared, { emit: async () => undefined, signal: new AbortController().signal });
    expect(result.events).toContainEqual(expect.objectContaining({
      kind: 'native.harness.failed', raw: { code: 'EVAL_FIXTURE_UNAVAILABLE', stage: 'fixture' },
    }));
    await restarted.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('eagerly captures every epoch catalog before a later build can replace authored selections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-eager-'));
  try {
    const suiteDir = join(root, 'evals');
    const fixtureFile = join(suiteDir, 'fixture', 'input.txt');
    const epochARoot = join(root, '.agent-bundle', 'epochs', 'epoch-eager-a');
    const epochBRoot = join(root, '.agent-bundle', 'epochs', 'epoch-eager-b');
    await Promise.all([
      mkdir(join(epochARoot, 'claude', '.claude-plugin'), { recursive: true }),
      mkdir(join(epochBRoot, 'claude', '.claude-plugin'), { recursive: true }),
      mkdir(join(suiteDir, 'fixture'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(epochARoot, 'claude', '.claude-plugin', 'plugin.json'), '{"name":"review"}\n'),
      writeFile(join(epochBRoot, 'claude', '.claude-plugin', 'plugin.json'), '{"name":"review"}\n'),
      writeFile(fixtureFile, 'epoch A fixture bytes\n'),
    ]);
    const referenceA = epoch('epoch-eager-a', epochARoot);
    const referenceB = Object.freeze({
      ...epoch('epoch-eager-b', epochBRoot),
      epoch: Object.freeze({ ...epoch('epoch-eager-b', epochBRoot).epoch, targetDigests: Object.freeze({ claude: 'target-b-claude', codex: 'target-b-codex' }) }),
    });
    let authoredGeneration: 'a' | 'b' = 'a';
    let discoveryCalls = 0;
    const discover = async () => {
      discoveryCalls += 1;
      return authoredGeneration === 'a'
        ? nativeSuite('claude', join(suiteDir, 'review.eval.ts'))
        : dualHostSuite(join(suiteDir, 'review.eval.ts'));
    };

    // This is the artifact-publication hook: neither epoch has been browsed.
    await publishNativePlaygroundCatalogSnapshot({ discover, epoch: referenceA.epoch, projectRoot: root });
    authoredGeneration = 'b';
    await writeFile(fixtureFile, 'epoch B fixture bytes\n');
    await publishNativePlaygroundCatalogSnapshot({ discover, epoch: referenceB.epoch, projectRoot: root });
    discoveryCalls = 0;

    const restarted = new NativePlaygroundService({
      discover,
      inspectArtifact: async (reference) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: reference.epoch.targetDigests }),
        root: reference.root,
      }),
      native: {
        claudeRun: async (request) => request.args[0] === '--version'
          ? Object.freeze({ exitCode: 0, stderr: '', stdout: '2.1.232\n' })
          : Object.freeze({ exitCode: 0, stderr: '', stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\n' }),
      },
      projectRoot: root,
    });
    const [catalogA, catalogB] = await Promise.all([restarted.catalog(referenceA), restarted.catalog(referenceB)]);
    expect(discoveryCalls).toBe(0);
    expect(catalogA.selections).toHaveLength(1);
    expect(catalogA.selections[0]?.host).toBe('claude');
    expect(catalogB.selections).toHaveLength(2);
    expect(catalogB.selections.map((selection) => selection.host)).toEqual(['claude', 'codex']);

    const prepared = await restarted.prepare(referenceA, {
      caseId: catalogA.cases[0]!.id,
      fixtureId: catalogA.fixtures[0]!.id,
      host: 'claude',
      modelPinId: catalogA.modelPins[0]!.id,
      operation: 'native.prompt',
      prompt: 'Review the fixture.',
      target: 'claude',
    });
    const result = await restarted.run(prepared, { emit: async () => undefined, signal: new AbortController().signal });
    expect(result.events).toContainEqual(expect.objectContaining({
      kind: 'native.harness.failed', raw: { code: 'EVAL_FIXTURE_UNAVAILABLE', stage: 'fixture' },
    }));
    await restarted.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('publishes one versionless catalog sidecar shape and rejects forged, escaping, extra-key, versioned, and symlinked sidecars', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-sidecar-'));
  try {
    const epochRoot = join(root, '.agent-bundle', 'epochs', 'epoch-sidecar');
    const suiteDir = join(root, 'evals');
    const fixtureDir = join(suiteDir, 'fixture');
    const fixtureFile = join(fixtureDir, 'input.txt');
    await Promise.all([
      mkdir(join(epochRoot, 'claude', '.claude-plugin'), { recursive: true }),
      mkdir(fixtureDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(epochRoot, 'claude', '.claude-plugin', 'plugin.json'), '{"name":"review"}\n'),
      writeFile(fixtureFile, 'fixture bytes\n'),
    ]);
    const reference = epoch('epoch-sidecar', epochRoot);
    const options = {
      discover: async () => nativeSuite('claude', join(suiteDir, 'review.eval.ts')),
      inspectArtifact: async (candidate: NativePlaygroundEpochReference) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
        root: candidate.root,
      }),
      projectRoot: root,
    } as const;
    const initial = new NativePlaygroundService(options);
    await initial.catalog(reference);
    await initial.close();
    const sidecar = join(root, '.agent-bundle', 'epochs', '.metadata', 'native-playground', 'epoch-sidecar.json');
    const baseline = await readFile(sidecar, 'utf8');
    const assertRejected = async (mutate: (snapshot: Record<string, unknown>) => void): Promise<void> => {
      const snapshot = JSON.parse(baseline) as Record<string, unknown>;
      mutate(snapshot);
      await writeFile(sidecar, `${JSON.stringify(snapshot)}\n`);
      const restarted = new NativePlaygroundService(options);
      await expect(restarted.catalog(reference)).rejects.toThrow('catalog snapshot is invalid');
      await restarted.close();
    };
    await assertRejected((snapshot) => {
      snapshot.version = 1;
    });
    expect(JSON.parse(baseline)).not.toHaveProperty('version');
    await assertRejected((snapshot) => {
      (((snapshot.selections as Record<string, unknown>[])[0]!.fixturePlan as Record<string, unknown>).sourcePath) = '/private/escape';
    });
    await assertRejected((snapshot) => {
      (((snapshot.selections as Record<string, unknown>[])[0]!.fixturePlan as Record<string, unknown>).entries as Record<string, unknown>[])[0]!.path = '../../escape';
    });
    await assertRejected((snapshot) => {
      (snapshot.selections as Record<string, unknown>[])[0]!.unexpected = 'smuggled';
    });
    await assertRejected((snapshot) => {
      (snapshot.selections as Record<string, unknown>[])[0]!.caseId = 'forged-case-id';
    });
    await assertRejected((snapshot) => {
      (snapshot.selections as Record<string, unknown>[])[0]!.modelPinId = 'forged-model-id';
    });
    await assertRejected((snapshot) => {
      ((((snapshot.selections as Record<string, unknown>[])[0]!.evalCase as Record<string, unknown>).hosts as Record<string, Record<string, unknown>>).claude!).model = 'unreviewed-model';
    });
    await writeFile(sidecar, baseline);
    const outside = join(root, 'outside');
    await mkdir(outside);
    const sidecarTarget = join(outside, 'catalog.json');
    await writeFile(sidecarTarget, baseline);
    await rm(sidecar, { force: true });
    await symlink(sidecarTarget, sidecar, 'file');
    const sidecarSymlinked = new NativePlaygroundService(options);
    await expect(sidecarSymlinked.catalog(reference)).rejects.toThrow('catalog snapshot is invalid');
    await sidecarSymlinked.close();
    await rm(sidecar, { force: true });
    await writeFile(sidecar, baseline);
    await rm(fixtureDir, { force: true, recursive: true });
    await symlink(outside, fixtureDir, 'dir');
    const symlinked = new NativePlaygroundService(options);
    await expect(symlinked.catalog(reference)).rejects.toThrow('catalog snapshot is invalid');
    await symlinked.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects catalog directories that escape epoch metadata through a symlinked directory or ancestor', async () => {
  for (const symlinkLocation of ['catalog', 'metadata'] as const) {
    const root = await mkdtemp(join(tmpdir(), `agent-bundle-native-playground-${symlinkLocation}-escape-`));
    try {
      const epochsRoot = join(root, '.agent-bundle', 'epochs');
      const reference = epoch(`epoch-${symlinkLocation}-escape`, join(epochsRoot, `epoch-${symlinkLocation}-escape`));
      const outside = join(root, 'outside');
      await Promise.all([mkdir(reference.root, { recursive: true }), mkdir(outside)]);
      if (symlinkLocation === 'metadata') {
        await symlink(outside, join(epochsRoot, '.metadata'), 'dir');
      } else {
        const metadata = join(epochsRoot, '.metadata');
        await mkdir(metadata);
        await symlink(outside, join(metadata, 'native-playground'), 'dir');
      }
      const service = new NativePlaygroundService({
        discover: async () => Object.freeze([]),
        inspectArtifact: async (candidate) => Object.freeze({
          binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
          root: candidate.root,
        }),
        projectRoot: root,
      });
      await expect(service.catalog(reference)).rejects.toThrow('catalog directory is invalid');
      await service.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

it('fsyncs durable catalog publication, validates a no-replace winner, and retains every staging cleanup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-durable-'));
  const catalogDirectory = join(root, 'catalog');
  const reference = epoch('epoch-durable', join(root, 'artifact'));
  const failures = new Map<string, Error>([
    ['write', new Error('write failed')],
    ['file', new Error('file sync failed')],
    ['link', new Error('link failed')],
    ['directory', new Error('directory sync failed')],
  ]);
  const serviceFor = (failure: 'directory' | 'file' | 'link' | 'write' | undefined, removeFailure?: Error): NativePlaygroundService => {
    const storage: NativePlaygroundCatalogStorage = {
      link: async (source, destination) => {
        if (failure === 'link') throw failures.get('link')!;
        await link(source, destination);
      },
      mkdir,
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'writeFile') {
              return async (...args: unknown[]) => {
                if (failure === 'write') throw failures.get('write')!;
                await (target.writeFile as (...input: unknown[]) => Promise<void>)(...args);
              };
            }
            if (property === 'sync') {
              return async () => {
                if (failure === 'file' && String(path).includes('.stage-')) throw failures.get('file')!;
                if (failure === 'directory' && String(path) === catalogDirectory) throw failures.get('directory')!;
                await target.sync();
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      remove: async (path, options) => {
        if (removeFailure !== undefined && String(path).includes('.stage-')) throw removeFailure;
        await rm(path, options);
      },
    } as NativePlaygroundCatalogStorage;
    return new NativePlaygroundService({
      catalogDirectory,
      catalogStorage: storage,
      discover: async () => suite(),
      inspectArtifact: async (candidate) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
        root: candidate.root,
      }),
      planFixture: async () => fixturePlan,
      projectRoot: '/project',
    });
  };
  try {
    for (const failure of ['write', 'file', 'link', 'directory'] as const) {
      await rm(catalogDirectory, { force: true, recursive: true });
      const service = serviceFor(failure);
      await expect(service.catalog(reference)).rejects.toThrow(failures.get(failure)!.message);
      expect((await readdir(catalogDirectory)).filter((name) => name.includes('.stage-'))).toEqual([]);
      await service.close();
    }
    await rm(catalogDirectory, { force: true, recursive: true });
    const cleanupFailure = new Error('stage cleanup failed');
    const cleanupService = serviceFor('file', cleanupFailure);
    await expect(cleanupService.catalog(reference)).rejects.toMatchObject({ errors: [failures.get('file'), cleanupFailure] });
    await cleanupService.close();
    await rm(catalogDirectory, { force: true, recursive: true });

    // Two independent services race on the same epoch: the loser validates the
    // link winner rather than replacing it.
    const [left, right] = [serviceFor(undefined), serviceFor(undefined)];
    const [leftCatalog, rightCatalog] = await Promise.all([left.catalog(reference), right.catalog(reference)]);
    expect(leftCatalog).toEqual(rightCatalog);
    expect((await readdir(catalogDirectory)).filter((name) => name.includes('.stage-'))).toEqual([]);
    await Promise.all([left.close(), right.close()]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('caches the catalog fixture plan for later opaque selection preparation', async () => {
  let planCalls = 0;
  const service = new NativePlaygroundService({
    catalogDirectory: testCatalogDirectory(),
    discover: async () => suite(),
    inspectArtifact: async (reference) => Object.freeze({
      binding: Object.freeze({ manifestPath: `${reference.root}/agent-bundle.manifest.json`, source: 'explicit' as const, targetDigests: reference.epoch.targetDigests }),
      manifest: Object.freeze({}),
      root: reference.root,
    }),
    planFixture: async () => {
      planCalls += 1;
      return fixturePlan;
    },
    projectRoot: '/project',
  });
  const catalog = await service.catalog(epoch('epoch-a', '/epochs/a'));
  await service.prepare(epoch('epoch-a', '/epochs/a'), {
    caseId: catalog.cases[0]!.id,
    fixtureId: catalog.fixtures[0]!.id,
    host: 'claude',
    modelPinId: catalog.modelPins[0]!.id,
    operation: 'native.prompt',
    prompt: 'Browser prompt.',
    target: 'claude',
  });
  expect(planCalls).toBe(1);
  await service.close();
});

it('refuses fixture bytes changed after cataloging without recomputing the server-owned plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-stale-fixture-'));
  try {
    const artifact = join(root, 'artifact');
    const suiteDir = join(root, 'evals');
    const fixtureFile = join(suiteDir, 'fixture', 'input.txt');
    await mkdir(join(artifact, 'claude', '.claude-plugin'), { recursive: true });
    await mkdir(join(suiteDir, 'fixture'), { recursive: true });
    await writeFile(join(artifact, 'claude', '.claude-plugin', 'plugin.json'), '{"name":"review"}\n');
    await writeFile(fixtureFile, 'catalog baseline\n');
    const reference = epoch('epoch-native-stale-fixture', artifact);
    const commands: string[] = [];
    const service = new NativePlaygroundService({
      discover: async () => nativeSuite('claude', join(suiteDir, 'review.eval.ts')),
      inspectArtifact: async (candidate) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
        root: candidate.root,
      }),
      native: {
        claudeRun: async (request) => {
          commands.push(request.args[0] ?? '');
          if (request.args[0] === '--version') return Object.freeze({ exitCode: 0, stderr: '', stdout: '2.1.232\n' });
          return Object.freeze({ exitCode: 0, stderr: '', stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\n' });
        },
      },
      projectRoot: root,
    });
    const catalog = await service.catalog(reference);
    await writeFile(fixtureFile, 'mutated after cataloging\n');
    const prepared = await service.prepare(reference, {
      caseId: catalog.cases[0]!.id,
      fixtureId: catalog.fixtures[0]!.id,
      host: 'claude',
      modelPinId: catalog.modelPins[0]!.id,
      operation: 'native.prompt',
      prompt: 'Review the fixture.',
      target: 'claude',
    });
    const phases: string[] = [];
    const result = await service.run(prepared, {
      emit: async (event) => { phases.push(event.kind); },
      signal: new AbortController().signal,
    });

    expect(commands).toEqual(['--version', 'auth']);
    expect(phases).toEqual(['native.preflight']);
    expect(result.status).toBe('failed');
    expect(result.events).toContainEqual(expect.objectContaining({
      kind: 'native.harness.failed',
      raw: { code: 'EVAL_FIXTURE_UNAVAILABLE', stage: 'fixture' },
    }));
    await service.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('turns missing, incompatible, and unauthenticated native preflight into path-free harness evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-preflight-'));
  try {
    const reference = epoch('epoch-native-preflight', join(root, 'artifact'));
    for (const scenario of ['missing', 'incompatible', 'unauthenticated'] as const) {
      const service = new NativePlaygroundService({
        discover: async () => nativeSuite('claude', join(root, 'evals', 'review.eval.ts')),
        inspectArtifact: async (candidate) => Object.freeze({
          binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
          root: candidate.root,
        }),
        native: {
          claudeRun: async (request) => {
            if (scenario === 'missing') {
              const error: NodeJS.ErrnoException = new Error('claude missing at /private/native/claude with sk-proj-1234567890abcdef');
              error.code = 'ENOENT';
              throw error;
            }
            if (request.args[0] === '--version') {
              return Object.freeze({ exitCode: 0, stderr: 'sk-proj-1234567890abcdef /private/native/stderr', stdout: scenario === 'incompatible' ? '2.1.231\n' : '2.1.232\n' });
            }
            return Object.freeze({
              exitCode: 0,
              stderr: 'sk-proj-1234567890abcdef /private/native/stderr',
              stdout: '{"loggedIn":false,"authMethod":"api-key","apiProvider":"key","subscriptionType":"none"}\n',
            });
          },
        },
        planFixture: async () => Object.freeze({ ...fixturePlan, sourcePath: join(root, 'evals', 'fixture') }),
        projectRoot: root,
      });
      const catalog = await service.catalog(reference);
      const prepared = await service.prepare(reference, {
        caseId: catalog.cases[0]!.id,
        fixtureId: catalog.fixtures[0]!.id,
        host: 'claude',
        modelPinId: catalog.modelPins[0]!.id,
        operation: 'native.prompt',
        prompt: 'Review the fixture.',
        target: 'claude',
      });
      const phases: string[] = [];
      const result = await service.run(prepared, {
        emit: async (event) => { phases.push(event.kind); },
        signal: new AbortController().signal,
      });

      expect(phases).toEqual(['native.preflight']);
      expect(result.status).toBe('failed');
      expect(result.events).toContainEqual(expect.objectContaining({
        kind: 'native.harness.failed',
        raw: { code: 'EVAL_PROCESS_UNAVAILABLE', stage: 'preflight' },
      }));
      expect(result.events).not.toContainEqual(expect.objectContaining({ kind: 'native.hooks' }));
      expect(result.events).not.toContainEqual(expect.objectContaining({ kind: 'native.scripts' }));
      expect(result.events).not.toContainEqual(expect.objectContaining({ kind: 'native.response' }));
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('/private/native');
      expect(serialized).not.toContain('sk-proj-1234567890abcdef');
      await service.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('projects only awaited normalized Claude completion evidence and removes its isolated workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-'));
  try {
    const artifact = join(root, 'artifact');
    const suiteDir = join(root, 'evals');
    await mkdir(join(artifact, 'claude', '.claude-plugin'), { recursive: true });
    await mkdir(join(suiteDir, 'fixture'), { recursive: true });
    await writeFile(join(artifact, 'claude', '.claude-plugin', 'plugin.json'), '{"name":"review"}\n');
    await writeFile(join(suiteDir, 'fixture', 'input.txt'), 'baseline only\n');
    await writeFile(join(suiteDir, 'grader.mjs'), 'export default () => ({ detail: "sk-proj-1234567890abcdef /private/native/grader", outcome: "pass" });\n');
    const reference = epoch('epoch-native-run', artifact);
    const discovered = nativeSuite('claude', join(suiteDir, 'review.eval.ts'))[0]!;
    const evaluatedCase = discovered.suite.cases[0]!;
    const scriptEvidenceSuite: readonly DiscoveredEvalSuite[] = Object.freeze([Object.freeze({
      sourcePath: discovered.sourcePath,
      suite: Object.freeze({
        ...discovered.suite,
        cases: Object.freeze([Object.freeze({
          ...evaluatedCase,
          assertions: Object.freeze([Object.freeze({ id: 'grader', kind: 'outcome' as const, minimumEvidence: 'observed' as const, script: 'grader.mjs' })]),
        })]),
      }),
    })]);
    const service = new NativePlaygroundService({
      discover: async () => scriptEvidenceSuite,
      inspectArtifact: async (candidate) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
        root: candidate.root,
      }),
      native: {
        claudeRun: async (request) => {
          if (request.args[0] === '--version') return Object.freeze({ exitCode: 0, stderr: '', stdout: '2.1.232\n' });
          if (request.args[0] === 'auth') {
            return Object.freeze({ exitCode: 0, stderr: '', stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\n' });
          }
          await writeFile(join(request.cwd, 'host-change.txt'), 'this must not be exposed\n');
          return Object.freeze({ exitCode: 0, stderr: 'credential=sk-proj-1234567890abcdef /private/native/stderr', stdout: claudeStream });
        },
      },
      projectRoot: root,
    });
    const catalog = await service.catalog(reference);
    const prepared = await service.prepare(reference, {
      caseId: catalog.cases[0]!.id,
      fixtureId: catalog.fixtures[0]!.id,
      host: 'claude',
      modelPinId: catalog.modelPins[0]!.id,
      operation: 'native.prompt',
      prompt: 'Review the fixture.',
      target: 'claude',
    });
    const emitted: string[] = [];
    const result = await service.run(prepared, {
      emit: async (event) => { emitted.push(event.kind); },
      signal: new AbortController().signal,
    });

    expect(emitted).toEqual(['native.preflight', 'native.fixture.materialized', 'native.host.started']);
    expect(result.events.map((event) => event.kind)).toEqual([
      'native.provenance',
      'native.activation',
      'native.mcp',
      'native.assertions',
      'native.hooks',
      'native.scripts',
      'native.response',
      'native.workspace',
    ]);
    expect(result.events).toContainEqual(expect.objectContaining({
      kind: 'native.provenance',
      raw: {
        hostCliVersion: '2.1.232',
        invocation: { mode: 'automatic' },
        model: 'pinned-claude-model',
        semanticGrader: null,
      },
      source: 'host-preflight',
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      kind: 'native.hooks', raw: { events: ['session-start'] }, source: 'hook',
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      kind: 'native.activation', raw: { activated: ['[REDACTED]'], level: 'observed' }, source: 'skill-evidence',
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      kind: 'native.scripts', raw: { level: 'observed', results: [{ detail: '[REDACTED]', id: 'grader.mjs', outcome: 'pass' }] }, source: 'script',
    }));
    expect(result.events).not.toContainEqual(expect.objectContaining({ kind: 'native.raw.references' }));
    expect(result.response).toContain('[REDACTED]');
    expect(result.response).toContain('[path]');
    expect(result.workspace).toEqual({ changes: [expect.objectContaining({ kind: 'added' })] });
    const persistedShape = JSON.stringify(result);
    expect(persistedShape).not.toContain(root);
    expect(persistedShape).not.toContain('this must not be exposed');
    expect(persistedShape).not.toContain('sk-proj-1234567890abcdef');
    expect((await readdir(join(root, '.agent-bundle'))).filter((entry) => entry.startsWith('native-playground-'))).toEqual([]);
    await service.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('redacts hostile normalized Codex MCP labels without changing observed evidence classification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-hostile-mcp-'));
  try {
    const artifact = join(root, 'artifact');
    const suiteDir = join(root, 'evals');
    const normalCodexHome = join(root, 'normal-codex-home');
    await mkdir(join(artifact, 'codex', '.agents', 'plugins'), { recursive: true });
    await mkdir(join(suiteDir, 'fixture'), { recursive: true });
    await mkdir(normalCodexHome, { recursive: true });
    await writeFile(join(artifact, 'codex', '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'native-marketplace',
      plugins: [{ name: 'native-review', source: { path: './', source: 'local' } }],
    }));
    await writeFile(join(suiteDir, 'fixture', 'input.txt'), 'baseline only\n');
    await writeFile(join(normalCodexHome, 'auth.json'), '{"opaque":"session"}\n');
    const reference = epoch('epoch-native-hostile-mcp', artifact, 'codex');
    const service = new NativePlaygroundService({
      discover: async () => nativeSuite('codex', join(suiteDir, 'review.eval.ts')),
      environment: Object.freeze({ CODEX_HOME: normalCodexHome }),
      inspectArtifact: async (candidate) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
        root: candidate.root,
      }),
      native: {
        codexRun: async (command) => {
          const step = command.args[0] === 'plugin' ? `${command.args[0]}.${command.args[1]}` : command.args[0];
          if (step === 'plugin.list') {
            return Object.freeze({
              exitCode: 0,
              stderr: '',
              stdout: '{"installed":[{"name":"native-review","marketplaceName":"native-marketplace","installed":true,"enabled":true}]}',
            });
          }
          if (step !== 'exec') return Object.freeze({ exitCode: 0, stderr: '', stdout: 'codex-cli 0.147.0\n' });
          return Object.freeze({
            exitCode: 0,
            stderr: '',
            stdout: [
              '{"type":"item.completed","item":{"id":"hostile-mcp","type":"mcp_tool_call","server":"/private/native/mcp","tool":"sk-proj-1234567890abcdef"}}',
              '{"type":"turn.completed"}',
            ].join('\n'),
          });
        },
      },
      projectRoot: root,
    });
    const catalog = await service.catalog(reference);
    const prepared = await service.prepare(reference, {
      caseId: catalog.cases[0]!.id,
      fixtureId: catalog.fixtures[0]!.id,
      host: 'codex',
      modelPinId: catalog.modelPins[0]!.id,
      operation: 'native.prompt',
      prompt: 'Review the fixture.',
      target: 'codex',
    });
    const result = await service.run(prepared, { emit: async () => undefined, signal: new AbortController().signal });
    expect(result.events).toContainEqual(expect.objectContaining({
      kind: 'native.mcp',
      raw: { calls: [{ server: '[REDACTED]', tool: '[REDACTED]' }], level: 'observed' },
    }));
    expect(JSON.stringify(result)).not.toContain('/private/native/mcp');
    expect(JSON.stringify(result)).not.toContain('sk-proj-1234567890abcdef');
    await service.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('awaits a cancelled Codex child, preserves its harness failure, and removes all temporary state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-codex-'));
  try {
    const artifact = join(root, 'artifact');
    const suiteDir = join(root, 'evals');
    const normalCodexHome = join(root, 'normal-codex-home');
    await mkdir(join(artifact, 'codex', '.agents', 'plugins'), { recursive: true });
    await mkdir(join(suiteDir, 'fixture'), { recursive: true });
    await mkdir(normalCodexHome, { recursive: true });
    await writeFile(join(artifact, 'codex', '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'native-marketplace',
      plugins: [{ name: 'native-review', source: { path: './', source: 'local' } }],
    }));
    await writeFile(join(suiteDir, 'fixture', 'input.txt'), 'baseline only\n');
    await writeFile(join(normalCodexHome, 'auth.json'), '{"opaque":"session"}\n');
    const reference = epoch('epoch-native-codex', artifact, 'codex');
    let started!: () => void;
    const spawned = new Promise<void>((resolvePromise) => { started = resolvePromise; });
    let observedAbort = false;
    const service = new NativePlaygroundService({
      discover: async () => nativeSuite('codex', join(suiteDir, 'review.eval.ts')),
      environment: Object.freeze({ CODEX_HOME: normalCodexHome }),
      inspectArtifact: async (candidate) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
        root: candidate.root,
      }),
      native: {
        codexRun: async (command) => {
          const step = command.args[0] === 'plugin'
            ? `${command.args[0]}.${command.args[1]}`
            : command.args[0];
          if (step === 'plugin.list') {
            return Object.freeze({
              exitCode: 0,
              stderr: '',
              stdout: '{"installed":[{"name":"native-review","marketplaceName":"native-marketplace","installed":true,"enabled":true}]}',
            });
          }
          if (step !== 'exec') return Object.freeze({ exitCode: 0, stderr: '', stdout: 'codex-cli 0.147.0\n' });
          started();
          return new Promise((resolvePromise) => {
            command.signal?.addEventListener('abort', () => {
              observedAbort = true;
              resolvePromise(Object.freeze({ exitCode: 1, failure: 'cancelled', stderr: 'sk-proj-1234567890abcdef /private/native/stderr', stdout: '' }));
            }, { once: true });
          });
        },
      },
      projectRoot: root,
    });
    const catalog = await service.catalog(reference);
    const prepared = await service.prepare(reference, {
      caseId: catalog.cases[0]!.id,
      fixtureId: catalog.fixtures[0]!.id,
      host: 'codex',
      modelPinId: catalog.modelPins[0]!.id,
      operation: 'native.prompt',
      prompt: 'Review the fixture.',
      target: 'codex',
    });
    const controller = new AbortController();
    const emitted: string[] = [];
    const running = service.run(prepared, {
      emit: async (event) => { emitted.push(event.kind); },
      signal: controller.signal,
    });
    await spawned;
    controller.abort(new Error('test cancellation'));
    const result = await running;

    expect(observedAbort).toBe(true);
    expect(emitted).toEqual(['native.fixture.materialized', 'native.preflight', 'native.codex.setup', 'native.host.started']);
    expect(result.status).toBe('failed');
    expect(result.events).toContainEqual(expect.objectContaining({
      kind: 'native.harness.failed',
      raw: { code: 'EVAL_TRACE_UNAVAILABLE', stage: 'trace' },
    }));
    expect(result.events).toContainEqual(expect.objectContaining({ kind: 'native.workspace' }));
    expect(JSON.stringify(result)).not.toContain('sk-proj-1234567890abcdef');
    expect((await readdir(join(root, '.agent-bundle'))).filter((entry) => entry.startsWith('native-playground-'))).toEqual([]);
    await service.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not deadlock when a direct native Codex abort listener awaits a reentrant close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-direct-close-'));
  try {
    const artifact = join(root, 'artifact');
    const suiteDir = join(root, 'evals');
    const normalCodexHome = join(root, 'normal-codex-home');
    await Promise.all([
      mkdir(join(artifact, 'codex', '.agents', 'plugins'), { recursive: true }),
      mkdir(join(suiteDir, 'fixture'), { recursive: true }),
      mkdir(normalCodexHome, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(artifact, 'codex', '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'native-marketplace', plugins: [{ name: 'native-review', source: { path: './', source: 'local' } }] })),
      writeFile(join(suiteDir, 'fixture', 'input.txt'), 'baseline only\n'),
      writeFile(join(normalCodexHome, 'auth.json'), '{"opaque":"session"}\n'),
    ]);
    const reference = epoch('epoch-native-direct-close', artifact, 'codex');
    let started!: () => void;
    const spawned = new Promise<void>((resolvePromise) => { started = resolvePromise; });
    let reentrant: Promise<void> | undefined;
    let abortHandlerCompleted = false;
    const service = new NativePlaygroundService({
      discover: async () => nativeSuite('codex', join(suiteDir, 'review.eval.ts')),
      environment: Object.freeze({ CODEX_HOME: normalCodexHome }),
      inspectArtifact: async (candidate) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
        root: candidate.root,
      }),
      native: {
        codexRun: async (command) => {
          const step = command.args[0] === 'plugin' ? `${command.args[0]}.${command.args[1]}` : command.args[0];
          if (step === 'plugin.list') return Object.freeze({ exitCode: 0, stderr: '', stdout: '{"installed":[{"name":"native-review","marketplaceName":"native-marketplace","installed":true,"enabled":true}]}' });
          if (step !== 'exec') return Object.freeze({ exitCode: 0, stderr: '', stdout: 'codex-cli 0.147.0\n' });
          started();
          return new Promise((resolvePromise) => {
            command.signal?.addEventListener('abort', () => {
              void (async () => {
                reentrant = service.close();
                await reentrant;
                abortHandlerCompleted = true;
                resolvePromise(Object.freeze({ exitCode: 1, failure: 'cancelled', stderr: '', stdout: '' }));
              })();
            }, { once: true });
          });
        },
      },
      projectRoot: root,
    });
    const catalog = await service.catalog(reference);
    const running = service.run(await service.prepare(reference, {
      caseId: catalog.cases[0]!.id,
      fixtureId: catalog.fixtures[0]!.id,
      host: 'codex',
      modelPinId: catalog.modelPins[0]!.id,
      operation: 'native.prompt',
      prompt: 'Review the fixture.',
      target: 'codex',
    }), { emit: async () => undefined, signal: new AbortController().signal });
    await spawned;
    const closing = service.close();
    await Promise.resolve();
    expect(reentrant).toBeDefined();
    expect(service.close()).toBe(closing);
    const settled = await Promise.race([
      closing.then(() => true, () => true),
      new Promise<boolean>((resolvePromise) => { setTimeout(() => resolvePromise(false), 50); }),
    ]);
    expect(settled).toBe(true);
    expect(reentrant).not.toBe(closing);
    expect(abortHandlerCompleted).toBe(true);
    await running;
    expect((await readdir(join(root, '.agent-bundle'))).filter((entry) => entry.startsWith('native-playground-'))).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not deadlock when caller cancellation reaches a native Codex close listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-external-close-'));
  try {
    const artifact = join(root, 'artifact');
    const suiteDir = join(root, 'evals');
    const normalCodexHome = join(root, 'normal-codex-home');
    await Promise.all([
      mkdir(join(artifact, 'codex', '.agents', 'plugins'), { recursive: true }),
      mkdir(join(suiteDir, 'fixture'), { recursive: true }),
      mkdir(normalCodexHome, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(artifact, 'codex', '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'native-marketplace', plugins: [{ name: 'native-review', source: { path: './', source: 'local' } }] })),
      writeFile(join(suiteDir, 'fixture', 'input.txt'), 'baseline only\n'),
      writeFile(join(normalCodexHome, 'auth.json'), '{"opaque":"session"}\n'),
    ]);
    const reference = epoch('epoch-native-external-close', artifact, 'codex');
    let started!: () => void;
    const spawned = new Promise<void>((resolvePromise) => { started = resolvePromise; });
    let reentrant: Promise<void> | undefined;
    let abortHandlerCompleted = false;
    const service = new NativePlaygroundService({
      discover: async () => nativeSuite('codex', join(suiteDir, 'review.eval.ts')),
      environment: Object.freeze({ CODEX_HOME: normalCodexHome }),
      inspectArtifact: async (candidate) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
        root: candidate.root,
      }),
      native: {
        codexRun: async (command) => {
          const step = command.args[0] === 'plugin' ? `${command.args[0]}.${command.args[1]}` : command.args[0];
          if (step === 'plugin.list') return Object.freeze({ exitCode: 0, stderr: '', stdout: '{"installed":[{"name":"native-review","marketplaceName":"native-marketplace","installed":true,"enabled":true}]}' });
          if (step !== 'exec') return Object.freeze({ exitCode: 0, stderr: '', stdout: 'codex-cli 0.147.0\n' });
          started();
          return new Promise((resolvePromise) => {
            command.signal?.addEventListener('abort', () => {
              void (async () => {
                reentrant = service.close();
                await reentrant;
                abortHandlerCompleted = true;
                resolvePromise(Object.freeze({ exitCode: 1, failure: 'cancelled', stderr: '', stdout: '' }));
              })();
            }, { once: true });
          });
        },
      },
      projectRoot: root,
    });
    const catalog = await service.catalog(reference);
    const caller = new AbortController();
    const running = service.run(await service.prepare(reference, {
      caseId: catalog.cases[0]!.id,
      fixtureId: catalog.fixtures[0]!.id,
      host: 'codex',
      modelPinId: catalog.modelPins[0]!.id,
      operation: 'native.prompt',
      prompt: 'Review the fixture.',
      target: 'codex',
    }), { emit: async () => undefined, signal: caller.signal });
    await spawned;
    caller.abort(new Error('caller cancelled'));
    await Promise.resolve();
    expect(reentrant).toBeDefined();
    const closing = service.close();
    expect(service.close()).toBe(closing);
    const settled = await Promise.race([
      closing.then(() => true, () => true),
      new Promise<boolean>((resolvePromise) => { setTimeout(() => resolvePromise(false), 50); }),
    ]);
    expect(settled).toBe(true);
    expect(reentrant).not.toBe(closing);
    expect(abortHandlerCompleted).toBe(true);
    await running;
    expect((await readdir(join(root, '.agent-bundle'))).filter((entry) => entry.startsWith('native-playground-'))).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('drains a gated catalog discovery before close and never publishes it after close begins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-catalog-close-'));
  try {
    let releaseDiscovery!: () => void;
    let discoveryStarted!: () => void;
    const discovery = new Promise<void>((resolvePromise) => { releaseDiscovery = resolvePromise; });
    const started = new Promise<void>((resolvePromise) => { discoveryStarted = resolvePromise; });
    const service = new NativePlaygroundService({
      discover: async () => {
        discoveryStarted();
        await discovery;
        return nativeSuite('claude', join(root, 'evals', 'review.eval.ts'));
      },
      inspectArtifact: async (reference) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: reference.epoch.targetDigests }),
        root: reference.root,
      }),
      planFixture: async () => Object.freeze({ ...fixturePlan, sourcePath: join(root, 'evals', 'fixture') }),
      projectRoot: root,
    });
    const reference = epoch('epoch-catalog-close', join(root, '.agent-bundle', 'epochs', 'epoch-catalog-close'));
    const pending = service.catalog(reference);
    await started;
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseDiscovery();
    await expect(pending).rejects.toThrow('closed');
    await closing;
    await expect(service.catalog(reference)).rejects.toThrow('closed');
    await expect(readFile(join(root, '.agent-bundle', 'epochs', '.metadata', 'native-playground', 'epoch-catalog-close.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
