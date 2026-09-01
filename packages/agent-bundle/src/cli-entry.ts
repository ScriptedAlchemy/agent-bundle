import type { CompiledCliCommand, CompiledCliOption } from './routes/types.ts';

/**
 * The framework-owned routed-CLI shell (#102 stage 2): command-tree
 * resolution, argv parsing against the statically compiled option surface,
 * generated help, deterministic exit codes, and signal handling.
 * `agent-bundle build` embeds the compiled command graph into every
 * generated CLI executable and aliases this module in, exactly like the
 * stdio MCP entry lifecycle.
 *
 * Exit codes: 0 success (or the validated result's `exitCode` under the
 * `result` policy), 1 execution or result-contract failure, 2 usage or input
 * validation failure, 130/143 after SIGINT/SIGTERM. Machine output (one
 * canonical JSON line) goes to stdout; help goes to stdout; diagnostics go
 * to stderr. Every value is injectable so the shell is testable with
 * plain-object harnesses.
 */

/** Raised for argv-shape failures: unknown commands or options, missing or malformed values. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/**
 * Raised by generated executables when the route module's own `inputSchema`
 * rejects parsed input — invalid input is a usage failure (exit 2), never an
 * execution failure.
 */
export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliInputError';
  }
}

export interface GeneratedCliExecuteContext {
  /** True when `--json` was passed; plain commands already emit canonical JSON. */
  readonly json: boolean;
  readonly signal: AbortSignal;
}

export interface RunGeneratedCliOptions {
  readonly argv: readonly string[];
  readonly commands: readonly CompiledCliCommand[];
  readonly description?: string;
  /** Runs one resolved command with parsed input; returns the validated result. */
  readonly execute: (
    command: CompiledCliCommand,
    input: Readonly<Record<string, unknown>>,
    context: GeneratedCliExecuteContext,
  ) => Promise<unknown>;
  readonly name: string;
  readonly signal?: AbortSignal;
  readonly version: string;
  readonly writeErr?: (text: string) => void;
  readonly writeOut?: (text: string) => void;
}

interface CommandTreeNode {
  readonly children: Map<string, CommandTreeNode>;
  command?: CompiledCliCommand;
  readonly path: readonly string[];
}

const buildCommandTree = (commands: readonly CompiledCliCommand[]): CommandTreeNode => {
  const root: CommandTreeNode = { children: new Map(), path: [] };
  for (const command of commands) {
    let node = root;
    for (const segment of command.path) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { children: new Map(), path: [...node.path, segment] };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.command = command;
    const parent = command.path.length === 1
      ? root
      : command.path.slice(0, -1).reduce((cursor, segment) => cursor.children.get(segment)!, root);
    for (const alias of command.aliases) {
      const target = parent.children.get(command.path[command.path.length - 1]!)!;
      parent.children.set(alias, target);
    }
  }
  return root;
};

const optionPlaceholder = (option: CompiledCliOption): string => {
  if (option.kind === 'boolean') return '';
  if (option.choices !== undefined) return ` <${option.choices.join('|')}>`;
  return ` <${option.kind}>`;
};

const positionalPlaceholder = (option: CompiledCliOption): string => {
  const name = option.repeated ? `${option.option}...` : option.option;
  return option.required ? `<${name}>` : `[${name}]`;
};

const helpColumns = (rows: readonly (readonly [string, string])[]): string => {
  const width = rows.reduce((max, [left]) => Math.max(max, left.length), 0);
  return rows.map(([left, right]) => `  ${left.padEnd(width)}${right === '' ? '' : `  ${right}`}`).join('\n');
};

const sortedPositionals = (command: CompiledCliCommand): readonly CompiledCliOption[] =>
  command.options
    .filter((option) => option.positional !== undefined)
    .sort((left, right) => left.positional! - right.positional!);

const namedOptions = (command: CompiledCliCommand): readonly CompiledCliOption[] =>
  command.options.filter((option) => option.positional === undefined);

