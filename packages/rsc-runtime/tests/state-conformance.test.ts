import { describe, it } from '@rstest/core';

import {
  createMemoryStateDriver,
  stateDriverConformanceCases,
  type StateConformanceContext,
} from '../src/state/index.js';

/**
 * Runs the shared driver conformance suite against the in-memory driver
 * (test-only, never durable). The workspace-durable `node:sqlite` driver
 * runs the same cases in state-sqlite tests; any external driver must pass
 * this exact suite to count as a completed integration (#98).
 */
const memoryContext = (): StateConformanceContext => {
  // One driver per case: `open` and `reopen` both resolve the shared
  // process-lifetime store, which is exactly what "another instance" means
  // for volatile in-process storage.
  const driver = createMemoryStateDriver({ lifetime: 'process' });
  return {
    durable: false,
    lifetime: 'process',
    open: (definition) => driver.open(definition),
    reopen: (definition) => driver.open(definition),
  };
};

describe('memory driver conformance', () => {
  for (const conformanceCase of stateDriverConformanceCases) {
    if (conformanceCase.durableOnly === true) {
      it.skip(`${conformanceCase.name} (durable-only)`, () => undefined);
      continue;
    }
    it(conformanceCase.name, () => conformanceCase.run(memoryContext()));
  }
});
