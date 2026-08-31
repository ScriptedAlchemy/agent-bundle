import { readFile } from 'node:fs/promises';

import { isHealthyCompilerFixture } from '../compiler-status-contract.ts';

const fixturePath = new URL('../assets/evals/fixtures/status/result.json', import.meta.url);

/**
 * `agent-bundle build` detects the `main` export and generates the process
 * envelope (argv, awaiting, numeric-return exit-code adoption) around it.
 */
export const main = async (): Promise<number> => {
  try {
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
    if (!isHealthyCompilerFixture(fixture)) {
      throw new Error('compiler fixture must contain the exact healthy compiler status');
    }
    process.stdout.write('Compiler fixture is healthy.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`Unable to verify service fixture: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};
