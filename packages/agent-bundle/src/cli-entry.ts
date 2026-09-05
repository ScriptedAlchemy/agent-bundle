import type { CompiledCliCommand, CompiledCliOption } from './routes/types.ts';
import { stableJson } from './core/digest.ts';
import {
  detectProcessTerminal,
  type AgentTerminal,
  type ProbedTerminalSurface,
  type TerminalStreamProbe,
} from './terminal-capability.ts';

export type { AgentTerminal } from './terminal-capability.ts';

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

/**
 * Structural mirrors of the runtime package's versioned Agent Document and
 * render-event contracts (`AGENT_DOCUMENT_VERSION` 1). The generated
 * executable feeds real runtime values through these shapes; keeping them
 * structural means this shell never imports `@agent-bundle/runtime` — the
 * generated bundle resolves the runtime from the consumer project instead.
 */
export type CliRenderedDocumentNode =
  | { readonly children: readonly CliRenderedDocumentNode[]; readonly kind: 'result'; readonly metadata?: unknown }
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'context'; readonly text: string }
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly completed: number; readonly kind: 'progress'; readonly message?: string; readonly total?: number }
  | { readonly data: string; readonly kind: 'image'; readonly mimeType: string }
  | { readonly data: string; readonly kind: 'audio'; readonly mimeType: string }
  | { readonly kind: 'resource'; readonly mimeType?: string; readonly name: string; readonly uri: string }
  | { readonly code: string; readonly kind: 'error'; readonly message: string };

export interface CliRenderedDocument {
  readonly root: CliRenderedDocumentNode;
  readonly status: 'failed' | 'represented-error' | 'success';
  readonly value?: unknown;
  readonly version: number;
}

export type CliRenderedEvent =
  | { readonly document: CliRenderedDocument; readonly sequence: number; readonly type: 'shell' }
  | { readonly completed: number; readonly message?: string; readonly sequence: number; readonly total?: number; readonly type: 'progress' }
  | { readonly boundaryId: string; readonly document: CliRenderedDocument; readonly sequence: number; readonly type: 'replace' }
  | { readonly boundaryId?: string; readonly error: { readonly code: string; readonly message: string }; readonly sequence: number; readonly type: 'error' }
  | { readonly document: CliRenderedDocument; readonly sequence: number; readonly type: 'complete' };

/**
 * The four output modes of one rendered invocation: interactive `tty`
 * updates progress in place before the final document; piped `markdown`
 * emits exactly one final document with no partial fallbacks; `json` emits
 * the canonical validated final value; `ndjson` emits the sequence-numbered
 * render-event stream (an Agent Bundle CLI/script dialect — never MCP
 * JSON-RPC, never written to an MCP server's stdout).
 */
export type CliOutputMode = 'json' | 'markdown' | 'ndjson' | 'tty';

/** One rendered run: a live render-event stream plus its validation and teardown. */
export interface GeneratedCliRenderSession {
  readonly close: () => Promise<void>;
  readonly events: () => ReadableStream<CliRenderedEvent>;
  /** Validates the complete document's value (the route's `resultSchema.parse`). */
  readonly validate: (value: unknown) => unknown;
}

/** Raised for argv-shape failures: unknown commands or options, missing or malformed values. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** The fail-closed confirmation diagnostic shared by bulk and explicit MCP tool projections. */
export const confirmationRequiredMessage = (server: string, tool: string): string =>
  `MCP tool ${server}:${tool} is mutation-capable per its MCP annotations and requires --yes.`;

/**
 * One input-validation failure of a routed command, already spelled in CLI
 * terms (#465): the argument the user typed rather than the schema path.
 */
export interface CliInputIssue {
  /** The plain-language expectation, e.g. `number <= 55000` or `one of: json, text`. */
  readonly expected: string;
  /** The schema's own message for the issue, kept for machine consumers. */
  readonly message: string;
  /** The value the command received at the issue path; absent when nothing was received. */
  readonly received?: unknown;
  /**
   * The CLI spelling of the failing argument: `--flag` for a named option,
   * `<name>` for a positional, `--input.<path>` for a projected MCP command,
   * or `input` when the issue is not attributable to one argument.
   */
  readonly target: string;
}

