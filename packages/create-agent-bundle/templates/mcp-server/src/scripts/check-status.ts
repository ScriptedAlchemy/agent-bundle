import { reportStatus } from '../status.js';

/**
 * `agent-bundle build` detects the `main` export and generates the process
 * envelope (argv, awaiting, numeric-return exit-code adoption) around it.
 */
export const main = async (argv: readonly string[]): Promise<number> => {
  const service = argv[0] ?? 'docs';
  const report = reportStatus(service);
  if (report.status !== 'healthy') {
    process.stderr.write(`${report.summary}\n`);
    return 1;
  }
  process.stdout.write(`${report.summary}\n`);
  return 0;
};
