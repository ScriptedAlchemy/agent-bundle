import { readFile } from 'node:fs/promises';

import { isHealthyCompilerFixture } from '../compiler-status-contract.ts';

const fixturePath = new URL('../assets/evals/fixtures/status/result.json', import.meta.url);

try {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
  if (!isHealthyCompilerFixture(fixture)) {
    throw new Error('compiler fixture must contain the exact healthy compiler status');
  }
  process.stdout.write('Compiler fixture is healthy.\n');
} catch (error) {
  process.stderr.write(`Unable to verify service fixture: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
