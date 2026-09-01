import {
  audibleOperations,
  defaultAudibleOperations,
  type AudibleOperations,
} from './operations/audible.js';
import {
  defaultDiscoveryOperations,
  discoveryOperations,
  type DiscoveryOperations,
} from './operations/discovery.js';
import {
  defaultEvidenceOperations,
  evidenceOperations,
  type EvidenceOperations,
} from './operations/evidence.js';
import {
  defaultMediaMutationOperations,
  mediaMutationOperations,
  type MediaMutationOperations,
} from './operations/media-mutation.js';
import {
  defaultOutputOperations,
  outputOperations,
  type OutputOperations,
} from './operations/output.js';
import { runCliCommands } from './cli-command.js';

export type CuratorOperations = AudibleOperations
  & DiscoveryOperations
  & EvidenceOperations
  & MediaMutationOperations
  & OutputOperations;

export interface CliOptions {
  readonly operations?: CuratorOperations;
  readonly signal?: AbortSignal;
  readonly write?: (value: string) => void;
}

export const runCli = (
  argv: readonly string[],
  options: CliOptions = {},
): Promise<0 | 1 | 2> => {
  const operations = {
    ...defaultAudibleOperations,
    ...defaultDiscoveryOperations,
    ...defaultEvidenceOperations,
    ...defaultMediaMutationOperations,
    ...defaultOutputOperations,
    ...(options.operations ?? {}),
  };
  const commands = Object.values({
    ...evidenceOperations(operations),
    ...mediaMutationOperations(operations),
    ...audibleOperations(operations),
    ...discoveryOperations(operations),
    ...outputOperations(operations),
  });
  return runCliCommands(commands, argv, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.write === undefined ? {} : { write: options.write }),
  });
};

export const main = async (argv: readonly string[]): Promise<void> => {
  try {
    process.exitCode = await runCli(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Audiobook curator failed.'}\n`);
    process.exitCode = 1;
  }
};