/** The machine-readable error code of an input-validation failure in `--json` and `--ndjson` output. */
export const cliInputInvalidCode = 'CLI_INPUT_INVALID';

/**
 * Raised by generated executables when the route module's own `inputSchema`
 * rejects parsed input — invalid input is a usage failure (exit 2), never an
 * execution failure. Construct it through {@link cliInputError} so a schema
 * failure carries its {@link CliInputIssue} list; the message-only form stays
 * for failures that are not attributable to individual arguments.
 */
export class CliInputError extends Error {
  readonly issues: readonly CliInputIssue[];

  constructor(message: string, issues: readonly CliInputIssue[] = []) {
    super(message);
    this.name = 'CliInputError';
    this.issues = Object.freeze([...issues]);
  }
}

/** The structural shape of a zod (v3/v4) issue, matched without importing zod: routed executables resolve zod from the consumer project. */
interface SchemaIssueLike {
  readonly code?: unknown;
  readonly exact?: unknown;
  readonly expected?: unknown;
  readonly format?: unknown;
  readonly includes?: unknown;
  readonly inclusive?: unknown;
  readonly keys?: unknown;
  readonly maximum?: unknown;
  readonly message: string;
  readonly minimum?: unknown;
  readonly origin?: unknown;
  readonly path: readonly PropertyKey[];
  readonly pattern?: unknown;
  readonly prefix?: unknown;
  readonly suffix?: unknown;
  readonly values?: unknown;
}

const isSchemaIssue = (value: unknown): value is SchemaIssueLike =>
  typeof value === 'object'
  && value !== null
  && typeof (value as { readonly message?: unknown }).message === 'string'
  && Array.isArray((value as { readonly path?: unknown }).path);

const schemaIssuesOf = (error: unknown): readonly SchemaIssueLike[] | undefined => {
  const issues = (error as { readonly issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues) || issues.length === 0 || !issues.every(isSchemaIssue)) return undefined;
  return issues;
};

/** `number <= 55000`, `non-empty string`, `array with at most 8 items`, `string with exactly 4 characters`, ... */
const boundLabel = (issue: SchemaIssueLike, direction: 'max' | 'min'): string => {
  const bound = direction === 'max' ? issue.maximum : issue.minimum;
  const inclusiveBound = issue.inclusive !== false;
  const value = String(bound);
  const quantifier = issue.exact === true
    ? 'exactly'
    : direction === 'max'
      ? (inclusiveBound ? 'at most' : 'fewer than')
      : (inclusiveBound ? 'at least' : 'more than');
  switch (issue.origin) {
    case 'string':
      if (direction === 'min' && inclusiveBound && bound === 1 && issue.exact !== true) return 'non-empty string';
      return `string with ${quantifier} ${value} characters`;
    case 'array':
    case 'set':
      return `${String(issue.origin)} with ${quantifier} ${value} items`;
    default: {
      const comparator = issue.exact === true
        ? '=='
        : direction === 'max' ? (inclusiveBound ? '<=' : '<') : (inclusiveBound ? '>=' : '>');
      return `${typeof issue.origin === 'string' ? issue.origin : 'value'} ${comparator} ${value}`;
    }
  }
};

/** The string-format refinements keep their operand: the user needs the prefix, suffix, substring, or pattern to fix the value. */
const formatLabel = (issue: SchemaIssueLike): string => {
  switch (issue.format) {
    case 'starts_with':
      return `string starting with ${JSON.stringify(issue.prefix)}`;
    case 'ends_with':
      return `string ending with ${JSON.stringify(issue.suffix)}`;
    case 'includes':
      return `string containing ${JSON.stringify(issue.includes)}`;
    case 'regex':
      return `string matching ${String(issue.pattern)}`;
    case 'url':
      return 'URL';
    default:
      return issue.message;
  }
};