const globalOptionRows: readonly (readonly [string, string])[] = [
  ['-h, --help', 'Show help.'],
  ['    --json', 'Emit the canonical JSON result.'],
  ['    --version', 'Print the version.'],
];

const commandUsage = (name: string, command: CompiledCliCommand): string => {
  const positionals = sortedPositionals(command).map(positionalPlaceholder);
  return `Usage: ${name} ${command.path.join(' ')} [options]${positionals.length === 0 ? '' : ` ${positionals.join(' ')}`}`;
};

const commandHelp = (name: string, command: CompiledCliCommand): string => {
  const lines: string[] = [commandUsage(name, command)];
  if (command.description !== undefined) lines.push('', command.description);
  if (command.aliases.length > 0) lines.push('', `Aliases: ${command.aliases.join(', ')}`);
  const positionals = sortedPositionals(command);
  if (positionals.length > 0) {
    lines.push('', 'Arguments:', helpColumns(positionals.map((option) => [
      positionalPlaceholder(option),
      [
        option.description ?? '',
        ...(option.choices === undefined ? [] : [`(${option.choices.join('|')})`]),
        ...(option.defaultValue === undefined ? [] : [`[default: ${JSON.stringify(option.defaultValue)}]`]),
      ].filter((part) => part !== '').join(' '),
    ])));
  }
  const options = namedOptions(command);
  const optionRows: (readonly [string, string])[] = options.map((option) => [
    `    --${option.option}${optionPlaceholder(option)}${option.repeated ? ' ...' : ''}`,
    [
      option.description ?? '',
      ...(option.required ? ['(required)'] : []),
      ...(option.defaultValue === undefined ? [] : [`[default: ${JSON.stringify(option.defaultValue)}]`]),
    ].filter((part) => part !== '').join(' '),
  ]);
  lines.push('', 'Options:', helpColumns([...optionRows, ...globalOptionRows]));
  return `${lines.join('\n')}\n`;
};

