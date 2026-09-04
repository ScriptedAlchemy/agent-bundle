import type { ExecutableMainContext } from 'agent-bundle';

/**
 * A plain script with the `main` process-envelope contract: the generated
 * `scripts/checksum.mjs` awaits `main(process.argv.slice(2), { terminal })`
 * and adopts a numeric return as the exit code. No renderer, no request
 * context; the terminal capability (#511) arrives through the envelope.
 */

/** Module state: a fresh process starts at zero, a cached module would not. */
let calls = 0;

export const main = async (argv: readonly string[], context: ExecutableMainContext): Promise<number | undefined> => {
  calls += 1;
  if (argv.includes('--explode')) {
    throw new Error('checksum exploded');
  }
  if (argv.includes('--terminal')) {
    // What the envelope probed for this process, as one canonical JSON line.
    process.stdout.write(`${JSON.stringify(context.terminal)}\n`);
    return 0;
  }
  if (argv.includes('--calls')) {
    process.stdout.write(`checksum call ${String(calls)} in ${process.argv[1]!}\n`);
    return 0;
  }
  if (argv.includes('--exit-then-hang')) {
    // A real process is gone at the exit; the never-settling await after it
    // (and the write) can only happen if the exit was merely simulated.
    try {
      process.exit(6);
    } catch {
      process.stdout.write('checksum survived process.exit\n');
    }
    await new Promise(() => undefined);
    return 0;
  }
  if (argv.includes('--exec-argv')) {
    // `node scripts/checksum.mjs` carries no Node flags; neither may this run.
    process.stdout.write(`checksum execArgv ${JSON.stringify(process.execArgv)}\n`);
    return 0;
  }
  if (argv.includes('--stdin')) {
    let input = '';
    for await (const chunk of process.stdin.setEncoding('utf8')) input += chunk as string;
    process.stdout.write(`checksum read ${String(input.length)} byte(s): ${input.trim()}\n`);
    return 0;
  }
  if (argv.includes('--hang')) {
    // A script that never finishes on its own; only the harness ending the
    // process ends this run.
    setInterval(() => undefined, 1000);
    await new Promise(() => undefined);
    return 0;
  }
  if (argv.includes('--ignore-sigterm')) {
    // A script that traps termination and carries on; only a harness that
    // reaps its process can end this run.
    process.on('SIGTERM', () => { process.stdout.write('checksum ignored SIGTERM\n'); });
    process.stdout.write('checksum trapping SIGTERM\n');
    // Keep the event loop alive; a pending promise alone would let Node exit.
    setInterval(() => undefined, 1000);
    await new Promise(() => undefined);
    return 0;
  }
  if (argv.includes('--chdir')) {
    // Process-level APIs a worker thread refuses; a process of its own has
    // them, and changing directory there leaves the harness's alone.
    process.chdir('..');
    process.stdout.write(`checksum cwd ${process.cwd()}\n`);
    return 0;
  }
  if (argv.includes('--exit-code-property')) {
    process.stdout.write('checksum set process.exitCode\n');
    process.exitCode = 4;
    return undefined;
  }
  if (argv.includes('--process-exit')) {
    process.stdout.write('checksum called process.exit\n');
    process.exit(5);
  }
  if (argv.includes('--swallow-exit')) {
    // A real process is gone after this call; nothing below can happen there.
    try {
      process.exit(3);
    } catch {
      process.stdout.write('checksum survived process.exit\n');
    }
    return 0;
  }
  const returned = argv.find((argument) => argument.startsWith('--return='));
  if (returned !== undefined) {
    return Number(returned.slice('--return='.length));
  }
  if (argv.includes('--delay')) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const total = argv.filter((argument) => !argument.startsWith('--')).reduce((sum, argument) => sum + argument.length, 0);
  process.stdout.write(`Fixture checksum: ${String(total)}\n`);
  if (total === 0) {
    process.stderr.write('No arguments to checksum.\n');
    return 2;
  }
  return 0;
};
