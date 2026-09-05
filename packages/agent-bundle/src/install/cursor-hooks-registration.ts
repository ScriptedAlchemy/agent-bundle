import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { Ajv } from 'ajv/dist/ajv.js';
import addFormats from 'ajv-formats';
import { Predicate } from 'effect';

import hooksSchema from '../adapters/schemas/cursor/hooks.schema.json' with { type: 'json' };
import marketplaceSchema from '../adapters/schemas/cursor/marketplace.schema.json' with { type: 'json' };
import pluginSchema from '../adapters/schemas/cursor/plugin.schema.json' with { type: 'json' };
import type { Diagnostic } from '../core/diagnostics.ts';
import { isErrno } from '../core/errors.ts';
import { resolveCursorHooksSource } from '../host-contracts/cursor-plugin-validation.ts';
import {
  cursorMarketplacePluginPath,
  cursorMarketplaceRoot,
} from './cursor-marketplace.ts';

/**
 * Read-only Doctor proof for Cursor hook registration (#407).
 *
 * Cursor delivers plugin hooks from the plugin manifest (`.cursor-plugin/plugin.json`
 * `hooks` -> the named document; `hooks/hooks.json` by folder discovery when
 * the field is absent), substituting `${CURSOR_PLUGIN_ROOT}` and running
 * each command from the plugin root (observed 2026-09-03, Cursor 3.18.25, isolated
 * HOME: preToolUse/postToolUse/stop fired for the emitted pack exactly like the
 * known-working ~/.cursor/plugins/local/tracedecay). `~/.cursor/hooks.json` is a
 * separate user-level registry; entries there that point into a plugin would run
 * the same hook twice, so Doctor reports them as duplicate delivery.
 */

export type CursorHooksRegistrationState = 'missing' | 'none' | 'registered' | 'stale';

export interface CursorHooksRegistration {
  readonly commands: number;
  readonly duplicates: readonly string[];
  readonly events: readonly string[];
  readonly source?: string;
  readonly state: CursorHooksRegistrationState;
}

const finding = (
  code: `AB73${number}`,
  message: string,
  recovery: string,
  severity: Diagnostic['severity'],
): Diagnostic => Object.freeze({ code, message, recovery, severity, target: 'cursor' });

const pluginRootToken = '${CURSOR_PLUGIN_ROOT}';

interface ParsedHooksDocument {
  readonly commands: readonly string[];
  readonly events: readonly string[];
  readonly prompts: number;
}

const schemaValidator = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true });
(addFormats as unknown as (target: Ajv) => void)(schemaValidator);
const validateHooksDocument = schemaValidator.compile(hooksSchema);
const validateMarketplaceDocument = schemaValidator.compile(marketplaceSchema);
const validatePluginDocument = schemaValidator.compile(pluginSchema);

/**
 * Accepts exactly what the pinned hooks.schema.json accepts (documented events, command hooks
 * `{ "command": string }` / `{ "type": "command", ... }`, prompt hooks `{ "type": "prompt", "prompt": string }`),
 * so AB7322 never reports `registered` for a document the static contract validator rejects.
 * Only command hooks have a script path to verify.
 */
const parseHooksDocument = (value: unknown): ParsedHooksDocument | undefined => {
  if (!validateHooksDocument(value) || !Predicate.isObject(value)) return undefined;
  const hooks = value.hooks;
  if (!Predicate.isObject(hooks)) return undefined;
  const events: string[] = [];
  const commands: string[] = [];
  let prompts = 0;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) return undefined;
    events.push(event);
    for (const entry of entries) {
      if (!Predicate.isObject(entry)) return undefined;
      if (entry.type === 'prompt') {
        prompts += 1;
        continue;
      }
      if (typeof entry.command !== 'string') return undefined;
      commands.push(entry.command);
    }
  }
  return { commands, events: events.sort((left, right) => left.localeCompare(right)), prompts };
};

/**
 * Minimal POSIX-ish word splitter: whitespace separates words, single/double quotes group (quotes removed),
 * and a backslash escapes only a following quote, backslash, or whitespace so Windows paths such as
 * `.\plugins\local\foo` survive intact. Enough to keep `"hooks/my hook.mjs"` one token.
 */