/** The plain-language expectation of one schema issue; falls back to the schema's message. */
const expectationOf = (issue: SchemaIssueLike): string => {
  switch (issue.code) {
    case 'invalid_type':
      return typeof issue.expected === 'string' ? issue.expected : issue.message;
    case 'too_big':
      return boundLabel(issue, 'max');
    case 'too_small':
      return boundLabel(issue, 'min');
    case 'invalid_value':
    case 'invalid_enum_value':
    case 'invalid_literal':
      return Array.isArray(issue.values)
        ? `one of: ${issue.values.map((value) => JSON.stringify(value)).join(', ')}`
        : issue.message;
    case 'invalid_format':
    case 'invalid_string':
      return formatLabel(issue);
    case 'unrecognized_keys':
      return Array.isArray(issue.keys)
        ? `no unknown ${issue.keys.length === 1 ? 'key' : 'keys'} ${issue.keys.map((key) => JSON.stringify(key)).join(', ')}`
        : issue.message;
    default:
      return issue.message;
  }
};

const valueAt = (input: unknown, path: readonly PropertyKey[]): unknown => {
  let cursor: unknown = input;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[segment];
  }
  return cursor;
};

const pathSuffix = (path: readonly PropertyKey[]): string =>
  path.map((segment) => (typeof segment === 'number' ? `[${String(segment)}]` : `.${String(segment)}`)).join('');

/**
 * Spells a schema path the way the user typed it: the first segment is the
 * schema property the compiler projected onto argv (`--kebab-flag` or
 * `<positional>`); a projected MCP command's whole input arrived through
 * `--input`, so its path renders as `--input.<path>`.
 */
const targetOf = (command: CompiledCliCommand, path: readonly PropertyKey[]): string => {
  if (path.length === 0) return 'input';
  if (command.mcp !== undefined && command.projection === undefined) return `--input${pathSuffix(path)}`;
  const [head, ...rest] = path;
  const option = command.options.find((candidate) => candidate.key === head);
  if (option === undefined) return `input${pathSuffix(path)}`;
  const spelled = option.positional === undefined ? `--${option.option}` : `<${option.option}>`;
  return `${spelled}${pathSuffix(rest)}`;
};

/** The one-line human rendering of one input issue. */
export const cliInputIssueLine = (issue: CliInputIssue): string =>
  `Invalid value for ${issue.target}: expected ${issue.expected}; received ${
    issue.received === undefined ? 'nothing' : stableJson(issue.received)
  }.`;

/**
 * Maps a route module's `inputSchema` failure onto a {@link CliInputError}
 * whose issues name the CLI argument, the expectation, and the received
 * value (#465). Any other thrown value keeps its message, exactly as before.
 * Generated executables, the routed-CLI test harness, and the rendered-command
 * harness all call this so every surface reports the same text.
 */
export const cliInputError = (
  command: CompiledCliCommand,
  input: Readonly<Record<string, unknown>>,
  error: unknown,
): CliInputError => {
  const schemaIssues = schemaIssuesOf(error);
  if (schemaIssues === undefined) {
    return new CliInputError(error instanceof Error ? error.message : String(error));
  }
  const issues = schemaIssues.map((issue): CliInputIssue => {
    const received = valueAt(input, issue.path);
    return {
      expected: expectationOf(issue),
      message: issue.message,
      ...(received === undefined ? {} : { received }),
      target: targetOf(command, issue.path),
    };
  });
  return new CliInputError(issues.map(cliInputIssueLine).join('\n'), issues);
};

export interface GeneratedCliExecuteContext {
  /** The raw argv the command consumed, for the provider invocation's `args`. */
  readonly args: readonly string[];
  /** True when `--json` was passed; plain commands already emit canonical JSON. */
  readonly json: boolean;
  readonly signal: AbortSignal;
  /** The process's terminal capability (#511), probed once by the shell; the executable mounts it as `request.terminal`. */
  readonly terminal: AgentTerminal;
}

