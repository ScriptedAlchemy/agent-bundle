import { describe, expect, it } from '@rstest/core';

import maybeFactoryConfig from '../agent-bundle.config.ts';
import { compileRouteGraph } from 'agent-bundle/api';

if (typeof maybeFactoryConfig === 'function') throw new Error('expected a static config object');
const config = maybeFactoryConfig;
const root = new URL('..', import.meta.url).pathname;

/**
 * The CLI is sixteen `<tool>.cli.ts` projections of the sixteen curator tools
 * (#725): one operation compiles to one command whose identity stays the
 * tool's, and the projection metadata carries the pre-#725 argv surface — the
 * same command names, option spellings, positionals, and exit-code policies
 * the deleted `src/cli/**` routes served.
 */
describe('audiobook-curator projected CLI', () => {
  it('compiles every curator tool to exactly one projected command', async () => {
    const graph = await compileRouteGraph(root, config);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.cli?.mode).toBe('generated');
    const commands = graph.cli!.commands!;
    const byName = new Map(commands.map((command) => [command.path.join(' '), command]));

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
    // Every command is a projection of a curator tool; no `src/cli` route and
    // no bulk `curator <tool>` command remains.
    expect(commands.every((command) => command.projection !== undefined && command.mcp?.server === 'curator' && command.rendered)).toBe(true);
    expect(commands.map((command) => command.routeId).sort()).toEqual(
      [...new Set(commands.map((command) => `tool:curator/${command.mcp!.tool}`))].sort(),
    );
    // The authored CLI never confirmed: plan-first commands gate mutation on
    // `--apply`, so no projection asks for `--yes`.
    expect(commands.every((command) => command.mcp!.confirm === false)).toBe(true);
    // The result exit-code policy rides exactly the commands that declared it.
    expect(commands.filter((command) => command.exitCode === 'result').map((command) => command.path.join(' ')).sort()).toEqual([
      'acoustic-identify', 'acoustic-verify', 'audible-search', 'audit', 'inventory', 'library-audit', 'whisper-verify',
    ]);
    // Only the region list needs reshaping; every other projection is renames.
    expect(commands.filter((command) => command.projection!.mapInput).map((command) => command.path.join(' '))).toEqual(['audible-search']);

    // inspect [--max-files N] <root>
    const inspect = byName.get('inspect')!;
    expect(inspect).toMatchObject({ exitCode: 'zero', routeId: 'tool:curator/inspect_sources' });
    expect(inspect.options).toEqual([
      { key: 'maxFiles', kind: 'number', option: 'max-files', repeated: false, required: false },
      { key: 'root', kind: 'string', option: 'root', positional: 0, repeated: false, required: true },
    ]);

    // inventory <source> [--report FILE] [--strict]
    const inventory = byName.get('inventory')!;
    expect(inventory).toMatchObject({ exitCode: 'result', routeId: 'tool:curator/inventory_sources' });
    expect(inventory.options.map((option) => [option.option, option.required, option.positional ?? null])).toEqual([
      ['report', false, null],
      ['source', true, 0],
      ['strict', false, null],
    ]);

    // library-audit <sources...> [--report FILE] [--concurrency N] [--strict]
    const libraryAudit = byName.get('library-audit')!;
    expect(libraryAudit).toMatchObject({ exitCode: 'result', routeId: 'tool:curator/audit_library' });
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
      'author', 'output', 'selection', 'title',
    ]);

    // prepare [--apply] [--name FILE] --output DIR <source> — the projection
    // spells the operation's outputRoot/outputName as --output/--name.
    const prepare = byName.get('prepare')!;
    expect(prepare.options.map((option) => [option.key, option.option, option.required, option.positional ?? null])).toEqual([
      ['apply', 'apply', false, null],
      ['outputName', 'name', false, null],
      ['outputRoot', 'output', true, null],
      ['source', 'source', true, 0],
    ]);

    // audible-search keeps --duration and the comma-separated --regions list.
    const audibleSearch = byName.get('audible-search')!;
    expect(audibleSearch.options.map((option) => option.option)).toEqual([
      'attempts', 'author', 'duration', 'limit', 'narrator', 'regions', 'report', 'title',
    ]);
    expect(audibleSearch.options.find((option) => option.option === 'duration')).toMatchObject({ key: 'durationSeconds', kind: 'number' });
    expect(audibleSearch.options.find((option) => option.option === 'regions')).toMatchObject({ key: 'regions', repeated: true });
    expect(audibleSearch.projection).toEqual({ mapInput: true, module: 'src/mcp/curator/tools/search_audible.cli.ts' });

    // audible-cache keeps --cache-dir.
    expect(byName.get('audible-cache')!.options.find((option) => option.key === 'cacheDirectory')).toMatchObject({ option: 'cache-dir', required: true });
  });
});
