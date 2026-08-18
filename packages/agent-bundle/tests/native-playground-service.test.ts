import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import { expectExitCode } from '../src/eval/assertions.ts';
import { digest } from '../src/core/digest.ts';
import { NativePlaygroundService, type NativePlaygroundEpochReference } from '../src/dev/native-playground-service.ts';
import type { DiscoveredEvalSuite } from '../src/eval/discovery.ts';
import type { EvalFixturePlan } from '../src/eval/fixtures.ts';
import { defineEvalSuite, normalizeEvalCase } from '../src/eval/suite.ts';

const epoch = (id: string, root: string, target?: 'claude' | 'codex') => Object.freeze({
  close: async () => undefined,
  epoch: Object.freeze({
    configDigest: `config-${id}`,
    createdAt: '2026-08-18T00:00:00.000Z',
    diagnostics: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
    id,
    manifestPath: 'agent-bundle.manifest.json',
    modelDigest: `model-${id}`,
    projectRevision: `revision-${id}`,
    targetDigests: target === undefined
      ? Object.freeze({ claude: `claude-target-${id}`, codex: `codex-target-${id}` })
      : Object.freeze({ [target]: `target-${id}` }),
  }),
  root,
});

const suite = (): readonly DiscoveredEvalSuite[] => Object.freeze([Object.freeze({
  sourcePath: '/project/evals/review.eval.ts',
  suite: defineEvalSuite({
    cases: Object.freeze([normalizeEvalCase({
      assertions: Object.freeze([expectExitCode(0)]),
      fixture: Object.freeze({ git: false, include: Object.freeze(['**/*']), path: './fixture' }),
      hosts: Object.freeze({ claude: Object.freeze({ model: 'author-pinned-model' }) }),
      id: 'review-case',
      invocation: Object.freeze({ mode: 'automatic' as const }),
      prompt: 'Original authored prompt.',
      trials: 1,
    })]),
    name: 'review',
  }),
})]);

const fixturePlan: EvalFixturePlan = Object.freeze({
  digest: digest({ entries: Object.freeze([]), git: false }),
  entries: Object.freeze([]),
  git: false,
  sourcePath: '/project/evals/fixture',
});

const fixturePlanAt = (baseDir: string): EvalFixturePlan => Object.freeze({
  ...fixturePlan,
  sourcePath: join(baseDir, 'fixture'),
});

let catalogDirectoryIndex = 0;
const catalogDirectories = new Set<string>();
const testCatalogDirectory = (): string => {
  const directory = join(tmpdir(), `agent-bundle-native-playground-catalog-${process.pid}-${catalogDirectoryIndex++}`);
  catalogDirectories.add(directory);
  return directory;
};

afterEach(async () => {
  const directories = [...catalogDirectories];
  catalogDirectories.clear();
  await Promise.all(directories.map((directory) => rm(directory, { force: true, recursive: true })));
});

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
    cases: Object.freeze([normalizeEvalCase({
      assertions: Object.freeze([expectExitCode(0)]),
      fixture: Object.freeze({ git: false, include: Object.freeze(['**/*']), path: './fixture' }),
      hosts: Object.freeze({ [host]: Object.freeze({ model: `pinned-${host}-model` }) }),
      id: `${host}-case`,
      invocation: Object.freeze({ mode: 'automatic' as const }),
      prompt: 'Original authored prompt.',
      trials: 1,
    })]),
    name: `${host}-review`,
  }),
})]);