export interface GeneratedCliRenderContext {
  /** The raw argv the command consumed, for the dispatch invocation's `args`. */
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  /** The process's terminal capability (#511), the same value that selected the output mode. */
  readonly terminal: AgentTerminal;
}

/**
 * The terminal capability one shell invocation reports (#511): an explicit
 * value wins (the in-process harness supplies one), otherwise the process's
 * own streams are probed, with the legacy `isTty` knob standing in for
 * stdout's TTY-ness so callers that only override that still see a
 * consistent capability and output mode.
 */
const resolveTerminal = (
  hostSurface: ProbedTerminalSurface,
  options: { readonly isTty?: () => boolean; readonly terminal?: AgentTerminal },
): AgentTerminal => {
  if (options.terminal !== undefined) return options.terminal;
  if (options.isTty === undefined) return detectProcessTerminal(hostSurface);
  const stdout: TerminalStreamProbe = {
    columns: process.stdout.columns,
    fd: 1,
    isTTY: options.isTty(),
    rows: process.stdout.rows,
  };
  return detectProcessTerminal(hostSurface, { stdout });
};

export interface RunGeneratedCliOptions {
  readonly argv: readonly string[];
  readonly commands: readonly CompiledCliCommand[];
  readonly description?: string;
  /** Runs one resolved plain command with parsed input; returns the validated result. */
  readonly execute: (
    command: CompiledCliCommand,
    input: Readonly<Record<string, unknown>>,
    context: GeneratedCliExecuteContext,
  ) => Promise<unknown>;
  /** Overrides stdout's TTY-ness only; rendered commands then update progress in place. Prefer `terminal`. */
  readonly isTty?: () => boolean;
  readonly name: string;
  /** Opens one rendered run for a resolved `.tsx` command with parsed input. */
  readonly render?: (
    command: CompiledCliCommand,
    input: Readonly<Record<string, unknown>>,
    context: GeneratedCliRenderContext,
  ) => GeneratedCliRenderSession | Promise<GeneratedCliRenderSession>;
  readonly signal?: AbortSignal;
  /**
   * The terminal capability to report and select the output mode from (#511).
   * Omitted, the shell probes this process's stdout and stderr once.
   */
  readonly terminal?: AgentTerminal;
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

const renderedOptionRows: readonly (readonly [string, string])[] = [
  ['-h, --help', 'Show help.'],
  ['    --json', 'Emit the canonical JSON result.'],
  ['    --ndjson', 'Emit the sequence-numbered render-event stream.'],
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
  if (command.mcp !== undefined) {
    lines.push('', `MCP tool: ${command.mcp.server}:${command.mcp.tool}`);
    if (command.mcp.confirm) lines.push('Mutation-capable; requires --yes.');
  }
  if (command.projection !== undefined) lines.push(`Projection: ${command.projection.module}`);
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
    `    ${[option.option, ...(option.aliases ?? [])].map((spelling) => `--${spelling}`).join(', ')}${optionPlaceholder(option)}${option.repeated ? ' ...' : ''}`,
    [
      option.description ?? '',
      ...(option.required ? ['(required)'] : []),
      ...(option.defaultValue === undefined ? [] : [`[default: ${JSON.stringify(option.defaultValue)}]`]),
    ].filter((part) => part !== '').join(' '),
  ]);
  lines.push('', 'Options:', helpColumns([...optionRows, ...(command.rendered ? renderedOptionRows : globalOptionRows)]));
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
  readonly ndjson: boolean;
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
  const options = new Map<string, CompiledCliOption>();
  for (const option of namedOptions(command)) {
    options.set(option.option, option);
    for (const alias of option.aliases ?? []) options.set(alias, option);
  }
  const positionals = sortedPositionals(command);
  const values = new Map<string, unknown>();
  const bare: string[] = [];
  let json = false;
  let ndjson = false;
  let index = 0;
  const readOption = (raw: string): void => {
    const separator = raw.indexOf('=');
    const name = separator === -1 ? raw.slice(2) : raw.slice(2, separator);
    const inline = separator === -1 ? undefined : raw.slice(separator + 1);
    if (name === 'json' && inline === undefined) {
      json = true;
      return;
    }
    if (name === 'ndjson' && inline === undefined) {
      ndjson = true;
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
    if (raw.startsWith('-') && raw.length > 1) {
      const positional = positionals[bare.length] ??
        (positionals[positionals.length - 1]?.repeated === true ? positionals[positionals.length - 1] : undefined);
      const negativeNumber = positional?.kind === 'number' && /^-\d/u.test(raw) && Number.isFinite(Number(raw));
      if (!negativeNumber) throw new CliUsageError(`Unknown option: ${raw}.`);
    }
    bare.push(raw);
  }

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
  if (json && ndjson) throw new CliUsageError('Use either --json or --ndjson, not both.');
  return { input: Object.fromEntries(values), json, ndjson };
};

