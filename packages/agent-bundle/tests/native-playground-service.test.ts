import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { NativePlaygroundService, type NativePlaygroundEpochReference } from '../src/dev/native-playground-service.ts';
import type { DiscoveredEvalSuite } from '../src/eval/discovery.ts';
import type { EvalFixturePlan } from '../src/eval/fixtures.ts';

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

const fixturePlan: EvalFixturePlan = Object.freeze({
  digest: 'fixture-content-digest',
  entries: Object.freeze([]),
  git: false,
  sourcePath: '/project/evals/fixture',
});

let catalogDirectoryIndex = 0;
const testCatalogDirectory = (): string => join(tmpdir(), `agent-bundle-native-playground-catalog-${process.pid}-${catalogDirectoryIndex++}`);

const claudeStream = [
  '{"type":"system","subtype":"init","plugins":[{"name":"review"}],"mcp_servers":[{"name":"project"}]}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"review:review"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__project__status","input":{}}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"token=sk-proj-1234567890abcdef at /private/native/response"}',
  '',
].join('\n');

const nativeSuite = (host: 'claude' | 'codex', sourcePath: string): readonly DiscoveredEvalSuite[] => Object.freeze([Object.freeze({
  sourcePath,
  suite: Object.freeze({
    cases: Object.freeze([Object.freeze({
      assertions: Object.freeze([]),
      digest: `authored-${host}-case`,
      fixture: Object.freeze({ git: false, include: Object.freeze(['**/*']), path: './fixture' }),
      hosts: Object.freeze({ [host]: Object.freeze({ model: `pinned-${host}-model` }) }),
      id: `${host}-case`,
      invocation: Object.freeze({ mode: 'automatic' as const }),
      prompt: 'Original authored prompt.',
      trials: 1,
    })]),
    digest: `suite-${host}-digest`,
    name: `${host}-review`,
  }),
})]);

const dualHostSuite = (sourcePath: string): readonly DiscoveredEvalSuite[] => Object.freeze([Object.freeze({
  sourcePath,
  suite: Object.freeze({
    cases: Object.freeze([Object.freeze({
      assertions: Object.freeze([]),
      digest: 'authored-dual-host-case',
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
    digest: 'dual-host-suite-digest',
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
    const options = {
      discover: async () => nativeSuite('claude', join(suiteDir, 'review.eval.ts')),
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
    const restarted = new NativePlaygroundService(options);
    const catalogB = await restarted.catalog(reference);
    expect(catalogB).toEqual(catalogA);
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
        planFixture: async () => fixturePlan,
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
    const reference = epoch('epoch-native-run', artifact);
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
      'native.raw.references',
      'native.workspace',
    ]);
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