const escapable = (char: string | undefined): boolean => char !== undefined && /[\s"'\\]/u.test(char);
const shellWords = (command: string): readonly string[] => {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let hasWord = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && quote === '"' && escapable(command[index + 1])) {
        index += 1;
        current += command[index] ?? '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasWord = true;
    } else if (char === '\\' && escapable(command[index + 1])) {
      index += 1;
      current += command[index] ?? '';
      hasWord = true;
    } else if (/\s/u.test(char)) {
      if (hasWord) words.push(current);
      current = '';
      hasWord = false;
    } else {
      current += char;
      hasWord = true;
    }
  }
  if (hasWord) words.push(current);
  return words;
};

/** Interpreters whose first operand is the script Cursor must find under the plugin root. */
const scriptInterpreters = new Set([
  'bash', 'bun', 'dash', 'deno', 'node', 'nodejs', 'perl', 'powershell', 'pwsh', 'python', 'python3', 'ruby', 'sh', 'tsx', 'zsh',
]);

/** Interpreters whose `run` subcommand precedes the script (`bun run ./x.ts`, `deno run -A ./x.ts`). */
const runSubcommandInterpreters = new Set(['bun', 'deno']);

/**
 * Interpreter options whose operand is inline source or a module name: the command runs no script file at all.
 * PowerShell entries are lower-case because its parameters are case-insensitive and are lower-cased before lookup.
 */
const inlineSourceOptions = new Set(['--eval', '--print', '-c', '-command', '-e', '-ec', '-encodedcommand', '-m', '-p']);

/** Interpreter options that consume the next token (a path or value), which is therefore not the entry script. */
const valueOptions = new Set([
  '--conditions', '--define', '--env-file', '--experimental-loader', '--import', '--input-type', '--loader',
  '--preload', '--require', '--stack-trace-limit', '--title', '-C', '-I', '-W', '-X', '-d', '-o', '-r',
  '-configurationname', '-ep', '-ex', '-executionpolicy', '-inputformat', '-outputformat', '-psconsolefile',
  '-settingsfile', '-wd', '-workingdirectory',
]);

const powerShell = new Set(['powershell', 'pwsh']);

const shellAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** `env [NAME=VALUE]... [OPTION]... COMMAND [ARG]...`: strips the assignments and options ahead of COMMAND. */
const unwrapEnv = (operands: readonly string[]): readonly string[] | undefined => {
  for (let index = 0; index < operands.length; index += 1) {
    const token = operands[index] ?? '';
    if (shellAssignment.test(token)) continue;
    if (token === '-u' || token === '--unset' || token === '-C' || token === '--chdir') {
      index += 1;
      continue;
    }
    if (token === '-S' || token === '--split-string') return undefined;
    if (token.startsWith('-') && token !== '-') continue;
    return operands.slice(index);
  }
  return undefined;
};

interface ExecutedPath {
  /** `executable` is the command word itself (PATH lookup unless it names a path); `operand` is a script argument. */
  readonly kind: 'executable' | 'operand';
  readonly token: string;
}

/**
 * The file a hook command executes: the executable token itself, or, for a known interpreter, the entry-script
 * operand after skipping options (value-taking options consume their operand; `--opt=value` consumes nothing;
 * PowerShell's `-File <path>` selects the script). `undefined` when the interpreter runs inline source
 * (`node -e`, `sh -c`, `python -m`) or has no operand. Other arguments (`--output ./state/result.json`) are
 * runtime inputs/outputs, never the executed file.
 */
const executedPath = (words: readonly string[]): ExecutedPath | undefined => {
  // Leading `NAME=value` words are shell assignments (`NODE_ENV=production node ./x.mjs`), not the command.
  const tokens = words.slice(words.findIndex((word) => !shellAssignment.test(word)));
  const [executable, ...operands] = tokens;
  if (executable === undefined || shellAssignment.test(executable)) return undefined;
  // Interpreter basenames are matched case-insensitively (`PowerShell.EXE`, `Node.exe` on Windows).
  const interpreter = executable.replace(/^.*[\\/]/u, '').replace(/\.exe$/iu, '').toLowerCase();
  if (interpreter === 'env') {
    const wrapped = unwrapEnv(operands);
    return wrapped === undefined ? undefined : executedPath(wrapped);
  }
  if (!scriptInterpreters.has(interpreter)) return { kind: 'executable', token: executable };
  const operand = (token: string | undefined): ExecutedPath | undefined =>
    token === undefined ? undefined : { kind: 'operand', token };
  const isPowerShell = powerShell.has(interpreter);
  let runSubcommandSeen = false;
  for (let index = 0; index < operands.length; index += 1) {
    const token = operands[index] ?? '';
    // `bun run <script>` / `deno run [permissions] <script>`: the subcommand is not the script.
    if (!runSubcommandSeen && token === 'run' && runSubcommandInterpreters.has(interpreter)) {
      runSubcommandSeen = true;
      continue;
    }
    if (!token.startsWith('-') || token === '-') return operand(token);
    // PowerShell parameters are case-insensitive; other interpreters' options are exact.
    const option = isPowerShell ? token.toLowerCase() : token;
    if (isPowerShell && (option === '-f' || option === '-file')) return operand(operands[index + 1]);
    if (inlineSourceOptions.has(option)) return undefined;
    if (valueOptions.has(option) && !option.includes('=')) index += 1;
  }
  return undefined;
};