const parseMcpCommandInput = (
  command: CompiledCliCommand,
  parsed: ParsedArgv,
): ParsedArgv => {
  if (command.mcp === undefined) return parsed;
  if (command.mcp.confirm && parsed.input['yes'] !== true) {
    throw new CliUsageError(confirmationRequiredMessage(command.mcp.server, command.mcp.tool));
  }
  if (command.projection !== undefined) {
    const input = { ...parsed.input };
    delete input['yes'];
    return { ...parsed, input };
  }
  const raw = parsed.input['input'];
  let input: unknown = {};
  if (raw !== undefined) {
    try {
      input = JSON.parse(raw as string) as unknown;
    } catch {
      throw new CliUsageError('--input must be one valid JSON object.');
    }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CliUsageError('--input must be a JSON object; arrays, null, and scalar values are not accepted.');
  }
  return { ...parsed, input: input as Readonly<Record<string, unknown>> };
};

const resultExitCode = (policy: 'result' | 'zero', result: unknown): number => {
  if (policy === 'zero') return 0;
  const exitCode = typeof result === 'object' && result !== null
    ? (result as Record<string, unknown>)['exitCode']
    : undefined;
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error(`The exitCode result policy requires an integer exitCode property between 0 and 255; got ${JSON.stringify(exitCode)}.`);
  }
  return exitCode;
};

const markdownBlocks = (node: CliRenderedDocumentNode): readonly string[] => {
  switch (node.kind) {
    case 'result':
      return node.children.flatMap(markdownBlocks);
    case 'markdown':
    case 'text':
      return [node.text];
    case 'context':
      return [node.text.split('\n').map((line) => `> ${line}`).join('\n')];
    case 'json':
      return [`\`\`\`json\n${JSON.stringify(node.value, null, 2)}\n\`\`\``];
    case 'progress':
      // Transient by contract: partial fallbacks never reach final Markdown.
      return [];
    case 'image':
      return [`![image](data:${node.mimeType};base64,${node.data})`];
    case 'audio':
      return [`[audio](data:${node.mimeType};base64,${node.data})`];
    case 'resource':
      return [`[${node.name}](${node.uri})`];
    case 'error':
      return [`**[${node.code}]** ${node.message}`];
    default: {
      const unreachable: never = node;
      throw new TypeError(`Unsupported Agent Document node ${String((unreachable as { kind?: string }).kind)}.`);
    }
  }
};

/** Projects one final Agent Document onto stable Markdown (the piped and TTY final output). */
export const projectCliDocumentToMarkdown = (document: CliRenderedDocument): string => {
  const blocks = markdownBlocks(document.root).filter((block) => block.trim() !== '');
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
};

/** The progress fields a render `progress` event and an `Agent.Progress` document node share. */
interface CliProgressSource {
  readonly completed: number;
  readonly message?: string;
  readonly total?: number;
}

const progressLine = (event: CliProgressSource): string => {
  const counter = event.total === undefined ? String(event.completed) : `${String(event.completed)}/${String(event.total)}`;
  return event.message === undefined ? counter : `${event.message} (${counter})`;
};

