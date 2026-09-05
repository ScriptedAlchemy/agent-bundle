import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from '@rstest/core';

import {
  declaredErrorClasses,
  entriesReaching,
  entryIdentityProbeScript,
  errorClassDefinitions,
  filesContaining,
  importClosure,
  parseEntryIdentityReport,
  probeEnvironment,
  readDistSources,
  runtimeEntryFiles,
  unreachedFiles,
  type RuntimeEntrySubpath,
} from './support/dist-graph.ts';

const execFile = promisify(executeFile);

/**
 * Packaged-tree boundaries for the optional state kernel (#98) and the
 * single-graph build (#566): stateless consumers who import the package root
 * (or `./plugin`) must receive none of the kernel or storage code, only the
 * `./state/sqlite` entry may load `node:sqlite`, and every error class is
 * defined once in the whole dist, so `instanceof` holds across entries. Runs
 * against the prebuilt dist (the integration pool builds it up front).
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const dist = join(packageRoot, 'dist');
const distFile = async (...segments: string[]): Promise<string> => readFile(join(dist, ...segments), 'utf8');

// Identifiers, not class names: the Effect boundary in the root graph lists
// typed error *names* (`isTypedRuntimeError`) without the classes. The kernel
// classes themselves are excluded by definition file, whatever the quoting.
const kernelIdentifiers = [
  'node:sqlite',
  'defineState',
  'DatabaseSync',
  'agent_state_journal',
  'createAgentNoticeLedger',
  'agent-notice-ledger/v1',
] as const;
const kernelErrorClasses = ['AgentStateError', 'AgentNoticeError'] as const;
const sqliteIdentifiers = ['node:sqlite', 'DatabaseSync'] as const;

let sources: ReadonlyMap<string, string>;
const closureSource = (subpath: RuntimeEntrySubpath): ReadonlyMap<string, string> =>
  new Map(importClosure(sources, runtimeEntryFiles[subpath]).map((file) => [file, sources.get(file)!]));

describe.sequential('state kernel packaging boundaries', () => {
  beforeAll(async () => {
    sources = await readDistSources(dist);
  });

  it('reaches every dist file from some public entry, so the graph walk sees every edge', () => {
    expect(unreachedFiles(sources)).toEqual([]);
  });

  it('publishes the provider invocation type from the root declaration entry', async () => {
    const declaration = await distFile('index.d.ts');
    expect(declaration).toContain('AgentRenderInvocation');
  });

  it('exposes exactly the documented subpaths, each backed by a dist file, plus the manifest', async () => {
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { import: string; types: string } | string>;
      sideEffects: unknown;
    };
    expect(packageJson.sideEffects).toBe(false);
    expect(Object.keys(packageJson.exports)).toEqual([
      '.',
      './plugin',
      './flight/server',
      './state',
      './state/sqlite',
      './notices',
      './notices/inbox-route',
      './mount',
      './lineage',
      './package.json',
    ]);
    expect(packageJson.exports['./package.json']).toBe('./package.json');
    for (const [subpath, target] of Object.entries(packageJson.exports)) {
      if (typeof target === 'string') continue;
      expect(target.import).toBe(`./dist/${runtimeEntryFiles[subpath as RuntimeEntrySubpath]}`);
      await expect(distFile(...target.import.replace('./dist/', '').split('/'))).resolves.toBeTruthy();
      await expect(distFile(...target.types.replace('./dist/', '').split('/'))).resolves.toBeTruthy();
    }
  });

  it('keeps every kernel and storage identifier out of the root and plugin graphs', () => {
    const kernelClassFiles = kernelErrorClasses.flatMap((name) => errorClassDefinitions(sources, name));
    expect(kernelClassFiles.length).toBeGreaterThan(0);
    for (const subpath of ['.', './plugin'] as const) {
      for (const [file, source] of closureSource(subpath)) {
        expect(kernelClassFiles, `${subpath} loads ${file}, which defines a kernel error class`).not.toContain(file);
        for (const identifier of kernelIdentifiers) {
          expect(source, `${subpath} loads ${file}, which must not contain ${identifier}`).not.toContain(identifier);
        }
      }
    }
    // Stage 2 puts Effect on the dispatcher, which is part of the root graph.
    // The plugin entry stays Effect-free so hook-only artifacts still skip it.
    for (const [file, source] of closureSource('./plugin')) {
      for (const identifier of ['from "effect"', 'Effect.runPromise']) {
        expect(source, `./plugin loads ${file}, which must not contain ${identifier}`).not.toContain(identifier);
      }
    }
  });

  it('confines node:sqlite to files only the state/sqlite entry reaches', () => {
    // By reachability, not file name: Rspack may legitimately move the sqlite
    // code into a chunk of its own, as long as no other entry's graph has it.
    const sqliteFiles = filesContaining(sources, sqliteIdentifiers);
    expect(sqliteFiles).toContain(runtimeEntryFiles['./state/sqlite']);
    for (const file of sqliteFiles) {
      expect(entriesReaching(sources, file), `${file} mentions node:sqlite`).toEqual(['./state/sqlite']);
    }
    expect([...closureSource('./state').values()].join('\n')).toContain('defineState');
    expect([...closureSource('./notices').values()].join('\n')).toContain('createAgentNoticeLedger');
    expect([...closureSource('./mount').values()].join('\n')).toContain('createGeneratedRuntimeState');
  });

  it('defines every error class exactly once across the whole dist', async () => {
    const declared = await declaredErrorClasses(join(packageRoot, 'src'));
    expect(declared).toContain('AgentStateError');
    expect(declared).toContain('AgentRequestError');
    const definitions = Object.fromEntries(declared.map((name) => [name, errorClassDefinitions(sources, name)]));
    for (const [name, files] of Object.entries(definitions)) {
      expect(files, `${name} is defined ${files.length} times in dist: ${files.join(', ')}`).toHaveLength(1);
    }
    // The state kernel's error class must sit in the graph of every entry
    // that throws or catches it, not only in the entry that exports it.
    const [stateErrorFile] = definitions['AgentStateError']!;
    for (const subpath of ['./state', './state/sqlite', './mount', './lineage', './notices'] as const) {
      expect(importClosure(sources, runtimeEntryFiles[subpath]), `${subpath} must reach ${stateErrorFile}`)
        .toContain(stateErrorFile);
    }
  });

  it('shares one class per error across entries and loads node:sqlite only through state/sqlite', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'runtime-entry-identity-'));
    try {
      const specifier = (subpath: RuntimeEntrySubpath): string => pathToFileURL(join(dist, runtimeEntryFiles[subpath])).href;
      const script = entryIdentityProbeScript({
        flightServer: specifier('./flight/server'),
        inboxRoute: specifier('./notices/inbox-route'),
        lineage: specifier('./lineage'),
        mount: specifier('./mount'),
        notices: specifier('./notices'),
        plugin: specifier('./plugin'),
        root: specifier('.'),
        sqlite: specifier('./state/sqlite'),
        state: specifier('./state'),
      }, stateRoot);
      // A child process: this worker may already have loaded node:sqlite for
      // another file, and the flight entry needs the react-server condition.
      const { stdout } = await execFile(
        process.execPath,
        ['--conditions=react-server', '--input-type=module', '--eval', script],
        { cwd: packageRoot, env: probeEnvironment() },
      );
      const report = parseEntryIdentityReport(stdout);
      expect(report.sqliteLoadedBeforeSqliteEntry).toBe(false);
      expect(report.sqliteLoadedAfterSqliteEntry).toBe(true);
      expect(report.requestErrorShared).toBe(true);
      expect(report.sqliteLifetimeError).toEqual({ code: 'lifetime-mismatch', instanceOfStateError: true, name: 'AgentStateError' });
      // The validators sqlite imports from the kernel directly, past the
      // state entry: the fork the old per-entry externals never covered.
      expect(report.sqliteRevisionError).toEqual({ code: 'invalid-input', instanceOfStateError: true, name: 'AgentStateError' });
      expect(report.mountLedgerError).toEqual({ code: 'lifetime-mismatch', instanceOfStateError: true, name: 'AgentStateError' });
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
    }
  });
});