/**
 * Where a hook's executed file lives under the plugin root: `${CURSOR_PLUGIN_ROOT}/...` spellings, and any other
 * non-absolute path (plugin hooks run from the plugin root, and the pinned schema resolves relative paths against
 * the hook source root). A bare executable word without a separator is a PATH lookup, not a plugin file.
 */
const pluginRelativePath = (executed: ExecutedPath, pluginDirectory: string): string | undefined => {
  const { kind, token } = executed;
  if (token.startsWith(`${pluginRootToken}/`) || token.startsWith(`${pluginRootToken}\\`)) {
    return join(pluginDirectory, token.slice(pluginRootToken.length + 1).replaceAll('\\', '/'));
  }
  if (token.startsWith('${') || token.startsWith('~') || isAbsolute(token) || /^[A-Za-z]:[\\/]/u.test(token)) return undefined;
  if (kind === 'executable' && !/[\\/]/u.test(token)) return undefined;
  return join(pluginDirectory, token.replaceAll('\\', '/'));
};

/**
 * The plugin-root file a hook command executes; empty when the executed file lives elsewhere (absolute, `~`, or a
 * PATH lookup) or the command runs inline source.
 */
const pluginRelativeScripts = (command: string, pluginDirectory: string): readonly string[] => {
  const executed = executedPath(shellWords(command));
  const script = executed === undefined ? undefined : pluginRelativePath(executed, pluginDirectory);
  return script === undefined ? [] : [script];
};

/**
 * Tolerant probe for a regular file (symlinks followed): `stat` never blocks on a FIFO the way `open`/`readFile`
 * would, and any inspection failure (ENOENT, ENOTDIR, EACCES) reads as absent instead of aborting Doctor.
 */
const regularFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** Tolerant directory probe with the same failure semantics as `regularFile`. */
const directory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Read a JSON document only after `stat` confirms a regular file: opening a FIFO (or a device) with `readFile`
 * would block Doctor until a writer appears. Anything that is not a regular file reads as `invalid`.
 */
const readJson = async (path: string): Promise<{ readonly value?: unknown; readonly error?: 'missing' | 'invalid' }> => {
  try {
    if (!(await stat(path)).isFile()) return { error: 'invalid' };
    return { value: JSON.parse(await readFile(path, 'utf8')) as unknown };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { error: 'missing' };
    return { error: 'invalid' };
  }
};

/** Windows paths are case-insensitive, so containment checks there fold case (Cursor itself runs the same file). */
const caseInsensitivePaths = process.platform === 'win32';