const treeHelp = (
  name: string,
  version: string,
  description: string | undefined,
  node: CommandTreeNode,
): string => {
  const lines: string[] = [];
  if (node.path.length === 0) {
    lines.push(`${name} ${version}`);
    if (description !== undefined) lines.push('', description);
    lines.push('', `Usage: ${name} <command> [options]`);
  } else {
    lines.push(`Usage: ${name} ${node.path.join(' ')} <command> [options]`);
  }
  const rows: (readonly [string, string])[] = [];
  const seen = new Set<CommandTreeNode>();
  for (const [segment, child] of [...node.children.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (seen.has(child)) continue;
    seen.add(child);
    const label = child.command === undefined ? `${segment} <command>` : segment;
    rows.push([label, child.command?.description ?? '']);
  }
  lines.push('', 'Commands:', helpColumns(rows));
  lines.push('', 'Options:', helpColumns(globalOptionRows));
  return `${lines.join('\n')}\n`;
};

interface ParsedArgv {
  readonly input: Readonly<Record<string, unknown>>;
  readonly json: boolean;
}

const coerceValue = (option: CompiledCliOption, value: string): unknown => {
  switch (option.kind) {
    case 'boolean':
      throw new CliUsageError(`--${option.option} is a flag and takes no value.`);
    case 'number': {
      const parsed = Number(value);
      if (value.trim() === '' || !Number.isFinite(parsed)) {
        throw new CliUsageError(`--${option.option} requires a number; got ${JSON.stringify(value)}.`);
      }
      return parsed;
    }
    case 'enum': {
      if (!(option.choices ?? []).includes(value)) {
        throw new CliUsageError(`--${option.option} must be one of: ${(option.choices ?? []).join(', ')}.`);
      }
      return value;
    }
    case 'string':
      return value;
    default: {
      const unreachable: never = option.kind;
      throw new TypeError(`Unhandled option kind ${String(unreachable)}.`);
    }
  }
};

const coercePositional = (option: CompiledCliOption, value: string): unknown => {
  switch (option.kind) {
    case 'number': {
      const parsed = Number(value);
      if (value.trim() === '' || !Number.isFinite(parsed)) {
        throw new CliUsageError(`<${option.option}> requires a number; got ${JSON.stringify(value)}.`);
      }
      return parsed;
    }
    case 'enum': {
      if (!(option.choices ?? []).includes(value)) {
        throw new CliUsageError(`<${option.option}> must be one of: ${(option.choices ?? []).join(', ')}.`);
      }
      return value;
    }
    case 'string':
      return value;
    case 'boolean':
      throw new CliUsageError(`<${option.option}> cannot be a flag.`);
    default: {
      const unreachable: never = option.kind;
      throw new TypeError(`Unhandled option kind ${String(unreachable)}.`);
    }
  }
};

/** Parses one resolved command's remaining argv against its compiled option surface. */
const parseCommandArgv = (command: CompiledCliCommand, argv: readonly string[]): ParsedArgv => {
  const options = new Map(namedOptions(command).map((option) => [option.option, option]));
  const values = new Map<string, unknown>();
  const bare: string[] = [];
  let json = false;
  let index = 0;
  const readOption = (raw: string): void => {
    const separator = raw.indexOf('=');
    const name = separator === -1 ? raw.slice(2) : raw.slice(2, separator);
    const inline = separator === -1 ? undefined : raw.slice(separator + 1);
    if (name === 'json' && inline === undefined) {
      json = true;
      return;
    }
    const option = options.get(name);
    if (option === undefined) throw new CliUsageError(`Unknown option: --${name}.`);
    if (option.kind === 'boolean') {
      if (inline !== undefined) throw new CliUsageError(`--${name} is a flag and takes no value.`);
      if (values.has(option.key)) throw new CliUsageError(`Duplicate option: --${name}.`);
      values.set(option.key, true);
      return;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new CliUsageError(`--${name} requires a value.`);
      value = next;
      index += 1;
    }
    const coerced = coerceValue(option, value);
    if (option.repeated) {
      const existing = values.get(option.key);
      values.set(option.key, Array.isArray(existing) ? [...existing, coerced] : [coerced]);
      return;
    }
    if (values.has(option.key)) throw new CliUsageError(`Duplicate option: --${name}.`);
    values.set(option.key, coerced);
  };
  for (; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (raw === '--') {
      bare.push(...argv.slice(index + 1));
      break;
    }
    if (raw.startsWith('--')) {
      readOption(raw);
      continue;
    }
    if (raw.startsWith('-') && raw.length > 1) throw new CliUsageError(`Unknown option: ${raw}.`);
    bare.push(raw);
  }

  const positionals = sortedPositionals(command);
  let cursor = 0;
  for (const option of positionals) {
    if (option.repeated) {
      const rest = bare.slice(cursor).map((value) => coercePositional(option, value));
      cursor = bare.length;
      if (rest.length === 0) {
        if (option.required) throw new CliUsageError(`Missing required argument: <${option.option}...>.`);
        continue;
      }
      values.set(option.key, rest);
      continue;
    }
    if (cursor >= bare.length) {
      if (option.required) throw new CliUsageError(`Missing required argument: <${option.option}>.`);
      continue;
    }
    values.set(option.key, coercePositional(option, bare[cursor]!));
    cursor += 1;
  }
  if (cursor < bare.length) {
    throw new CliUsageError(`Unexpected argument: ${JSON.stringify(bare[cursor]!)}.`);
  }
  for (const option of namedOptions(command)) {
    if (option.required && !values.has(option.key)) {
      throw new CliUsageError(`Missing required option: --${option.option}.`);
    }
  }
  return { input: Object.fromEntries(values), json };
};

const resultExitCode = (command: CompiledCliCommand, result: unknown): number => {
  if (command.exitCode === 'zero') return 0;
  const exitCode = typeof result === 'object' && result !== null
    ? (result as Record<string, unknown>)['exitCode']
    : undefined;
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error(`The exitCode result policy requires an integer exitCode property between 0 and 255; got ${JSON.stringify(exitCode)}.`);
  }
  return exitCode;
};

