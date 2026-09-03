import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import { expectExitCode } from '../src/eval/assertions.ts';
import { digest } from '../src/core/digest.ts';
import {
  NativePlaygroundService,
  nativePlaygroundStagingSweepLimits,
  publishNativePlaygroundCatalogSnapshot,
  type NativePlaygroundCatalogStorage,
  type NativePlaygroundEpochReference,
} from '../src/dev/playground/native-playground-service.ts';
import type { DiscoveredEvalSuite } from '../src/eval/discovery.ts';
import type { EvalFixturePlan } from '../src/eval/fixtures.ts';
import { defineEvalSuite, normalizeEvalCase } from '../src/eval/suite.ts';
import { deepFreeze } from '../src/core/freeze.ts';


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

const nativeCatalogDurabilityPlatformKey = Symbol.for('agent-bundle.native-playground-service.catalog-durability-platform');

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

it('persists a canonical suite whose authored case order differs from digest order', async () => {
  const catalogDirectory = testCatalogDirectory();
  const cases = ['alpha-case', 'beta-case'].map((id) => normalizeEvalCase({
    assertions: Object.freeze([expectExitCode(0)]),
    fixture: Object.freeze({ git: false, include: Object.freeze(['**/*']), path: './fixture' }),
    hosts: deepFreeze({ claude: { model: 'pinned-claude-model' } }),
    id,
    invocation: Object.freeze({ mode: 'automatic' as const }),
    prompt: `Review ${id}.`,
    trials: 1,
  })).sort((left, right) => right.digest.localeCompare(left.digest));
  expect(cases[0]!.digest.localeCompare(cases[1]!.digest)).toBeGreaterThan(0);
  const discovered = Object.freeze([Object.freeze({
    sourcePath: '/project/evals/ordered.eval.ts',
    suite: defineEvalSuite({ cases: Object.freeze(cases), name: 'ordered-review' }),
  })]);
  const reference = epoch('epoch-authored-order', '/epochs/authored-order');
  const service = new NativePlaygroundService({
    catalogDirectory,
    discover: async () => discovered,
    planFixture: async ({ baseDir }) => fixturePlanAt(baseDir),
    projectRoot: '/project',
  });

  const catalog = await service.catalog(reference);
  expect(catalog.cases.map((entry) => entry.label).sort()).toEqual([
    'ordered-review / alpha-case',
    'ordered-review / beta-case',
  ]);
  await service.close();

  const restarted = new NativePlaygroundService({
    catalogDirectory,
    discover: async () => { throw new Error('The persisted catalog must not rediscover authored cases.'); },
    planFixture: async ({ baseDir }) => fixturePlanAt(baseDir),
    projectRoot: '/project',
  });
  await expect(restarted.catalog(reference)).resolves.toEqual(catalog);
  await restarted.close();
});

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
    };
    expect(valid).not.toHaveProperty('version');
    const invalidSnapshots = [
      '{not json}\n',
      `${' '.repeat(8 * 1024 * 1024)}${JSON.stringify(valid)}\n`,
      `${JSON.stringify({ ...valid, selections: [valid.selections[0], valid.selections[0]] })}\n`,
      `${JSON.stringify({ ...valid, selections: Array.from({ length: 257 }, () => valid.selections[0]) })}\n`,
      `${JSON.stringify({ ...valid, version: 1 })}\n`,
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
  };
  const snapshots = [
    (snapshot: { selections: Record<string, unknown>[] }) => {
      snapshot.selections[0]!.unexpected = 'smuggled';
    },
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

it('requires every persisted fixture sha256 to be exactly 64 lowercase hexadecimal characters', async () => {
  for (const [label, sha256] of [
    ['uppercase', 'A'.repeat(64)],
    ['short', 'a'.repeat(63)],
    ['non-hex', 'g'.repeat(64)],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), `agent-bundle-native-playground-${label}-sha-`));
    try {
      const suiteDir = join(root, 'evals');
      const fixtureDir = join(suiteDir, 'fixture');
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(join(fixtureDir, 'input.txt'), 'fixture bytes\n');
      const entries = deepFreeze([{ executable: false, path: 'input.txt', sha256 }]);
      const service = new NativePlaygroundService({
        catalogDirectory: join(root, 'catalog'),
        discover: async () => nativeSuite('claude', join(suiteDir, 'review.eval.ts')),
        inspectArtifact: async (candidate) => Object.freeze({
          binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
          root: candidate.root,
        }),
        planFixture: async () => Object.freeze({
          digest: digest({ entries, git: false }),
          entries,
          git: false,
          sourcePath: fixtureDir,
        }),
        projectRoot: root,
      });
      await expect(service.catalog(epoch(`epoch-${label}-sha`, join(root, 'artifact'))))
        .rejects.toThrow('Native Playground discovered an invalid fixture plan.');
      await service.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

it('rejects a catalog whose cumulative nested values exceed the whole-sidecar budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-cumulative-budget-'));
  try {
    const suiteDir = join(root, 'evals');
    const fixtureDir = join(suiteDir, 'fixture');
    await mkdir(fixtureDir, { recursive: true });
    const entries = Object.freeze(Array.from({ length: 4_096 }, (_, index) => Object.freeze({
      executable: false,
      path: `file-${index}.txt`,
      sha256: 'a'.repeat(64),
    })).sort((left, right) => left.path.localeCompare(right.path)));
    const discovered = Object.freeze([Object.freeze({
      sourcePath: join(suiteDir, 'review.eval.ts'),
      suite: defineEvalSuite({
        cases: [0, 1].map((index) => ({
          assertions: [expectExitCode(0)],
          fixture: { git: false, include: ['**/*'], path: './fixture' },
          hosts: {
            claude: { model: 'pinned-claude-model' },
            codex: { model: 'pinned-codex-model' },
          },
          id: `budget-case-${index}`,
          invocation: { mode: 'automatic' as const },
          prompt: 'Review the fixture.',
          trials: 1,
        })),
        name: 'cumulative-budget',
      }),
    })]);
    const service = new NativePlaygroundService({
      catalogDirectory: join(root, 'catalog'),
      discover: async () => discovered,
      inspectArtifact: async (candidate) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
        root: candidate.root,
      }),
      planFixture: async () => Object.freeze({
        digest: digest({ entries, git: false }),
        entries,
        git: false,
        sourcePath: fixtureDir,
      }),
      projectRoot: root,
    });
    const reference = Object.freeze({
      ...epoch('epoch-cumulative-budget', join(root, 'artifact')),
      epoch: Object.freeze({
        ...epoch('epoch-cumulative-budget', join(root, 'artifact')).epoch,
        targetDigests: Object.freeze({ claude: 'target-claude', codex: 'target-codex' }),
      }),
    });
    await expect(service.catalog(reference)).rejects.toThrow('catalog snapshot is invalid');
    await service.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('tolerates only Windows directory fsync capability failures during catalog publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-windows-directory-sync-'));
  const catalogDirectory = join(root, 'catalog');
  const runtime = globalThis as typeof globalThis & Record<symbol, NodeJS.Platform | undefined>;
  const previousPlatform = runtime[nativeCatalogDurabilityPlatformKey];
  runtime[nativeCatalogDurabilityPlatformKey] = 'win32';
  const serviceFor = (code: 'EACCES' | 'EINVAL' | 'EPERM'): NativePlaygroundService => {
    const storage: NativePlaygroundCatalogStorage = {
      link,
      mkdir,
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (String(path) !== catalogDirectory) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'sync') {
              return async () => {
                throw Object.assign(new Error(`${code} directory sync`), { code });
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      move: rename,
      remove: rm,
    };
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
    for (const code of ['EACCES', 'EINVAL'] as const) {
      await rm(catalogDirectory, { force: true, recursive: true });
      const service = serviceFor(code);
      await expect(service.catalog(epoch(`epoch-${code.toLowerCase()}`, join(root, code)))).resolves.toMatchObject({ epochId: `epoch-${code.toLowerCase()}` });
      await service.close();
    }
    await rm(catalogDirectory, { force: true, recursive: true });
    const service = serviceFor('EPERM');
    await expect(service.catalog(epoch('epoch-eperm', join(root, 'EPERM')))).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: 'EPERM' }), expect.objectContaining({ code: 'EPERM' })],
    });
    await service.close();
  } finally {
    if (previousPlatform === undefined) delete runtime[nativeCatalogDurabilityPlatformKey];
    else runtime[nativeCatalogDurabilityPlatformKey] = previousPlatform;
    await rm(root, { force: true, recursive: true });
  }
});

