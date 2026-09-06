import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from '@rstest/core';

import markdownStreamManifest from '../../rsc-markdown-stream/package.json' with { type: 'json' };
import runtimeManifest from '../package.json' with { type: 'json' };
import {
  cachedNpmInstallArguments,
  installedEnvironment,
  sharedPackedTarball,
} from '../../agent-bundle/tests/support/shared-pack.ts';
import {
  declaredErrorClasses,
  entriesReaching,
  entryIdentityProbeScript,
  errorClassDefinitions,
  filesContaining,
  parseEntryIdentityReport,
  probeEnvironment,
  readDistSources,
  runtimeEntryFiles,
  unreachedFiles,
} from './support/dist-graph.ts';

const execFile = promisify(executeFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

interface InstalledManifest {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

/**
 * The release tarball, installed by npm and imported through its `exports`
 * map the way a consumer does (#566): one class per error across every
 * subpath, `node:sqlite` only behind `@agent-bundle/runtime/state/sqlite`,
 * no `@modelcontextprotocol/sdk` 1.x anywhere in the shipped manifest or
 * declarations, and the manifest itself reachable as `./package.json`.
 */
describe.sequential('packed @agent-bundle/runtime entry identity', () => {
  it('shares one kernel across every installed subpath and ships without the 1.x MCP SDK', async () => {
    const [runtime, markdownStream] = await Promise.all([
      sharedPackedTarball('runtime'),
      sharedPackedTarball('markdown-stream'),
    ]);
    const consumer = await mkdtemp(join(tmpdir(), 'runtime-packed-identity-'));
    try {
      await writeFile(join(consumer, 'package.json'), '{"name":"runtime-identity-consumer","type":"module","private":true}\n');
      // The renderer rides along until its version is on the registry; React
      // is the runtime's required peer; zod is the probe's own import.
      await execFile('npm', [
        'install',
        ...cachedNpmInstallArguments,
        runtime.tarball,
        markdownStream.tarball,
        'react@19.2.8',
        'react-dom@19.2.8',
        'zod@4.5.4',
      ], { cwd: consumer, env: installedEnvironment() });

      const installed = join(consumer, 'node_modules', '@agent-bundle', 'runtime');
      const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as InstalledManifest;
      expect(Object.keys(manifest.dependencies)).not.toContain('@modelcontextprotocol/sdk');
      expect(manifest.dependencies['@modelcontextprotocol/server']).toBeDefined();
      // The source manifest says `workspace:^`; the packer ships the caret of
      // the sibling's version, the same rewrite `pnpm publish` performs.
      expect(manifest.dependencies['rsc-markdown-stream']).toBe(`^${markdownStreamManifest.version}`);
      expect(manifest.exports['./package.json']).toBe('./package.json');
      expect(manifest.peerDependencies).toEqual(runtimeManifest.peerDependencies);
      for (const range of Object.values(manifest.peerDependencies)) expect(range).not.toBe('*');
      expect(manifest.peerDependenciesMeta?.['@rspack/core']?.optional).toBe(true);
      // npm validates every peer edge — the runtime's React carets and the
      // Flight binding's — against the React the consumer installed.
      const { stdout: tree } = await execFile('npm', ['ls', '--all', '--json'], { cwd: consumer, env: installedEnvironment() });
      expect(JSON.parse(tree)).not.toHaveProperty('problems');
      const declarations = (await readdir(join(installed, 'dist'), { recursive: true }))
        .filter((file): file is string => typeof file === 'string' && file.endsWith('.d.ts'));
      expect(declarations.length).toBeGreaterThan(0);
      for (const file of declarations) {
        expect(await readFile(join(installed, 'dist', file), 'utf8'), file).not.toContain('@modelcontextprotocol/sdk');
      }

      // The same static graph checks as state-packaging.test.ts, against the
      // shipped files: the probe below only sees what runs at import time, so
      // a deferred `import('node:sqlite')` in another entry needs this walk.
      const sources = await readDistSources(join(installed, 'dist'));
      expect(unreachedFiles(sources)).toEqual([]);
      for (const name of await declaredErrorClasses(join(packageRoot, 'src'))) {
        const files = errorClassDefinitions(sources, name);
        expect(files, `${name} is defined ${files.length} times in the installed dist: ${files.join(', ')}`).toHaveLength(1);
      }
      const sqliteFiles = filesContaining(sources, ['node:sqlite', 'DatabaseSync']);
      expect(sqliteFiles).toContain(runtimeEntryFiles['./state/sqlite']);
      for (const file of sqliteFiles) {
        expect(entriesReaching(sources, file), `${file} mentions node:sqlite`).toEqual(['./state/sqlite']);
      }

      const stateRoot = join(consumer, 'state');
      const script = entryIdentityProbeScript({
        flightServer: '@agent-bundle/runtime/flight/server',
        inboxRoute: '@agent-bundle/runtime/notices/inbox-route',
        lineage: '@agent-bundle/runtime/lineage',
        mount: '@agent-bundle/runtime/mount',
        notices: '@agent-bundle/runtime/notices',
        plugin: '@agent-bundle/runtime/plugin',
        root: '@agent-bundle/runtime',
        sqlite: '@agent-bundle/runtime/state/sqlite',
        state: '@agent-bundle/runtime/state',
      }, stateRoot);
      const { stdout } = await execFile(
        process.execPath,
        ['--conditions=react-server', '--input-type=module', '--eval', script],
        { cwd: consumer, env: probeEnvironment(installedEnvironment()) },
      );
      const report = parseEntryIdentityReport(stdout);
      expect(report).toEqual({
        mountLedgerError: { code: 'lifetime-mismatch', instanceOfStateError: true, name: 'AgentStateError' },
        requestErrorShared: true,
        sqliteLoadedBeforeSqliteEntry: false,
        sqliteLoadedAfterSqliteEntry: true,
        sqliteLifetimeError: { code: 'lifetime-mismatch', instanceOfStateError: true, name: 'AgentStateError' },
        sqliteRevisionError: { code: 'invalid-input', instanceOfStateError: true, name: 'AgentStateError' },
      });

      const resolved = await execFile(
        process.execPath,
        ['--input-type=module', '--eval', "process.stdout.write(import.meta.resolve('@agent-bundle/runtime/package.json'));"],
        { cwd: consumer, env: installedEnvironment() },
      );
      expect(fileURLToPath(resolved.stdout)).toBe(join(installed, 'package.json'));
    } finally {
      await rm(consumer, { force: true, recursive: true });
    }
  }, 180_000);
});
