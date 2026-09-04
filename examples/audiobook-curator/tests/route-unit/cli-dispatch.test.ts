import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';
import { cliJson, cliNdjson, invokeCli } from 'agent-bundle/test';

import inspectRoute, {
  inputSchema as inspectInputSchema,
  resultSchema as inspectResultSchema,
} from '../../src/cli/inspect.ts';
import { resultSchema as inventoryResultSchema } from '../../src/cli/inventory.tsx';
import { resultSchema as libraryAuditResultSchema } from '../../src/cli/library-audit.tsx';
import { inputSchema as convertAudiobookInputSchema } from '../../src/mcp/curator/tools/convert_audiobook.tsx';
import { resultSchema as inspectSourcesResultSchema } from '../../src/mcp/curator/tools/inspect_sources.tsx';

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
  'Audited 0 files (0 bytes) across 1 sources.',
  '',
  '## Library audit',
  '',
  '- **Files:** 0',
  '- **Total bytes:** 0',
  '- **Sources:** 1',
  '- **Metadata issues:** 0',
  '- **Duplicate candidates:** 0',
  '- **Multipart candidates:** 0',
  '',
  'No duplicate or multipart candidate groups were found.',
  '',
  '> Duplicate and multipart groups are review candidates, never deletion instructions.',
  '',
].join('\n');

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('audiobook-curator at the CLI dispatch proof level', () => {
  describe('custom commands', () => {
    it('emits the inspect receipt as one canonical JSON line with direct-operation byte parity', async () => {
      const { library } = await temporaryLibrary();
      const run = await invokeCli(['inspect', library, '--max-files', '1']);
      const directInput = inspectInputSchema.parse({ maxFiles: 1, root: library });
      const direct = inspectResultSchema.parse(await inspectRoute({
        input: directInput,
        signal: new AbortController().signal,
      }));
      const receipt = inspectResultSchema.parse(cliJson(run));

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.provenance.proofLevel).toBe('cli-dispatch');
      expect(receipt).toEqual(direct);
      expect(run.value).toEqual(direct);
      expect(run.stdout).toBe(`${JSON.stringify(direct)}\n`);
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

    it('reports a missing required option as a usage failure with the command help hint', async () => {
      const { library } = await temporaryLibrary();
      const run = await invokeCli(['inventory', library]);

      expect(run.exitCode).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('Missing required option: --report.');
      expect(run.stderr).toContain("Run 'audiobook-curator inventory --help' for usage.");
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
      expect(rootHelp.exitCode).toBe(0);
      expect(rootHelp.stderr).toBe('');
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

  describe('projected MCP commands', () => {
    it('runs read-only inspect_sources without --yes and emits its schema-validated JSON receipt', async () => {
      const { library } = await temporaryLibrary();
      const run = await invokeCli([
        'curator',
        'inspect_sources',
        '--input',
        JSON.stringify({ root: library }),
        '--json',
      ]);
      const receipt = inspectSourcesResultSchema.parse(cliJson(run));

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.routeId).toBe('tool:curator/inspect_sources');
      expect(receipt).toMatchObject({
        files: [],
        operation: 'inspect',
        root: library,
        totalBytes: 0,
      });
      expect(run.value).toEqual(receipt);
    });

    it('fails convert_audiobook closed without --yes and reaches domain validation with it', async () => {
      const { directory } = await temporaryLibrary();
      const selection = join(directory, 'selection.json');
      await writeFile(selection, JSON.stringify({ selections: [] }));
      const input = convertAudiobookInputSchema.parse({
        author: 'Example Author',
        output: join(directory, 'output'),
        selection,
        title: 'Example Title',
      });
      const argv = ['curator', 'convert_audiobook', '--input', JSON.stringify(input)];

      const denied = await invokeCli(argv);
      expect(denied.exitCode).toBe(2);
      expect(denied.stdout).toBe('');
      expect(denied.stderr).toContain('--yes');
      expect(denied.value).toBeUndefined();

      // An empty selection reaches domain validation before any media probe or binary.
      const allowed = await invokeCli([...argv, '--yes', '--json']);
      expect(allowed.exitCode).toBe(1);
      expect(allowed.stdout).toBe('');
      expect(allowed.stderr).toContain('Selection contains no audio files.');
      expect(allowed.stderr).not.toContain('requires --yes');
      expect(allowed.value).toBeUndefined();
    });

    it('maps invalid JSON and tool inputSchema rejection to usage exit 2', async () => {
      const invalidJson = await invokeCli(['curator', 'inspect_sources', '--input', '{']);
      expect(invalidJson.exitCode).toBe(2);
      expect(invalidJson.stdout).toBe('');
      expect(invalidJson.stderr).toContain('valid JSON object');
      expect(invalidJson.value).toBeUndefined();

      const rejected = await invokeCli([
        'curator',
        'inspect_sources',
        '--input',
        '{"root":""}',
      ]);
      expect(rejected.exitCode).toBe(2);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toContain('root');
      expect(rejected.stderr).toContain("Run 'audiobook-curator curator inspect_sources --help' for usage.");
      expect(rejected.value).toBeUndefined();
    });

    it('merges the curator group with custom commands and explains projected provenance', async () => {
      const [rootHelp, curatorHelp, mutationHelp] = await Promise.all([
        invokeCli(['--help']),
        invokeCli(['curator', '--help']),
        invokeCli(['curator', 'convert_audiobook', '--help']),
      ]);

      expect(rootHelp.exitCode).toBe(0);
      expect(rootHelp.stderr).toBe('');
      expect(rootHelp.stdout).toMatch(/^ {2}curator <command>(?: |$)/mu);
      expect(rootHelp.stdout).toMatch(/^ {2}inspect(?: |$)/mu);
      expect(curatorHelp.exitCode).toBe(0);
      expect(curatorHelp.stderr).toBe('');
      expect(curatorHelp.stdout).toMatch(/^ {2}inspect_sources(?: |$)/mu);
      expect(mutationHelp.exitCode).toBe(0);
      expect(mutationHelp.stderr).toBe('');
      expect(mutationHelp.stdout).toContain('MCP tool: curator:convert_audiobook');
      expect(mutationHelp.stdout).toContain('Mutation-capable; requires --yes.');
    });
  });

  describe('the rendered library-audit command', () => {
    it('emits exactly one final Markdown document when stdout is piped', async () => {
      const { report, run } = await invokeLibraryAudit();

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).toBe(libraryAuditMarkdown);
      expect(run.stdout).not.toContain('Auditing sources');
      expect(run.stdout).not.toContain('Audit complete');
      expect(libraryAuditResultSchema.parse(run.value)).toMatchObject({
        exitCode: 0,
        operation: 'library-audit',
        summary: { files: 0 },
      });
      expect(libraryAuditResultSchema.parse(JSON.parse(await readFile(report, 'utf8')))).toEqual(run.value);
    });

    it('writes progress-in-place frames before the final Markdown for an explicit TTY', async () => {
      const { run } = await invokeLibraryAudit([], true);

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).toContain('\r\u001B[2KAuditing sources (0/1)');
      expect(run.stdout).toContain('\r\u001B[2KAudit complete (1/1)');
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
      expect(events.some((event) => event.type === 'progress')).toBe(true);
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
