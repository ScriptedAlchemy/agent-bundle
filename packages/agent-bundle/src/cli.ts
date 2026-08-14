#!/usr/bin/env node
import { Command, CommanderError } from 'commander';

declare const __AGENT_BUNDLE_VERSION__: string;

export const runCli = async (args: string[]): Promise<number> => {
  const program = new Command();

  program.name('agent-bundle').version(__AGENT_BUNDLE_VERSION__).exitOverride();

  try {
    await program.parseAsync(args, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    throw error;
  }
};

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
