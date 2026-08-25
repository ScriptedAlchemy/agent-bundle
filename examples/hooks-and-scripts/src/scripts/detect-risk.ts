import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface ReleaseRisk {
  readonly id?: unknown;
  readonly severity?: unknown;
  readonly status?: unknown;
  readonly summary?: unknown;
}

interface RiskRegister {
  readonly risks?: readonly ReleaseRisk[];
}

const registerPath = join(process.cwd(), 'release', 'risk-register.json');

try {
  const register = JSON.parse(await readFile(registerPath, 'utf8')) as RiskRegister;
  if (!Array.isArray(register.risks)) throw new Error('risk register must contain a risks array');

  const blockers = register.risks.filter((risk) => risk.status === 'open' && risk.severity === 'high');
  if (blockers.length === 0) {
    process.stdout.write('No open high-severity release risks found.\n');
  } else {
    for (const risk of blockers) {
      process.stderr.write(`${typeof risk.id === 'string' ? risk.id : 'UNIDENTIFIED'}: ${typeof risk.summary === 'string' ? risk.summary : 'Open high-severity release risk'}\n`);
    }
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`Unable to detect release risks: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
