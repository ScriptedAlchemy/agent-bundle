import { auditAudiobook, inspectSources, prepareAudiobook, type AuditInput, type PrepareInput } from './curator-core.js';

export interface CuratorOperations {
  readonly audit: (input: AuditInput) => Promise<unknown>;
  readonly inspect: (input: { readonly maxFiles?: number; readonly root: string }) => Promise<unknown>;
  readonly prepare: (input: PrepareInput) => Promise<unknown>;
}

export interface CliOptions {
  readonly operations?: CuratorOperations;
  readonly write?: (value: string) => void;
}

const defaultOperations: CuratorOperations = {
  audit: (input) => auditAudiobook(input),
  inspect: (input) => inspectSources(input),
  prepare: (input) => prepareAudiobook(input),
};

const requiredPositional = (args: readonly string[], command: string): string => {
  const positional = args.filter((arg) => !arg.startsWith('--'));
  if (positional.length !== 1) throw new Error(`${command} requires exactly one path.`);
  return positional[0]!;
};

const optionValue = (args: readonly string[], option: string): string | undefined => {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
};

const assertOptions = (args: readonly string[], flags: ReadonlySet<string>, valued: ReadonlySet<string>): void => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) continue;
    if (flags.has(arg)) continue;
    if (valued.has(arg)) {
      index += 1;
      if (args[index] === undefined || args[index]!.startsWith('--')) throw new Error(`${arg} requires a value.`);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
};

export const runCli = async (argv: readonly string[], options: CliOptions = {}): Promise<0> => {
  const [command, ...args] = argv;
  const operations = options.operations ?? defaultOperations;
  let receipt: unknown;
  switch (command) {
    case 'inspect': {
      assertOptions(args, new Set(), new Set(['--max-files']));
      const maxFilesText = optionValue(args, '--max-files');
      const root = requiredPositional(args.filter((value, index) => args[index - 1] !== '--max-files'), 'inspect');
      const maxFiles = maxFilesText === undefined ? undefined : Number(maxFilesText);
      receipt = await operations.inspect({ ...(maxFiles === undefined ? {} : { maxFiles }), root });
      break;
    }
    case 'prepare': {
      assertOptions(args, new Set(['--apply']), new Set(['--name', '--output']));
      const source = requiredPositional(
        args.filter((value, index) => !['--name', '--output'].includes(args[index - 1] ?? '')),
        'prepare',
      );
      const outputRoot = optionValue(args, '--output');
      if (outputRoot === undefined) throw new Error('prepare requires --output.');
      const outputName = optionValue(args, '--name');
      receipt = await operations.prepare({
        ...(args.includes('--apply') ? { apply: true } : {}),
        ...(outputName === undefined ? {} : { outputName }),
        outputRoot,
        source,
      });
      break;
    }
    case 'audit': {
      assertOptions(args, new Set(['--full-decode']), new Set());
      const source = requiredPositional(args, 'audit');
      receipt = await operations.audit({ ...(args.includes('--full-decode') ? { fullDecode: true } : {}), source });
      break;
    }
    default:
      throw new Error(`Unknown command: ${command ?? ''}`);
  }
  (options.write ?? ((value) => process.stdout.write(value)))(`${JSON.stringify(receipt)}\n`);
  return 0;
};

export const main = async (argv: readonly string[]): Promise<void> => {
  try {
    process.exitCode = await runCli(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Audiobook curator failed.'}\n`);
    process.exitCode = 1;
  }
};