const userHookDuplicates = async (
  home: string,
  pluginDirectory: string,
  foldCase: boolean,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly duplicates: readonly string[] }> => {
  const userHooksPath = join(home, '.cursor', 'hooks.json');
  const document = await readJson(userHooksPath);
  if (document.error === 'missing') return { diagnostics: Object.freeze([]), duplicates: Object.freeze([]) };
  const parsed = document.error === undefined ? parseHooksDocument(document.value) : undefined;
  if (parsed === undefined) {
    return {
      diagnostics: Object.freeze([finding(
        'AB7323',
        `User hooks file ${JSON.stringify(userHooksPath)} is not a valid Cursor hooks document; Cursor ignores it and Doctor cannot check it for duplicate plugin hook delivery.`,
        'Repair or remove ~/.cursor/hooks.json; plugin hooks do not require it.',
        'warning',
      )]),
      duplicates: Object.freeze([]),
    };
  }
  const fold = (path: string): string => (foldCase ? path.toLowerCase() : path);
  const resolvedPlugin = resolve(pluginDirectory);
  const foldedPlugin = fold(resolvedPlugin);
  // User hooks run from ~/.cursor (https://cursor.com/docs/hooks), so relative command tokens resolve there.
  const userHookCwd = join(home, '.cursor');
  const insidePlugin = (resolvedCandidate: string): boolean => {
    const candidate = fold(resolvedCandidate);
    return candidate === foldedPlugin || candidate.startsWith(`${foldedPlugin}/`) || candidate.startsWith(`${foldedPlugin}\\`);
  };
  // Only the file the user hook executes counts: a plugin-local path passed as data (`--output
  // ./plugins/local/foo/state.json`) does not deliver that plugin's hook. `insidePlugin` matches on a path
  // component boundary so `plugins/local/foo` does not claim hooks aimed at `plugins/local/foo-tools`.
  const pointsIntoPlugin = (command: string): boolean => {
    const executed = executedPath(shellWords(command));
    if (executed === undefined || executed.token.length === 0) return false;
    const { kind, token } = executed;
    if (token.startsWith('~/')) return insidePlugin(resolve(home, token.slice(2)));
    if (isAbsolute(token)) return insidePlugin(resolve(token));
    // A bare executable word is a PATH lookup; any other relative spelling (either separator, e.g.
    // `.\plugins\local\foo` on Windows) resolves against ~/.cursor.
    if (kind === 'executable' && !/[\\/]/u.test(token)) return false;
    return insidePlugin(resolve(userHookCwd, token.replaceAll('\\', '/')));
  };
  const duplicates = parsed.commands.filter(pointsIntoPlugin);
  if (duplicates.length === 0) return { diagnostics: Object.freeze([]), duplicates: Object.freeze([]) };
  return {
    diagnostics: Object.freeze([finding(
      'AB7323',
      `User hooks file ${JSON.stringify(userHooksPath)} registers ${duplicates.length} command(s) that point into ` +
        `${JSON.stringify(resolvedPlugin)}; Cursor already delivers that plugin's manifest hooks, so each event would run twice.`,
      'Remove the plugin-pointing entries from ~/.cursor/hooks.json; the plugin manifest registration is sufficient.',
      'warning',
    )]),
    duplicates: Object.freeze(duplicates),
  };
};

/**
 * Inspect the hooks registration of one installed Cursor plugin directory
 * whose loader manifest is `.cursor-plugin/plugin.json`.
 */
