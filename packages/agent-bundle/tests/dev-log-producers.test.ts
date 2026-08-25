import { expect, it } from '@rstest/core';

import { attachProjectEventLogs, createProjectDevLogger } from '../src/dev/logs/dev-log-producers.ts';
import { DevLogService } from '../src/dev/logs/dev-log-service.ts';
import { ProjectEventHub } from '../src/dev/events.ts';

it('records project service events and derives build, artifact, and diagnostic records from the project hub', () => {
  const logs = new DevLogService({ projectRoot: '/work/project' });
  const events = new ProjectEventHub();
  const detach = attachProjectEventLogs(logs, events);
  const logger = createProjectDevLogger(logs);

  logger.log?.('project.load', { root: '/work/project', target: 'codex' });
  events.publish({
    payload: {
      completedAt: '2026-08-18T12:01:00.000Z',
      diagnostics: [{ code: 'BUILD_FAILED', message: 'Broken /work/project/src/index.ts', severity: 'error' }],
      id: 'build-1',
      outcome: 'failed',
      sourceRevision: 'source-1',
      startedAt: '2026-08-18T12:00:00.000Z',
    },
    type: 'build.failed',
  });
  events.publish({
    epochId: 'epoch-1',
    payload: {
      activeEpoch: {
        configDigest: 'config-1',
        createdAt: '2026-08-18T12:02:00.000Z',
        diagnostics: { errors: 0, infos: 0, warnings: 0 },
        id: 'epoch-1',
        manifestPath: '/work/project/.agent-bundle/epochs/epoch-1/manifest.json',
        modelDigest: 'model-1',
        projectRevision: 'source-1',
        targetDigests: { codex: 'target-1' },
      },
      currentSourceRevision: 'source-1',
      state: 'active',
    },
    type: 'artifact.available',
  });
  detach();

  const records = logs.replay().records;
  expect(records.map((record) => [record.producer, record.kind, record.level])).toEqual([
    ['project', 'project.load', 'info'],
    ['build', 'build.failed', 'error'],
    ['diagnostic', 'build.failed.diagnostic', 'error'],
    ['build', 'artifact.available', 'info'],
  ]);
  expect(records[1]?.details).toMatchObject({ diagnostics: [{ message: 'Broken <project>/src/index.ts' }] });
  expect(records[2]?.context).toEqual({ buildId: 'build-1', diagnosticCode: 'BUILD_FAILED' });
  expect(records[3]?.context).toEqual({ epochId: 'epoch-1' });
});
