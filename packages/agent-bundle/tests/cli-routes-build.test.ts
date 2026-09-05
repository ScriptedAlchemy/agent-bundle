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
 * What the fixture's `library-tooling` provider observes of the request on
 * every generated surface (#459): a routed-CLI executable mounts no host
 * conversation, so `host`/`lineage` carry the typed `unsupported-surface`
 * reason the route reads too; the process-lifetime `src/state.ts` mounts the
 * `read`-only state handle and the `inbox`/`published`-only notice handle; `useAgent()`
 * throws `outside-invocation` because the resolver runs outside the request.
 */
const providerView = {
  handle: 'outside-invocation',
  host: 'unsupported-surface',
  lineage: 'unsupported-surface',
  notices: ['inbox', 'published'],
  plugin: 'available',
  session: 'not-provided',
  state: { keys: ['lifetime', 'read'], lifetime: 'process', revision: 0 },
  workspace: process.cwd(),
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
      '  routes: { mcpCommands: true },',
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
    // Process-lifetime state, so every generated scope mounts a state handle
    // and a notice ledger without touching the plugin root on disk.
    writeProjectFile(root, 'src/state.ts', [
      "import { defineState } from '@agent-bundle/runtime/state';",
      "import { z } from 'zod';",
      'export default defineState({',
      '  events: { noted: z.object({ note: z.string() }).strict() },',
      "  id: 'cli-bin-fixture/notes',",
      '  initial: { notes: [] },',
      "  lifetime: 'process',",
      '  reduce: (state, event) => ({ notes: [...state.notes, event.payload.note] }),',
      '  schema: z.object({ notes: z.array(z.string()) }).strict(),',
      '});',
      '',
    ].join('\n')),
    // A conventional request context provider (#313): every generated request
    // scope — plain CLI, rendered CLI, projected MCP command, rendered script —
    // mounts the same value. Beside the invocation it reports the request view
    // the scope resolved it over (#459): the identity axes as the route reads
    // them, the read-only state and notice handles, and the runtime error
    // `useAgent()` raises because providers run outside the request context.
    writeProjectFile(root, 'src/providers/library-tooling.ts', [
      "import { AgentRequestError, useAgent } from '@agent-bundle/runtime';",
      'export default async function libraryTooling(context) {',
      '  const { invocation, signal } = context;',
      "  if (signal.aborted) throw new DOMException('aborted', 'AbortError');",
      '  let handle;',
      "  try { useAgent(); handle = 'reachable'; } catch (error) { handle = error instanceof AgentRequestError ? error.code : 'unexpected'; }",
      '  const view = {',
      '    handle,',
      "    host: context.host.state === 'available' ? context.host.value.name : context.host.reason,",
      "    lineage: context.lineage.state === 'available' ? context.lineage.value.conversation : context.lineage.reason,",
      '    notices: context.notices === undefined ? null : Object.keys(context.notices).sort(),',
      '    plugin: context.plugin.state,',
      "    session: context.session.state === 'available' ? context.session.value.sessionId : context.session.reason,",
      '    state: context.state === undefined',
      '      ? null',
      '      : { keys: Object.keys(context.state).sort(), lifetime: context.state.lifetime, revision: (await context.state.read()).revision },',
      "    workspace: context.workspace.state === 'available' ? context.workspace.value.root : context.workspace.reason,",
      '  };',
      // Branching on the documented kind fails loudly if a surface ever posts
      // no invocation to its worker again (#319 review).
      "  switch (invocation.kind) {",
      "    case 'cli': case 'script': case 'tool': return { kind: invocation.kind, tool: 'ffprobe 6.1', view };",
      "    default: throw new Error(`unexpected invocation kind ${String(invocation.kind)}`);",
      '  }',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/cli/tooling.ts', [
      "import { agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { description: 'Report the mounted request providers.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({',
      '  hits: z.number().int().min(1),',
      "  libraryTooling: z.object({ kind: z.literal('cli'), tool: z.string(), view: z.unknown() }).strict(),",
      '}).strict();',
      'export default async function tooling() {',
      '  const context = await agent();',
      '  return { hits: context.providers.processLifetime.hits, libraryTooling: context.providers.libraryTooling };',
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
      'export const resultSchema = z.object({ books: z.number(), root: z.string(), tooling: z.string(), view: z.unknown() }).strict();',
      'export default async function Report({ input, signal }) {',
      "  if (signal.aborted) throw new DOMException('aborted', 'AbortError');",
      '  const context = await agent();',
      "  await context.progress.report({ completed: 1, message: 'scanning', total: 2 });",
      '  const result = { books: 2, root: input.root, tooling: `${context.providers.libraryTooling.kind}:${context.providers.libraryTooling.tool}`, view: context.providers.libraryTooling.view };',
      '  return (',
      '    <Agent.Result value={result}>',
      '      <Agent.Markdown>{`Found **2** books under ${input.root}.`}</Agent.Markdown>',
      '    </Agent.Result>',
      '  );',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/cli/exit-zero.tsx', [
      "import { z } from 'zod';",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.boolean() }).strict();',
      'export default async function ExitZero() {',
      '  process.exit(0);',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/harness/tools/lookup.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Looks up one value.' };",
      'export const inputSchema = z.object({ message: z.string().default("ready") }).strict();',
      "export const resultSchema = z.object({ invocation: z.literal('tool'), message: z.string(), operationId: z.string(), tooling: z.string(), view: z.unknown() }).strict();",
      'export default async function Lookup({ input }) {',
      '  const context = await agent();',
      "  await context.progress.report({ completed: 1, message: 'lookup', total: 1 });",
      '  const result = { invocation: context.invocation.kind, message: input.message, operationId: context.invocation.operationId, tooling: `${context.providers.libraryTooling.kind}:${context.providers.libraryTooling.tool}`, view: context.providers.libraryTooling.view };',
      '  return <Agent.Result value={result}><Agent.Markdown>{`Lookup: ${input.message}`}</Agent.Markdown></Agent.Result>;',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/harness/tools/apply.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { description: 'Applies one value.' };",
      'export const inputSchema = z.object({ value: z.string() }).strict();',
      "export const resultSchema = z.object({ invocation: z.literal('tool'), operationId: z.string(), value: z.string() }).strict();",
      'export default async function Apply({ input }) {',
      '  const context = await agent();',
      '  const result = { invocation: context.invocation.kind, operationId: context.invocation.operationId, value: input.value };',
      '  return <Agent.Result value={result}><Agent.Text>{`Applied ${input.value}.`}</Agent.Text></Agent.Result>;',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/scripts/checksum.ts', [
      'const checksum = async (): Promise<number> => {',
      "  process.stdout.write('Fixture checksum: 102\\n');",
      '  return 0;',
      '};',
      'export default checksum;',
      'export { checksum as main };',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/scripts/summarize.tsx', [
      "import React from 'react';",
      "import { Agent, agent } from '@agent-bundle/runtime';",
      'export default async function Summarize({ argv, signal }) {',
      "  if (signal.aborted) throw new DOMException('aborted', 'AbortError');",
      '  const context = await agent();',
      '  const result = { arguments: argv.length, tooling: `${context.providers.libraryTooling.kind}:${context.providers.libraryTooling.tool}`, view: context.providers.libraryTooling.view };',
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
    'src/cli/tooling.ts',
    'src/mcp/harness/tools/apply.tsx',
    'src/mcp/harness/tools/lookup.tsx',
    'src/providers/library-tooling.ts',
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
  // Plain .ts commands mount conventional providers once per request (#313),
  // with the framework-owned processLifetime value beside them.
  const tooling = await execFile(binPath, ['tooling']);
  expect(JSON.parse(tooling.stdout)).toEqual({ hits: 1, libraryTooling: { kind: 'cli', tool: 'ffprobe 6.1', view: providerView } });

  // Nested commands parse positionals/options and honor the result exit-code policy.
  const audit = await execFile(binPath, ['library', 'audit', 'a', 'b']);
  expect(JSON.parse(audit.stdout)).toEqual({ exitCode: 0, sources: ['a', 'b'] });
  await expect(execFile(binPath, ['library', 'audit', '--strict', 'a', 'b']))
    .rejects.toMatchObject({ code: 2, stdout: '{"exitCode":2,"sources":["a","b"]}\n' });

  // Usage and input-validation failures exit 2 with diagnostics on stderr only.
  await expect(execFile(binPath, ['unknown'])).rejects.toMatchObject({ code: 2, stdout: '' });
  // The packed executable spells a schema rejection in CLI terms (#465): the
  // argument, the expectation, the received value, then the usage line —
  // never the raw zod issue JSON.
  const tooMany = execFile(binPath, ['library', 'audit', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  await expect(tooMany).rejects.toMatchObject({
    code: 2,
    stderr: [
      'Invalid value for <sources>: expected array with at most 8 items; received ["a","b","c","d","e","f","g","h","i"].',
      'Usage: cli-bin-fixture library audit [options] <sources...>',
      "Run 'cli-bin-fixture library audit --help' for usage.",
      '',
    ].join('\n'),
    stdout: '',
  });
  const tooManyJson = execFile(binPath, ['library', 'audit', '--max-findings', '-1', 'a', '--json']);
  await expect(tooManyJson).rejects.toMatchObject({ code: 2, stdout: '' });
  await tooManyJson.catch((failure: { readonly stderr: string }) => {
    expect(JSON.parse(failure.stderr)).toEqual({
      error: {
        code: 'CLI_INPUT_INVALID',
        issues: [{ expected: 'number >= 0', message: expect.any(String), received: -1, target: '--max-findings' }],
        usage: 'Usage: cli-bin-fixture library audit [options] <sources...>',
      },
    });
  });

  // The rendered .tsx command (#102 stage 3) renders through the dispatcher
  // against the sibling react-server worker.
  const workerPath = join(root, 'dist', 'bin', 'cli-bin-fixture-flight.mjs');
  await expect(stat(workerPath)).resolves.toMatchObject({});
  // Piped output is exactly one final Markdown document, no partial fallbacks.
  const piped = await execFile(binPath, ['report', '/library']);
  expect(piped.stdout).toBe('Found **2** books under /library.\n');
  // --json returns the canonical validated final value; the rendered command
  // observed the same conventional provider as the plain command (#313).
  const reportJson = await execFile(binPath, ['report', '/library', '--json']);
  expect(JSON.parse(reportJson.stdout)).toEqual({ books: 2, root: '/library', tooling: 'cli:ffprobe 6.1', view: providerView });
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

  // Projected MCP tools share this executable and invoke the tool route
  // contract, including machine output and fail-closed mutation gating.
  const projectedJson = await execFile(binPath, [
    'harness', 'lookup', '--input', '{"message":"packed"}', '--json',
  ]);
  // The projected command's provider sees `invocation.kind === 'tool'`, not the
  // CLI surface it was typed on (#319 review).
  expect(JSON.parse(projectedJson.stdout)).toEqual({
    invocation: 'tool',
    message: 'packed',
    operationId: 'tool:harness/lookup',
    tooling: 'tool:ffprobe 6.1',
    view: providerView,
  });
  const projectedNdjson = await execFile(binPath, [
    'harness', 'lookup', '--input', '{"message":"events"}', '--ndjson',
  ]);
  const projectedEvents = projectedNdjson.stdout.trimEnd().split('\n')
    .map((line) => JSON.parse(line) as { jsonrpc?: unknown; sequence: number; type: string });
  expect(projectedEvents.some((event) => event.type === 'progress')).toBe(true);
  expect(projectedEvents.at(-1)?.type).toBe('complete');
  expect(projectedEvents.every((event) => event.jsonrpc === undefined)).toBe(true);
  await expect(execFile(binPath, [
    'harness', 'apply', '--input', '{"value":"blocked"}', '--json',
  ])).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringContaining('requires --yes'),
    stdout: '',
  });
  const projectedMutation = await execFile(binPath, [
    'harness', 'apply', '--input', '{"value":"allowed"}', '--yes', '--json',
  ]);
  expect(JSON.parse(projectedMutation.stdout)).toEqual({
    invocation: 'tool',
    operationId: 'tool:harness/apply',
    value: 'allowed',
  });

  // A worker that exits cleanly before completing a request must fail that
  // request explicitly instead of leaving its Flight stream unsettled.
  await expect(execFile(binPath, ['exit-zero'], { timeout: 5_000 })).rejects.toMatchObject({
    code: 1,
    stderr: 'Generated render worker exited with code 0.\n',
    stdout: '',
  });

  // The rendered .tsx script (#102 stage 3) ships beside plain scripts in
  // the target artifact with the same output contract.
  const scriptPath = join(root, 'artifact', 'scripts', 'summarize.mjs');
  await expect(stat(join(root, 'artifact', 'scripts', 'summarize-flight.mjs'))).resolves.toMatchObject({});
  const scriptMarkdown = await execFile(process.execPath, [scriptPath, 'alpha', 'beta']);
  expect(scriptMarkdown.stdout).toBe('Summarized 2 arguments.\n');
  // The rendered script's provider sees `invocation.kind === 'script'` (#313).
  const scriptJson = await execFile(process.execPath, [scriptPath, 'alpha', '--json']);
  expect(JSON.parse(scriptJson.stdout)).toEqual({ arguments: 1, tooling: 'script:ffprobe 6.1', view: providerView });

  // #102 acceptance: one build ships custom, MCP-generated, plain, and rendered commands/scripts.
  const plainScriptPath = join(root, 'artifact', 'scripts', 'checksum.mjs');
  await expect(stat(plainScriptPath)).resolves.toMatchObject({});
  const plainScript = await execFile(process.execPath, [plainScriptPath]);
  expect(plainScript.stdout).toBe('Fixture checksum: 102\n');
  await expect(stat(join(root, 'artifact', 'scripts', 'checksum-flight.mjs'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