export const inspectCursorPluginHooks = async (
  pluginDirectory: string,
  home: string,
  options: { readonly caseInsensitivePaths?: boolean } = {},
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly registration: CursorHooksRegistration }> => {
  const none: CursorHooksRegistration = Object.freeze({ commands: 0, duplicates: Object.freeze([]), events: Object.freeze([]), state: 'none' });
  const manifest = await readJson(join(pluginDirectory, '.cursor-plugin/plugin.json'));
  if (manifest.error !== undefined || !Predicate.isObject(manifest.value)) {
    return { diagnostics: Object.freeze([]), registration: none };
  }
  // The same manifest-driven resolution the static validator applies (#438): the `hooks` field names the
  // document Cursor loads; the folder-discovery default `hooks/hooks.json` applies only when it is absent.
  const hooksSource = resolveCursorHooksSource(manifest.value);
  let parsed: ParsedHooksDocument | undefined;
  let source: string;
  switch (hooksSource.kind) {
    case 'default': {
      source = join(pluginDirectory, hooksSource.path);
      const document = await readJson(source);
      if (document.error === 'missing') return { diagnostics: Object.freeze([]), registration: none };
      parsed = document.error === undefined ? parseHooksDocument(document.value) : undefined;
      break;
    }
    case 'file': {
      source = isAbsolute(hooksSource.declared) ? hooksSource.declared : join(pluginDirectory, hooksSource.path);
      const document = await readJson(source);
      if (document.error === 'missing') {
        return {
          diagnostics: Object.freeze([finding(
            'AB7322',
            `Cursor plugin ${JSON.stringify(pluginDirectory)} declares hooks at ${JSON.stringify(hooksSource.declared)} but that file is missing; Cursor loads no hooks for it.`,
            'Reinstall the plugin from a bundle whose hooks document exists.',
            'error',
          )]),
          registration: Object.freeze({ ...none, source, state: 'missing' }),
        };
      }
      parsed = document.error === undefined ? parseHooksDocument(document.value) : undefined;
      break;
    }
    case 'inline':
      source = '.cursor-plugin/plugin.json#hooks';
      parsed = parseHooksDocument(hooksSource.value);
      break;
    case 'invalid':
      source = '.cursor-plugin/plugin.json#hooks';
      parsed = undefined;
      break;
    default: {
      const exhaustive: never = hooksSource;
      throw new TypeError(`Unexpected Cursor hooks source ${String(exhaustive)}.`);
    }
  }
  if (parsed === undefined) {
    return {
      diagnostics: Object.freeze([finding(
        'AB7322',
        `Cursor plugin ${JSON.stringify(pluginDirectory)} hooks document ${JSON.stringify(source)} is not a valid ` +
          '`{ "version": 1, "hooks": { <event>: [{ "command": ... } | { "type": "prompt", "prompt": ... }] } }` document; Cursor loads no hooks for it.',
        'Rebuild and reinstall the plugin; the hooks document the manifest names must follow the pinned Cursor hooks schema.',
        'error',
      )]),
      registration: Object.freeze({ ...none, source, state: 'stale' }),
    };
  }
  const missingScripts: string[] = [];
  for (const command of parsed.commands) {
    for (const script of pluginRelativeScripts(command, pluginDirectory)) {
      if (!(await regularFile(script))) missingScripts.push(script);
    }
  }
  const duplicates = await userHookDuplicates(home, pluginDirectory, options.caseInsensitivePaths ?? caseInsensitivePaths);
  const registration: CursorHooksRegistration = Object.freeze({
    commands: parsed.commands.length,
    duplicates: duplicates.duplicates,
    events: Object.freeze(parsed.events),
    source,
    state: missingScripts.length > 0 ? 'stale' : 'registered',
  });
  const diagnostics: Diagnostic[] = [];
  if (missingScripts.length > 0) {
    diagnostics.push(finding(
      'AB7322',
      `Cursor plugin ${JSON.stringify(pluginDirectory)} registers ${parsed.commands.length} hook command(s) but ` +
        `${missingScripts.length} target script(s) are missing under the plugin root (${missingScripts.map((path) => JSON.stringify(path)).join(', ')}).`,
      'Reinstall the plugin so every ${CURSOR_PLUGIN_ROOT}-relative hook script exists.',
      'error',
    ));
  } else if (parsed.events.length > 0) {
    const shape = parsed.prompts > 0
      ? `${parsed.commands.length} command(s), ${parsed.prompts} prompt hook(s)`
      : `${parsed.commands.length} command(s)`;
    diagnostics.push(finding(
      'AB7322',
      `Cursor plugin ${JSON.stringify(pluginDirectory)} registers plugin-scoped hooks for ${parsed.events.join(', ')} ` +
        `(${shape}) through its manifest; Cursor runs them from the plugin root with ${pluginRootToken} substituted.`,
      'No action needed; Cursor delivers manifest hooks without a ~/.cursor/hooks.json entry.',
      'info',
    ));
  }
  diagnostics.push(...duplicates.diagnostics);
  return { diagnostics: Object.freeze(diagnostics), registration };
};

export interface CursorMarketplaceStagingFinding {
  readonly commit?: string;
  readonly entry: string;
  readonly marketplace?: string;
  readonly name: string;
  readonly path: string;
  readonly state: 'corrupt' | 'registered' | 'unregistered';
  readonly version?: string;
}

/**
 * Cursor's cache is partitioned per marketplace: `plugins/cache/<sanitize(marketplaceSlug)>/<pluginId>/<version>`
 * (observed 2026-09-03; e.g. `cache/cursor-public/continual-learning/<sha>/`), and Cursor writes an empty
 * `.cache-complete` receipt beside `.cursor-plugin/` once the copy finished. The `<version>` segment observed
 * for Git-backed marketplaces is the marketplace commit SHA. Only a receipted entry in the staged
 * marketplace's partition whose segment equals the staged HEAD commit (the plugin version is used only when
 * no commit is known) proves that *this* staged repository was imported; the same plugin cached from another
 * marketplace, a receipt from an earlier staging commit, or a half-written cache directory, does not.
 * Malformed cache entries are skipped rather than aborting Doctor.
 */
const sanitizeCacheSegment = (segment: string): string => segment.replaceAll(/[^A-Za-z0-9._-]/gu, '-');

