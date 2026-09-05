import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

/**
 * Static view of a built `@agent-bundle/runtime` dist: which files each
 * public entry pulls in, and where each error class is defined. Shared by the
 * integration-pool packaging test (workspace `dist`) and the packed identity
 * test (the `dist` npm installed from the release tarball).
 */

/** Public entry file for each `exports` subpath, relative to `dist`. */
export const runtimeEntryFiles = Object.freeze({
  '.': 'index.js',
  './flight/server': 'flight/server.js',
  './lineage': 'lineage.js',
  './mount': 'mount.js',
  './notices': 'notices.js',
  './notices/inbox-route': 'notices/inbox-route.js',
  './plugin': 'plugin.js',
  './state': 'state.js',
  './state/sqlite': 'state/sqlite.js',
} as const);

export type RuntimeEntrySubpath = keyof typeof runtimeEntryFiles;

/**
 * The three forms Rspack's ESM output uses for a relative edge: a static
 * `import … from`/`export … from` statement (matched from the statement start,
 * so a string literal or comment mid-line does not count), a bare side-effect
 * `import "./x.js"`, and a dynamic `import("./x.js")`. `unreachedFiles`
 * catches any fourth form: Rslib emits no chunk nothing imports.
 */
const relativeImportPattern =
  /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["'](\.\.?\/[^"']+)["']|^\s*import\s*["'](\.\.?\/[^"']+)["']|\bimport\(\s*["'](\.\.?\/[^"']+)["']\s*\)/gmu;
const errorNamePattern = /this\.name = ['"]([A-Za-z]+Error)['"]/gu;

const distPath = (file: string): string => normalize(file).split(sep).join('/');

/** Every `.js` file under `dist`, relative with `/` separators, with its source. */
export const readDistSources = async (dist: string): Promise<ReadonlyMap<string, string>> => {
  const entries = await readdir(dist, { recursive: true, withFileTypes: true });
  const sources = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const absolute = join(entry.parentPath, entry.name);
    sources.set(distPath(absolute.slice(dist.length + 1)), await readFile(absolute, 'utf8'));
  }
  return sources;
};

/**
 * Files an entry loads: itself plus everything reachable through relative
 * static imports, re-exports, and dynamic imports, as `dist`-relative paths.
 * Bare specifiers (`react`, `effect`, `node:sqlite`) are not files and are
 * left in the sources for the caller to grep.
 */
export const importClosure = (sources: ReadonlyMap<string, string>, entry: string): readonly string[] => {
  const closure = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (closure.has(file)) continue;
    const source = sources.get(file);
    if (source === undefined) throw new Error(`dist graph walk reached ${file}, which is not in dist`);
    closure.add(file);
    for (const match of source.matchAll(relativeImportPattern)) {
      pending.push(distPath(join(dirname(file), (match[1] ?? match[2] ?? match[3])!)));
    }
  }
  return [...closure].sort();
};

/** The public entries whose graph includes `file`. */
export const entriesReaching = (sources: ReadonlyMap<string, string>, file: string): readonly RuntimeEntrySubpath[] =>
  (Object.keys(runtimeEntryFiles) as RuntimeEntrySubpath[])
    .filter((subpath) => importClosure(sources, runtimeEntryFiles[subpath]).includes(file));

/**
 * Dist files no public entry reaches. Rslib emits a chunk only because some
 * entry imports it, so a non-empty answer means an import form the walker
 * does not parse — and every closure-based assertion is then incomplete.
 */
export const unreachedFiles = (sources: ReadonlyMap<string, string>): readonly string[] => {
  const reached = new Set(
    (Object.values(runtimeEntryFiles) as string[]).flatMap((entry) => importClosure(sources, entry)),
  );
  return [...sources.keys()].filter((file) => !reached.has(file)).sort();
};

/** Dist files whose source contains any of `identifiers`. */
export const filesContaining = (sources: ReadonlyMap<string, string>, identifiers: readonly string[]): readonly string[] =>
  [...sources]
    .filter(([, source]) => identifiers.some((identifier) => source.includes(identifier)))
    .map(([file]) => file)
    .sort();

/** Names of the error classes a source tree declares through `this.name = '<Name>'`. */
export const declaredErrorClasses = async (sourceRoot: string): Promise<readonly string[]> => {
  const entries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = await readFile(join(entry.parentPath, entry.name), 'utf8');
    for (const match of source.matchAll(errorNamePattern)) names.add(match[1]!);
  }
  return [...names].sort();
};

/**
 * One entry per definition of the class named `name`: the dist file it sits
 * in, repeated when a file holds two copies. Rspack renames a class it bundles
 * twice, so the constructor's `this.name` assignment (either quote style) is
 * the one marker a duplicated definition cannot hide behind.
 */
export const errorClassDefinitions = (sources: ReadonlyMap<string, string>, name: string): readonly string[] => {
  const marker = new RegExp(`this\\.name = ['"]${name}['"]`, 'gu');
  return [...sources]
    .flatMap(([file, source]) => Array.from(source.matchAll(marker), () => file))
    .sort();
};

/**
 * Environment for a probe child: the caller's, without `NODE_OPTIONS`, so a
 * preload or condition the host session set (one importing `node:sqlite`, say)
 * cannot leak into what the probe measures.
 */
