import { greet } from './index.js';

const usage = 'Usage: my-agent-plugin <name>\n';

/** Injectable writer so tests can capture output without a child process. */
export const runCli = (
  argv: readonly string[],
  write: (line: string) => void = (line) => { process.stdout.write(line); },
): 0 | 2 => {
  const [name, ...rest] = argv;
  if (name === '--help' || name === '-h') {
    write(usage);
    return 0;
  }
  if (name === undefined || rest.length > 0) {
    write(usage);
    return 2;
  }
  write(`${greet(name).message}\n`);
  return 0;
};

/**
 * `agent-bundle build` detects the `main` export and generates the process
 * envelope around it. The same module is the package bin (`src/cli.ts`
 * convention → `dist/bin/my-agent-plugin.js`) and, because the config also
 * declares it as a script, an executable inside every host artifact.
 */
export const main = async (argv: readonly string[]): Promise<number> => runCli(argv);