it('preserves a catalog replacement raced into rollback and fsyncs the parent after cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-rollback-race-'));
  const catalogDirectory = join(root, 'catalog');
  const reference = epoch('epoch-rollback-race', join(root, 'artifact'));
  const sidecar = join(catalogDirectory, 'epoch-rollback-race.json');
  const replacement = '{"replacement":true}\n';
  let directorySyncs = 0;
  let injectReplacement = false;
  let replacementInjected = false;
  const replaceSidecar = async (): Promise<void> => {
    if (!injectReplacement || replacementInjected) return;
    replacementInjected = true;
    const replacementPath = join(catalogDirectory, '.replacement');
    await writeFile(replacementPath, replacement);
    await rename(replacementPath, sidecar);
  };
  const storage = {
    link,
    mkdir,
    open: async (path: Parameters<typeof open>[0], flags: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
      const handle = await open(path, flags, mode);
      if (String(path) !== catalogDirectory) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') return async () => { directorySyncs += 1; await target.sync(); };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    remove: async (path: Parameters<typeof rm>[0], options: Parameters<typeof rm>[1]) => {
      if (String(path) === sidecar) await replaceSidecar();
      await rm(path, options);
    },
    move: async (oldPath: Parameters<typeof rename>[0], newPath: Parameters<typeof rename>[1]) => {
      if (String(oldPath) === sidecar) await replaceSidecar();
      await rename(oldPath, newPath);
    },
  } as NativePlaygroundCatalogStorage & { readonly move: typeof rename };
  try {
    const service = new NativePlaygroundService({
      catalogDirectory,
      catalogStorage: storage,
      discover: async () => Object.freeze([]),
      inspectArtifact: async (candidate) => Object.freeze({
        binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
        root: candidate.root,
      }),
      projectRoot: root,
    });
    const receipt = await service.publishCatalogSnapshot(reference);
    const publicationSyncs = directorySyncs;
    injectReplacement = true;
    await receipt.rollback();
    expect(await readFile(sidecar, 'utf8')).toBe(replacement);
    expect(directorySyncs).toBe(publicationSyncs + 1);
    await service.close();
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
      if (failure === 'directory') {
        await expect(service.catalog(reference)).rejects.toMatchObject({
          errors: [failures.get(failure), failures.get(failure)],
        });
      } else {
        await expect(service.catalog(reference)).rejects.toThrow(failures.get(failure)!.message);
      }
      expect((await readdir(catalogDirectory)).filter((name) => name.includes('.stage-'))).toEqual([]);
      await expect(readFile(join(catalogDirectory, `${reference.epoch.id}.json`), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
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

it('waits for a linked winner to release its staging link, then adopts it instead of rejecting the doubly linked sidecar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-linked-winner-'));
  const catalogDirectory = join(root, 'catalog');
  const reference = epoch('epoch-linked-winner', join(root, 'artifact'));
  const sidecar = join(catalogDirectory, `${reference.epoch.id}.json`);
  let winnerStaging: string | undefined;
  let signalLinked!: () => void;
  const linked = new Promise<void>((resolvePromise) => { signalLinked = resolvePromise; });
  let releaseWinnerCleanup!: () => void;
  const winnerCleanup = new Promise<void>((resolvePromise) => { releaseWinnerCleanup = resolvePromise; });
  const storage: NativePlaygroundCatalogStorage = {
    link: async (source, destination) => {
      await link(source, destination);
      winnerStaging = String(source);
      signalLinked();
    },
    mkdir,
    open,
    remove: async (path, options) => {
      if (String(path) === winnerStaging) await winnerCleanup;
      await rm(path, options);
    },
  };
  const serviceFor = (): NativePlaygroundService => new NativePlaygroundService({
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
  const winner = serviceFor();
  const loser = serviceFor();
  try {
    const winning = winner.catalog(reference);
    await linked;
    // The winner has linked its staging file into place but has not released
    // it yet: the published sidecar is legitimately doubly linked here, and a
    // reader must treat it as a publication still in progress.
    expect((await stat(sidecar)).nlink).toBe(2);

    const losing = loser.catalog(reference);
    await expect(Promise.race([
      losing.then(() => 'adopted' as const),
      new Promise<'pending'>((resolvePromise) => { setTimeout(() => resolvePromise('pending'), 150); }),
    ])).resolves.toBe('pending');
    expect((await stat(sidecar)).nlink).toBe(2);
    releaseWinnerCleanup();
    expect(await winning).toEqual(await losing);
    expect((await stat(sidecar)).nlink).toBe(1);
    expect((await readdir(catalogDirectory)).filter((name) => name.includes('.stage-'))).toEqual([]);
    await Promise.all([winner.close(), loser.close()]);
  } finally {
    releaseWinnerCleanup();
    await rm(root, { force: true, recursive: true });
  }
});

it('never adopts a staged sidecar that its publisher rolls back, and republishes its own instead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-withdrawn-winner-'));
  const catalogDirectory = join(root, 'catalog');
  const reference = epoch('epoch-withdrawn-winner', join(root, 'artifact'));
  const sidecar = join(catalogDirectory, `${reference.epoch.id}.json`);
  const cleanupFailure = new Error('winner stage cleanup failed');
  let winnerStaging: string | undefined;
  let signalLinked!: () => void;
  const linked = new Promise<void>((resolvePromise) => { signalLinked = resolvePromise; });
  let releaseWinnerCleanup!: () => void;
  const winnerCleanup = new Promise<void>((resolvePromise) => { releaseWinnerCleanup = resolvePromise; });
  const winnerStorage: NativePlaygroundCatalogStorage = {
    link: async (source, destination) => {
      await link(source, destination);
      winnerStaging = String(source);
      signalLinked();
    },
    mkdir,
    open,
    remove: async (path, options) => {
      if (String(path) === winnerStaging) {
        // The winner's staging cleanup stalls, then fails: the sidecar stays
        // doubly linked the whole time and is rolled back afterwards.
        await winnerCleanup;
        throw cleanupFailure;
      }
      await rm(path, options);
    },
  };
  const serviceFor = (storage?: NativePlaygroundCatalogStorage): NativePlaygroundService => new NativePlaygroundService({
    catalogDirectory,
    ...(storage === undefined ? {} : { catalogStorage: storage }),
    discover: async () => suite(),
    inspectArtifact: async (candidate) => Object.freeze({
      binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
      root: candidate.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  const winner = serviceFor(winnerStorage);
  const loser = serviceFor();
  try {
    const winning = winner.catalog(reference);
    await linked;
    expect((await stat(sidecar)).nlink).toBe(2);
    const losing = loser.catalog(reference);
    await expect(Promise.race([
      losing.then(() => 'adopted' as const),
      new Promise<'pending'>((resolvePromise) => { setTimeout(() => resolvePromise('pending'), 150); }),
    ])).resolves.toBe('pending');
    releaseWinnerCleanup();
    await expect(winning).rejects.toMatchObject({ errors: [cleanupFailure] });
    // The reader saw the publication withdrawn rather than adopting the rolled
    // back inode, so it discovered and persisted a singly linked sidecar itself.
    const adopted = await losing;
    expect((await stat(sidecar)).nlink).toBe(1);
    expect(await loser.catalog(reference)).toEqual(adopted);
    await Promise.all([winner.close(), loser.close()]);
  } finally {
    releaseWinnerCleanup();
    await rm(root, { force: true, recursive: true });
  }
});

it('withdraws a sidecar whose directory fsync fails before releasing its staging link, so a waiting reader never adopts it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-fsync-withdrawn-'));
  const catalogDirectory = join(root, 'catalog');
  const reference = epoch('epoch-fsync-withdrawn', join(root, 'artifact'));
  const sidecar = join(catalogDirectory, `${reference.epoch.id}.json`);
  const directoryFailure = new Error('directory sync failed');
  let signalLinked!: () => void;
  const linked = new Promise<void>((resolvePromise) => { signalLinked = resolvePromise; });
  let releaseDirectorySync!: () => void;
  const directorySync = new Promise<void>((resolvePromise) => { releaseDirectorySync = resolvePromise; });
  const winnerStorage: NativePlaygroundCatalogStorage = {
    link: async (source, destination) => {
      await link(source, destination);
      signalLinked();
    },
    mkdir,
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync' && String(path) === catalogDirectory) {
            return async () => {
              // The publisher stalls on its directory fsync after the link, then fails it.
              await directorySync;
              throw directoryFailure;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    remove: rm,
  } as NativePlaygroundCatalogStorage;
  const serviceFor = (storage?: NativePlaygroundCatalogStorage): NativePlaygroundService => new NativePlaygroundService({
    catalogDirectory,
    ...(storage === undefined ? {} : { catalogStorage: storage }),
    discover: async () => suite(),
    inspectArtifact: async (candidate) => Object.freeze({
      binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
      root: candidate.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  const winner = serviceFor(winnerStorage);
  const loser = serviceFor();
  try {
    const winning = winner.catalog(reference);
    await linked;
    expect((await stat(sidecar)).nlink).toBe(2);
    const losing = loser.catalog(reference);
    await expect(Promise.race([
      losing.then(() => 'adopted' as const),
      new Promise<'pending'>((resolvePromise) => { setTimeout(() => resolvePromise('pending'), 150); }),
    ])).resolves.toBe('pending');
    releaseDirectorySync();
    // The rollback's own directory fsync fails the same way, so both are retained.
    await expect(winning).rejects.toMatchObject({ errors: [directoryFailure, directoryFailure] });
    const adopted = await losing;
    expect((await stat(sidecar)).nlink).toBe(1);
    expect((await readdir(catalogDirectory)).filter((name) => name.includes('.stage-'))).toEqual([]);
    expect(await loser.catalog(reference)).toEqual(adopted);
    await Promise.all([winner.close(), loser.close()]);
  } finally {
    releaseDirectorySync();
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps the staging link when a failed publication cannot roll its sidecar back, so readers never see it as settled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-rollback-failed-'));
  const catalogDirectory = join(root, 'catalog');
  const reference = epoch('epoch-rollback-failed', join(root, 'artifact'));
  const sidecar = join(catalogDirectory, `${reference.epoch.id}.json`);
  const directoryFailure = new Error('directory sync failed');
  const moveFailure = Object.assign(new Error('rename busy'), { code: 'EBUSY' });
  const storage: NativePlaygroundCatalogStorage = {
    link,
    mkdir,
    move: async () => { throw moveFailure; },
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync' && String(path) === catalogDirectory) {
            return async () => { throw directoryFailure; };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    remove: rm,
  } as NativePlaygroundCatalogStorage;
  const serviceFor = (
    discover: () => Promise<readonly DiscoveredEvalSuite[]>,
    catalogStorage?: NativePlaygroundCatalogStorage,
  ): NativePlaygroundService => new NativePlaygroundService({
    catalogDirectory,
    catalogStagingSettleDeadlineMs: 50,
    ...(catalogStorage === undefined ? {} : { catalogStorage }),
    discover,
    inspectArtifact: async (candidate) => Object.freeze({
      binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
      root: candidate.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  try {
    const winner = serviceFor(async () => suite(), storage);
    await expect(winner.catalog(reference)).rejects.toMatchObject({
      errors: [directoryFailure, moveFailure],
    });
    await winner.close();
    // The sidecar survived its failed rollback, so its staging link survives with
    // it: the publication still reads as in progress, never as settled.
    expect((await stat(sidecar)).nlink).toBe(2);
    expect((await readdir(catalogDirectory)).filter((name) => name.includes('.stage-'))).toHaveLength(1);
    const reader = serviceFor(async () => { throw new Error('An unsettled catalog must not fall back to discovery.'); });
    await expect(reader.catalog(reference)).rejects.toThrow('catalog snapshot is invalid');
    await reader.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

const exitedPid = (): number => {
  for (let pid = 4_194_000; pid > 1_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('No exited pid was available for the abandoned-staging fixture.');
};

it('recovers a staging link abandoned by an exited publisher after the settle deadline, but never one whose publisher is alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-abandoned-staging-'));
  const catalogDirectory = join(root, 'catalog');
  const reference = epoch('epoch-abandoned-staging', join(root, 'artifact'));
  const sidecar = join(catalogDirectory, `${reference.epoch.id}.json`);
  const directorySyncs: string[] = [];
  // Fault injection for the recovery fallback chain. Directory fsync failures
  // are counted down so that the recovery fsync fails while the fsync that
  // makes the compensating guard durable succeeds.
  let directorySyncFailuresLeft = 0;
  const directorySyncFailure = Object.assign(new Error('directory sync failed'), { code: 'EIO' });
  let relinkFailure: Error | undefined;
  let concurrentRestorer = false;
  let sidecarRemoveFailure: Error | undefined;
  const storage: NativePlaygroundCatalogStorage = {
    link: async (source, destination) => {
      if (String(destination).endsWith('-orphan')) {
        if (relinkFailure !== undefined) throw relinkFailure;
        if (concurrentRestorer) {
          // Another reader restored the same alias a moment earlier.
          await link(source, destination);
          throw Object.assign(new Error('link exists'), { code: 'EEXIST' });
        }
      }
      await link(source, destination);
    },
    mkdir,
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync' && String(path) === catalogDirectory) {
            return async () => {
              directorySyncs.push(String(path));
              if (directorySyncFailuresLeft > 0) {
                directorySyncFailuresLeft -= 1;
                throw directorySyncFailure;
              }
              await target.sync();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    remove: async (path, options) => {
      if (sidecarRemoveFailure !== undefined && String(path) === sidecar) throw sidecarRemoveFailure;
      await rm(path, options);
    },
  } as NativePlaygroundCatalogStorage;
  const serviceFor = (discover: () => Promise<readonly DiscoveredEvalSuite[]>): NativePlaygroundService => new NativePlaygroundService({
    catalogDirectory,
    catalogStagingSettleDeadlineMs: 50,
    catalogStorage: storage,
    discover,
    inspectArtifact: async (candidate) => Object.freeze({
      binding: Object.freeze({ manifestPath: 'agent-bundle.manifest.json', source: 'explicit' as const, targetDigests: candidate.epoch.targetDigests }),
      root: candidate.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  const rejectsUnsettled = async (label: string): Promise<void> => {
    const reader = serviceFor(async () => { throw new Error(`${label} must not fall back to discovery.`); });
    await expect(reader.catalog(reference)).rejects.toThrow();
    await reader.close();
  };
  try {
    const writer = serviceFor(async () => suite());
    const published = await writer.catalog(reference);
    await writer.close();

    // A publisher that is still running owns its staging link: the reader waits out the deadline and rejects.
    const live = join(catalogDirectory, `.${reference.epoch.id}.stage-${String(process.pid)}-live`);
    await link(sidecar, live);
    await rejectsUnsettled('A blocked catalog');
    expect((await stat(sidecar)).nlink).toBe(2);
    await rm(live);

    // A recovery whose directory fsync fails has not made the orphan's removal
    // durable: the staging guard is restored, fsynced, and the sidecar stays unsettled.
    const orphan = join(catalogDirectory, `.${reference.epoch.id}.stage-${String(exitedPid())}-orphan`);
    await link(sidecar, orphan);
    directorySyncFailuresLeft = 1;
    directorySyncs.length = 0;
    await rejectsUnsettled('An unsynced recovery');
    expect((await stat(sidecar)).nlink).toBe(2);
    expect((await stat(orphan)).ino).toBe((await stat(sidecar)).ino);
    expect(directorySyncs).toEqual([catalogDirectory, catalogDirectory]);

    // A concurrent recoverer restored the same alias first: EEXIST on an entry
    // that already aliases the sidecar counts as a restored guard.
    directorySyncFailuresLeft = 1;
    concurrentRestorer = true;
    await rejectsUnsettled('A racing recovery');
    concurrentRestorer = false;
    expect((await stat(sidecar)).nlink).toBe(2);
    expect((await stat(orphan)).ino).toBe((await stat(sidecar)).ino);

    // When the guard cannot be re-linked and the sidecar cannot be unlinked
    // either, a fresh fsynced guard under this process's pid keeps it doubly linked.
    directorySyncFailuresLeft = 1;
    relinkFailure = Object.assign(new Error('relink denied'), { code: 'EPERM' });
    sidecarRemoveFailure = Object.assign(new Error('sidecar busy'), { code: 'EBUSY' });
    await rejectsUnsettled('A guarded recovery');
    expect((await stat(sidecar)).nlink).toBe(2);
    const guards = (await readdir(catalogDirectory)).filter((name) => name.includes(`.stage-${String(process.pid)}-guard-`));
    expect(guards).toHaveLength(1);
    expect((await stat(join(catalogDirectory, guards[0]!))).ino).toBe((await stat(sidecar)).ino);
    // A live-pid guard is honoured by the next reader until this process exits.
    await rejectsUnsettled('A guarded catalog');
    await rm(join(catalogDirectory, guards[0]!));
    await link(sidecar, orphan);
    relinkFailure = undefined;
    sidecarRemoveFailure = undefined;

    // When every fsync keeps failing, the sidecar is withdrawn rather than left
    // singly linked: the guard chain never trusts an unsynced step.
    directorySyncFailuresLeft = Number.POSITIVE_INFINITY;
    await rejectsUnsettled('A withdrawn recovery');
    directorySyncFailuresLeft = 0;
    await expect(stat(sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
    const republisher = serviceFor(async () => suite());
    expect(await republisher.catalog(reference)).toEqual(published);
    await republisher.close();
    // The restored orphan name still aliases the withdrawn inode; a fresh
    // sidecar is singly linked and unaffected by it.
    expect((await stat(sidecar)).nlink).toBe(1);
    await rm(orphan);
    await link(sidecar, orphan);

    // A publisher that exited after link() but before cleanup left a complete,
    // fsynced sidecar behind: the reader withdraws the orphan and adopts it.
    directorySyncs.length = 0;
    const reader = serviceFor(async () => { throw new Error('A recovered catalog must not fall back to discovery.'); });
    expect(await reader.catalog(reference)).toEqual(published);
    await reader.close();
    expect((await stat(sidecar)).nlink).toBe(1);
    expect((await readdir(catalogDirectory)).filter((name) => name.includes('.stage-'))).toEqual([]);
    // The exited publisher may never have flushed the directory after link(); recovery does.
    expect(directorySyncs).toEqual([catalogDirectory]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('still rejects a persisted catalog aliased by a hard link that is not an epoch staging file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-aliased-catalog-'));
  const catalogDirectory = join(root, 'catalog');
  const reference = epoch('epoch-aliased-catalog', join(root, 'artifact'));
  const sidecar = join(catalogDirectory, `${reference.epoch.id}.json`);
  const serviceFor = (discover: () => Promise<readonly DiscoveredEvalSuite[]>): NativePlaygroundService => new NativePlaygroundService({
    catalogDirectory,
    discover,
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  try {
    const writer = serviceFor(async () => suite());
    await writer.catalog(reference);
    await writer.close();
    for (const alias of ['alias.json', '.epoch-other.stage-alias', `.${reference.epoch.id}.staged`]) {
      await link(sidecar, join(catalogDirectory, alias));
      const reader = serviceFor(async () => { throw new Error('An aliased catalog must not fall back to discovery.'); });
      await expect(reader.catalog(reference)).rejects.toThrow('catalog snapshot is invalid');
      await reader.close();
      await rm(join(catalogDirectory, alias));
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

const sweepFixture = async (): Promise<{
  readonly catalogDirectory: string;
  readonly root: string;
  readonly service: NativePlaygroundService;
  readonly staging: (epochId: string, pid: number, nonce: string) => string;
  readonly stagingEntries: () => Promise<string[]>;
}> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-staging-sweep-'));
  const catalogDirectory = join(root, 'catalog');
  await mkdir(catalogDirectory, { recursive: true });
  const service = new NativePlaygroundService({
    catalogDirectory,
    discover: async () => suite(),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  return {
    catalogDirectory,
    root,
    service,
    staging: (epochId, pid, nonce) => join(catalogDirectory, `.${epochId}.stage-${String(pid)}-${nonce}`),
    stagingEntries: async () => (await readdir(catalogDirectory)).filter((name) => name.includes('.stage-')).sort(),
  };
};

it('sweeps staging files orphaned by exited publishers of other epochs on the next publish', async () => {
  const { catalogDirectory, root, service, staging, stagingEntries } = await sweepFixture();
  const exited = exitedPid();
  try {
    // A publisher that died before link(), or that lost the EEXIST race, left
    // a singly linked staging file; a recovery guard whose sidecar was later
    // withdrawn is in the same position.
    const orphan = staging('epoch-old', exited, 'deadbeef');
    const guard = staging('epoch-old', exited, 'guard-cafe');
    await writeFile(orphan, '{"stale":true}\n');
    await writeFile(guard, '{"stale":true}\n');
    // The epoch being published is never swept by its own publication, even
    // when its orphan's publisher has exited: same-epoch links belong to the
    // reader protocol of that epoch.
    const sameEpoch = staging('epoch-new', exited, 'abandoned');
    await writeFile(sameEpoch, '{"stale":true}\n');
    expect(await stagingEntries()).toHaveLength(3);

    await service.catalog(epoch('epoch-new', join(root, 'artifact-new')));
    expect(await stagingEntries()).toEqual([`.epoch-new.stage-${String(exited)}-abandoned`]);
    await expect(readFile(join(catalogDirectory, 'epoch-new.json'), 'utf8')).resolves.toContain('"epochId":"epoch-new"');

    // The next epoch's publication sweeps what the previous one left alone.
    await service.catalog(epoch('epoch-next', join(root, 'artifact-next')));
    expect(await stagingEntries()).toEqual([]);
    await expect(readFile(join(catalogDirectory, 'epoch-new.json'), 'utf8')).resolves.toContain('"epochId":"epoch-new"');
    await expect(readFile(join(catalogDirectory, 'epoch-next.json'), 'utf8')).resolves.toContain('"epochId":"epoch-next"');
  } finally {
    await service.close();
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps a live winner\'s staging link, live-publisher and foreign entries, and never leaves the catalog directory while sweeping', async () => {
  const { catalogDirectory, root, service, staging, stagingEntries } = await sweepFixture();
  const exited = exitedPid();
  try {
    // An older epoch whose publisher exited between link() and cleanup: its
    // staging entry aliases the winner sidecar and stays for reader recovery.
    await service.catalog(epoch('epoch-old', join(root, 'artifact-old')));
    const oldSidecar = join(catalogDirectory, 'epoch-old.json');
    const linked = staging('epoch-old', exited, 'linked');
    await link(oldSidecar, linked);
    // A publisher that is still running owns its staging file.
    const live = staging('epoch-old', process.pid, 'live');
    await writeFile(live, '{"live":true}\n');
    // Foreign files that merely resemble the pattern are not this publisher's.
    const foreign = [
      join(catalogDirectory, `epoch-old.stage-${String(exited)}-nodot`),
      join(catalogDirectory, `.epoch-old.staged-${String(exited)}-suffix`),
      join(catalogDirectory, `.epoch-old.stage-${String(exited)}`),
      join(catalogDirectory, '.epoch-old.stage-notapid-nonce'),
      join(catalogDirectory, `.epoch-old.stage-${String(exited)}-bad nonce`),
    ];
    for (const path of foreign) await writeFile(path, '{"foreign":true}\n');
    // A directory and a symlink under the pattern are not regular files; the
    // symlink's target outside the catalog directory is never followed.
    const nestedDirectory = staging('epoch-old', exited, 'directory');
    await mkdir(nestedDirectory);
    await writeFile(join(nestedDirectory, `.epoch-old.stage-${String(exited)}-nested`), '{"nested":true}\n');
    const outside = join(root, 'outside.json');
    await writeFile(outside, '{"outside":true}\n');
    const symlinked = staging('epoch-old', exited, 'symlink');
    await symlink(outside, symlinked);
    // A staging entry whose sidecar exists but is a different inode aliases
    // something unknown once doubly linked; it is left alone too.
    const aliasedElsewhere = staging('epoch-old', exited, 'aliased');
    await link(outside, aliasedElsewhere);
    const before = await stagingEntries();

    await service.catalog(epoch('epoch-new', join(root, 'artifact-new')));

    expect(await stagingEntries()).toEqual(before);
    expect((await stat(linked)).ino).toBe((await stat(oldSidecar)).ino);
    expect((await stat(oldSidecar)).nlink).toBe(2);
    await expect(readFile(live, 'utf8')).resolves.toBe('{"live":true}\n');
    for (const path of foreign) await expect(readFile(path, 'utf8')).resolves.toBe('{"foreign":true}\n');
    await expect(readFile(join(nestedDirectory, `.epoch-old.stage-${String(exited)}-nested`), 'utf8')).resolves.toBe('{"nested":true}\n');
    await expect(readFile(outside, 'utf8')).resolves.toBe('{"outside":true}\n');
    expect((await stat(outside)).nlink).toBe(2);
    await expect(readFile(symlinked, 'utf8')).resolves.toBe('{"outside":true}\n');
    // The kept, still-linked older epoch reads back through the recovery path.
    const reader = new NativePlaygroundService({
      catalogDirectory,
      catalogStagingSettleDeadlineMs: 50,
      discover: async () => { throw new Error('A recovered catalog must not fall back to discovery.'); },
      planFixture: async () => fixturePlan,
      projectRoot: '/project',
    });
    await expect(reader.catalog(epoch('epoch-old', join(root, 'artifact-old')))).resolves.toMatchObject({ epochId: 'epoch-old' });
    await reader.close();
  } finally {
    await service.close();
    await rm(root, { force: true, recursive: true });
  }
});

it('bounds the orphan sweep per publish and finishes on later publications', async () => {
  const { root, service, staging, stagingEntries } = await sweepFixture();
  const exited = exitedPid();
  const { candidates, removals } = nativePlaygroundStagingSweepLimits;
  try {
    // More orphans than one publish removes: the cap's worth goes now, the rest next time.
    const orphans = Array.from({ length: removals + 4 }, (_, index) => staging('epoch-bulk', exited, `orphan${String(index).padStart(2, '0')}`));
    for (const path of orphans) await writeFile(path, '{"stale":true}\n');
    await service.catalog(epoch('epoch-first', join(root, 'artifact-first')));
    expect(await stagingEntries()).toHaveLength(4);
    await service.catalog(epoch('epoch-second', join(root, 'artifact-second')));
    expect(await stagingEntries()).toEqual([]);

    // Examination is bounded too: when the cap's worth of candidates all belong
    // to a live publisher, an orphan sorting after them waits for a later sweep.
    const held = Array.from({ length: candidates }, (_, index) => staging('epoch-aaaa', process.pid, `held${String(index).padStart(3, '0')}`));
    for (const path of held) await writeFile(path, '{"live":true}\n');
    const trailing = staging('epoch-zzzz', exited, 'trailing');
    await writeFile(trailing, '{"stale":true}\n');
    await service.catalog(epoch('epoch-third', join(root, 'artifact-third')));
    expect(await stagingEntries()).toHaveLength(candidates + 1);
    await expect(readFile(trailing, 'utf8')).resolves.toBe('{"stale":true}\n');
    for (const path of held) await rm(path);
    await service.catalog(epoch('epoch-fourth', join(root, 'artifact-fourth')));
    expect(await stagingEntries()).toEqual([]);
  } finally {
    await service.close();
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

it('retains a genuine admitted catalog failure in the stable close result', async () => {
  let rejectDiscovery!: (reason: unknown) => void;
  let discoveryStarted!: () => void;
  const discovery = new Promise<readonly DiscoveredEvalSuite[]>((_, reject) => { rejectDiscovery = reject; });
  const started = new Promise<void>((resolvePromise) => { discoveryStarted = resolvePromise; });
  const failure = new Error('catalog discovery failed');
  const service = new NativePlaygroundService({
    catalogDirectory: testCatalogDirectory(),
    discover: async () => {
      discoveryStarted();
      return discovery;
    },
    projectRoot: '/project',
  });
  const pending = service.catalog(epoch('epoch-catalog-failure', '/epochs/catalog-failure'));
  await started;
  const closing = service.close();
  rejectDiscovery(failure);
  await expect(pending).rejects.toBe(failure);
  await expect(closing).rejects.toMatchObject({ errors: [failure] });
});

it('returns ownership-safe receipts for created and accepted native catalog sidecars', async () => {
  const catalogDirectory = testCatalogDirectory();
  const reference = epoch('epoch-publication-receipt', '/epochs/publication-receipt');
  const serviceFor = (): NativePlaygroundService => new NativePlaygroundService({
    catalogDirectory,
    discover: async () => suite(),
    inspectArtifact: async (candidate) => Object.freeze({
      binding: Object.freeze({
        manifestPath: candidate.epoch.manifestPath,
        source: 'explicit' as const,
        targetDigests: candidate.epoch.targetDigests,
      }),
      root: candidate.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  const owner = serviceFor();
  const accepted = serviceFor();
  const ownerReceipt = await owner.publishCatalogSnapshot(reference);
  const acceptedReceipt = await accepted.publishCatalogSnapshot(reference);
  const sidecar = join(catalogDirectory, `${reference.epoch.id}.json`);

  expect(ownerReceipt).toMatchObject({ created: true });
  expect(acceptedReceipt).toMatchObject({ created: false, identity: ownerReceipt.identity });
  await acceptedReceipt.rollback();
  await expect(readFile(sidecar, 'utf8')).resolves.toContain(reference.epoch.id);
  await ownerReceipt.rollback();
  await expect(readFile(sidecar, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await Promise.all([owner.close(), accepted.close()]);
});

it('does not let a native catalog owner receipt remove replaced sidecar contents', async () => {
  const catalogDirectory = testCatalogDirectory();
  const reference = epoch('epoch-publication-replaced', '/epochs/publication-replaced');
  const service = new NativePlaygroundService({
    catalogDirectory,
    discover: async () => suite(),
    inspectArtifact: async (candidate) => Object.freeze({
      binding: Object.freeze({
        manifestPath: candidate.epoch.manifestPath,
        source: 'explicit' as const,
        targetDigests: candidate.epoch.targetDigests,
      }),
      root: candidate.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  const receipt = await service.publishCatalogSnapshot(reference);
  const sidecar = join(catalogDirectory, `${reference.epoch.id}.json`);
  await writeFile(sidecar, 'replacement contents\n');

  await receipt.rollback();
  await expect(readFile(sidecar, 'utf8')).resolves.toBe('replacement contents\n');
  await service.close();
});

it('does not delete a sidecar replaced between receipt validation and rollback removal', async () => {
  const catalogDirectory = testCatalogDirectory();
  const reference = epoch('epoch-publication-race', '/epochs/publication-race');
  const sidecar = join(catalogDirectory, `${reference.epoch.id}.json`);
  const replacement = 'replacement at removal boundary\n';
  const storage = {
    link,
    mkdir,
    move: async (source: Parameters<typeof rename>[0], destination: Parameters<typeof rename>[1]) => {
      await rename(source, destination);
      await writeFile(sidecar, replacement);
    },
    open,
    remove: async (path: Parameters<typeof rm>[0], options: Parameters<typeof rm>[1]) => {
      if (String(path) === sidecar) await writeFile(sidecar, replacement);
      await rm(path, options);
    },
  } as NativePlaygroundCatalogStorage & { readonly move: typeof rename };
  const service = new NativePlaygroundService({
    catalogDirectory,
    catalogStorage: storage,
    discover: async () => suite(),
    inspectArtifact: async (candidate) => Object.freeze({
      binding: Object.freeze({
        manifestPath: candidate.epoch.manifestPath,
        source: 'explicit' as const,
        targetDigests: candidate.epoch.targetDigests,
      }),
      root: candidate.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  const receipt = await service.publishCatalogSnapshot(reference);

  await receipt.rollback();
  await expect(readFile(sidecar, 'utf8')).resolves.toBe(replacement);
  await service.close();
});

it('rolls back an owned native catalog sidecar when staging cleanup alone fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-cleanup-only-'));
  const catalogDirectory = join(root, 'catalog');
  const reference = epoch('epoch-cleanup-only', '/epochs/cleanup-only');
  const cleanupFailure = new Error('stage cleanup failed');
  const storage: NativePlaygroundCatalogStorage = {
    link,
    mkdir,
    open,
    remove: async (path, options) => {
      if (String(path).includes('.stage-')) throw cleanupFailure;
      await rm(path, options);
    },
  };
  const service = new NativePlaygroundService({
    catalogDirectory,
    catalogStorage: storage,
    discover: async () => suite(),
    inspectArtifact: async (candidate) => Object.freeze({
      binding: Object.freeze({
        manifestPath: candidate.epoch.manifestPath,
        source: 'explicit' as const,
        targetDigests: candidate.epoch.targetDigests,
      }),
      root: candidate.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  try {
    await expect(service.publishCatalogSnapshot(reference)).rejects.toMatchObject({
      errors: [cleanupFailure],
    });
    await expect(readFile(join(catalogDirectory, `${reference.epoch.id}.json`), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await service.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('preserves a replacement sidecar when staging cleanup fails after the owned link is replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-cleanup-replaced-'));
  const catalogDirectory = join(root, 'catalog');
  const reference = epoch('epoch-cleanup-replaced', '/epochs/cleanup-replaced');
  const cleanupFailure = new Error('stage cleanup failed');
  const replacement = 'replacement contents\n';
  const storage: NativePlaygroundCatalogStorage = {
    link: async (source, destination) => {
      await link(source, destination);
      await rm(destination);
      await writeFile(destination, replacement);
    },
    mkdir,
    open,
    remove: async (path, options) => {
      if (String(path).includes('.stage-')) throw cleanupFailure;
      await rm(path, options);
    },
  };
  const service = new NativePlaygroundService({
    catalogDirectory,
    catalogStorage: storage,
    discover: async () => suite(),
    inspectArtifact: async (candidate) => Object.freeze({
      binding: Object.freeze({
        manifestPath: candidate.epoch.manifestPath,
        source: 'explicit' as const,
        targetDigests: candidate.epoch.targetDigests,
      }),
      root: candidate.root,
    }),
    planFixture: async () => fixturePlan,
    projectRoot: '/project',
  });
  try {
    await expect(service.publishCatalogSnapshot(reference)).rejects.toMatchObject({
      errors: [cleanupFailure],
    });
    await expect(readFile(join(catalogDirectory, `${reference.epoch.id}.json`), 'utf8')).resolves.toBe(replacement);
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
    await closing;
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
    await expect(service.catalog(reference)).rejects.toThrow('closed');
    const closing = service.close();
    expect(service.close()).toBe(closing);
    expect(reentrant).not.toBe(closing);
    await reentrant;
    expect(abortHandlerCompleted).toBe(true);
    await running;
    await closing;
    expect((await readdir(join(root, '.agent-bundle'))).filter((entry) => entry.startsWith('native-playground-'))).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