const dualHostSuite = (sourcePath = '/project/evals/review.eval.ts'): readonly DiscoveredEvalSuite[] => Object.freeze([Object.freeze({
  sourcePath,
  suite: defineEvalSuite({
    cases: Object.freeze([normalizeEvalCase({
      assertions: Object.freeze([expectExitCode(0)]),
      fixture: Object.freeze({ git: false, include: Object.freeze(['**/*']), path: './fixture' }),
      hosts: Object.freeze({
        claude: Object.freeze({ model: 'pinned-claude-model' }),
        codex: Object.freeze({ model: 'pinned-codex-model' }),
      }),
      id: 'dual-host-case',
      invocation: Object.freeze({ mode: 'automatic' as const }),
      prompt: 'Original authored prompt.',
      trials: 1,
    })]),
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

it('rejects corrupt, oversized, and duplicate persisted catalog snapshots without rediscovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-invalid-catalog-'));
  const catalogDirectory = join(root, 'catalogs');
  const reference = epoch('epoch-invalid-catalog', join(root, 'epoch'));
  const snapshotPath = join(catalogDirectory, `${reference.epoch.id}.json`);
  try {
    const writer = new NativePlaygroundService({
      catalogDirectory,
      discover: async () => nativeSuite('claude', join(root, 'evals', 'review.eval.ts')),
      planFixture: async ({ baseDir }) => fixturePlanAt(baseDir),
      projectRoot: root,
    });
    await writer.catalog(reference);
    await writer.close();
    const valid = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      epochId: string;
      selections: unknown[];
      version: number;
    };
    const invalidSnapshots = [
      '{not json}\n',
      `${' '.repeat(8 * 1024 * 1024)}${JSON.stringify(valid)}\n`,
      `${JSON.stringify({ ...valid, selections: [valid.selections[0], valid.selections[0]] })}\n`,
      `${JSON.stringify({ ...valid, selections: Array.from({ length: 257 }, () => valid.selections[0]) })}\n`,
    ];

    for (const invalid of invalidSnapshots) {
      await writeFile(snapshotPath, invalid);
      const reader = new NativePlaygroundService({
        catalogDirectory,
        discover: async () => { throw new Error('Invalid persisted snapshots must not fall back to live discovery.'); },
        planFixture: async ({ baseDir }) => fixturePlanAt(baseDir),
        projectRoot: root,
      });
      await expect(reader.catalog(reference)).rejects.toThrow('catalog snapshot is invalid');
      await reader.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a persisted catalog replaced by a symbolic link before parsing it', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-linked-catalog-'));
  const catalogDirectory = join(root, 'catalogs');
  const reference = epoch('epoch-linked-catalog', join(root, 'epoch'));
  const snapshotPath = join(catalogDirectory, `${reference.epoch.id}.json`);
  const replacementPath = join(root, 'replacement.json');
  try {
    const writer = new NativePlaygroundService({
      catalogDirectory,
      discover: async () => nativeSuite('claude', join(root, 'evals', 'review.eval.ts')),
      planFixture: async ({ baseDir }) => fixturePlanAt(baseDir),
      projectRoot: root,
    });
    await writer.catalog(reference);
    await writer.close();
    await writeFile(replacementPath, await readFile(snapshotPath));
    await rm(snapshotPath);
    await symlink(replacementPath, snapshotPath);

    const reader = new NativePlaygroundService({
      catalogDirectory,
      discover: async () => { throw new Error('A linked catalog must not fall back to discovery.'); },
      projectRoot: root,
    });
    await expect(reader.catalog(reference)).rejects.toThrow('catalog snapshot');
    await reader.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects semantically hostile persisted catalog selections without rediscovery', async () => {
  const catalogDirectory = testCatalogDirectory();
  const reference = epoch('epoch-semantic-catalog', '/epochs/semantic-catalog');
  const snapshotPath = join(catalogDirectory, `${reference.epoch.id}.json`);
  const writer = new NativePlaygroundService({
    catalogDirectory,
    discover: async () => dualHostSuite(),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  await writer.catalog(reference);
  await writer.close();
  const valid = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
    readonly epochId: string;
    readonly selections: readonly Record<string, unknown>[];
    readonly version: number;
  };
  const snapshots = [
    (snapshot: { selections: Record<string, unknown>[] }) => {
      const evalCase = snapshot.selections[0]!.evalCase as Record<string, unknown>;
      evalCase.prompt = 'tampered authored prompt';
    },
    (snapshot: { selections: Record<string, unknown>[] }) => {
      const fixturePlan = snapshot.selections[0]!.fixturePlan as Record<string, unknown>;
      fixturePlan.entries = [Object.freeze({ executable: false, path: '../escaped.txt', sha256: '0'.repeat(64) })];
      fixturePlan.digest = digest({ entries: fixturePlan.entries, git: fixturePlan.git });
    },
    (snapshot: { selections: Record<string, unknown>[] }) => {
      snapshot.selections[0]!.suiteSourcePath = '../../outside.eval.ts';
    },
    (snapshot: { selections: Record<string, unknown>[] }) => {
      const evalCase = snapshot.selections[0]!.evalCase as Record<string, unknown>;
      const hosts = evalCase.hosts as Record<string, unknown>;
      hosts.claude = Object.freeze({ model: 'different-pinned-model' });
      evalCase.digest = normalizeEvalCase(evalCase as never).digest;
    },
    (snapshot: { selections: Record<string, unknown>[] }) => {
      snapshot.selections[0]!.caseId = digest({ forged: 'case-id' });
    },
    (snapshot: { selections: Record<string, unknown>[] }) => {
      snapshot.selections[0]!.fixtureId = digest({ forged: 'fixture-id' });
    },
    (snapshot: { selections: Record<string, unknown>[] }) => {
      snapshot.selections[0]!.modelPinId = digest({ forged: 'model-pin-id' });
    },
  ] as const;

  for (const mutate of snapshots) {
    const snapshot = JSON.parse(JSON.stringify(valid)) as { selections: Record<string, unknown>[] };
    mutate(snapshot);
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
    const reader = new NativePlaygroundService({
      catalogDirectory,
      discover: async () => { throw new Error('Invalid persisted snapshots must not fall back to live discovery.'); },
      planFixture: async () => fixturePlan,
      projectRoot: '/project',
    });
    await expect(reader.catalog(reference)).rejects.toThrow('catalog snapshot is invalid');
    await reader.close();
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

it('prepares every advertised dual-host model pin from its exact catalog tuple', async () => {
  const service = new NativePlaygroundService({
    catalogDirectory: testCatalogDirectory(),
    discover: async () => dualHostSuite(),
    inspectArtifact: async (reference) => Object.freeze({
      binding: Object.freeze({ manifestPath: `${reference.root}/agent-bundle.manifest.json`, source: 'explicit' as const, targetDigests: reference.epoch.targetDigests }),
      manifest: Object.freeze({}),
      root: reference.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  const reference = epoch('epoch-a', '/epochs/a');
  const catalog = await service.catalog(reference);
  const caseId = catalog.cases[0]!.id;
  const fixtureId = catalog.fixtures[0]!.id;
  const claude = catalog.modelPins.find((pin) => pin.host === 'claude');
  const codex = catalog.modelPins.find((pin) => pin.host === 'codex');
  if (claude === undefined || codex === undefined) throw new Error('Expected both native host pins.');

  await expect(service.prepare(reference, {
    caseId,
    fixtureId,
    host: 'claude',
    modelPinId: claude.id,
    operation: 'native.prompt',
    prompt: 'Browser prompt.',
    target: 'claude',
  })).resolves.toMatchObject({ host: 'claude' });
  await expect(service.prepare(reference, {
    caseId,
    fixtureId,
    host: 'codex',
    modelPinId: codex.id,
    operation: 'native.prompt',
    prompt: 'Browser prompt.',
    target: 'codex',
  })).resolves.toMatchObject({ host: 'codex' });
  await expect(service.prepare(reference, {
    caseId,
    fixtureId,
    host: 'claude',
    modelPinId: codex.id,
    operation: 'native.prompt',
    prompt: 'Browser prompt.',
    target: 'claude',
  })).rejects.toThrow('catalog selection');
  await service.close();
});

it('keeps close pending until admitted run cleanup has settled', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-native-close-'));
  let enterCleanup!: () => void;
  let releaseCleanup!: () => void;
  const cleanupEntered = new Promise<void>((resolvePromise) => { enterCleanup = resolvePromise; });
  const cleanupRelease = new Promise<void>((resolvePromise) => { releaseCleanup = resolvePromise; });
  const runFailure = new Error('stop after workspace admission');
  try {
    const service = new NativePlaygroundService({
      discover: async () => suite(),
      planFixture: async () => fixturePlan,
      projectRoot,
      removeWorkspace: async () => {
        enterCleanup();
        await cleanupRelease;
      },
    });
    const evalCase = suite()[0]!.suite.cases[0]!;
    const running = service.run(Object.freeze({
      artifact: Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: Object.freeze({ claude: 'target-digest' }) }),
        root: '/epochs/epoch-a',
      }),
      epochId: 'epoch-a',
      evalCase,
      fixtureDigest: fixturePlan.digest,
      fixturePlan,
      host: 'claude' as const,
      prompt: 'Review.',
      suiteDir: '/project/evals',
      target: 'claude',
    }), {
      emit: async () => { throw runFailure; },
      signal: new AbortController().signal,
    });
    const runningResult = running.then(
      () => undefined,
      (error: unknown) => error,
    );

    await cleanupEntered;
    let closeSettled = false;
    const closing = service.close().finally(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseCleanup();

    expect(await runningResult).toBe(runFailure);
    await expect(closing).resolves.toBeUndefined();
  } finally {
    releaseCleanup();
    await rm(projectRoot, { force: true, recursive: true });
  }
});

it('retains an admitted workspace cleanup failure for service close', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-native-cleanup-failure-'));
  const cleanupFailure = new Error('workspace cleanup failed');
  const runFailure = new Error('stop after workspace admission');
  try {
    const service = new NativePlaygroundService({
      discover: async () => suite(),
      planFixture: async () => fixturePlan,
      projectRoot,
      removeWorkspace: async () => { throw cleanupFailure; },
    });
    const evalCase = suite()[0]!.suite.cases[0]!;

    await expect(service.run(Object.freeze({
      artifact: Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: Object.freeze({ claude: 'target-digest' }) }),
        root: '/epochs/epoch-a',
      }),
      epochId: 'epoch-a',
      evalCase,
      fixtureDigest: fixturePlan.digest,
      fixturePlan,
      host: 'claude' as const,
      prompt: 'Review.',
      suiteDir: '/project/evals',
      target: 'claude',
    }), {
      emit: async () => { throw runFailure; },
      signal: new AbortController().signal,
    })).rejects.toBe(cleanupFailure);

    const closing = service.close();
    expect(service.close()).toBe(closing);
    const closeFailure = await closing.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(closeFailure).toBeInstanceOf(AggregateError);
    expect((closeFailure as AggregateError).errors).toEqual([cleanupFailure]);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
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
        planFixture: async ({ baseDir }) => fixturePlanAt(baseDir),
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
      suite: defineEvalSuite({
        cases: Object.freeze([normalizeEvalCase({
          ...evaluatedCase,
          assertions: Object.freeze([Object.freeze({ id: 'grader', kind: 'outcome' as const, minimumEvidence: 'observed' as const, script: 'grader.mjs' })]),
        })]),
        name: discovered.suite.name,
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
      'native.activation',
      'native.mcp',
      'native.assertions',
      'native.hooks',
      'native.scripts',
      'native.response',
      'native.workspace',
    ]);
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

it('bounds normalized native evidence before it reaches durable Playground events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-bounds-'));
  try {
    const artifact = join(root, 'artifact');
    const suiteDir = join(root, 'evals');
    await mkdir(join(artifact, 'claude', '.claude-plugin'), { recursive: true });
    await mkdir(join(suiteDir, 'fixture'), { recursive: true });
    await writeFile(join(artifact, 'claude', '.claude-plugin', 'plugin.json'), '{"name":"review"}\n');
    await writeFile(join(suiteDir, 'fixture', 'input.txt'), 'baseline only\n');
    const response = 'bounded response '.repeat(32_768);
    const stream = [
      '{"type":"system","subtype":"init","plugins":[{"name":"review"}]}',
      ...Array.from({ length: 80 }, (_, index) => JSON.stringify({ type: 'system', hook_event_name: `hook-${index}` })),
      ...Array.from({ length: 80 }, (_, index) => JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: `mcp__server${index}__tool${index}`, input: {} }] },
      })),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: response }),
      '',
    ].join('\n');
    const reference = epoch('epoch-native-bounds', artifact);
    const service = new NativePlaygroundService({
      discover: async () => nativeSuite('claude', join(suiteDir, 'review.eval.ts')),
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
          return Object.freeze({ exitCode: 0, stderr: '', stdout: stream });
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
    const result = await service.run(prepared, { emit: async () => undefined, signal: new AbortController().signal });
    const hooks = result.events.find((event) => event.kind === 'native.hooks');
    const mcp = result.events.find((event) => event.kind === 'native.mcp');
    const responseEvent = result.events.find((event) => event.kind === 'native.response');

    expect((hooks?.raw as { events: string[] }).events).toHaveLength(64);
    expect(hooks?.raw).toMatchObject({ truncated: true });
    expect((mcp?.raw as { calls: unknown[] }).calls).toHaveLength(64);
    expect(mcp?.raw).toMatchObject({ truncated: true });
    expect(Buffer.byteLength((responseEvent?.raw as { text: string }).text, 'utf8')).toBeLessThanOrEqual(256 * 1024);
    expect((responseEvent?.raw as { text: string }).text.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(responseEvent), 'utf8')).toBeLessThan(1024 * 1024);
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
