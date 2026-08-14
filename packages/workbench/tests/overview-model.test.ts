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
  expect(overview.epoch).toMatchObject({ id: 'epoch-active', state: 'active', summary: 'Current artifact epoch' });
  expect(overview.targets).toEqual([
    { digest: 'claude-digest', name: 'claude', state: 'built' },
    { digest: 'codex-digest', name: 'codex', state: 'built' },
  ]);
  expect(overview.diagnostics).toEqual([]);
  expect(overview.nextAction).toEqual({ label: 'Rebuild', summary: 'Artifact epoch is current' });
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
  expect(overview.epoch).toMatchObject({ id: 'epoch-last-good', state: 'stale', summary: 'Last good artifact epoch' });
  expect(overview.targets).toEqual([{ digest: 'portable-digest', name: 'portable', state: 'last-good' }]);
  expect(overview.diagnostics).toEqual([{ code: 'AB4000', message: 'Plugin name is required.', severity: 'error' }]);
  expect(overview.nextAction).toEqual({ label: 'Rebuild', summary: 'Resolve 1 error, then rebuild' });
});
