import { access } from 'node:fs/promises';

import { describe, expect, it } from '@rstest/core';

import { scanEntryExportsSource, stripCommentsAndStrings } from '../src/build/entry-exports.ts';
import {
  generatedExecutableEntrySource,
  generatedStdioMcpEntrySource,
  mcpEntryRuntimePath,
  mcpEntryRuntimeSpecifier,
} from '../src/build/entry-shell.ts';

describe('entry export scanning', () => {
  it('detects declaration-form main exports', () => {
    expect(scanEntryExportsSource('export const main = async () => 0;')).toEqual({
      hasDefaultExport: false,
      hasMainExport: true,
    });
    expect(scanEntryExportsSource('export async function main(argv) { return 0; }').hasMainExport).toBe(true);
    expect(scanEntryExportsSource('export function main() {}').hasMainExport).toBe(true);
    expect(scanEntryExportsSource('export let main = 1;\n').hasMainExport).toBe(true);
  });

  it('detects brace-clause exports with renames', () => {
    expect(scanEntryExportsSource('const run = 1; export { run as main };').hasMainExport).toBe(true);
    expect(scanEntryExportsSource('const main = 1; export { main };').hasMainExport).toBe(true);
    expect(scanEntryExportsSource('const main = 1; export { main as other };').hasMainExport).toBe(false);
    expect(scanEntryExportsSource("export { factory as default } from './server.ts';").hasDefaultExport).toBe(true);
  });

  it('detects default exports and ignores type-only clauses', () => {
    expect(scanEntryExportsSource('export default () => ({});').hasDefaultExport).toBe(true);
    expect(scanEntryExportsSource('const f = 1;\nexport default f;').hasDefaultExport).toBe(true);
    expect(scanEntryExportsSource("export type { Thing as default } from './types.ts';").hasDefaultExport).toBe(false);
    expect(scanEntryExportsSource('export type { main } from "./types.ts";').hasMainExport).toBe(false);
  });

  it('never matches inside comments, strings, or template literals', () => {
    expect(scanEntryExportsSource('// export default nothing\nconst a = 1;').hasDefaultExport).toBe(false);
    expect(scanEntryExportsSource('/* export const main = 1 */ const a = 1;').hasMainExport).toBe(false);
    expect(scanEntryExportsSource("const s = 'export default x';").hasDefaultExport).toBe(false);
    expect(scanEntryExportsSource('const s = `export const main = ${1}`;').hasMainExport).toBe(false);
    expect(scanEntryExportsSource('const t = `a ${`b ${1} export default c`} d`;').hasDefaultExport).toBe(false);
  });

  it('survives regex literals containing slashes', () => {
    const source = "const re = /https:\\/\\//u; export default re;";
    expect(scanEntryExportsSource(source).hasDefaultExport).toBe(true);
    expect(stripCommentsAndStrings('const division = a / b / c; export const main = 1;')).toContain('export const main');
  });

  it('handles TypeScript syntax the JS lexers cannot parse', () => {
    const source = [
      "import type { Widget } from './types.ts';",
      'export interface CliOptions { readonly write?: (value: string) => void }',
      'export const main = async (argv: readonly string[]): Promise<void> => {},',
    ].join('\n');
    expect(scanEntryExportsSource(source)).toEqual({ hasDefaultExport: false, hasMainExport: true });
  });
});

describe('generated entry templates', () => {
  it('locates the on-disk mcp-entry runtime module for bundler aliasing', async () => {
    const path = mcpEntryRuntimePath();
    await expect(access(path)).resolves.toBeUndefined();
    expect(path.endsWith('mcp-entry.ts') || path.endsWith('mcp-entry.js')).toBe(true);
  });

  it('generates a stdio entry that defers the consumer import behind the lifecycle', () => {
    const source = generatedStdioMcpEntrySource({ entrySource: '/proj/src/mcp/curator.ts', serverName: 'curator' });
    expect(source).toContain(`from ${JSON.stringify(mcpEntryRuntimeSpecifier)}`);
    expect(source).toContain('loadEntry: () => import("/proj/src/mcp/curator.ts")');
    expect(source).toContain('serverName: "curator"');
    // The consumer module must never be statically imported: the console
    // guard has to activate before its side effects can reach stdout.
    expect(source).not.toMatch(/^import[^\n]*curator\.ts/mu);
  });

  it('generates a process envelope that adopts numeric exit codes', () => {
    const source = generatedExecutableEntrySource({ entrySource: '/proj/src/cli.ts', exportName: 'main' });
    expect(source).toContain('import * as entry from "/proj/src/cli.ts"');
    expect(source).toContain('entry["main"]');
    expect(source).toContain('await main(process.argv.slice(2))');
    expect(source).toContain("if (typeof code === 'number') process.exitCode = code;");
    expect(generatedExecutableEntrySource({ entrySource: '/e.ts', exportName: 'default' })).toContain('entry["default"]');
  });
});
