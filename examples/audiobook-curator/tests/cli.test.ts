import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import maybeFactoryConfig from '../agent-bundle.config.ts';
import { compileRouteGraph } from 'agent-bundle/api';
import inspectRoute, { inputSchema as inspectInput, resultSchema as inspectResult } from '../src/cli/inspect.ts';

if (typeof maybeFactoryConfig === 'function') throw new Error('expected a static config object');
const config = maybeFactoryConfig;
const root = new URL('..', import.meta.url).pathname;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

/**
 * The routed-CLI migration pins (#102 stages 2-3): the compiled command
 * graph carries exactly the pre-migration argv surface — the same command
 * names, option spellings, positionals, and exit-code policies the manual
 * `runCli` dispatcher served — and plain routes still emit the identical
 * one-line JSON receipts.
 */
describe('audiobook-curator routed CLI', () => {
  it('compiles the migrated commands and projected MCP toolset in one graph', async () => {
    const graph = await compileRouteGraph(root, config);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.cli?.mode).toBe('generated');
    const commands = graph.cli!.commands!;
    const customCommands = commands.filter((command) => command.mcp === undefined);
    const projectedCommands = commands.filter((command) => command.mcp !== undefined);
    const byName = new Map(customCommands.map((command) => [command.path.join(' '), command]));

    expect([...byName.keys()].sort()).toEqual([
      'acoustic-identify',
      'acoustic-verify',
      'apply-chapters',
      'apply-metadata',
      'audible-cache',
      'audible-search',
      'audible-select',
      'audit',
      'convert',
      'inspect',
      'inventory',
      'library-audit',
      'prepare',
      'select',
      'shelf',
      'whisper-verify',
    ]);
    expect(projectedCommands).toHaveLength(16);
    expect(projectedCommands.every((command) =>
      command.path[0] === 'curator' && command.rendered)).toBe(true);

    // inspect [--max-files N] <root>
    const inspect = byName.get('inspect')!;
    expect(inspect).toMatchObject({ exitCode: 'zero', rendered: false });
    expect(inspect.options).toEqual([
      { key: 'maxFiles', kind: 'number', option: 'max-files', repeated: false, required: false },
      { key: 'root', kind: 'string', option: 'root', positional: 0, repeated: false, required: true },
    ]);

    // inventory <source> --report FILE [--strict]
    const inventory = byName.get('inventory')!;
    expect(inventory).toMatchObject({ exitCode: 'result', rendered: false });
    expect(inventory.options.map((option) => [option.option, option.required, option.positional ?? null])).toEqual([
      ['report', true, null],
      ['source', true, 0],
      ['strict', false, null],
    ]);

    // library-audit <sources...> --report FILE [--concurrency N] [--strict] — the rendered command.
    const libraryAudit = byName.get('library-audit')!;
    expect(libraryAudit).toMatchObject({ exitCode: 'result', rendered: true });
    expect(libraryAudit.options.map((option) => [option.option, option.repeated, option.positional ?? null])).toEqual([
      ['concurrency', false, null],
      ['report', false, null],
      ['sources', true, 0],
      ['strict', false, null],
    ]);

    // convert keeps its full named-option surface, including kebab-case
    // projections of camelCase keys (--audio-bitrate, --forge-aac-encoder).
    const convert = byName.get('convert')!;
    expect(convert.options.map((option) => option.option).sort()).toEqual([
      'apply', 'artwork', 'audio-bitrate', 'audio-codec', 'author', 'engine',
      'forge-aac-encoder', 'forge-cli', 'jobs', 'language', 'narrator',
      'output', 'overwrite', 'receipt', 'selection', 'title', 'year',
    ]);
    expect(convert.options.filter((option) => option.required).map((option) => option.option)).toEqual([
      'author', 'output', 'receipt', 'selection', 'title',
    ]);

    // prepare [--apply] [--name FILE] --output DIR <source> — the handler
    // maps --output/--name onto the operation's outputRoot/outputName.
    const prepare = byName.get('prepare')!;
    expect(prepare.options.map((option) => [option.option, option.required, option.positional ?? null])).toEqual([
      ['apply', false, null],
      ['name', false, null],
      ['output', true, null],
      ['source', true, 0],
    ]);

    // audible-search keeps --duration and the comma-separated --regions list.
    const audibleSearch = byName.get('audible-search')!;
    expect(audibleSearch.options.map((option) => option.option)).toEqual([
      'attempts', 'author', 'duration', 'limit', 'narrator', 'regions', 'report', 'title',
    ]);
    expect(audibleSearch).toMatchObject({ exitCode: 'result' });

    // audible-cache keeps --cache-dir.
    expect(byName.get('audible-cache')!.options.some((option) => option.option === 'cache-dir')).toBe(true);

    // The result exit-code policy rides exactly the commands that declared it.
    expect(customCommands.filter((command) => command.exitCode === 'result').map((command) => command.path.join(' ')).sort()).toEqual([
      'acoustic-identify', 'acoustic-verify', 'audible-search', 'audit', 'inventory', 'library-audit', 'whisper-verify',
    ]);
  });

  it('keeps the plain inspect receipt byte-identical to the pre-migration CLI output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'curator-cli-inspect-'));
    directories.push(directory);
    const input = inspectInput.parse({ root: directory });
    const result = inspectResult.parse(await inspectRoute({ input, signal: new AbortController().signal }));
    // The generated shell prints exactly JSON.stringify(result) + '\n', the
    // same line `runCliCommands` wrote before the migration.
    expect(JSON.stringify(result)).toBe(JSON.stringify({
      files: [],
      operation: 'inspect',
      root: directory,
      totalBytes: 0,
    }));
  });
});
