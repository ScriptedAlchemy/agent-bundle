import { createTestFileRuntimeKernel } from '../../src/runtime/state-file-test-support.js';

const stateFile = process.argv[2];
if (stateFile === undefined) throw new Error('state file argument is required');

const kernel = createTestFileRuntimeKernel({
  stateFile,
  adapter: {
    beforeAppend: () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
    criticalSectionMs: 10,
    ownerSettlementMs: 2_000,
  },
});

try {
  await kernel.recordEdit({
    host: 'codex',
    idempotencyKey: 'test:state:settlement-exit',
    path: 'settlement-exit.ts',
    sessionId: 'session-1',
    toolName: 'apply_patch',
  });
  throw new Error('timed-out state mutation unexpectedly succeeded');
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes('exceeded 10 ms')) throw error;
  process.stdout.write('phase-settled\n');
}