/**
 * The `Agent.Progress` nodes of a streamed `shell`/`replace` document, in
 * document order — a `Suspense` fallback rendered as `Agent.Progress` is the
 * route's progress surface, so the interactive TTY shows it exactly as it
 * shows an explicit `progress.report()` (#448).
 */
const progressNodes = (node: CliRenderedDocumentNode): readonly CliProgressSource[] => {
  switch (node.kind) {
    case 'result':
      return node.children.flatMap(progressNodes);
    case 'progress':
      return [node];
    case 'audio':
    case 'context':
    case 'error':
    case 'image':
    case 'json':
    case 'markdown':
    case 'resource':
    case 'text':
      return [];
    default: {
      const unreachable: never = node;
      throw new TypeError(`Unsupported Agent Document node ${String((unreachable as { kind?: string }).kind)}.`);
    }
  }
};

const clearProgressLine = '\r\u001B[2K';

interface RenderedRunOptions {
  /** Exit-code policy of the invocation: a routed command's policy, or `zero` for rendered scripts. */
  readonly exitCode: 'result' | 'zero';
  readonly mode: CliOutputMode;
  readonly session: GeneratedCliRenderSession;
  readonly signal: AbortSignal;
  readonly writeErr: (text: string) => void;
  readonly writeOut: (text: string) => void;
}

/**
 * Drives one rendered run through its output mode: machine output on stdout,
 * diagnostics on stderr, deterministic exit codes (0 success or the `result`
 * policy's `exitCode`, 1 render/contract failure).
 */
const runRenderedInvocation = async (options: RenderedRunOptions): Promise<number> => {
  const { mode, writeErr, writeOut } = options;
  const reader = options.session.events().getReader();
  let complete: CliRenderedDocument | undefined;
  let progressShown = false;
  const showProgress = (source: CliProgressSource): void => {
    if (mode !== 'tty') return;
    writeOut(`${clearProgressLine}${progressLine(source)}`);
    progressShown = true;
  };
  // A fallback is re-streamed with every chunk that leaves its boundary
  // pending; the line is redrawn only when the fallback itself changed. A TTY
  // has no monotonic constraint, so an explicit report always redraws.
  const shownFallbacks = new Set<string>();
  const showFallback = (node: CliProgressSource): void => {
    const key = JSON.stringify([node.completed, node.message, node.total]);
    if (shownFallbacks.has(key)) return;
    shownFallbacks.add(key);
    showProgress(node);
  };
  const clearProgress = (): void => {
    if (progressShown) {
      writeOut(clearProgressLine);
      progressShown = false;
    }
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const event = next.value;
      if (mode === 'ndjson') {
        writeOut(`${JSON.stringify(event)}\n`);
      }
      switch (event.type) {
        case 'shell':
        case 'replace':
          for (const node of progressNodes(event.document.root)) showFallback(node);
          break;
        case 'progress':
          showProgress(event);
          break;
        case 'error':
          if (mode !== 'ndjson') {
            clearProgress();
            writeErr(`[${event.error.code}] ${event.error.message}\n`);
          }
          break;
        case 'complete':
          complete = event.document;
          break;
        default: {
          const unreachable: never = event;
          throw new TypeError(`Unsupported render event ${String((unreachable as { type?: string }).type)}.`);
        }
      }
    }
  } catch (error) {
    clearProgress();
    if (options.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      writeErr('Aborted.\n');
      return 1;
    }
    writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  clearProgress();
  if (complete === undefined) {
    writeErr('The render ended without a complete document.\n');
    return 1;
  }
  let value: unknown = complete.value;
  try {
    value = options.session.validate(value);
  } catch (error) {
    writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  switch (mode) {
    case 'json':
      writeOut(`${JSON.stringify(value ?? null)}\n`);
      break;
    case 'ndjson':
      break;
    case 'tty':
    case 'markdown':
      writeOut(projectCliDocumentToMarkdown(complete));
      break;
    default: {
      const unreachable: never = mode;
      throw new TypeError(`Unsupported output mode ${String(unreachable)}.`);
    }
  }
  if (complete.status !== 'success') return 1;
  return resultExitCode(options.exitCode, value);
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
  let parsed: ParsedArgv | undefined;
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
    parsed = parseMcpCommandInput(command, parseCommandArgv(command, rest));
    signal.throwIfAborted();
    // Probed once: the same value selects the output mode and reaches the
    // route as `request.terminal`, so the two can never disagree.
    const terminal = resolveTerminal('cli', options);
    if (command.rendered) {
      if (options.render === undefined) {
        throw new Error(`Rendered command ${command.path.join(' ')} has no render host.`);
      }
      const mode: CliOutputMode = parsed.ndjson
        ? 'ndjson'
        : parsed.json
          ? 'json'
          : terminal.stdout.kind === 'tty'
            ? 'tty'
            : 'markdown';
      const session = await options.render(command, parsed.input, { args: rest, signal, terminal });
      try {
        return await runRenderedInvocation({
          exitCode: command.exitCode,
          mode,
          session,
          signal,
          writeErr,
          writeOut,
        });
      } finally {
        await session.close();
      }
    }
    if (parsed.ndjson) throw new CliUsageError('--ndjson requires a rendered command.');
    const result = await options.execute(command, parsed.input, { args: rest, json: parsed.json, signal, terminal });
    signal.throwIfAborted();
    const exitCode = resultExitCode(command.exitCode, result);
    writeOut(`${stableJson(result === undefined ? null : result)}\n`);
    return exitCode;
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      writeErr('Aborted.\n');
      return 1;
    }
    const helpPath = node.path.length === 0 ? '' : ` ${node.path.join(' ')}`;
    const helpHint = `Run '${options.name}${helpPath} --help' for usage.\n`;
    if (error instanceof CliInputError && error.issues.length > 0 && node.command !== undefined) {
      writeInputIssues({
        command: node.command,
        issues: error.issues,
        mode: parsed?.ndjson === true ? 'ndjson' : parsed?.json === true ? 'json' : 'text',
        name: options.name,
        writeErr,
        writeOut,
      });
      if (parsed?.json !== true && parsed?.ndjson !== true) writeErr(helpHint);
      return 2;
    }
    const usage = error instanceof CliUsageError || error instanceof CliInputError;
    writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
    if (usage) writeErr(helpHint);
    return usage ? 2 : 1;
  }
};

