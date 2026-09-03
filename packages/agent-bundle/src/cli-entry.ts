import type { CompiledCliCommand, CompiledCliOption } from './routes/types.ts';
import { stableJson } from './core/digest.ts';

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
  /** The raw argv the command consumed, for the provider invocation's `args`. */
  readonly args: readonly string[];
  /** True when `--json` was passed; plain commands already emit canonical JSON. */
  readonly json: boolean;
  readonly signal: AbortSignal;
}

export interface GeneratedCliRenderContext {
  /** The raw argv the command consumed, for the dispatch invocation's `args`. */
  readonly args: readonly string[];
  readonly signal: AbortSignal;
}

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
  /** True when stdout is an interactive terminal; rendered commands then update progress in place. */
  readonly isTty?: () => boolean;
  readonly name: string;
  /** Opens one rendered run for a resolved `.tsx` command with parsed input. */
  readonly render?: (
    command: CompiledCliCommand,
    input: Readonly<Record<string, unknown>>,
    context: GeneratedCliRenderContext,
  ) => GeneratedCliRenderSession;
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
  const options = new Map(namedOptions(command).map((option) => [option.option, option]));
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
  if (command.mcp.confirm && parsed.input['yes'] !== true) {
    throw new CliUsageError(
      `MCP tool ${command.mcp.server}:${command.mcp.tool} is mutation-capable per its MCP annotations and requires --yes.`,
    );
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

const progressLine = (event: { readonly completed: number; readonly message?: string; readonly total?: number }): string => {
  const counter = event.total === undefined ? String(event.completed) : `${String(event.completed)}/${String(event.total)}`;
  return event.message === undefined ? counter : `${event.message} (${counter})`;
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
          break;
        case 'progress':
          if (mode === 'tty') {
            writeOut(`${clearProgressLine}${progressLine(event)}`);
            progressShown = true;
          }
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
    const parsed = parseMcpCommandInput(command, parseCommandArgv(command, rest));
    signal.throwIfAborted();
    if (command.rendered) {
      if (options.render === undefined) {
        throw new Error(`Rendered command ${command.path.join(' ')} has no render host.`);
      }
      const mode: CliOutputMode = parsed.ndjson
        ? 'ndjson'
        : parsed.json
          ? 'json'
          : (options.isTty ?? (() => process.stdout.isTTY === true))()
            ? 'tty'
            : 'markdown';
      const session = options.render(command, parsed.input, { args: rest, signal });
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
    const result = await options.execute(command, parsed.input, { args: rest, json: parsed.json, signal });
    signal.throwIfAborted();
    const exitCode = resultExitCode(command.exitCode, result);
    writeOut(`${stableJson(result === undefined ? null : result)}\n`);
    return exitCode;
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

export interface RunGeneratedRenderedScriptOptions {
  readonly argv: readonly string[];
  /** Opens one rendered run for the script with the mode flags removed from argv. */
  readonly createSession: (
    argv: readonly string[],
    context: { readonly signal: AbortSignal },
  ) => GeneratedCliRenderSession;
  readonly isTty?: () => boolean;
  readonly name: string;
  readonly signal?: AbortSignal;
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
  const mode: CliOutputMode = ndjson
    ? 'ndjson'
    : json
      ? 'json'
      : (options.isTty ?? (() => process.stdout.isTTY === true))()
        ? 'tty'
        : 'markdown';
  const session = options.createSession(argv, { signal });
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
