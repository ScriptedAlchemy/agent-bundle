import { runRscCli } from '@agent-bundle/rsc-runtime/plugin';

import {
  createAudiobookCuratorApplication,
  type AudiobookCuratorOperations,
} from './application.js';

export type CuratorOperations = AudiobookCuratorOperations;

export interface CliOptions {
  readonly operations?: CuratorOperations;
  readonly signal?: AbortSignal;
  readonly write?: (value: string) => void;
}

export const runCli = (
  argv: readonly string[],
  options: CliOptions = {},
): Promise<0 | 1 | 2> => runRscCli(
  createAudiobookCuratorApplication({ ...(options.operations === undefined ? {} : { operations: options.operations }) }),
  argv,
  {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.write === undefined ? {} : { write: options.write }),
  },
);

export const main = async (argv: readonly string[]): Promise<void> => {
  try {
    process.exitCode = await runCli(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Audiobook curator failed.'}\n`);
    process.exitCode = 1;
  }
};