/**
 * Runs one routed-CLI invocation to completion and returns the process exit
 * code. Help and machine output go through `writeOut`; diagnostics through
 * `writeErr`; nothing here touches `process`.
 */
export const runGeneratedCliEntry = async (options: RunGeneratedCliOptions): Promise<number> => {
  const writeOut = options.writeOut ?? ((text: string) => void process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string) => void process.stderr.write(text));
  const signal = options.signal ?? new AbortController().signal;
  const tree = buildCommandTree(options.commands);

  let node = tree;
  let index = 0;
  try {
    if (options.argv[0] === '--version') {
      writeOut(`${options.name} ${options.version}\n`);
      return 0;
    }
    while (index < options.argv.length) {
      const token = options.argv[index]!;
      if (token === '--help' || token === '-h') {
        writeOut(node.command === undefined
          ? treeHelp(options.name, options.version, options.description, node)
          : commandHelp(options.name, node.command));
        return 0;
      }
      if (node.command !== undefined || token.startsWith('-')) break;
      const child = node.children.get(token);
      if (child === undefined) {
        throw new CliUsageError(node.path.length === 0
          ? `Unknown command: ${token}.`
          : `Unknown command: ${node.path.join(' ')} ${token}.`);
      }
      node = child;
      index += 1;
    }
    if (node.command === undefined) {
      if (node.path.length === 0 && index >= options.argv.length) {
        writeOut(treeHelp(options.name, options.version, options.description, node));
        return 0;
      }
      const token = options.argv[index];
      if (token !== undefined && token.startsWith('-')) {
        throw new CliUsageError(`Unknown option: ${token}.`);
      }
      throw new CliUsageError(`Missing command: ${options.name}${node.path.length === 0 ? '' : ` ${node.path.join(' ')}`} <command>.`);
    }
    const command = node.command;
    const rest = options.argv.slice(index);
    const terminator = rest.indexOf('--');
    const visible = terminator === -1 ? rest : rest.slice(0, terminator);
    if (visible.includes('--help') || visible.includes('-h')) {
      writeOut(commandHelp(options.name, command));
      return 0;
    }
    const parsed = parseCommandArgv(command, rest);
    signal.throwIfAborted();
    const result = await options.execute(command, parsed.input, { json: parsed.json, signal });
    signal.throwIfAborted();
    writeOut(`${JSON.stringify(result)}\n`);
    return resultExitCode(command, result);
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      writeErr('Aborted.\n');
      return 1;
    }
    const usage = error instanceof CliUsageError || error instanceof CliInputError;
    writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
    if (usage) {
      const helpPath = node.path.length === 0 ? '' : ` ${node.path.join(' ')}`;
      writeErr(`Run '${options.name}${helpPath} --help' for usage.\n`);
    }
    return usage ? 2 : 1;
  }
};

/**
 * The generated executable envelope: wires process argv, stdout/stderr,
 * SIGINT/SIGTERM (which reach the framework `AbortSignal` and exit 130/143),
 * and the process exit code around {@link runGeneratedCliEntry}.
 */
export const runGeneratedCliProcess = async (
  options: Omit<RunGeneratedCliOptions, 'argv' | 'signal' | 'writeErr' | 'writeOut'>,
): Promise<void> => {
  const controller = new AbortController();
  let signalExitCode: number | undefined;
  const onSignal = (exitCode: number): void => {
    signalExitCode = exitCode;
    controller.abort(new DOMException('The CLI process received a termination signal', 'AbortError'));
  };
  process.once('SIGINT', () => onSignal(130));
  process.once('SIGTERM', () => onSignal(143));
  const code = await runGeneratedCliEntry({
    ...options,
    argv: process.argv.slice(2),
    signal: controller.signal,
  });
  process.exitCode = signalExitCode ?? code;
};
