import { expect, it } from '@rstest/core';

import { DevLogService } from '../src/dev/dev-log-service.ts';
import { ProjectEventHub } from '../src/dev/events.ts';
import { startForegroundServer, type ForegroundCoordinator } from '../src/dev/foreground-server.ts';
import type { Invalidation, ProjectStatus } from '../src/dev/types.ts';

const status = (): ProjectStatus => ({
  artifact: { state: 'missing' },
  build: { state: 'idle' },
  source: { diagnostics: [], state: 'unknown' },
});

const coordinator: ForegroundCoordinator = {
  close: async () => undefined,
  rebuild: async (_invalidation: Invalidation) => undefined,
  start: async () => undefined,
  status,
};

it('mounts authenticated Dev Log replay on the foreground server', async () => {
  const logs = new DevLogService({ projectRoot: '/work/project' });
  logs.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'Loaded project.' });
  const server = await startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    logs,
    port: 0,
    sessionToken: 'test-session-token',
  });
  try {
    const response = await fetch(`${server.url}/api/logs/replay`, {
      headers: { origin: server.url, 'x-agent-bundle-session': server.sessionToken },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      replay: { records: [{ kind: 'project.load', producer: 'project' }] },
    });
  } finally {
    await server.close();
  }
});