interface InputIssuesReport {
  readonly command: CompiledCliCommand;
  readonly issues: readonly CliInputIssue[];
  readonly mode: 'json' | 'ndjson' | 'text';
  readonly name: string;
  readonly writeErr: (text: string) => void;
  readonly writeOut: (text: string) => void;
}

/**
 * Reports input-validation issues (#465) per output mode: plain text on
 * stderr, one issue per line and the exact usage line; `--json` keeps stdout
 * empty and writes one canonical error object to stderr; `--ndjson` keeps the
 * stdout stream machine-only with one canonical error event.
 */
const writeInputIssues = (report: InputIssuesReport): void => {
  const usage = commandUsage(report.name, report.command);
  switch (report.mode) {
    case 'json':
      report.writeErr(`${stableJson({ error: { code: cliInputInvalidCode, issues: report.issues, usage } })}\n`);
      return;
    case 'ndjson':
      report.writeOut(`${stableJson({
        error: {
          code: cliInputInvalidCode,
          issues: report.issues,
          message: report.issues.map(cliInputIssueLine).join('\n'),
          usage,
        },
        sequence: 0,
        type: 'error',
      })}\n`);
      return;
    case 'text':
      for (const issue of report.issues) report.writeErr(`${cliInputIssueLine(issue)}\n`);
      report.writeErr(`${usage}\n`);
      return;
    default: {
      const unreachable: never = report.mode;
      throw new TypeError(`Unsupported output mode ${String(unreachable)}.`);
    }
  }
};

