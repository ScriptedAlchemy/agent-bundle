import { expect, it } from '@rstest/core';

import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';
import type { ApplicationTree } from '../src/application/application-tree-model.ts';
import { buildStatusFor, problemFailureCount, problemsFor, staleCatalogMessage } from '../src/shell/build-status-model.ts';

it('projects one real active epoch, generated targets, and a current-source summary', () => {
  const model = buildStatusFor({
    artifact: {
      activeEpoch: {
        configDigest: 'config',
        createdAt: '2026-08-14T12:00:00.000Z',
        diagnostics: { errors: 0, infos: 0, warnings: 0 },
        id: 'epoch-active',
        manifestPath: 'agent-bundle.manifest.json',
        modelDigest: 'model',
        projectRevision: 'revision-1',
        targetDigests: { claude: 'claude-digest', codex: 'codex-digest' },
      },
      currentSourceRevision: 'revision-1',
      state: 'active',
    },
    build: { state: 'idle' },
    source: { diagnostics: [], revision: 'revision-1', state: 'ready' },
  });

  expect(model.build).toBe('idle');
  expect(model.source).toEqual({ label: 'Normalized successfully', revision: 'revision-1', state: 'ready' });
  expect(model.epoch).toMatchObject({ id: 'epoch-active', state: 'active', summary: 'Current build' });
  expect(model.targets).toEqual([
    { digest: 'claude-digest', name: 'claude', state: 'built' },
    { digest: 'codex-digest', name: 'codex', state: 'built' },
  ]);
  expect(model.diagnostics).toEqual([]);
  expect(model.errorCount).toBe(0);
  expect(model.nextAction).toEqual({ label: 'Rebuild', summary: 'The current build matches your source' });
  expect(Object.isFrozen(model)).toBe(true);
});

const failedStatus: ProjectStatus = {
  artifact: {
    activeEpoch: {
      configDigest: 'config',
      createdAt: '2026-08-14T12:00:00.000Z',
      diagnostics: { errors: 0, infos: 0, warnings: 0 },
      id: 'epoch-last-good',
      manifestPath: 'agent-bundle.manifest.json',
      modelDigest: 'model',
      projectRevision: 'revision-1',
      targetDigests: { portable: 'portable-digest' },
    },
    currentSourceRevision: 'revision-2',
    state: 'stale',
  },
  build: {
    lastAttempt: {
      completedAt: '2026-08-14T12:01:00.000Z',
      diagnostics: [{ code: 'AB4000', message: 'Plugin name is required.', severity: 'error' }],
      id: 'attempt-1',
      outcome: 'failed',
      sourceRevision: 'revision-2',
      startedAt: '2026-08-14T12:00:01.000Z',
    },
    state: 'failed',
  },
  source: {
    diagnostics: [{ code: 'AB4000', message: 'Plugin name is required.', severity: 'error' }],
    revision: 'revision-2',
    state: 'invalid',
  },
};

it('uses only real diagnostics, deduplicated, to explain a stale epoch and its next rebuild action', () => {
  const model = buildStatusFor(failedStatus);

  expect(model.build).toBe('failed');
  expect(model.source).toEqual({ label: 'Normalization needs attention', revision: 'revision-2', state: 'invalid' });
  expect(model.epoch).toMatchObject({ id: 'epoch-last-good', state: 'stale', summary: 'Last good build' });
  expect(model.targets).toEqual([{ digest: 'portable-digest', name: 'portable', state: 'last-good' }]);
  expect(model.diagnostics).toEqual([{ code: 'AB4000', message: 'Plugin name is required.', severity: 'error' }]);
  expect(model.errorCount).toBe(1);
  expect(model.nextAction).toEqual({ label: 'Rebuild', summary: 'Resolve 1 error, then rebuild' });
});

const activeStatus = (epochId: string): ProjectStatus => ({
  artifact: {
    activeEpoch: {
      configDigest: 'config',
      createdAt: '2026-08-14T12:00:00.000Z',
      diagnostics: { errors: 0, infos: 0, warnings: 0 },
      id: epochId,
      manifestPath: 'agent-bundle.manifest.json',
      modelDigest: 'model',
      projectRevision: 'revision-2',
      targetDigests: { portable: 'portable-digest' },
    },
    currentSourceRevision: 'revision-2',
    state: 'active',
  },
  build: { state: 'idle' },
  source: { diagnostics: [], revision: 'revision-2', state: 'ready' },
});

it('omits host adoption when the foreground reports none', () => {
  expect(buildStatusFor(activeStatus('epoch-1')).hostAdoption).toBeUndefined();
});

const gatedStatus: ProjectStatus = {
  ...activeStatus('epoch-2'),
  hostAdoption: {
    adoptedEpochId: 'epoch-1',
    contracts: {
      diagnostics: [{
        code: 'AB7211',
        message: 'Contract matrix reported 2 violation(s) at the dev-epoch proof level.',
        severity: 'error',
        target: 'epoch-2',
      }],
      epochId: 'epoch-2',
      failures: [{ checks: ['coverage', 'sweep'], routeId: 'tool:fixture/version' }],
      state: 'failed',
      summary: 'Development contract matrix reported 2 violation(s).',
    },
    mode: 'gated',
  },
};

it('surfaces a failed contract gate as host-facing diagnostics while the build itself is current', () => {
  const model = buildStatusFor(gatedStatus);

  expect(model.epoch).toMatchObject({ id: 'epoch-2', state: 'active', summary: 'Current build' });
  expect(model.hostAdoption).toEqual({
    adoptedEpochId: 'epoch-1',
    failures: [{ checks: ['coverage', 'sweep'], routeId: 'tool:fixture/version' }],
    gateSummary: 'Development contract matrix reported 2 violation(s).',
    mode: 'gated',
    state: 'failed',
    summary: 'Contract matrix failed for build epoch-2 with 2 violations; hosts keep build epoch-1',
  });
  expect(model.diagnostics).toEqual([expect.objectContaining({ code: 'AB7211', target: 'epoch-2' })]);
  expect(model.nextAction).toEqual({
    label: 'Rebuild',
    summary: 'Resolve 1 error, then rebuild; hosts keep the last passing build',
  });
});

