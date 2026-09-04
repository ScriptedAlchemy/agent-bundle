/**
 * The operator `.env` layer of an installed pack (#469): plain Node, no
 * framework dependency, so every emitted stdio MCP entry, standalone hook
 * wrapper, and artifact CLI executable can carry it without growing.
 *
 * `agent-bundle mcp run` already composes manifest env < `.env` files <
 * `process.env` for the server it spawns. Hosts launch installed packs
 * directly, so the emitted shells apply the same layer themselves: the file
 * fills only variables the host did not set, so an exported variable always
 * wins, and manifest env (already in `process.env` by the time a shell runs)
 * loses to the file exactly as under `mcp run`. Values are never logged.
 */
import { readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

/**
 * Names the file(s) to read instead of the plugin root's `.env` / `.env.local`
 * pair: one path, or several joined by the platform path delimiter, applied
 * in order (later files win). The value `none` disables the layer — which is
 * what `agent-bundle mcp run --no-env` hands its child, so the shell's own
 * layer never re-adds what the operator asked to leave out.
 */
export const OPERATOR_ENV_FILE_VARIABLE = 'AGENT_BUNDLE_ENV_FILE';

/** The `AGENT_BUNDLE_ENV_FILE` value that disables the operator env layer. */
export const OPERATOR_ENV_FILE_NONE = 'none';

/** The conventional files, lowest priority first: `.env.local` overrides `.env`. */
export const OPERATOR_ENV_FILE_NAMES: readonly string[] = Object.freeze(['.env', '.env.local']);

export interface OperatorEnvFile {
  readonly path: string;
  /** `applied` counts the variables this file set; `absent` means the file does not exist. */
  readonly state: 'absent' | 'loaded' | 'unreadable';
  readonly applied?: number;
}

export interface OperatorEnvResult {
  /** The files considered, in the order they were applied. */
  readonly files: readonly OperatorEnvFile[];
  /** The variables the layer set, sorted; a name only, never a value. */
  readonly applied: readonly string[];
}

export interface OperatorEnvOptions {
  /** The environment to fill; `process.env` by default. Mutated in place. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The plugin root the files live under: the expanded `AGENT_BUNDLE_PLUGIN_ROOT`
   * when the host set one, otherwise the shell's own fallback (the artifact root
   * — the parent of `mcp/`, `bin/`, `hooks/` — or the caller's `.agent-bundle`).
   */
  readonly pluginRoot: string;
}

const unexpandedToken = /\$\{[^}]*\}/u;

/**
 * The plugin root an emitted shell reads its operator files from: the same
 * precedence the runtime's `resolvePluginRoot` applies (an expanded
 * `AGENT_BUNDLE_PLUGIN_ROOT`, else the shell's fallback), spelled here without
 * a runtime import so the shared-runtime hook wrapper stays dependency-free.
 */
export const operatorEnvPluginRoot = (
  fallback: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const declared = env['AGENT_BUNDLE_PLUGIN_ROOT']?.trim() ?? '';
  return declared === '' || unexpandedToken.test(declared) ? resolve(fallback) : resolve(declared);
};

/**
 * The files a launch considers, in application order: the explicit
 * `AGENT_BUNDLE_ENV_FILE` list, nothing for `none`, or the plugin root's
 * conventional pair.
 */
export const operatorEnvFilePaths = (
  pluginRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] => {
  const explicit = env[OPERATOR_ENV_FILE_VARIABLE]?.trim() ?? '';
  if (explicit === OPERATOR_ENV_FILE_NONE) return Object.freeze([]);
  if (explicit !== '') {
    return Object.freeze(explicit.split(delimiter).map((path) => path.trim()).filter((path) => path !== '').map((path) => resolve(path)));
  }
  return Object.freeze(OPERATOR_ENV_FILE_NAMES.map((name) => join(pluginRoot, name)));
};

const unquote = (raw: string): string => {
  const value = raw.trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === '`') && value.endsWith(quote)) {
      const inner = value.slice(1, -1);
      return quote === '"' ? inner.replace(/\\n/gu, '\n').replace(/\\r/gu, '\r').replace(/\\"/gu, '"') : inner;
    }
  }
  // An unquoted value ends at the first ` #` comment.
  const comment = value.search(/\s#/u);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
};

/**
 * The dotenv grammar the shells accept: `KEY=value` lines, an optional
 * `export ` prefix, blank lines and `#` comments, single-, double-, or
 * backtick-quoted values (double quotes expand `\n`, `\r`, `\"`), and a
 * multi-line double- or single-quoted value that closes on a later line. No
 * `${VAR}` interpolation — a value is used exactly as written. Later lines
 * win over earlier ones for the same key.
 */
export const parseOperatorEnv = (contents: string): Record<string, string> => {
  const parsed: Record<string, string> = {};
  const lines = contents.replace(/\r\n?/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(line);
    if (match === null) continue;
    const key = match[1]!;
    let raw = match[2]!.trim();
    const quote = raw[0];
    if (quote === '"' || quote === "'") {
      // A quoted value continues until a line ends with the closing quote.
      const closed = (): boolean => raw.length >= 2 && raw.endsWith(quote) && !raw.endsWith(`\\${quote}`);
      while (!closed() && index + 1 < lines.length) {
        index += 1;
        raw += `\n${lines[index]!}`;
      }
    }
    parsed[key] = unquote(raw);
  }
  return parsed;
};

const readOptional = (path: string): string | undefined | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
};

/**
 * Applies the operator `.env` layer to `env` in place, filling only variables
 * the host did not set, and reports what happened without ever touching a
 * value. Missing files are the normal case (most packs need none); an
 * unreadable one is reported and skipped, never fatal — a pack must start
 * even when its operator file has the wrong permissions.
 */
export const applyOperatorEnv = (options: OperatorEnvOptions): OperatorEnvResult => {
  const env = options.env ?? process.env;
  const reserved = new Set(Object.keys(env).filter((key) => env[key] !== undefined));
  const files: OperatorEnvFile[] = [];
  const applied = new Set<string>();
  for (const path of operatorEnvFilePaths(options.pluginRoot, env)) {
    const contents = readOptional(path);
    if (contents === undefined) {
      files.push({ path, state: 'absent' });
      continue;
    }
    if (contents === null) {
      files.push({ path, state: 'unreadable' });
      continue;
    }
    let count = 0;
    for (const [key, value] of Object.entries(parseOperatorEnv(contents))) {
      if (reserved.has(key)) continue;
      env[key] = value;
      applied.add(key);
      count += 1;
    }
    files.push({ applied: count, path, state: 'loaded' });
  }
  return Object.freeze({
    applied: Object.freeze([...applied].sort((left, right) => left.localeCompare(right))),
    files: Object.freeze(files),
  });
};