export interface RunGeneratedRenderedScriptOptions {
  readonly argv: readonly string[];
  /** Opens one rendered run for the script with the mode flags removed from argv. */
  readonly createSession: (
    argv: readonly string[],
    context: { readonly signal: AbortSignal; readonly terminal: AgentTerminal },
  ) => GeneratedCliRenderSession;
  /** Overrides stdout's TTY-ness only. Prefer `terminal`. */
  readonly isTty?: () => boolean;
  readonly name: string;
  readonly signal?: AbortSignal;
  /** The terminal capability to report and select the output mode from (#511); probed from the process when omitted. */
  readonly terminal?: AgentTerminal;
  readonly writeErr?: (text: string) => void;
  readonly writeOut?: (text: string) => void;
}

/**
 * Runs one rendered script (`src/scripts/<name>.tsx`) to completion and
 * returns the process exit code. The framework dialect reserves exactly
 * `--json` and `--ndjson` (before a `--` terminator); every other argument
 * passes through to the script component's `argv` prop untouched. Exit codes
 * derive from the final document status: 0 on `success`, 1 otherwise.
 */
export const runGeneratedRenderedScript = async (
  options: RunGeneratedRenderedScriptOptions,
): Promise<number> => {
  const writeOut = options.writeOut ?? ((text: string) => void process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string) => void process.stderr.write(text));
  const signal = options.signal ?? new AbortController().signal;
  const terminator = options.argv.indexOf('--');
  const visible = terminator === -1 ? options.argv : options.argv.slice(0, terminator);
  const json = visible.includes('--json');
  const ndjson = visible.includes('--ndjson');
  if (json && ndjson) {
    writeErr('Use either --json or --ndjson, not both.\n');
    return 2;
  }
  const argv = options.argv.filter((argument, index) =>
    (terminator !== -1 && index > terminator) || (argument !== '--json' && argument !== '--ndjson'));
  const terminal = resolveTerminal('script', options);
  const mode: CliOutputMode = ndjson
    ? 'ndjson'
    : json
      ? 'json'
      : terminal.stdout.kind === 'tty'
        ? 'tty'
        : 'markdown';
  const session = options.createSession(argv, { signal, terminal });
  try {
    return await runRenderedInvocation({
      exitCode: 'zero',
      mode,
      session,
      signal,
      writeErr,
      writeOut,
    });
  } finally {
    await session.close();
  }
};

interface ProcessSignalWiring {
  readonly exitCode: () => number | undefined;
  readonly signal: AbortSignal;
}

const wireProcessSignals = (): ProcessSignalWiring => {
  const controller = new AbortController();
  let signalExitCode: number | undefined;
  const onSignal = (exitCode: number): void => {
    signalExitCode = exitCode;
    controller.abort(new DOMException('The process received a termination signal', 'AbortError'));
  };
  process.once('SIGINT', () => onSignal(130));
  process.once('SIGTERM', () => onSignal(143));
  return { exitCode: () => signalExitCode, signal: controller.signal };
};

/**
 * The generated executable envelope: wires process argv, stdout/stderr,
 * SIGINT/SIGTERM (which reach the framework `AbortSignal` and exit 130/143),
 * and the process exit code around {@link runGeneratedCliEntry}.
 */
export const runGeneratedCliProcess = async (
  options: Omit<RunGeneratedCliOptions, 'argv' | 'signal' | 'writeErr' | 'writeOut'>,
): Promise<void> => {
  const wiring = wireProcessSignals();
  const code = await runGeneratedCliEntry({
    ...options,
    argv: process.argv.slice(2),
    signal: wiring.signal,
  });
  process.exitCode = wiring.exitCode() ?? code;
};

/** The generated rendered-script envelope, mirroring {@link runGeneratedCliProcess}. */
export const runGeneratedRenderedScriptProcess = async (
  options: Omit<RunGeneratedRenderedScriptOptions, 'argv' | 'signal' | 'writeErr' | 'writeOut'>,
): Promise<void> => {
  const wiring = wireProcessSignals();
  const code = await runGeneratedRenderedScript({
    ...options,
    argv: process.argv.slice(2),
    signal: wiring.signal,
  });
  process.exitCode = wiring.exitCode() ?? code;
};
