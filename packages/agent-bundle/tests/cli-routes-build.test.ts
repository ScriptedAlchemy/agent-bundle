import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it } from '@rstest/core';

import { build } from '../src/api.ts';

const execFile = promisify(executeFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

/**
 * The routed-CLI packaging proof (#102 stage 2): `src/cli/**` routes feed the
 * existing package-build pipeline as one generated Rslib executable, and the
 * emitted bin serves help, JSON output, exit codes, and usage failures per
 * the documented contract.
 */
it('builds and runs the generated routed-CLI executable', { retry: 2, timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-cli-bin-'));
  roots.push(root);
  // The audiobook example's installed tree supplies @agent-bundle/runtime and zod.
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        zod: '4.4.3',
      },
      name: 'cli-bin-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      'export default defineConfig({',
      "  plugin: { description: 'Routed CLI fixture.', name: 'cli-bin-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/cli/doctor.ts', [
      "import { agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { aliases: ['health'], description: 'Inspect the runtime.' };",
      'export const inputSchema = z.object({ verbose: z.boolean().optional() }).strict();',
      "export const resultSchema = z.object({ invocation: z.string(), status: z.literal('ready'), surface: z.string() }).strict();",
      'export default async function doctor({ input, signal }) {',
      "  if (signal.aborted) throw new DOMException('aborted', 'AbortError');",
      '  const context = await agent();',
      '  return {',
      '    invocation: context.invocation.kind,',
      "    status: 'ready',",
      "    surface: input.verbose === true ? `${context.invocation.surface} (verbose)` : context.invocation.surface,",
      '  };',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/cli/library/audit.ts', [
      "import { z } from 'zod';",
      "export const config = { description: 'Audit sources.', exitCode: 'result', positionals: ['sources'] };",
      'export const inputSchema = z.object({',
      '  maxFindings: z.number().int().min(0).default(1),',
      '  sources: z.array(z.string().min(1)).min(1).max(8),',
      '  strict: z.boolean().optional(),',
      '}).strict();',
      'export const resultSchema = z.object({ exitCode: z.number(), sources: z.array(z.string()) }).strict();',
      'export default async function audit({ input }) {',
      '  return {',
      '    exitCode: input.strict === true && input.sources.length > input.maxFindings ? 2 : 0,',
      '    sources: input.sources,',
      '  };',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/cli/report.tsx', [
      "import React from 'react';",
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { description: 'Render a library report.', positionals: ['root'] };",
      'export const inputSchema = z.object({ root: z.string().min(1) }).strict();',
      'export const resultSchema = z.object({ books: z.number(), root: z.string() }).strict();',
      'export default async function Report({ input, signal }) {',
      "  if (signal.aborted) throw new DOMException('aborted', 'AbortError');",
      '  const context = await agent();',
      "  await context.progress.report({ completed: 1, message: 'scanning', total: 2 });",
      '  const result = { books: 2, root: input.root };',
      '  return (',
      '    <Agent.Result value={result}>',
      '      <Agent.Markdown>{`Found **2** books under ${input.root}.`}</Agent.Markdown>',
      '    </Agent.Result>',
      '  );',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/scripts/summarize.tsx', [
      "import React from 'react';",
      "import { Agent } from '@agent-bundle/runtime';",
      'export default async function Summarize({ argv, signal }) {',
      "  if (signal.aborted) throw new DOMException('aborted', 'AbortError');",
      '  const result = { arguments: argv.length };',
      '  return (',
      '    <Agent.Result value={result}>',
      '      <Agent.Text>{`Summarized ${String(argv.length)} arguments.`}</Agent.Text>',
      '    </Agent.Result>',
      '  );',
      '}',
      '',
    ].join('\n')),
  ]);

  const result = await build({ output: 'artifact', packageOutputs: true, root });
  expect(result.model.packageBuild?.bins).toMatchObject([
    { name: 'cli-bin-fixture', provenance: { kind: 'conventional' } },
  ]);
  const binPath = join(root, 'dist', 'bin', 'cli-bin-fixture.js');
  const binSource = await readFile(binPath, 'utf8');
  expect(binSource.startsWith('#!/usr/bin/env node\n')).toBe(true);
  expect(binSource).not.toMatch(/from\s*['"]agent-bundle\/cli-entry['"]/u);
  expect((await stat(binPath)).mode & 0o111).not.toBe(0);
  // The emitted executable's provenance names every command route module.
  const binEvidence = result.packageBuild!.files.find((file) => file.path === 'bin/cli-bin-fixture.js');
  expect(binEvidence?.sourceInputs).toEqual(expect.arrayContaining([
    'src/cli/doctor.ts',
    'src/cli/library/audit.ts',
  ]));

  // Help and version come from the compiled command graph.
  const help = await execFile(binPath, ['--help']);
  expect(help.stdout).toContain('cli-bin-fixture 1.0.0');
  expect(help.stdout).toContain('Routed CLI fixture.');
  expect(help.stdout).toContain('doctor');
  expect(help.stdout).toContain('library <command>');
  const commandHelp = await execFile(binPath, ['library', 'audit', '--help']);
  expect(commandHelp.stdout).toContain('Usage: cli-bin-fixture library audit [options] <sources...>');
  expect(commandHelp.stdout).toContain('--max-findings <number>');
  await expect(execFile(binPath, ['--version'])).resolves.toMatchObject({ stdout: 'cli-bin-fixture 1.0.0\n' });

  // Commands run inside the typed Agent request context and print one JSON line.
  const doctor = await execFile(binPath, ['doctor']);
  expect(JSON.parse(doctor.stdout)).toEqual({ invocation: 'cli', status: 'ready', surface: 'doctor' });
  const aliased = await execFile(binPath, ['health', '--verbose', '--json']);
  expect(JSON.parse(aliased.stdout)).toEqual({ invocation: 'cli', status: 'ready', surface: 'doctor (verbose)' });

  // Nested commands parse positionals/options and honor the result exit-code policy.
  const audit = await execFile(binPath, ['library', 'audit', 'a', 'b']);
  expect(JSON.parse(audit.stdout)).toEqual({ exitCode: 0, sources: ['a', 'b'] });
  await expect(execFile(binPath, ['library', 'audit', '--strict', 'a', 'b']))
    .rejects.toMatchObject({ code: 2, stdout: '{"exitCode":2,"sources":["a","b"]}\n' });

  // Usage and input-validation failures exit 2 with diagnostics on stderr only.
  await expect(execFile(binPath, ['unknown'])).rejects.toMatchObject({ code: 2, stdout: '' });
  const tooMany = execFile(binPath, ['library', 'audit', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  await expect(tooMany).rejects.toMatchObject({ code: 2, stdout: '' });
  await expect(tooMany).rejects.toMatchObject({ stderr: expect.stringContaining('sources') });

  // The rendered .tsx command (#102 stage 3) renders through the dispatcher
  // against the sibling react-server worker.
  const workerPath = join(root, 'dist', 'bin', 'cli-bin-fixture-flight.mjs');
  await expect(stat(workerPath)).resolves.toMatchObject({});
  // Piped output is exactly one final Markdown document, no partial fallbacks.
  const piped = await execFile(binPath, ['report', '/library']);
  expect(piped.stdout).toBe('Found **2** books under /library.\n');
  // --json returns the canonical validated final value.
  const reportJson = await execFile(binPath, ['report', '/library', '--json']);
  expect(JSON.parse(reportJson.stdout)).toEqual({ books: 2, root: '/library' });
  // --ndjson exposes the sequence-numbered render-event stream, including
  // the progress the component reported through the request context.
  const reportEvents = await execFile(binPath, ['report', '/library', '--ndjson']);
  const events = reportEvents.stdout.trimEnd().split('\n')
    .map((line) => JSON.parse(line) as { sequence: number; type: string });
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
  expect(events.some((event) => event.type === 'progress')).toBe(true);
  expect(events[events.length - 1]!.type).toBe('complete');
  // Rendered input-validation failures stay usage failures.
  await expect(execFile(binPath, ['report'])).rejects.toMatchObject({ code: 2, stdout: '' });

  // The rendered .tsx script (#102 stage 3) ships beside plain scripts in
  // the target artifact with the same output contract.
  const scriptPath = join(root, 'artifact', 'portable', 'scripts', 'summarize.mjs');
  await expect(stat(join(root, 'artifact', 'portable', 'scripts', 'summarize-flight.mjs'))).resolves.toMatchObject({});
  const scriptMarkdown = await execFile(process.execPath, [scriptPath, 'alpha', 'beta']);
  expect(scriptMarkdown.stdout).toBe('Summarized 2 arguments.\n');
  const scriptJson = await execFile(process.execPath, [scriptPath, 'alpha', '--json']);
  expect(JSON.parse(scriptJson.stdout)).toEqual({ arguments: 1 });
});
