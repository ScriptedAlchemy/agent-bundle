import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { NativePlaygroundService } from '../src/dev/native-playground-service.ts';
import type { DiscoveredEvalSuite } from '../src/eval/discovery.ts';
import type { EvalFixturePlan } from '../src/eval/fixtures.ts';

const epoch = (id: string, root: string) => Object.freeze({
  close: async () => undefined,
  epoch: Object.freeze({
    configDigest: `config-${id}`,
    createdAt: '2026-08-18T00:00:00.000Z',
    diagnostics: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
    id,
    manifestPath: 'agent-bundle.manifest.json',
    modelDigest: `model-${id}`,
    projectRevision: `revision-${id}`,
    targetDigests: Object.freeze({ claude: `claude-target-${id}`, codex: `codex-target-${id}` }),
  }),
  root,
});

const suite = (): readonly DiscoveredEvalSuite[] => Object.freeze([Object.freeze({
  sourcePath: '/project/evals/review.eval.ts',
  suite: Object.freeze({
    cases: Object.freeze([Object.freeze({
      assertions: Object.freeze([]),
      digest: 'authored-case-digest',
      fixture: Object.freeze({ git: false, include: Object.freeze(['**/*']), path: './fixture' }),
      hosts: Object.freeze({ claude: Object.freeze({ model: 'author-pinned-model' }) }),
      id: 'review-case',
      invocation: Object.freeze({ mode: 'automatic' as const }),
      prompt: 'Original authored prompt.',
      trials: 1,
    })]),
    digest: 'suite-digest',
    name: 'review',
  }),
})]);

const dualHostSuite = (): readonly DiscoveredEvalSuite[] => Object.freeze([Object.freeze({
  sourcePath: '/project/evals/review.eval.ts',
  suite: Object.freeze({
    cases: Object.freeze([Object.freeze({
      assertions: Object.freeze([]),
      digest: 'authored-dual-host-case-digest',
      fixture: Object.freeze({ git: false, include: Object.freeze(['**/*']), path: './fixture' }),
      hosts: Object.freeze({
        claude: Object.freeze({ model: 'claude-pinned-model' }),
        codex: Object.freeze({ model: 'codex-pinned-model' }),
      }),
      id: 'dual-host-review-case',
      invocation: Object.freeze({ mode: 'automatic' as const }),
      prompt: 'Original authored prompt.',
      trials: 1,
    })]),
    digest: 'dual-host-suite-digest',
    name: 'dual-host-review',
  }),
})]);

const fixturePlan: EvalFixturePlan = Object.freeze({
  digest: 'fixture-content-digest',
  entries: Object.freeze([]),
  git: false,
  sourcePath: '/project/evals/fixture',
});

it('pins opaque native catalog selections to their catalog epoch and never resolves them across epochs', async () => {
  const service = new NativePlaygroundService({
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

it('uses the catalog fixture plan unchanged so changed authored fixture bytes fail materialization instead of replanning', async () => {
  let planCalls = 0;
  const service = new NativePlaygroundService({
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