export const probeEnvironment = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const { NODE_OPTIONS: _ignored, ...environment } = base;
  return environment;
};

/** Specifier for each entry the identity probe imports, in load order. */
export interface EntryIdentityProbeSpecifiers {
  readonly flightServer: string;
  readonly inboxRoute: string;
  readonly lineage: string;
  readonly mount: string;
  readonly notices: string;
  readonly plugin: string;
  readonly root: string;
  readonly sqlite: string;
  readonly state: string;
}

/** What one thrown error looked like to the probe. */
export interface ProbedError {
  readonly code: string | undefined;
  readonly instanceOfStateError: boolean;
  readonly name: string;
}

/** JSON the identity probe prints on its last stdout line. */
export interface EntryIdentityReport {
  /** `mount`'s request-lifetime ledger rejection, checked against `state`'s `AgentStateError`. */
  readonly mountLedgerError: ProbedError;
  /** `root.AgentRequestError === plugin.AgentRequestError`. */
  readonly requestErrorShared: boolean;
  /** `node:sqlite` in `process.moduleLoadList` after every entry but `state/sqlite` loaded. */
  readonly sqliteLoadedBeforeSqliteEntry: boolean;
  /** `node:sqlite` in `process.moduleLoadList` after `state/sqlite` loaded. */
  readonly sqliteLoadedAfterSqliteEntry: boolean;
  /** The sqlite driver's volatile-definition rejection, checked against `state`'s class. */
  readonly sqliteLifetimeError: ProbedError;
  /** A sqlite store's malformed-revision rejection: thrown by kernel code sqlite imports directly. */
  readonly sqliteRevisionError: ProbedError;
}

/**
 * Source of an ESM script (`node --conditions=react-server --input-type=module
 * --eval`) that imports every public entry, records whether `node:sqlite`
 * came along, and provokes `AgentStateError`s from the sqlite and mount
 * entries to compare against the class the state entry exports. `zod` must
 * resolve from the child's working directory; `stateRoot` is a scratch
 * directory the sqlite driver may write to.
 */
export const entryIdentityProbeScript = (specifiers: EntryIdentityProbeSpecifiers, stateRoot: string): string => [
  `const specifiers = ${JSON.stringify(specifiers)};`,
  "const sqliteLoaded = () => process.moduleLoadList.includes('NativeModule sqlite');",
  'const root = await import(specifiers.root);',
  'const plugin = await import(specifiers.plugin);',
  'await import(specifiers.flightServer);',
  'const state = await import(specifiers.state);',
  'const notices = await import(specifiers.notices);',
  'await import(specifiers.inboxRoute);',
  'const mount = await import(specifiers.mount);',
  'await import(specifiers.lineage);',
  'const sqliteLoadedBeforeSqliteEntry = sqliteLoaded();',
  'const sqlite = await import(specifiers.sqlite);',
  'const sqliteLoadedAfterSqliteEntry = sqliteLoaded();',
  "const { z } = await import('zod');",
  'const probe = async (run) => {',
  '  try { await run(); } catch (error) {',
  '    return { code: error?.code, instanceOfStateError: error instanceof state.AgentStateError, name: error?.name };',
  '  }',
  "  throw new Error('expected a rejection');",
  '};',
  'const definition = (lifetime) => state.defineState({',
  '  events: { noted: z.object({ value: z.string() }).strict() },',
  "  id: 'entry-identity/' + lifetime,",
  '  initial: { notes: [] },',
  '  lifetime,',
  '  reduce: (current, event) => ({ notes: [...current.notes, event.payload.value] }),',
  '  schema: z.object({ notes: z.array(z.string()) }).strict(),',
  '});',
  `const driver = sqlite.createSqliteStateDriver({ root: ${JSON.stringify(stateRoot)} });`,
  "const sqliteLifetimeError = await probe(() => driver.open(definition('process')));",
  "const store = await driver.open(definition('workspace-durable'));",
  'const sqliteRevisionError = await probe(() => store.read({ revision: -1 }));',
  'await store.close();',
  'await driver.close();',
  "const noticeRuntime = mount.createGeneratedNoticeRuntime({ driver: state.createMemoryStateDriver({ lifetime: 'request' }), lifetime: 'request' });",
  'const mountLedgerError = await probe(async () => (await noticeRuntime.noticeLedger()).read());',
  'await noticeRuntime.close();',
  'process.stdout.write(JSON.stringify({',
  '  mountLedgerError,',
  '  requestErrorShared: root.AgentRequestError === plugin.AgentRequestError,',
  '  sqliteLoadedBeforeSqliteEntry,',
  '  sqliteLoadedAfterSqliteEntry,',
  '  sqliteLifetimeError,',
  '  sqliteRevisionError,',
  "}) + '\\n');",
].join('\n');

/** The report an identity probe run printed: the last non-empty stdout line. */
export const parseEntryIdentityReport = (stdout: string): EntryIdentityReport => {
  const line = stdout.trim().split('\n').at(-1);
  if (line === undefined || line === '') throw new Error('entry identity probe printed nothing');
  return JSON.parse(line) as EntryIdentityReport;
};
