import {
  agent,
  available,
  runAgentRequest,
} from '../../dist/index.js';
import {
  agentNoticeStateDefinition,
  createAgentNoticeLedger,
} from '../../dist/notices.js';
import { createSqliteStateDriver } from '../../dist/state/sqlite.js';

const [file, mode] = process.argv.slice(2);
if (typeof file !== 'string' || (mode !== 'publish' && mode !== 'deliver')) {
  throw new Error('usage: notices-sqlite-process.mjs <file> <publish|deliver>');
}

const driver = createSqliteStateDriver({ file });
const store = await driver.open(agentNoticeStateDefinition());
const ledger = createAgentNoticeLedger(store, {
  authorize: () => ({ state: 'authorized' }),
});

try {
  if (mode === 'publish') {
    const result = await runAgentRequest({
      actor: available({ id: 'publisher' }, 'native'),
      host: available({ name: 'claude' }, 'native'),
      invocation: {
        id: 'publish-process',
        kind: 'tool',
        startedAt: '2026-09-01T19:00:00.000Z',
      },
      noticeLedger: ledger,
      session: available({ sessionId: 'session-1' }, 'native'),
      workspace: available({ root: '/workspace' }, 'native'),
    }, async () => (await agent()).notices.publish({
      content: {
        root: { kind: 'text', text: 'cross-process notice' },
        status: 'success',
        version: 1,
      },
      dedupeKey: 'cross-process',
      priority: 'high',
      recipient: {
        actor: { id: 'recipient' },
        workspace: { root: '/workspace' },
      },
    }, { idempotencyKey: 'publish:cross-process' }));
    process.stdout.write(JSON.stringify({
      id: result.notice.id,
      state: result.notice.state,
    }));
  } else {
    const result = await runAgentRequest({
      actor: available({ id: 'recipient' }, 'native'),
      host: available({ name: 'claude' }, 'native'),
      invocation: {
        id: 'delivery-process',
        kind: 'event',
        startedAt: '2026-09-01T19:05:00.000Z',
      },
      noticeLedger: ledger,
      session: available({ sessionId: 'session-1' }, 'native'),
      workspace: available({ root: '/workspace' }, 'native'),
    }, async () => (await agent()).notices.read());
    process.stdout.write(JSON.stringify(result));
  }
} finally {
  await driver.close();
}
