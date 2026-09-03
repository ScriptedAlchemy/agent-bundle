import { expect, it } from '@rstest/core';

import { overviewFor } from '../src/overview-model.ts';

it('projects one real active epoch, generated targets, and a current-source normalization summary', () => {
  const overview = overviewFor({
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

  expect(overview.normalization).toEqual({ label: 'Normalized successfully', revision: 'revision-1', state: 'ready' });
  expect(overview.epoch).toMatchObject({ id: 'epoch-active', state: 'active', summary: 'Current build' });
  expect(overview.targets).toEqual([
    { digest: 'claude-digest', name: 'claude', state: 'built' },
    { digest: 'codex-digest', name: 'codex', state: 'built' },
  ]);
  expect(overview.diagnostics).toEqual([]);
  expect(overview.nextAction).toEqual({ label: 'Rebuild', summary: 'The current build matches your source' });
});

it('uses only real diagnostics to explain a stale epoch and its next rebuild action', () => {
  const overview = overviewFor({
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
  });

  expect(overview.normalization).toEqual({ label: 'Normalization needs attention', revision: 'revision-2', state: 'invalid' });
  expect(overview.epoch).toMatchObject({ id: 'epoch-last-good', state: 'stale', summary: 'Last good build' });
  expect(overview.targets).toEqual([{ digest: 'portable-digest', name: 'portable', state: 'last-good' }]);
  expect(overview.diagnostics).toEqual([{ code: 'AB4000', message: 'Plugin name is required.', severity: 'error' }]);
  expect(overview.nextAction).toEqual({ label: 'Rebuild', summary: 'Resolve 1 error, then rebuild' });
});

const activeStatus = (epochId: string) => ({
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
    state: 'active' as const,
  },
  build: { state: 'idle' as const },
  source: { diagnostics: [], revision: 'revision-2', state: 'ready' as const },
});

it('omits host adoption when the foreground reports none', () => {
  expect(overviewFor(activeStatus('epoch-1')).hostAdoption).toBeUndefined();
});

it('surfaces a failed contract gate as host-facing diagnostics while the build itself is current', () => {
  const overview = overviewFor({
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
  });

  expect(overview.epoch).toMatchObject({ id: 'epoch-2', state: 'active', summary: 'Current build' });
  expect(overview.hostAdoption).toEqual({
    adoptedEpochId: 'epoch-1',
    failures: [{ checks: ['coverage', 'sweep'], routeId: 'tool:fixture/version' }],
    gateSummary: 'Development contract matrix reported 2 violation(s).',
    mode: 'gated',
    state: 'failed',
    summary: 'Contract matrix failed for build epoch-2 with 2 violations; hosts keep build epoch-1',
  });
  expect(overview.diagnostics).toEqual([expect.objectContaining({ code: 'AB7211', target: 'epoch-2' })]);
  expect(overview.nextAction).toEqual({
    label: 'Rebuild',
    summary: 'Resolve 1 error, then rebuild; hosts keep the last passing build',
  });
});

it('describes passing, pending, and direct host adoption without adding diagnostics', () => {
  const passed = overviewFor({
    ...activeStatus('epoch-2'),
    hostAdoption: {
      adoptedEpochId: 'epoch-2',
      contracts: { diagnostics: [], epochId: 'epoch-2', failures: [], state: 'passed', summary: 'Development contract matrix passed.' },
      mode: 'gated',
    },
  });
  expect(passed.hostAdoption).toMatchObject({ state: 'passed', summary: 'Contract matrix passed; hosts serve the current build' });
  expect(passed.diagnostics).toEqual([]);

  const pending = overviewFor({ ...activeStatus('epoch-2'), hostAdoption: { mode: 'gated' } });
  expect(pending.hostAdoption).toMatchObject({ failures: [], state: 'pending' });

  const direct = overviewFor({ ...activeStatus('epoch-2'), hostAdoption: { adoptedEpochId: 'epoch-2', mode: 'direct' } });
  expect(direct.hostAdoption).toEqual({
    adoptedEpochId: 'epoch-2',
    failures: [],
    mode: 'direct',
    state: 'direct',
    summary: 'Hosts serve the published build directly',
  });
  expect(direct.nextAction).toEqual({ label: 'Rebuild', summary: 'The current build matches your source' });
});

it('projects a detached immutable changed-file list and defaults absent browser activity to empty', () => {
  const status = {
    artifact: { state: 'missing' as const },
    build: { state: 'idle' as const },
    source: { diagnostics: [], state: 'unknown' as const },
  };
  const changedFiles = ['src/alpha.ts', 'src/beta.ts'];
  const overview = overviewFor(status, changedFiles);
  const withoutActivity = overviewFor(status);

  expect(overview.changedFiles).toEqual(['src/alpha.ts', 'src/beta.ts']);
  expect(overview.changedFiles).not.toBe(changedFiles);
  expect(Object.isFrozen(overview.changedFiles)).toBe(true);
  expect(() => (overview.changedFiles as string[]).push('src/gamma.ts')).toThrow(TypeError);
  expect(withoutActivity.changedFiles).toEqual([]);
  expect(Object.isFrozen(withoutActivity.changedFiles)).toBe(true);
});