export const cacheHasPlugin = async (
  home: string,
  marketplace: string,
  name: string,
  version: string | undefined,
  commit: string | undefined,
): Promise<boolean> => {
  const pluginRoot = join(home, '.cursor', 'plugins', 'cache', sanitizeCacheSegment(marketplace), sanitizeCacheSegment(name));
  let segments: readonly string[];
  try {
    segments = await readdir(pluginRoot);
  } catch {
    return false;
  }
  // The staged commit is the only segment that proves *this* staging was imported; the plugin version is
  // a fallback solely when no commit is known.
  const expectedSegment = commit ?? version;
  for (const segment of segments) {
    if (expectedSegment !== undefined && segment !== sanitizeCacheSegment(expectedSegment)) continue;
    if (!(await regularFile(join(pluginRoot, segment, '.cache-complete')))) continue;
    const installed = await readJson(join(pluginRoot, segment, '.cursor-plugin', 'plugin.json'));
    if (installed.error !== undefined || !Predicate.isObject(installed.value)) continue;
    if (installed.value.name !== name) continue;
    if (version === undefined || installed.value.version === version) return true;
  }
  return false;
};

const isCommitSha = (value: string | undefined): value is string => value !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);

/** Resolves HEAD to a commit SHA; `undefined` when HEAD is missing, unreadable, malformed, or unborn. */
export const readHeadCommit = async (repoRoot: string): Promise<string | undefined> => {
  try {
    const head = (await readFile(join(repoRoot, '.git', 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref: ')) return isCommitSha(head) ? head : undefined;
    const ref = head.slice('ref: '.length);
    let resolved: string | undefined;
    try {
      resolved = (await readFile(join(repoRoot, '.git', ref), 'utf8')).trim();
    } catch {
      const packed = await readFile(join(repoRoot, '.git', 'packed-refs'), 'utf8');
      resolved = packed.split('\n').find((candidate) => candidate.endsWith(` ${ref}`))?.split(' ')[0];
    }
    return isCommitSha(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Runs `git <args>` in `cwd` for read-only verification; resolves `undefined` when git is not installed,
 * in which case object-level checks are skipped and only the ref text is validated.
 */
export type CursorStagingGit = (
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly exitCode: number | null; readonly stdout: string } | undefined>;

type StagedRepositoryIntegrity = 'dirty' | 'missing-object' | 'ok' | 'unverified';

/**
 * Cursor imports the commit HEAD names, not the working tree and not the ref text. A syntactically valid SHA whose
 * object is absent (`git cat-file -e <sha>^{commit}`) cannot be imported, and a working tree that differs from HEAD
 * (`git status --porcelain`, including ignored files) means the bytes Doctor hashed are not the bytes Cursor holds.
 * `--no-optional-locks` keeps the probe read-only (no index refresh).
 */
const verifyStagedRepository = async (
  git: CursorStagingGit | undefined,
  repoRoot: string,
  commit: string,
): Promise<StagedRepositoryIntegrity> => {
  if (git === undefined) return 'unverified';
  const object = await git(['cat-file', '-e', `${commit}^{commit}`], repoRoot);
  if (object === undefined) return 'unverified';
  if (object.exitCode !== 0) return 'missing-object';
  const status = await git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--ignored=matching'], repoRoot);
  if (status === undefined) return 'unverified';
  if (status.exitCode !== 0 || status.stdout.trim() !== '') return 'dirty';
  return 'ok';
};

/** Inventory the Agent Bundle-owned staged Cursor marketplaces and whether Cursor has imported them. */
export const inspectCursorMarketplaceStaging = async (
  home: string,
  git?: CursorStagingGit,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly findings: readonly CursorMarketplaceStagingFinding[] }> => {
  const root = cursorMarketplaceRoot(join(home, '.cursor'));
  let entries: readonly string[];
  try {
    entries = (await readdir(root)).sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { diagnostics: Object.freeze([]), findings: Object.freeze([]) };
    return {
      diagnostics: Object.freeze([finding(
        'AB7324',
        `Staged Cursor marketplaces at ${JSON.stringify(root)} could not be read; Doctor cannot tell whether a marketplace-mode install awaits import.`,
        'Repair permissions for the Agent Bundle marketplace staging directory or remove it and rerun `agent-bundle install cursor --mode marketplace`.',
        'error',
      )]),
      findings: Object.freeze([]),
    };
  }
  const diagnostics: Diagnostic[] = [];
  const findings: CursorMarketplaceStagingFinding[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const path = join(root, entry);
    // Only directories can be staged repositories; a stray file in the staging root is not a finding.
    if (!(await directory(path))) continue;
    const manifest = await readJson(join(path, '.cursor-plugin', 'marketplace.json'));
    const plugin = await readJson(join(cursorMarketplacePluginPath(path, entry), '.cursor-plugin', 'plugin.json'));
    const marketplace = manifest.error === undefined && Predicate.isObject(manifest.value) && typeof manifest.value.name === 'string'
      ? manifest.value.name
      : undefined;
    const version = plugin.error === undefined && Predicate.isObject(plugin.value) && typeof plugin.value.version === 'string'
      ? plugin.value.version
      : undefined;
    // The whole manifest must satisfy the pinned closed marketplace schema; Cursor rejects imports that do not.
    const manifestValid = manifest.error === undefined && validateMarketplaceDocument(manifest.value);
    const listsPlugin = manifestValid && Predicate.isObject(manifest.value) && Array.isArray(manifest.value.plugins) &&
      manifest.value.plugins.some((candidate: unknown) =>
        Predicate.isObject(candidate) && candidate.name === entry && candidate.source === `plugins/${entry}`);
    const pluginNamed = plugin.error === undefined && validatePluginDocument(plugin.value) &&
      Predicate.isObject(plugin.value) && plugin.value.name === entry;
    const commit = (await directory(join(path, '.git'))) ? await readHeadCommit(path) : undefined;
    if (marketplace === undefined || !listsPlugin || !pluginNamed || commit === undefined) {
      findings.push({ entry, name: entry, path, state: 'corrupt', ...(marketplace === undefined ? {} : { marketplace }) });
      diagnostics.push(finding(
        'AB7324',
        `Staged Cursor marketplace ${JSON.stringify(path)} is incomplete (marketplace.json missing, failing the pinned ` +
          `marketplace schema, or not listing ${entry} at plugins/${entry}; plugins/${entry}/.cursor-plugin/plugin.json ` +
          `missing, failing the pinned plugin schema, or not named ${entry}; or no committed Git HEAD).`,
        'Remove the staged directory and rerun `agent-bundle install cursor --mode marketplace`.',
        'error',
      ));
      continue;
    }
    const integrity = await verifyStagedRepository(git, path, commit);
    if (integrity === 'missing-object' || integrity === 'dirty') {
      findings.push({ commit, entry, marketplace, name: entry, path, state: 'corrupt', ...(version === undefined ? {} : { version }) });
      diagnostics.push(finding(
        'AB7324',
        integrity === 'missing-object'
          ? `Staged Cursor marketplace ${JSON.stringify(path)} names HEAD ${commit} but that commit object does not exist in the repository; Cursor cannot import it.`
          : `Staged Cursor marketplace ${JSON.stringify(path)} has a working tree that differs from committed HEAD ${commit}; Cursor imports the commit, so the staged files are not what Cursor would install.`,
        'Remove the staged directory and rerun `agent-bundle install cursor --mode marketplace`.',
        'error',
      ));
      continue;
    }
    const registered = await cacheHasPlugin(home, marketplace, entry, version, commit);
    findings.push({
      commit,
      entry,
      marketplace,
      name: entry,
      path,
      state: registered ? 'registered' : 'unregistered',
      ...(version === undefined ? {} : { version }),
    });
    diagnostics.push(registered
      ? finding(
        'AB7324',
        `Staged Cursor marketplace ${marketplace} (${entry}@${version ?? 'unknown'}) is imported: Cursor holds a completed (.cache-complete) copy under ~/.cursor/plugins/cache/${marketplace}.`,
        'No action needed.',
        'info',
      )
      : finding(
        'AB7324',
        `Staged Cursor marketplace ${marketplace} at ${JSON.stringify(path)} is not yet imported by Cursor (no completed ${entry}@${version ?? 'unknown'} copy under ~/.cursor/plugins/cache/${marketplace}).`,
        `In Cursor open Customize -> Plugins -> "Add Plugins from Local Repository", select ${path}, then install ${entry}; or use \`agent-bundle install cursor --mode local\`.`,
        'warning',
      ));
  }
  return { diagnostics: Object.freeze(diagnostics), findings: Object.freeze(findings) };
};
