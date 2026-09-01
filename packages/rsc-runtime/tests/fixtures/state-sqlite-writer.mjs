/**
 * Cross-process writer for the sqlite state driver proofs. Runs against the
 * BUILT package (dist/), so two independent Node processes exercise the real
 * published module graph over one workspace-durable database file.
 *
 * argv: <databaseFile> <writerId> <mode:count|loop> [count]
 *
 * The definition mirrors `crossProcessDefinition` in
 * ../state-sqlite-cross-process.test.ts; the two must stay identical.
 */
import { z } from 'zod';

import { defineState } from '../../dist/state.js';
import { createSqliteStateDriver } from '../../dist/state/sqlite.js';

const [, , file, writerId, mode, countText] = process.argv;
if (typeof file !== 'string' || typeof writerId !== 'string' || (mode !== 'count' && mode !== 'loop')) {
  process.stderr.write('usage: state-sqlite-writer.mjs <file> <writerId> <count|loop> [count]\n');
  process.exit(2);
}

const definition = defineState({
  events: {
    taskAdded: z.object({ id: z.string().min(1), title: z.string().min(1) }).strict(),
  },
  id: 'state-cross-process/tasks',
  initial: { tasks: [] },
  lifetime: 'workspace-durable',
  reduce: (state, event) => ({ tasks: [...state.tasks, event.payload] }),
  schema: z.object({ tasks: z.array(z.object({ id: z.string(), title: z.string() }).strict()) }).strict(),
});

const driver = createSqliteStateDriver({ file });
const store = await driver.open(definition);

if (mode === 'count') {
  const count = Number(countText);
  for (let index = 0; index < count; index += 1) {
    await store.dispatch(
      'taskAdded',
      { id: `${writerId}-${String(index)}`, title: `Task ${writerId} ${String(index)}` },
      { idempotencyKey: `${writerId}:${String(index)}` },
    );
  }
  await store.close();
  process.stdout.write(JSON.stringify({ committed: count, writerId }));
  process.exit(0);
}

// mode === 'loop': commit forever; the parent SIGKILLs this process mid-write
// to prove a killed writer can never leave a successful-but-corrupt state.
process.stdout.write('{"ready":true}\n');
for (let index = 0; ; index += 1) {
  await store.dispatch(
    'taskAdded',
    { id: `${writerId}-${String(index)}`, title: `Task ${writerId} ${String(index)}` },
    { idempotencyKey: `${writerId}:${String(index)}` },
  );
}
