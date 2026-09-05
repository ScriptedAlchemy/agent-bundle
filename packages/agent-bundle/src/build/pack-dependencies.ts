import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { posix, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import npa from 'npm-package-arg';
import ts from 'typescript-5';

import { isErrno } from '../core/errors.ts';
import { isRecord } from '../core/strict-json.ts';

/**
 * Evidence for the npm prepack dependency gate (`AB7014`/`AB7015`, emitted by
 * `pack-inventory.ts`): how a consumer's npm reads each `package.json`
 * dependency entry, and which of them a consumer must have installed — the
 * packages the packed declaration files reference, as TypeScript reads them,
 * and the packages the consumer-side install scripts name or run. Packed
 * JavaScript is never read: a compiled bundle inlines its imports (`AB6005`),
 * and a prebuilt payload declares what it loads (`runtimeDependencies`).
 */

/** Relative, package-imports (`#`), absolute, and URL-scheme specifiers (`node:`, `data:`, `file:`, `C:\`) name no package. */
const nonPackageSpecifier = /^(?:[.#/]|[a-z][a-z0-9+.-]*:)/iu;
/** `@scope/name` or `name`; a subpath after it is dropped. */
const packageNamePrefix = /^(?:@[^/]+\/)?[^@/][^/]*/u;

/** The package name an import specifier resolves through, or `undefined` for anything that is not a bare specifier. */
export const packageNameOf = (specifier: string): string | undefined =>
  nonPackageSpecifier.test(specifier) || isBuiltin(specifier) ? undefined : packageNamePrefix.exec(specifier)?.[0];

/**
 * Protocols only a workspace manager understands. pnpm, Yarn, and Bun
 * rewrite them to registry versions while packing; npm publishes them
 * verbatim and every consumer then fails with `EUNSUPPORTEDPROTOCOL`.
 */
const workspaceProtocol = /^(?:workspace|catalog):/u;

/** Exact-prefix, as the packers test it: `" workspace:*"` is rewritten by none of them and published verbatim. */
export const isWorkspaceProtocol = (specifier: string): boolean => workspaceProtocol.test(specifier);

/**
 * How a consumer's npm reads one dependency entry, name and specifier
 * together:
 *
 * - `registry`: a version, range, dist-tag, or `npm:` alias of one — resolved
 *   through the registry, the only kind a published package can rely on.
 * - `fetched`: parseable, but a git, remote-tarball, or path source. npm 12
 *   refuses the first two by default (`allow-git=none`, `allow-remote=none`)
 *   and a path never exists on the consumer's disk; an optional entry
 *   survives the failed fetch, any other kind fails the install.
 * - `unparseable`: npm rejects the manifest before fetching anything —
 *   `EINVALIDPACKAGENAME`, `EUNSUPPORTEDPROTOCOL` (`workspace:`, `catalog:`,
 *   `link:`, a typo), `EINVALIDTAGNAME`, an alias of a non-registry target,
 *   or an invalid URL — whichever field declares it, even a peer it would
 *   never install.
 *
 * The verdict is npm's own: `npm-package-arg` is the parser npm, Arborist,
 * and pacote share, so the gate agrees with the consumer's install by
 * construction rather than by imitating its grammar. Whether the packer
 * rewrites a workspace protocol first is the caller's policy
 * (`isWorkspaceProtocol`).
 */
export type DependencyKind = 'registry' | 'fetched' | 'unparseable';

/**
 * Where the package would be installed from, for path specifiers: a directory
 * deep enough that `file:../sibling` stays distinguishable from a path inside
 * the package. Nothing touches the disk.
 */
const packageAnchor = '/package/root';

export const classifyDependency = (name: string, specifier: string): DependencyKind => {
  try {
    // The manifest value exactly as npm reads it: `" npm:bar@1"` is an invalid dist-tag, not an alias.
    return npa.resolve(name, specifier, packageAnchor).registry === true ? 'registry' : 'fetched';
  } catch {
    return 'unparseable';
  }
};

/**
 * The tarball-relative path a `file:` or bare path specifier reads from, when
 * it stays inside the package: `vendor/foo` for `file:vendor/foo`,
 * `vendor/foo.tgz` for `file:vendor/foo.tgz`. npm installs such a dependency
 * from the consumer's own `node_modules/<package>` copy, so shipping the
 * source in the tarball makes it installable without a registry. `undefined`
 * for anything else, including a path that escapes the package
 * (`file:../sibling`), which no consumer has.
 */
export const packagedSourcePath = (name: string, specifier: string): string | undefined => {
  try {
    const parsed = npa.resolve(name, specifier, packageAnchor);
    if ((parsed.type !== 'directory' && parsed.type !== 'file') || typeof parsed.fetchSpec !== 'string') return undefined;
    const path = relative(packageAnchor, parsed.fetchSpec).split('\\').join('/');
    return path === '' || path.startsWith('../') || path.startsWith('/') ? undefined : path;
  } catch {
    return undefined;
  }
};

const nulTerminated = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString('utf8');
};

const octalField = (bytes: Uint8Array): number | undefined => {
  const text = nulTerminated(bytes).trim();
  return /^[0-7]*$/u.test(text) ? Number.parseInt(text || '0', 8) : undefined;
};

/** Whether a 512-byte ustar header's stored checksum matches its bytes (the checksum field itself read as spaces). */
const headerChecksumValid = (header: Buffer): boolean => {
  const stored = octalField(header.subarray(148, 156));
  if (stored === undefined) return false;
  let sum = 0;
  for (const [index, byte] of header.entries()) sum += index >= 148 && index < 156 ? 0x20 : byte;
  return sum === stored;
};

/**
 * Whether a tar archive holds a package npm can install: an entry
 * `<dir>/package.json` one level down (the layout npm strips one component
 * from on install) whose payload parses to a JSON object. Headers are the
 * 512-byte ustar records, each with a valid checksum and a payload within the
 * archive; an all-zero record ends the archive. A malformed or truncated
 * archive (`TAR_BAD_ARCHIVE`) or a manifest that does not parse (`EJSONPARSE`)
 * fails the consumer's install, so neither counts.
 */
const tarHoldsPackage = (archive: Buffer): boolean => {
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return false;
    const size = octalField(header.subarray(124, 136));
    if (size === undefined || !headerChecksumValid(header) || offset + 512 + size > archive.length) return false;
    const name = nulTerminated(header.subarray(0, 100));
    const prefix = nulTerminated(header.subarray(345, 500));
    if (/^[^/]+\/package\.json$/u.test(prefix === '' ? name : `${prefix}/${name}`)) {
      try {
        const parsed: unknown = JSON.parse(archive.subarray(offset + 512, offset + 512 + size).toString('utf8'));
        return isRecord(parsed);
      } catch {
        return false;
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return false;
};

/**
 * Whether the packed copy of a `file:` source is one npm can install from:
 * a directory whose packed `package.json` parses to an object, or a packed
 * tarball — gzipped or plain — holding a package. A path that merely exists
 * under the right name (`foo.tgz` that is not an archive) fails the consumer's
 * install with `TAR_BAD_ARCHIVE`, so it is not installable.
 */
export const packagedSourceInstallable = async (
  projectRoot: string,
  source: string,
  packed: ReadonlySet<string>,
): Promise<boolean> => {
  if (packed.has(`${source}/package.json`)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(resolve(projectRoot, source, 'package.json'), 'utf8'));
      return isRecord(parsed);
    } catch {
      return false;
    }
  }
  if (!packed.has(source)) return false;
  let bytes: Buffer;
  try {
    bytes = await readFile(resolve(projectRoot, source));
  } catch {
    return false;
  }
  let archive = bytes;
  try {
    archive = gunzipSync(bytes);
  } catch {
    // Not gzipped: a plain `.tar`, or not an archive at all — the header scan decides.
  }
  return tarHoldsPackage(archive);
};

/** The `bin` commands of each declared dependency, by package name; the unscoped name stands in when no manifest is readable. */
type ExecutableCommands = ReadonlyMap<string, readonly string[]>;

const declarationSuffix = /\.d\.[cm]?ts$/u;

/** Every string target in a `package.json` `imports` map, through conditional and nested targets. */
const importMapTargets = (value: unknown): readonly string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(importMapTargets);
  return isRecord(value) ? Object.values(value).flatMap(importMapTargets) : [];
};

/**
 * The targets the manifest's `imports` map gives one `#specifier`, resolved
 * the way Node does: the exact key, or else the pattern key `#prefix*suffix`
 * with the longest prefix (then the longest key) the specifier matches, its
 * `*` in every target replaced by the matched segment (`#setup/foo` through
 * `"#setup/*": "./scripts/*.js"` is `./scripts/foo.js`). Which conditional
 * target Node then picks depends on conditions, so every target of the
 * matched key is a candidate; a specifier no key matches reaches nothing.
 */
const packageImportTargets = (packageDocument: Readonly<Record<string, unknown>>, specifier: string): readonly string[] => {
  const imports = packageDocument.imports;
  if (!isRecord(imports)) return [];
  if (!specifier.includes('*') && Object.hasOwn(imports, specifier)) return importMapTargets(imports[specifier]);
  let best: { readonly key: string; readonly prefix: string; readonly suffix: string } | undefined;
  for (const key of Object.keys(imports)) {
    const star = key.indexOf('*');
    if (star === -1 || key.includes('*', star + 1)) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (specifier.length < key.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (best === undefined || prefix.length > best.prefix.length || (prefix.length === best.prefix.length && key.length > best.key.length)) {
      best = { key, prefix, suffix };
    }
  }
  if (best === undefined) return [];
  const segment = specifier.slice(best.prefix.length, specifier.length - best.suffix.length);
  return importMapTargets(imports[best.key]).map((target) => target.replaceAll('*', segment));
};

/**
 * The lifecycle scripts npm runs when installing a package from a registry
 * or tarball. `prepare` is not one: npm runs it on `pack`, on local and
 * `link:` installs, and for git dependencies — never for the published
 * tarball — so a package it alone names is one every consumer installs for
 * nothing.
 */
const installScripts = ['preinstall', 'install', 'postinstall'] as const;

/**
 * The segments of one shell word: a double-quoted one, in which a backslash
 * escapes `"`, `\`, `$`, `` ` ``, and a newline and is literal before anything
 * else; a single-quoted one, in which nothing escapes; and an unquoted
 * backslash escape, `\x` being `x` and `\<newline>` a continuation. Unquoted
 * text between them stands as written.
 */
const shellSegment = /"((?:[^"\\\n]|\\[\s\S])*)"|'([^'\n]*)'|\\([\s\S])/gu;
const doubleQuotedEscape = /\\([\\"$`\n])/gu;

/** The text a shell word denotes: quotes removed and escapes resolved, segment by segment. */
const unquoteShellWord = (word: string): string => word.replace(
  shellSegment,
  (_segment, doubleQuoted: string | undefined, singleQuoted: string | undefined, escaped: string | undefined) => {
    if (doubleQuoted !== undefined) return doubleQuoted.replace(doubleQuotedEscape, (_escape, char: string) => (char === '\n' ? '' : char));
    if (singleQuoted !== undefined) return singleQuoted;
    return escaped === '\n' ? '' : escaped ?? '';
  },
);

/**
 * A shell command's words: quoted arguments kept whole and unquoted (`node
 * "scripts/my install.cjs"` is two words, `--import="./setup.mjs"` one),
 * backslash escapes resolved (`"require(\"driver\")"` is
 * `require("driver")`, `\"quoted\"` is `"quoted"`, `'lit\eral'` keeps its
 * backslash), and the operators `&&`, `||`, `;`, `|`, `&` split off even
 * without surrounding whitespace (`node install.js&&echo done` is four
 * words). A newline is an operator too: it ends a command as `;` does, and is
 * how `installScriptText` joins one script's body to the next.
 */
export const shellWords = (command: string): readonly string[] =>
  Array.from(
    command.matchAll(/(?:"(?:[^"\\\n]|\\[\s\S])*"|'[^'\n]*'|(?:[^\s"'&|;\\]|\\[\s\S])+)+|&&|\|\||[;|&\n]/gu),
    (match) => unquoteShellWord(match[0]),
  );

const unscopedName = (name: string): string => name.replace(/^@[^/]+\//u, '');

/**
 * The executables a dependency puts on `PATH`, from its own manifest under
 * `node_modules`. A string-form `bin` is one command named after the installed
 * manifest's unscoped `name` — `real` for an alias `"wrapper":
 * "npm:@scope/real@1"`, not `wrapper`. When the manifest is unreadable —
 * absent, not JSON, or not an object — the dependency's unscoped name stands
 * in (npm's default bin name); a broken install never fails the gate.
 */
const executableCommands = async (names: readonly string[], projectRoot: string): Promise<ExecutableCommands> => {
  const readManifest = async (name: string): Promise<Readonly<Record<string, unknown>> | undefined> => {
    try {
      // Plain `JSON.parse`, not `core/strict-json.ts`: this is a third party's manifest read as npm reads it, where a
      // duplicate key's last value wins and decides the `bin` name; our own strict config rules do not apply to it.
      const parsed: unknown = JSON.parse(await readFile(resolve(projectRoot, 'node_modules', name, 'package.json'), 'utf8'));
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const binCommands = async (name: string): Promise<readonly string[]> => {
    const parsed = await readManifest(name);
    if (parsed === undefined) return [unscopedName(name)];
    const bin = parsed.bin;
    if (isRecord(bin)) return Object.keys(bin);
    if (typeof bin !== 'string') return [];
    return [unscopedName(typeof parsed.name === 'string' ? parsed.name : name)];
  };
  return new Map(await Promise.all(names.map(async (name) => [name, await binCommands(name)] as const)));
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * Dependencies a consumer's install lifecycle mentions: npm puts every
 * dependency's executables on `PATH` for `preinstall`/`install`/`postinstall`,
 * so a script that names a dependency, or one of its `bin` commands, anywhere
 * may need it installed even though nothing else references it. Keep-only
 * evidence for `AB7014`: a mention in an argument or `echo` string cannot
 * report a dependency, but neither does it prove the script runs it.
 */
const installScriptMentions = (text: string, executables: ExecutableCommands): readonly string[] => {
  if (text === '') return [];
  const runs = (command: string): boolean => new RegExp(String.raw`(?<![\w-])${escapeRegExp(command)}(?![\w-])`, 'u').test(text);
  return [...executables]
    .filter(([name, commands]) => text.includes(name) || commands.some(runs))
    .map(([name]) => name);
};

const shellOperators = new Set(['&&', '||', ';', '|', '&', '\n']);
/** An environment assignment before the command proper (`FOO=1 node x`), also the form `cross-env` and `env` take: name, then value. */
const environmentAssignment = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/u;
/** Words a shell command may start with before the command proper, besides environment assignments: options, and wrappers that exec their argument. */
const commandPrefix = /^(?:-|npx$|bunx$|cross-env$|env$|exec$|dotenv$|nice$|time$)/u;
const packageManagers = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const execSubcommands = new Set(['exec', 'dlx', 'x']);
/** npm's `run` and its aliases; each runs the script the first positional names. */
const runSubcommands = new Set(['run', 'run-script', 'rum', 'urn']);
/** npm's direct script commands, each running the script of the same name (`t` and `tst` are `test`). */
const directScriptCommands: ReadonlyMap<string, string> = new Map([
  ['test', 'test'],
  ['tst', 'test'],
  ['t', 'test'],
  ['start', 'start'],
  ['stop', 'stop'],
  ['restart', 'restart'],
]);
/** Options npm, pnpm, Yarn, and Bun read with their value in the next word (`--prefix .`); `--option=value` takes none. */
const valuedManagerOptions = new Set(['-w', '--workspace', '-C', '--prefix', '--filter', '--script-shell', '--loglevel', '--userconfig', '--registry']);

interface ParsedOption {
  readonly name: string;
  readonly value: string | undefined;
}

/**
 * A command line read as its program does, up to the first positional word:
 * every `-x` before it is an option — one in `valued`, in space form, taking
 * the next word as its value, `--x=v` carrying its own, any other a flag —
 * and `--` ends the options, the word after it being positional. `-` alone
 * is positional (stdin). Returns the options and the index of that first
 * positional, `words.length` when there is none.
 */
const leadingOptions = (
  words: readonly string[],
  valued: ReadonlySet<string>,
  from = 0,
): { readonly options: readonly ParsedOption[]; readonly positional: number } => {
  const options: ParsedOption[] = [];
  for (let index = from; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word === '--') return { options, positional: index + 1 };
    if (word === '-' || !word.startsWith('-')) return { options, positional: index };
    const assigned = /^(--[^=]+)=(.*)$/u.exec(word);
    if (assigned !== null) {
      options.push({ name: assigned[1] as string, value: assigned[2] });
    } else if (valued.has(word)) {
      options.push({ name: word, value: words[index + 1] });
      index += 1;
    } else {
      options.push({ name: word, value: undefined });
    }
  }
  return { options, positional: words.length };
};

/** One simple command of a shell script: what it runs, the words after it, and the environment set for it alone. */
interface SimpleCommand {
  /** The command proper, the directory dropped from a path (`./node_modules/.bin/tsc` is `tsc`). */
  readonly command: string;
  readonly operands: readonly string[];
  /** The assignments before the command (`NODE_OPTIONS=-r x node install.js`, `cross-env CI=1 tsc`), by variable name. */
  readonly environment: ReadonlyMap<string, string>;
  /** The manifest script a package-manager command delegates to: `npm run setup`, `pnpm --filter pkg run setup`, `npm test`, `yarn start`. */
  readonly script: string | undefined;
}

/**
 * What a package-manager command runs, read as `npm [options] <subcommand>
 * [options] <positional…>`. A `run` subcommand (`run-script`, `rum`, `urn`)
 * runs the first positional after it as a manifest script — the rest, after
 * a `--` or not, are that script's arguments (`npm run setup -- dormant`
 * runs `setup` alone, as does `npm run setup dormant`) — and `test`, `start`,
 * `stop`, `restart` (`t`, `tst`) run the script of that name, their
 * positionals being arguments too. `exec`, `dlx`, and `x` run the first
 * positional as a command, the rest its operands. Any other subcommand is
 * the manager's own.
 */
const managerCommand = (manager: string, args: readonly string[], environment: ReadonlyMap<string, string>): SimpleCommand => {
  const sub = leadingOptions(args, valuedManagerOptions).positional;
  const subcommand = args[sub];
  const next = leadingOptions(args, valuedManagerOptions, sub + 1).positional;
  if (subcommand !== undefined && execSubcommands.has(subcommand) && next < args.length) {
    return { command: posix.basename(args[next] as string), environment, operands: args.slice(next + 1), script: undefined };
  }
  const script = subcommand === undefined
    ? undefined
    : runSubcommands.has(subcommand) ? args[next] : directScriptCommands.get(subcommand);
  return { command: manager, environment, operands: args.slice(sub + 1), script };
};

/**
 * The simple commands of a shell script, one per operator-separated segment:
 * the first word after environment assignments and exec wrappers (`FOO=1 npx
 * tsc`, `pnpm exec -- tsc`, `cross-env CI=1 tsc`) is the command, the rest of
 * the segment its operands, the assignments its environment; a package
 * manager's command is read by its own grammar (`managerCommand`).
 */
const simpleCommands = (text: string): readonly SimpleCommand[] => {
  const words = shellWords(text);
  const commands: SimpleCommand[] = [];
  let start = 0;
  const segment = (end: number): void => {
    const environment = new Map<string, string>();
    let index = start;
    for (; index < end; index += 1) {
      const assignment = environmentAssignment.exec(words[index] as string);
      if (assignment !== null) environment.set(assignment[1] as string, assignment[2] as string);
      else if (!commandPrefix.test(words[index] as string)) break;
    }
    if (index >= end) return;
    const word = words[index] as string;
    const rest = words.slice(index + 1, end);
    commands.push(packageManagers.has(word)
      ? managerCommand(word, rest, environment)
      : { command: posix.basename(word), environment, operands: rest, script: undefined });
  };
  words.forEach((word, index) => {
    if (!shellOperators.has(word)) return;
    segment(index);
    start = index + 1;
  });
  segment(words.length);
  return commands;
};

/**
 * The text a consumer's install lifecycle executes: the lifecycle scripts,
 * plus every script they reach through `npm run <name>` or a direct `npm
 * test`/`start`/`stop`/`restart` (with its `pre<name>` and `post<name>`
 * hooks), transitively. Dependency executables are on `PATH` for all of them.
 */
const installScriptText = (scripts: Readonly<Record<string, unknown>>): string => {
  const seen = new Set<string>();
  /**
   * The scripts npm runs for a delegated name: the script with its hooks, or
   * nothing when there is no such script — except `restart`, which without a
   * `restart` script runs `stop` then `start`, each with its hooks, inside
   * `prerestart`/`postrestart`.
   */
  const lifecycle = (name: string): readonly string[] => {
    if (Object.hasOwn(scripts, name)) return [`pre${name}`, name, `post${name}`];
    return name === 'restart' ? ['prerestart', ...lifecycle('stop'), ...lifecycle('start'), 'postrestart'] : [];
  };
  const visit = (name: string): void => {
    const body = scripts[name];
    if (seen.has(name) || typeof body !== 'string') return;
    seen.add(name);
    for (const { script } of simpleCommands(body)) {
      if (script !== undefined) for (const hook of lifecycle(script)) visit(hook);
    }
  };
  for (const script of installScripts) visit(script);
  return [...seen].map((name) => scripts[name] as string).join('\n');
};

/**
 * Node's options that take their value in the next word (`--require x`;
 * `--require=x` carries its own). Everything else before the program is a
 * flag, so the first word that is neither is the program.
 */
const valuedNodeOptions = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader',
  '-e', '--eval', '-p', '--print', '-pe',
  '--input-type', '-C', '--conditions', '--env-file', '--env-file-if-exists', '--title', '--run',
  '--test-name-pattern', '--test-reporter', '--test-reporter-destination', '--test-shard', '--watch-path',
  '--openssl-config', '--icu-data-dir', '--unhandled-rejections', '--dns-result-order', '--experimental-default-type',
  '--redirect-warnings', '--report-directory', '--report-filename', '--report-signal', '--diagnostic-dir',
  '--disable-warning', '--localstorage-file', '--cpu-prof-dir', '--cpu-prof-name', '--heap-prof-dir', '--heap-prof-name',
  '--trace-event-categories', '--trace-event-file-pattern', '--experimental-sea-config', '--secure-heap',
  '--stack-trace-limit', '--max-http-header-size', '--inspect-port', '--experimental-policy', '--policy-integrity',
  '--tls-cipher-list', '--tls-keylog', '--heapsnapshot-signal', '--heapsnapshot-near-heap-limit',
]);
/** Node's preloads, loaded before the program: `-r`/`--require` (CommonJS), `--import`, and `--loader`/`--experimental-loader` (ES modules). */
const preloadOptions = /^(?:-r|--require|--import|--loader|--experimental-loader)$/u;

/**
 * The options of a `node` command, read as Node does — `node [options]
 * [script | -e code | -] [arguments]`: everything up to the first positional
 * or a `--`, nothing after it (`node install.js --require x` passes
 * `--require x` to `install.js`). A `NODE_OPTIONS` assignment on the same
 * command (`NODE_OPTIONS=--require=x node install.js`, `cross-env
 * NODE_OPTIONS="-r x" node .`) supplies options Node applies before the
 * command line's; one exported by an earlier command is not read.
 */
const nodeCommand = ({ environment, operands }: SimpleCommand): readonly ParsedOption[] => [
  ...leadingOptions(shellWords(environment.get('NODE_OPTIONS') ?? ''), valuedNodeOptions).options,
  ...leadingOptions(operands, valuedNodeOptions).options,
];

/**
 * The values a script gives one of `node`'s options, across every `node`
 * command in command position: `-r dotenv/config` or `--require=dotenv/config`
 * before the program, or in the command's `NODE_OPTIONS`; the same flag after
 * the program (`node install.js -r x`) or on another command (`rm -r dist`)
 * is never Node's.
 */
const nodeOptionValues = (commands: readonly SimpleCommand[], options: RegExp): readonly string[] =>
  commands.filter(({ command }) => command === 'node').flatMap((command) => nodeCommand(command)
    .flatMap(({ name, value }) => (options.test(name) && value !== undefined ? [value] : [])));

/** The package names among `specifiers`: bare ones by `packageNameOf`, `#` ones through the manifest's `imports` map. */
const packageNames = (packageDocument: Readonly<Record<string, unknown>>, specifiers: readonly string[]): readonly string[] =>
  specifiers
    .flatMap((specifier) => (specifier.startsWith('#') ? packageImportTargets(packageDocument, specifier) : [specifier]))
    .flatMap((specifier) => {
      const name = packageNameOf(specifier);
      return name === undefined ? [] : [name];
    });

/**
 * Dependencies a consumer's install lifecycle fails without: one of their
 * `bin` commands in command position (`setup-tool --init`, `npx setup-tool`,
 * `./node_modules/.bin/setup-tool`), a file of theirs run directly (`node
 * node_modules/setup-tool/install.js`), or a bare preload (`node -r
 * setup-tool/register .`, `NODE_OPTIONS=--import=setup-tool node .`); a
 * relative preload names no package. An optional dependency npm skipped
 * after a failed fetch then fails the script, so this is what turns a
 * survivable `AB7015` fatal; `echo setup-tool` never does.
 */
const installScriptNeeds = (
  text: string,
  commands: readonly SimpleCommand[],
  executables: ExecutableCommands,
  packageDocument: Readonly<Record<string, unknown>>,
): readonly string[] => {
  const run = new Set(commands.map(({ command }) => command));
  const words = shellWords(text);
  return [
    ...[...executables]
      .filter(([name, bins]) => bins.some((command) => run.has(command))
        || words.some((word) => word.replace(/^\.\//u, '').startsWith(`node_modules/${name}/`)))
      .map(([name]) => name),
    ...packageNames(packageDocument, nodeOptionValues(commands, preloadOptions)),
  ];
};

export interface InstallScriptDependencies {
  /** Every package a consumer-side install script names or runs: keep-only evidence for `AB7014`. */
  readonly names: ReadonlySet<string>;
  /** The subset the install fails without (`installScriptNeeds`), which escalates an optional dependency's `AB7015`. */
  readonly needed: ReadonlySet<string>;
}

/** What the consumer-side install scripts (`installScriptText`) say about the installed dependencies `declared`. */
export const installScriptDependencies = async (options: {
  readonly declared: readonly string[];
  readonly dependencyRoot?: string;
  readonly packageDocument: Readonly<Record<string, unknown>>;
  readonly projectRoot: string;
}): Promise<InstallScriptDependencies> => {
  const executables = await executableCommands(options.declared, resolve(options.dependencyRoot ?? options.projectRoot));
  const text = installScriptText(isRecord(options.packageDocument.scripts) ? options.packageDocument.scripts : {});
  const needed = new Set(installScriptNeeds(text, simpleCommands(text), executables, options.packageDocument));
  return { names: new Set([...installScriptMentions(text, executables), ...needed]), needed };
};

/**
 * The package a `/// <reference types="name" />` directive resolves through:
 * `name` itself when it ships declarations, or its DefinitelyTyped package
 * (`@types/name`; `@types/scope__name` for a scoped name). Both are reported,
 * since the declaration cannot say which one the consumer needs.
 */
const typeDirectivePackages = (name: string): readonly string[] => [
  name,
  name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`,
];

/**
 * Package names a declaration file makes a consumer need, as TypeScript reads
 * it (`preProcessFile`, string escapes already decoded): every `importedFiles`
 * entry (`import`/`export … from`, `import x = require("…")`, `import("…")`
 * types, module augmentations in an external-module file) and every
 * `typeReferenceDirectives` entry with its `@types` twin. The
 * `ambientExternalModules` — `declare module "x"` in a file with no imports —
 * declare that module themselves and make nothing needed. Relative and
 * built-in specifiers name no package; a `#subpath` specifier reaches
 * whatever the manifest's `imports` map gives it (`packageImportTargets`).
 */
export const declarationPackageReferences = (text: string, packageDocument: Readonly<Record<string, unknown>>): readonly string[] => {
  const { importedFiles, typeReferenceDirectives } = ts.preProcessFile(text, true, false);
  return packageNames(packageDocument, [
    ...importedFiles.map((file) => file.fileName),
    ...typeReferenceDirectives.flatMap((directive) => typeDirectivePackages(directive.fileName)),
  ]);
};

/** Package names the packed declaration files reference; `paths` is the pack inventory (POSIX, no `./`). */
export const packedDeclarationReferences = async (options: {
  readonly packageDocument: Readonly<Record<string, unknown>>;
  readonly paths: readonly string[];
  readonly projectRoot: string;
}): Promise<ReadonlySet<string>> => {
  const projectRoot = resolve(options.projectRoot);
  const references = await Promise.all(options.paths.filter((path) => declarationSuffix.test(path)).map(async (path) => {
    let text: string;
    try {
      text = await readFile(resolve(projectRoot, path), 'utf8');
    } catch (error) {
      // npm listed the file; only its absence is a benign inconsistency.
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    }
    return declarationPackageReferences(text, options.packageDocument);
  }));
  return new Set(references.flat());
};
