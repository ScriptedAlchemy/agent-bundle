import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface StatusFixture {
  readonly checks?: readonly { readonly status?: string }[];
  readonly service?: string;
  readonly status?: string;
}

const fixturePath = join(process.cwd(), 'evals', 'fixtures', 'status', 'result.json');

try {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as StatusFixture;
  const checksPass = fixture.checks?.every((check) => check.status === 'passing') === true;
  if (fixture.service !== 'compiler' || fixture.status !== 'healthy' || !checksPass) {
    throw new Error('compiler fixture must contain only passing checks and a healthy status');
  }
  process.stdout.write('Compiler fixture is healthy.\n');
} catch (error) {
  process.stderr.write(`Unable to verify service fixture: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