it('describes passing, pending, and direct host adoption without adding diagnostics', () => {
  const passed = buildStatusFor({
    ...activeStatus('epoch-2'),
    hostAdoption: {
      adoptedEpochId: 'epoch-2',
      contracts: { diagnostics: [], epochId: 'epoch-2', failures: [], state: 'passed', summary: 'Development contract matrix passed.' },
      mode: 'gated',
    },
  });
  expect(passed.hostAdoption).toMatchObject({ state: 'passed', summary: 'Contract matrix passed; hosts serve the current build' });
  expect(passed.diagnostics).toEqual([]);

  const pending = buildStatusFor({ ...activeStatus('epoch-2'), hostAdoption: { mode: 'gated' } });
  expect(pending.hostAdoption).toMatchObject({ failures: [], state: 'pending' });

  const direct = buildStatusFor({ ...activeStatus('epoch-2'), hostAdoption: { adoptedEpochId: 'epoch-2', mode: 'direct' } });
  expect(direct.hostAdoption).toEqual({
    adoptedEpochId: 'epoch-2',
    failures: [],
    mode: 'direct',
    state: 'direct',
    summary: 'Hosts serve the published build directly',
  });
  expect(direct.nextAction).toEqual({ label: 'Rebuild', summary: 'The current build matches your source' });
});

const treeWith = (source: string): ApplicationTree => ({
  diagnostics: [],
  groups: [{
    key: 'scripts',
    kind: 'scripts',
    label: 'Scripts',
    leaves: [{
      config: [],
      execution: 'invoke',
      key: '/routes/scripts/sync',
      label: 'sync',
      ref: { kind: 'script', name: 'sync' },
      routeId: 'script:sync',
      source,
    }],
  }],
  leafCount: 1,
  state: 'fresh',
});

it('lists source, build, contract-gate, catalog, host, and runtime problems, errors first, with route deep links', () => {
  const problems = problemsFor({
    catalog: {
      diagnostics: [{ code: 'AB5101', message: 'Route input schema is loose.', severity: 'warning', sourcePath: 'src/scripts/sync.ts' }],
      state: 'stale',
    },
    runtimeDiagnostic: 'AB8200 — provider failed to load',
    status: { ...gatedStatus, source: { ...gatedStatus.source, diagnostics: [{ code: 'AB4001', message: 'Description is missing.', severity: 'info', sourcePath: 'agent-bundle.config.ts' }] } },
    tree: treeWith('src/scripts/sync.ts'),
  });

  expect(problems.map((problem) => [problem.severity, problem.source, problem.code])).toEqual([
    ['error', 'contract-gate', 'AB7211'],
    ['error', 'contract-gate', undefined],
    ['error', 'host-attach', undefined],
    ['error', 'runtime', undefined],
    ['warning', 'route-catalog', 'AB5101'],
    ['warning', 'route-catalog', undefined],
    ['info', 'source', 'AB4001'],
  ]);
  const contractFailure = problems[1]!;
  expect(contractFailure.node).toEqual({ kind: 'tool', name: 'version', server: 'fixture' });
  expect(contractFailure.message).toBe('tool:fixture/version failed 2 contract checks: coverage, sweep');
  expect(contractFailure.location).toBe('tool:fixture/version');
  expect(problems[2]!.message).toBe('Contract matrix failed for build epoch-2 with 2 violations; hosts keep build epoch-1');
  expect(problems[4]!.node).toEqual({ kind: 'script', name: 'sync' });
  expect(problems[5]).toMatchObject({ message: staleCatalogMessage, repairable: true });
  expect(problems[6]).toMatchObject({ location: 'agent-bundle.config.ts', repairable: true });
  expect(problems[6]!.node).toBeUndefined();
  expect(problemFailureCount(problems)).toBe(4);
  expect(Object.isFrozen(problems)).toBe(true);
});

it('reports an unavailable catalog as an error and a healthy project as no problems', () => {
  const unavailable = problemsFor({
    catalog: { diagnostics: [], message: 'Route manifest is not available.', state: 'unavailable' },
    status: activeStatus('epoch-1'),
  });
  expect(unavailable).toEqual([{ message: 'Route manifest is not available.', repairable: true, severity: 'error', source: 'route-catalog' }]);

  expect(problemsFor({ catalog: { diagnostics: [], state: 'current' }, status: activeStatus('epoch-1') })).toEqual([]);
  expect(problemsFor({ status: activeStatus('epoch-1') })).toEqual([]);
});

it('deep-links a build diagnostic through its route-id target', () => {
  const [problem] = problemsFor({
    status: {
      ...activeStatus('epoch-1'),
      build: {
        lastAttempt: {
          completedAt: '2026-08-14T12:01:00.000Z',
          diagnostics: [{ code: 'AB5200', message: 'Tool schema invalid.', severity: 'error', target: 'tool:curator/search_audible' }],
          id: 'attempt-1',
          outcome: 'failed',
          sourceRevision: 'revision-2',
          startedAt: '2026-08-14T12:00:01.000Z',
        },
        state: 'failed',
      },
    },
  });
  expect(problem).toMatchObject({
    code: 'AB5200',
    location: 'tool:curator/search_audible',
    node: { kind: 'tool', name: 'search_audible', server: 'curator' },
    repairable: true,
    source: 'build',
  });
});
