import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@rstest/core';

import { build, type ReadyInspectResult, validate } from '../src/api.ts';
import { runCli } from '../src/cli.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';

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
      "export const resultSchema = z.object({ invocation: z.enum(['cli', 'tool']), message: z.string(), operationId: z.string(), tooling: z.string(), view: z.unknown() }).strict();",
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
      "export const resultSchema = z.object({ invocation: z.enum(['cli', 'tool']), operationId: z.string(), value: z.string() }).strict();",
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
  // The projected command and provider both see the CLI surface; the tool id
  // remains the operation identity.
  expect(JSON.parse(projectedJson.stdout)).toEqual({
    invocation: 'cli',
    message: 'packed',
    operationId: 'tool:harness/lookup',
    tooling: 'cli:ffprobe 6.1',
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
    invocation: 'cli',
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

/**
 * AB4837 (#558): a routed command that value-imports a compiler-carrying
 * framework entry is refused when the route graph compiles — by `validate`
 * without building, and by `build` before the bundler inlines the compiler
 * into the self-contained bin and fails with an opaque error that names the
 * generated file instead of the route.
 */
it('refuses a routed command that imports agent-bundle/api with AB4837 before bundling', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-cli-bin-framework-import-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        zod: '4.4.3',
      },
      name: 'cli-bin-framework-import-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      'export default defineConfig({',
      "  plugin: { description: 'Routed CLI fixture.', name: 'cli-bin-framework-import-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
    // The #558 shape: the command serves an MCP App by importing the compiler.
    writeProjectFile(root, 'src/cli/dashboard.ts', [
      "import { z } from 'zod';",
      "export const config = { description: 'Open the dashboard in a browser.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ url: z.string() }).strict();',
      'export default async function dashboard() {',
      "  const { serveApp } = await import('agent-bundle/api');",
      "  const served = await serveApp({ app: 'curator/dashboard', root: process.cwd() });",
      '  return { url: served.url };',
      '}',
      '',
    ].join('\n')),
  ]);
  const expected = {
    code: 'AB4837',
    message: 'Route module src/cli/dashboard.ts imports "agent-bundle/api" as a value; the routed CLI executable is self-contained and cannot bundle the compiler, so the build would fail deep inside the generated executable (an unresolvable compiler module or AB6005) instead of at this import.',
    severity: 'error',
    sourcePath: join(root, 'src', 'cli', 'dashboard.ts'),
  };

  // Reported statically, without a build.
  const validation = await validate({ root });
  expect(validation.diagnostics.filter((diagnostic) => diagnostic.code === 'AB4837')).toEqual([expect.objectContaining(expected)]);

  // The build rejects on the same diagnostic before any executable is bundled.
  const failure: unknown = await build({ output: 'artifact', packageOutputs: true, root }).then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(DiagnosticError);
  const { diagnostics } = failure as DiagnosticError;
  const reported = diagnostics.filter((diagnostic) => diagnostic.code === 'AB4837');
  expect(reported).toEqual([expect.objectContaining(expected)]);
  expect(reported[0]?.recovery).toContain('spawnServeApp from agent-bundle/serve-app-command');
  // Neither the bundler's resolution failure nor the artifact validator's
  // rejection of the inlined compiler reaches the author any more.
  expect(diagnostics.some((diagnostic) => diagnostic.message.includes("Can't resolve"))).toBe(false);
  expect(diagnostics.some((diagnostic) => diagnostic.code === 'AB6005')).toBe(false);
  await expect(stat(join(root, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(root, 'artifact'))).rejects.toMatchObject({ code: 'ENOENT' });
});

/**
 * The CLI surface projection (#596) in a built executable: `submit.cli.ts`
 * beside `src/mcp/demo/tools/submit.tsx` projects the tool onto `<bin> submit`
 * with an idiomatic grammar, the generated shell parses that grammar and
 * applies `mapInput` before the tool's canonical schema, and `inspect --routes`
 * reports the projection on the compiled command. One build serves every case.
 */
describe('the CLI surface projection in the generated routed-CLI executable', () => {
  const projectionModule = 'src/mcp/demo/tools/submit.cli.ts';
  const usage = 'Usage: cli-projection-fixture submit [options] <argv...>';
  let root: string;
  let binPath: string;
  let built: Awaited<ReturnType<typeof build>>;

  beforeAll(async () => {
    // `process.cwd()` in the child is the resolved path; the fixture compares against it.
    root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-cli-projection-')));
    binPath = join(root, 'dist', 'bin', 'cli-projection-fixture.js');
    await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
    await Promise.all([
      writeProjectFile(root, 'package.json', JSON.stringify({
        dependencies: {
          '@agent-bundle/runtime': 'workspace:*',
          zod: '4.4.3',
        },
        name: 'cli-projection-fixture',
        type: 'module',
        version: '1.0.0',
      })),
      writeProjectFile(root, 'agent-bundle.config.ts', [
        "import { defineConfig } from 'agent-bundle/config';",
        'export default defineConfig({',
        "  plugin: { description: 'CLI projection fixture.', name: 'cli-projection-fixture', version: '1.0.0' },",
        '  routes: { mcpCommands: true },',
        "  targets: ['portable'],",
        '});',
        '',
      ].join('\n')),
      writeProjectFile(root, 'src/mcp/demo/tools/ping.tsx', [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { z } from 'zod';",
        "export const config = { annotations: { readOnlyHint: true }, description: 'Answers a ping.' };",
        'export const inputSchema = z.object({}).strict();',
        "export const resultSchema = z.object({ pong: z.literal(true) }).strict();",
        'export default async function Ping() {',
        '  return <Agent.Result value={{ pong: true }}><Agent.Text>pong</Agent.Text></Agent.Result>;',
        '}',
        '',
      ].join('\n')),
      writeProjectFile(root, 'src/mcp/demo/tools/purge.tsx', [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { z } from 'zod';",
        "export const config = { annotations: { readOnlyHint: false }, description: 'Purges one cache target.' };",
        'export const inputSchema = z.object({ target: z.string().min(1) }).strict();',
        "export const resultSchema = z.object({ operation: z.literal('purge'), target: z.string() }).strict();",
        'export default async function Purge({ input }) {',
        "  const value = { operation: 'purge', target: input.target };",
        '  return <Agent.Result value={value}><Agent.Text>{`purged: ${input.target}`}</Agent.Text></Agent.Result>;',
        '}',
        '',
      ].join('\n')),
      writeProjectFile(root, 'src/mcp/demo/tools/purge.cli.ts', [
        "export const config = { command: ['purge'], positionals: ['target'] };",
        'export const mapInput = (input) => {',
        "  if ('yes' in input) throw new Error('mapInput received the confirmation flag.');",
        '  return input;',
        '};',
        '',
      ].join('\n')),
      writeProjectFile(root, 'src/mcp/demo/tools/submit.tsx', [
        "import { Agent, agent } from '@agent-bundle/runtime';",
        "import { z } from 'zod';",
        "export const config = { annotations: { readOnlyHint: false }, description: 'Submits one command line as lane work.' };",
        // The application-owned optional `yes` key (#616): the projection
        // declares confirm: false, so the shell strips nothing and the value
        // must reach the tool through the canonical schema.
        'export const inputSchema = z.object({',
        '  argv: z.array(z.string()).min(1),',
        "  cwd: z.string().min(1).default('.'),",
        '  laneKey: z.string().optional(),',
        '  tags: z.array(z.string()).optional(),',
        '  yes: z.boolean().optional(),',
        '});',
        'export const resultSchema = z.object({',
        '  argv: z.array(z.string()).min(1),',
        '  cwd: z.string().min(1),',
        '  laneKey: z.string().optional(),',
        "  operation: z.literal('submit'),",
        '  tags: z.array(z.string()).optional(),',
        '  yes: z.boolean().optional(),',
        '});',
        'export default async function Submit({ input }) {',
        '  const { invocation } = await agent();',
        "  const value = { ...input, operation: 'submit' };",
        '  return (',
        '    <Agent.Result value={value}>',
        "      <Agent.Text>{`submit: ${input.argv.join(' ')}`}</Agent.Text>",
        '      <Agent.Text>{`invocation: ${invocation.kind} ${invocation.operationId} ${invocation.surface}`}</Agent.Text>',
        '    </Agent.Result>',
        '  );',
        '}',
        '',
      ].join('\n')),
      writeProjectFile(root, projectionModule, [
        'export const config = {',
        "  command: ['submit'],",
        '  confirm: false,',
        '  flags: {',
        "    cwd: { description: 'Working directory of the command (default: the current directory).', required: false },",
        "    laneKey: { name: 'lane' },",
        "    tags: { description: 'Tag attached to the request (repeatable; duplicates are dropped).', name: 'tag' },",
        '  },',
        "  positionals: ['argv'],",
        '};',
        'export const mapInput = (input) => {',
        '  const tags = input.tags === undefined ? undefined : [...new Set(input.tags)];',
        "  const rejected = tags?.find((tag) => tag.startsWith('!'));",
        '  if (rejected !== undefined) throw new Error(`Tag ${JSON.stringify(rejected)} must not start with "!".`);',
        '  return { ...input, cwd: input.cwd ?? process.cwd(), ...(tags === undefined ? {} : { tags }) };',
        '};',
        '',
      ].join('\n')),
    ]);
    built = await build({ output: 'artifact', packageOutputs: true, root });
  }, 120_000);

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('bundles the projection module into the executable and keeps the tool as the only route behind it', async () => {
    expect(built.model.packageBuild?.bins).toMatchObject([
      { name: 'cli-projection-fixture', provenance: { kind: 'conventional' } },
    ]);
    await expect(stat(binPath)).resolves.toMatchObject({});
    const evidence = built.packageBuild!.files.find((file) => file.path === 'bin/cli-projection-fixture.js');
    expect(evidence?.sourceInputs).toEqual(expect.arrayContaining([
      'src/mcp/demo/tools/ping.tsx',
      'src/mcp/demo/tools/purge.cli.ts',
      'src/mcp/demo/tools/purge.tsx',
      projectionModule,
      'src/mcp/demo/tools/submit.tsx',
    ]));
    const generatedCli = built.model.packageBuild?.bins[0]?.generatedCli;
    expect(generatedCli?.commands.map((command) => command.path.join(' ')).sort()).toEqual(['demo ping', 'purge', 'submit']);
    expect(generatedCli?.routes.map((route) => route.id).sort()).toEqual(['tool:demo/ping', 'tool:demo/purge', 'tool:demo/submit']);
  });

  it('prints help with the short path, the projected spellings, the tool provenance, and the projection module', async () => {
    const help = await execFile(binPath, ['submit', '--help'], { cwd: root });

    expect(help.stdout).toContain(`${usage}\n`);
    expect(help.stdout).toContain('Submits one command line as lane work.');
    expect(help.stdout).toContain('MCP tool: demo:submit');
    expect(help.stdout).toContain(`Projection: ${projectionModule}`);
    expect(help.stdout).toMatch(/^ +<argv\.\.\.>/mu);
    expect(help.stdout).toMatch(/^ +--cwd <string> +Working directory of the command \(default: the current directory\)\. \[default: "\."\]$/mu);
    expect(help.stdout).toMatch(/^ +--lane <string>/mu);
    expect(help.stdout).toMatch(/^ +--tag <string> \.\.\. +Tag attached to the request/mu);
    expect(help.stdout).not.toContain('requires --yes');
    expect(help.stdout).not.toContain('--input');
    expect(help.stdout).not.toContain('(required)');
    const tree = await execFile(binPath, ['--help'], { cwd: root });
    expect(tree.stdout).toMatch(/^ +submit +Submits one command line as lane work\.$/mu);
    expect(tree.stdout).toMatch(/^ +demo <command>/mu);
  });

  it('round-trips the projected grammar through --json: renamed flag, repeated flag, passthrough argv, derived cwd', async () => {
    const submitted = await execFile(binPath, ['submit', '--lane', 'x', '--tag', 'a', '--tag', 'a', '--json', '--', 'cargo', 'check'], { cwd: root });
    expect(JSON.parse(submitted.stdout)).toEqual({ argv: ['cargo', 'check'], cwd: root, laneKey: 'x', operation: 'submit', tags: ['a'] });

    const passthrough = await execFile(binPath, ['submit', '--cwd', '/tmp/elsewhere', '--json', '--', 'cargo', 'check', '-p', 'core', '--lane', 'literal'], { cwd: root });
    expect(JSON.parse(passthrough.stdout)).toEqual({ argv: ['cargo', 'check', '-p', 'core', '--lane', 'literal'], cwd: '/tmp/elsewhere', operation: 'submit' });

    const piped = await execFile(binPath, ['submit', '--', 'cargo', 'check'], { cwd: root });
    expect(piped.stdout).toBe('submit: cargo check\n\ninvocation: cli tool:demo/submit submit\n');

    const ping = await execFile(binPath, ['demo', 'ping', '--json'], { cwd: root });
    expect(JSON.parse(ping.stdout)).toEqual({ pong: true });
  });

  it('requires and strips --yes before a confirming projection maps input', async () => {
    await expect(execFile(binPath, ['purge', 'cache', '--json'], { cwd: root })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('MCP tool demo:purge is mutation-capable per its MCP annotations and requires --yes.'),
      stdout: '',
    });

    const purged = await execFile(binPath, ['purge', '--yes', 'cache', '--json'], { cwd: root });
    expect(JSON.parse(purged.stdout)).toEqual({ operation: 'purge', target: 'cache' });
    expect(purged.stdout).not.toContain('yes');
  });

  it('hands a non-confirming projection its application-owned --yes as tool input (#616)', async () => {
    // The tool contract declares an optional `yes: z.boolean()` and the
    // projection sets confirm: false, so `yes` belongs to the application:
    // the shell strips nothing and the value crosses the canonical schema.
    const affirmed = await execFile(binPath, ['submit', '--yes', '--json', '--', 'cargo', 'check'], { cwd: root });
    expect(JSON.parse(affirmed.stdout)).toEqual({ argv: ['cargo', 'check'], cwd: root, operation: 'submit', yes: true });

    const absent = await execFile(binPath, ['submit', '--json', '--', 'cargo', 'check'], { cwd: root });
    expect(JSON.parse(absent.stdout)).toEqual({ argv: ['cargo', 'check'], cwd: root, operation: 'submit' });
  });

  it('exits 2 from the packed shell when mapInput throws or the mapped input fails the canonical schema', async () => {
    await expect(execFile(binPath, ['submit', '--tag', '!boom', '--', 'cargo', 'check'], { cwd: root })).rejects.toMatchObject({
      code: 2,
      stderr: [
        'Tag "!boom" must not start with "!".',
        "Run 'cli-projection-fixture submit --help' for usage.",
        '',
      ].join('\n'),
      stdout: '',
    });
    await expect(execFile(binPath, ['submit', '--cwd', '', '--', 'cargo', 'check'], { cwd: root })).rejects.toMatchObject({
      code: 2,
      stderr: [
        'Invalid value for --cwd: expected non-empty string; received "".',
        usage,
        "Run 'cli-projection-fixture submit --help' for usage.",
        '',
      ].join('\n'),
      stdout: '',
    });
    await expect(execFile(binPath, ['submit', '--lane', 'x'], { cwd: root })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('Missing required argument: <argv...>.'),
      stdout: '',
    });
  });

  it('shows the projection on the compiled command through inspect --routes', async () => {
    const terminal = captureCliTerminal();
    const code = await runCli(['inspect', '--root', root, '--routes', '--json'], terminal.output);

    expect(code).toBe(0);
    const document = JSON.parse(terminal.stdout()) as ReadyInspectResult;
    const commands = document.selected?.routes?.cli?.commands ?? [];
    expect(commands.map((command) => command.path.join(' ')).sort()).toEqual(['demo ping', 'purge', 'submit']);
    expect(commands.find((command) => command.routeId === 'tool:demo/submit')).toMatchObject({
      mcp: { confirm: false, server: 'demo', tool: 'submit' },
      options: [
        expect.objectContaining({ key: 'argv', option: 'argv', positional: 0, repeated: true, required: true }),
        expect.objectContaining({ key: 'cwd', option: 'cwd', repeated: false, required: false }),
        expect.objectContaining({ key: 'laneKey', option: 'lane', repeated: false, required: false }),
        expect.objectContaining({ key: 'tags', option: 'tag', repeated: true, required: false }),
        expect.objectContaining({ key: 'yes', kind: 'boolean', option: 'yes', repeated: false, required: false }),
      ],
      path: ['submit'],
      projection: { mapInput: true, module: projectionModule },
      rendered: true,
      routeId: 'tool:demo/submit',
    });
    expect(commands.find((command) => command.routeId === 'tool:demo/ping')).not.toHaveProperty('projection');
    expect(document.selected?.routes?.servers.flatMap((server) => server.routes.map((route) => route.id))).toEqual([
      'tool:demo/ping',
      'tool:demo/purge',
      'tool:demo/submit',
    ]);
  });
});
