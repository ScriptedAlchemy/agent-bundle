import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';
import { cliJson, cliNdjson, invokeCli, invokeMcpTool } from 'agent-bundle/test';

import { resultSchema as libraryAuditResultSchema } from '../../src/mcp/curator/tools/audit_library.tsx';
import { inputSchema as convertAudiobookInputSchema } from '../../src/mcp/curator/tools/convert_audiobook.tsx';
import { inputSchema as inspectInputSchema, resultSchema as inspectResultSchema } from '../../src/mcp/curator/tools/inspect_sources.tsx';
import { resultSchema as inventoryResultSchema } from '../../src/mcp/curator/tools/inventory_sources.tsx';
import { resultSchema as audibleSearchResultSchema } from '../../src/mcp/curator/tools/search_audible.tsx';
import { resultSchema as audibleSelectResultSchema } from '../../src/mcp/curator/tools/select_audible_edition.tsx';
import { discoveryOperations } from '../../src/operations/discovery.ts';

const directories: string[] = [];

const temporaryLibrary = async (): Promise<{
  readonly directory: string;
  readonly library: string;
  readonly report: string;
}> => {
  const directory = await mkdtemp(join(tmpdir(), 'curator-cli-dispatch-'));
  const library = join(directory, 'library');
  await mkdir(library);
  directories.push(directory);
  return { directory, library, report: join(directory, 'report.json') };
};

const invokeLibraryAudit = async (
  outputArgs: readonly string[] = [],
  tty = false,
) => {
  const fixture = await temporaryLibrary();
  const run = await invokeCli([
    'library-audit',
    fixture.library,
    '--report',
    fixture.report,
    '--concurrency',
    '1',
    ...outputArgs,
  ], { tty });
  return { ...fixture, run };
};

const libraryAuditMarkdown = [
  'Audited 0 library media files and found 0 duplicate candidate groups.',
  '',
  '- **Files:** 0',
  '- **Total bytes:** 0',
  '- **Missing album:** 0',
  '- **Missing artwork:** 0',
  '- **Missing author:** 0',
  '- **Missing chapters:** 0',
  '- **Missing title:** 0',
  '- **Probe failures:** 0',
  '',
  'No duplicate or multipart candidate groups were found.',
  '',
  '> Duplicate and multipart groups are review candidates, never deletion instructions.',
  '',
].join('\n');

const audibleProduct = {
  asin: 'B012345678',
  authors: [{ name: 'Ursula K. Le Guin' }],
  format_type: 'Unabridged',
  language: 'English',
  narrators: [{ name: 'Rob Inglis' }],
  runtime_length_min: 600,
  title: 'A Wizard of Earthsea',
};

/**
 * A deterministic Audible: every catalog request answers with one product,
 * and the requested hosts are recorded so a test can count domain calls. The
 * projection contract must be provable while Audible itself is unreachable.
 */
