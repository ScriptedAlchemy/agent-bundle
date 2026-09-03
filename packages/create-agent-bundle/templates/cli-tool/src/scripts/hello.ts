import { greet } from '../index.js';

/**
 * A conventional plain script: `agent-bundle build` compiles it to
 * `scripts/hello.mjs` inside every host artifact and, because the module
 * exports `main`, wraps it in the framework process envelope — argv in, a
 * numeric return adopted as the exit code, ordinary stdout/stderr semantics.
 */
export const main = async (argv: readonly string[]): Promise<number> => {
  const [name, ...rest] = argv;
  if (name === undefined || rest.length > 0) {
    process.stderr.write('Usage: hello <name>\n');
    return 2;
  }
  process.stdout.write(`${greet(name).message}\n`);
  return 0;
};
