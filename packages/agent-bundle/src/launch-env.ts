/**
 * The operator `.env` layer of an installed pack (#469): plain Node, no
 * framework dependency, so every emitted stdio MCP entry, standalone hook
 * wrapper, and artifact CLI executable can carry it without growing.
 *
 * `agent-bundle mcp run` already composes manifest env < `.env` files <
 * `process.env` for the server it spawns. Hosts launch installed packs
 * directly, so the emitted shells apply the same layer themselves: the file
 * fills only variables the host did not set, so an exported variable always
 * wins. A host merges the manifest `env` block into the child environment
 * before launch, so by the time a shell runs a manifest default is
 * indistinguishable from an exported variable — unless the shell knows the
 * defaults. The stdio MCP shell therefore carries its server's manifest `env`
 * (`manifestEnv`); a variable that still holds its manifest default is not
 * reserved, so the file beats manifest env exactly as under `mcp run`.
 * Values are never logged.
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
   * The manifest `env` defaults the host merged into `env` before launch (the
   * stdio server's declared block, as built). A variable whose current value
   * equals its default is treated as the pass-through it almost always is,
   * so the file may override it; one that differs was exported by the host or
   * the operator and stays reserved. The one ambiguity is accepted: an
   * operator export that equals the manifest default reads as the default.
   * A default that still carries a path token never matches its expanded
   * value, so such a variable stays reserved.
   */
  readonly manifestEnv?: Readonly<Record<string, string>>;
  /**
   * The platform whose environment-key rules apply; `process.platform` by
   * default. Windows environment names are case-insensitive, so a host `Path`
   * reserves `PATH` there.
   */
  readonly platform?: NodeJS.Platform;
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
 * Like the runtime, only the blank check reads a trimmed copy: a configured
 * path is resolved exactly as written, so both resolutions name one directory.
 */
export const operatorEnvPluginRoot = (
  fallback: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const declared = env['AGENT_BUNDLE_PLUGIN_ROOT'] ?? '';
  return declared.trim() === '' || unexpandedToken.test(declared) ? resolve(fallback) : resolve(declared);
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

/** The index of the first unescaped `quote` after the opening one, or -1 while the value is still open. */
const closingQuoteIndex = (raw: string, quote: string): number => {
  for (let index = 1; index < raw.length; index += 1) {
    if (raw[index] === '\\') {
      index += 1;
      continue;
    }
    if (raw[index] === quote) return index;
  }
  return -1;
};

/** An unquoted value ends at the first ` #` comment. */
const unquotedValue = (raw: string): string => {
  const value = raw.trim();
  const comment = value.search(/\s#/u);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
};

const quotedValue = (quote: string, inner: string): string =>
  quote === '"' ? inner.replace(/\\n/gu, '\n').replace(/\\r/gu, '\r').replace(/\\"/gu, '"') : inner;

/**
 * The dotenv grammar the shells accept: `KEY=value` lines, an optional
 * `export ` prefix, blank lines and `#` comments (including after a closing
 * quote: `TOKEN="secret" # note`), single-, double-, or backtick-quoted values
 * (double quotes expand `\n`, `\r`, `\"`), and a multi-line double- or
 * single-quoted value that closes on a later line. No `${VAR}` interpolation
 * — a value is used exactly as written. Later lines win over earlier ones for
 * the same key.
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
    if (quote === '"' || quote === "'" || quote === '`') {
      // A double- or single-quoted value continues onto later lines until its
      // closing quote; what follows the closing quote may only be a comment.
      let end = closingQuoteIndex(raw, quote);
      while (end === -1 && quote !== '`' && index + 1 < lines.length) {
        index += 1;
        raw += `\n${lines[index]!}`;
        end = closingQuoteIndex(raw, quote);
      }
      if (end !== -1) {
        const trailer = raw.slice(end + 1).trim();
        if (trailer === '' || trailer.startsWith('#')) {
          parsed[key] = quotedValue(quote, raw.slice(1, end));
          continue;
        }
      }
    }
    // Unterminated or followed by something other than a comment: dotenv reads
    // the line as an unquoted value, quotes and all.
    parsed[key] = unquotedValue(raw);
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
 * the host did not set (a variable still holding its `manifestEnv` default
 * counts as unset), and reports what happened without ever touching a
 * value. Missing files are the normal case (most packs need none); an
 * unreadable one is reported and skipped, never fatal — a pack must start
 * even when its operator file has the wrong permissions.
 */
export const applyOperatorEnv = (options: OperatorEnvOptions): OperatorEnvResult => {
  const env = options.env ?? process.env;
  // Windows environment names are case-insensitive: a host `Path` reserves
  // `PATH`, so the file may not overwrite it under another spelling.
  const reservedKey = (options.platform ?? process.platform) === 'win32'
    ? (key: string): string => key.toUpperCase()
    : (key: string): string => key;
  const manifestDefaults = new Map(
    Object.entries(options.manifestEnv ?? {}).map(([key, value]) => [reservedKey(key), value] as const),
  );
  // A variable the host passed through unchanged from the manifest is the
  // lowest layer under `mcp run` too, so the file may fill it; anything
  // else present was exported by the host or the operator and is reserved.
  const reserved = new Set(
    Object.keys(env)
      .filter((key) => env[key] !== undefined && manifestDefaults.get(reservedKey(key)) !== env[key])
      .map(reservedKey),
  );
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
      if (reserved.has(reservedKey(key))) continue;
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