const withAudible = async <T>(run: () => Promise<T>): Promise<{ readonly hosts: readonly string[]; readonly value: T }> => {
  const hosts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    hosts.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host);
    return new Response(JSON.stringify({ products: [audibleProduct] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    return { hosts, value: await run() };
  } finally {
    globalThis.fetch = realFetch;
  }
};

const withoutGeneratedAt = (value: unknown): unknown => {
  const { generatedAt: _generatedAt, ...rest } = value as { readonly generatedAt: string };
  return rest;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('audiobook-curator at the CLI dispatch proof level', () => {
  describe('projected tool commands', () => {
    it('emits the inspect receipt as one canonical JSON line with direct-operation parity', async () => {
      const { library } = await temporaryLibrary();
      const run = await invokeCli(['inspect', library, '--max-files', '1', '--json']);
      const directInput = inspectInputSchema.parse({ maxFiles: 1, root: library });
      const direct = inspectResultSchema.parse(await discoveryOperations.inspect.handler(directInput, {
        signal: new AbortController().signal,
      }));
      const receipt = inspectResultSchema.parse(cliJson(run));

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.provenance.proofLevel).toBe('cli-dispatch');
      expect(run.routeId).toBe('tool:curator/inspect_sources');
      expect(receipt).toEqual(direct);
      expect(run.value).toEqual(direct);
      expect(run.stdout).toBe(`${JSON.stringify(direct)}\n`);
    });

    it('renders the tool document for the plain command and rejects the bulk curator group', async () => {
      const { library } = await temporaryLibrary();
      const run = await invokeCli(['inspect', library]);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('Inspected 0 audio files (0 bytes).');
      expect(run.stdout).toContain(`- **Root:** ${library}`);

      // One operation compiles to one command: a projected tool has no
      // `curator <tool> --input` twin.
      const bulk = await invokeCli(['curator', 'inspect_sources', '--input', JSON.stringify({ root: library })]);
      expect(bulk.exitCode).toBe(2);
      expect(bulk.stderr).toContain('Unknown command: curator.');
    });

    it('uses a successful inventory receipt exit code as the process exit code', async () => {
      const { library, report } = await temporaryLibrary();
      const run = await invokeCli(['inventory', library, '--report', report, '--strict', '--json']);
      const receipt = inventoryResultSchema.parse(cliJson(run));

      expect(receipt).toMatchObject({
        exitCode: 0,
        operation: 'inventory',
        summary: { errors: 0, files: 0 },
      });
      expect(run.exitCode).toBe(receipt.exitCode);
      expect(run.value).toEqual(receipt);
      expect(inventoryResultSchema.parse(JSON.parse(await readFile(report, 'utf8')))).toEqual(receipt);
    });

    it('runs inventory without --report, as the tool allows, and writes no report file', async () => {
      // Migration note (#734): the retired `src/cli/inventory.tsx` required
      // `--report`; the projected command shares the tool's optional field.
      const { directory, library } = await temporaryLibrary();
      const run = await invokeCli(['inventory', library, '--strict', '--json']);
      expect(await readdir(directory)).toEqual(['library']);
      const receipt = inventoryResultSchema.parse(cliJson(run));
      const tool = await invokeMcpTool('inventory_sources', { input: { source: library, strict: true } });

      expect(run.exitCode).toBe(0);
      expect(receipt).toMatchObject({ exitCode: 0, operation: 'inventory', summary: { errors: 0, files: 0 } });
      expect(run.value).toEqual(receipt);
      expect(tool.isError).toBe(false);
      expect(withoutGeneratedAt(tool.structuredContent)).toEqual(withoutGeneratedAt(receipt));
    });

    it('uses a failing inventory receipt exit code as the process exit code without ffprobe', async () => {
      const { directory, library, report } = await temporaryLibrary();
      await writeFile(join(library, 'broken.mp3'), 'not audio');
      const previousPath = process.env['PATH'];
      const run = await (async () => {
        // Fail the media probe before an external executable can run.
        process.env['PATH'] = directory;
        try {
          return await invokeCli(['inventory', library, '--report', report, '--strict', '--json']);
        } finally {
          if (previousPath === undefined) delete process.env['PATH'];
          else process.env['PATH'] = previousPath;
        }
      })();
      const receipt = inventoryResultSchema.parse(cliJson(run));

      expect(receipt).toMatchObject({
        exitCode: 1,
        operation: 'inventory',
        summary: { errors: 1, files: 0 },
      });
      expect(run.exitCode).toBe(receipt.exitCode);
      expect(run.value).toEqual(receipt);
    });

    it('reports an unknown command as a usage failure with the root help hint', async () => {
      const run = await invokeCli(['not-a-command']);

      expect(run.exitCode).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('Unknown command: not-a-command.');
      expect(run.stderr).toContain("Run 'audiobook-curator --help' for usage.");
    });

    it('reports an unknown option as a usage failure with the command help hint', async () => {
      const { library } = await temporaryLibrary();
      const run = await invokeCli(['inspect', library, '--wat']);

      expect(run.exitCode).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('Unknown option: --wat.');
      expect(run.stderr).toContain("Run 'audiobook-curator inspect --help' for usage.");
    });

    it('reports a missing required option under its projected spelling with the command help hint', async () => {
      const run = await invokeCli(['audible-cache', '--asin', 'B012345678']);

      expect(run.exitCode).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('Missing required option: --cache-dir.');
      expect(run.stderr).toContain("Run 'audiobook-curator audible-cache --help' for usage.");
    });

    it('projects real option spellings into command help and all routes into root help', async () => {
      const [commandHelp, rootHelp] = await Promise.all([
        invokeCli(['inspect', '--help']),
        invokeCli(['--help']),
      ]);

      expect(commandHelp.exitCode).toBe(0);
      expect(commandHelp.stderr).toBe('');
      expect(commandHelp.stdout).toContain('Usage: audiobook-curator inspect [options] <root>');
      expect(commandHelp.stdout).toContain('--max-files <number>');
      expect(commandHelp.stdout).toContain('MCP tool: curator:inspect_sources');
      expect(commandHelp.stdout).toContain('Projection: src/mcp/curator/tools/inspect_sources.cli.ts');
      expect(rootHelp.exitCode).toBe(0);
      expect(rootHelp.stderr).toBe('');
      expect(rootHelp.stdout).not.toMatch(/^ {2}curator(?: |$)/mu);
      for (const command of [
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
      ]) {
        expect(rootHelp.stdout).toMatch(new RegExp(`^  ${command}(?: |$)`, 'mu'));
      }
    });

    it('maps the inspect zod bounds failure to a flag error and exit 2 (#465)', async () => {
      const { library } = await temporaryLibrary();
      const run = await invokeCli(['inspect', library, '--max-files', '0']);

      expect(run.exitCode).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe([
        'Invalid value for --max-files: expected number >= 1; received 0.',
        'Usage: audiobook-curator inspect [options] <root>',
        "Run 'audiobook-curator inspect --help' for usage.",
        '',
      ].join('\n'));
      expect(run.stderr).not.toContain('maxFiles');
      expect(run.stderr).not.toContain('too_small');
    });
  });

  describe('the audible-search projection against the search_audible tool', () => {
    const query = {
      author: 'Ursula K. Le Guin',
      durationSeconds: 36_000,
      title: 'A Wizard of Earthsea',
    };

    it('reaches one domain invocation per region from either surface with an equal receipt', async () => {
      const cli = await withAudible(() => invokeCli([
        'audible-search',
        '--title', query.title,
        '--author', query.author,
        '--duration', String(query.durationSeconds),
        '--regions', 'us,uk',
        '--json',
      ]));
      const tool = await withAudible(() => invokeMcpTool('search_audible', { input: { ...query, regions: ['us', 'uk'] } }));
      const receipt = audibleSearchResultSchema.parse(cliJson(cli.value));

      expect(cli.value.exitCode).toBe(0);
      expect(cli.value.stderr).toBe('');
      expect(cli.value.routeId).toBe('tool:curator/search_audible');
      expect(cli.hosts).toEqual(['api.audible.com', 'api.audible.co.uk']);
      expect(tool.hosts).toEqual(cli.hosts);
      expect(tool.value.isError).toBe(false);
      expect(receipt.query).toEqual(query);
      expect(receipt.candidates.map((candidate) => candidate.region)).toEqual(['us', 'uk']);
      expect(withoutGeneratedAt(tool.value.structuredContent)).toEqual(withoutGeneratedAt(receipt));
      expect(cli.value.value).toEqual(receipt);
    });

    it('renders the same headline and ranking the tool renders', async () => {
      const { value: run } = await withAudible(() => invokeCli(['audible-search', '--title', query.title]));
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('Ranked 1 Audible candidates');
      expect(run.stdout).toContain('A Wizard of Earthsea');
    });

    it('defaults an omitted --regions to the operation default of one us search', async () => {
      const { hosts, value: run } = await withAudible(() => invokeCli(['audible-search', '--title', query.title, '--json']));
      expect(run.exitCode).toBe(0);
      expect(hosts).toEqual(['api.audible.com']);
      expect(audibleSearchResultSchema.parse(cliJson(run)).query).toEqual({ title: query.title });
    });

    it('accepts a repeated --regions and rejects an unknown region as a usage failure', async () => {
      const repeated = await withAudible(() => invokeCli(['audible-search', '--title', query.title, '--regions', 'de', '--regions', 'fr', '--json']));
      expect(repeated.value.exitCode).toBe(0);
      expect(repeated.hosts).toEqual(['api.audible.de', 'api.audible.fr']);

      // The region list is split before the canonical schema validates, so a
      // typo is a usage failure the tool's enum reports, never a request.
      const rejected = await withAudible(() => invokeCli(['audible-search', '--title', query.title, '--regions', 'us,mars']));
      expect(rejected.hosts).toEqual([]);
      expect(rejected.value.exitCode).toBe(2);
      expect(rejected.value.stdout).toBe('');
      expect(rejected.value.stderr).toContain('Invalid value for --regions[1]');
      expect(rejected.value.stderr).toContain('"mars"');
      expect(rejected.value.value).toBeUndefined();
    });

    it('uses the receipt exit code when every region fails', async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error('offline'); };
      try {
        const run = await invokeCli(['audible-search', '--title', query.title, '--attempts', '1', '--json']);
        const receipt = audibleSearchResultSchema.parse(cliJson(run));
        expect(receipt.exitCode).toBe(1);
        expect(receipt.errors.map((error) => error.region)).toEqual(['us']);
        expect(run.exitCode).toBe(1);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  describe('mutation commands keep the plan-first policy', () => {
    it('runs convert without --yes, gates the mutation on --apply, and reaches domain validation', async () => {
      const { directory } = await temporaryLibrary();
      const selection = join(directory, 'selection.json');
      await writeFile(selection, JSON.stringify({ selections: [] }));
      const input = convertAudiobookInputSchema.parse({
        author: 'Example Author',
        output: join(directory, 'output'),
        selection,
        title: 'Example Title',
      });
      const argv = [
        'convert',
        '--author', input.author,
        '--output', input.output,
        '--selection', input.selection,
        '--title', input.title,
      ];

      // An empty selection reaches domain validation before any media probe or binary.
      const planned = await invokeCli([...argv, '--json']);
      expect(planned.exitCode).toBe(1);
      expect(planned.stdout).toBe('');
      expect(planned.stderr).toContain('Selection contains no audio files.');
      expect(planned.stderr).not.toContain('--yes');
      expect(planned.value).toBeUndefined();

      // Migration note (#734): the retired `src/cli/convert.tsx` required
      // `--receipt`; the projected command shares the tool's optional field.
      // With or without it, the failure is the same and no receipt is written.
      const receipt = join(directory, 'convert-receipt.json');
      const withReceipt = await invokeCli([...argv, '--receipt', receipt, '--json']);
      expect(withReceipt.exitCode).toBe(1);
      expect(withReceipt.stderr).toBe(planned.stderr);
      await expect(readFile(receipt, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      // The projection declares confirm: false, so --yes is not an option here.
      const confirmed = await invokeCli([...argv, '--yes']);
      expect(confirmed.exitCode).toBe(2);
      expect(confirmed.stderr).toContain('Unknown option: --yes.');

      const help = await invokeCli(['convert', '--help']);
      expect(help.stdout).toContain('MCP tool: curator:convert_audiobook');
      expect(help.stdout).toContain('--apply');
      expect(help.stdout).not.toContain('requires --yes');
    });
  });

  describe('receipt paths are optional on the projected commands', () => {
    const candidateReport = async (): Promise<{ readonly candidates: string; readonly directory: string }> => {
      const { directory } = await temporaryLibrary();
      const candidates = join(directory, 'candidates.json');
      await writeFile(candidates, JSON.stringify({
        candidates: [{
          asin: 'B0CURATOR01',
          authors: [{ name: 'Ada Author' }],
          evidence: { authorMatch: true, languageMatch: true, narratorMatch: true, score: 100, strictIdentityMatch: true, titleMatch: true, unabridged: true },
          narrators: [{ name: 'Nora Narrator' }],
          region: 'us',
          title: 'The Selected Edition',
        }],
        errors: [],
        exitCode: 0,
        generatedAt: '2026-09-02T18:00:00.000Z',
        humanReviewRequired: true,
        mutation: false,
        operation: 'audible-search',
        query: { title: 'The Selected Edition' },
        reviewNote: 'Choose the matching edition.',
      }));
      return { candidates, directory };
    };

    it('records an Audible selection with and without --receipt and writes the file only when asked', async () => {
      const { candidates, directory } = await candidateReport();
      const receiptPath = join(directory, 'selection.json');
      const argv = ['audible-select', '--candidate', '1', '--candidates', candidates, '--json'];

      const without = await invokeCli(argv);
      expect(await readdir(directory)).toEqual(['candidates.json', 'library']);
      const withReceipt = await invokeCli([...argv, '--receipt', receiptPath]);
      const tool = await invokeMcpTool('select_audible_edition', { input: { candidate: 1, candidates } });

      for (const run of [without, withReceipt]) {
        expect(run.exitCode).toBe(0);
        expect(run.stderr).toBe('');
        expect(run.routeId).toBe('tool:curator/select_audible_edition');
        expect(audibleSelectResultSchema.parse(cliJson(run))).toMatchObject({
          candidateNumber: 1,
          humanReviewed: true,
          mutation: false,
          operation: 'audible-select',
          selected: { asin: 'B0CURATOR01' },
        });
      }
      expect(withoutGeneratedAt(cliJson(withReceipt))).toEqual(withoutGeneratedAt(cliJson(without)));
      expect(withoutGeneratedAt(tool.structuredContent)).toEqual(withoutGeneratedAt(cliJson(without)));
      expect(audibleSelectResultSchema.parse(JSON.parse(await readFile(receiptPath, 'utf8')))).toEqual(withReceipt.value);
      expect((await readdir(directory)).filter((name) => name.endsWith('.json')).sort()).toEqual(['candidates.json', 'selection.json']);
    });
  });

  describe('the rendered library-audit command', () => {
    it('emits exactly one final Markdown document when stdout is piped', async () => {
      const { report, run } = await invokeLibraryAudit();

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).toBe(libraryAuditMarkdown);
      expect(run.stdout).not.toContain('Analyzing duplicate and multipart groups');
      expect(libraryAuditResultSchema.parse(run.value)).toMatchObject({
        exitCode: 0,
        operation: 'library-audit',
        summary: { files: 0 },
      });
      expect(libraryAuditResultSchema.parse(JSON.parse(await readFile(report, 'utf8')))).toEqual(run.value);
    });

    it('writes the Suspense progress frame in place before the final Markdown for an explicit TTY', async () => {
      const { run } = await invokeLibraryAudit([], true);

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).toContain('\r\u001B[2KAnalyzing duplicate and multipart groups (0)');
      expect(run.stdout.indexOf('\r\u001B[2K')).toBeLessThan(run.stdout.indexOf(libraryAuditMarkdown));
      expect(run.stdout.endsWith(libraryAuditMarkdown)).toBe(true);
    });

    it('emits a canonical schema-validated JSON receipt', async () => {
      const { run } = await invokeLibraryAudit(['--json']);
      const receipt = libraryAuditResultSchema.parse(cliJson(run));

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe('');
      expect(receipt).toMatchObject({
        exitCode: 0,
        operation: 'library-audit',
        summary: { files: 0 },
      });
      expect(run.value).toEqual(receipt);
      expect(run.stdout).toBe(`${JSON.stringify(receipt)}\n`);
    });

    it('emits a monotonic CLI-dialect NDJSON stream ending in complete', async () => {
      const { run } = await invokeLibraryAudit(['--ndjson']);
      const events = cliNdjson(run);
      const sequences = events.map((event) => event.sequence);
      const terminal = events.at(-1);

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe('');
      // The Suspense fallback is a document event in the stream, not a
      // `progress` event: the tool reports no request-scoped progress.
      expect(events.some((event) => event.type === 'progress')).toBe(false);
      expect(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]!)).toBe(true);
      expect(terminal).toMatchObject({
        document: { status: 'success' },
        type: 'complete',
      });
      if (terminal?.type !== 'complete') throw new Error('expected a terminal complete event');
      expect(libraryAuditResultSchema.parse(terminal.document.value)).toEqual(run.value);
      expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('"jsonrpc"');
      expect(run.stdout.trim().split('\n')).toHaveLength(events.length);
    });

    it('rejects conflicting JSON and NDJSON output modes at the shell boundary', async () => {
      const { run } = await invokeLibraryAudit(['--json', '--ndjson']);

      expect(run.exitCode).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('Use either --json or --ndjson, not both.');
      expect(run.stderr).toContain("Run 'audiobook-curator library-audit --help' for usage.");
    });
  });
});
