import { execFile as executeFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it } from '@rstest/core';

import { createDefaultRegistry, TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import { build, inspect } from '../src/api.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';

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

const pluginName = 'cli-bin-artifact';
const hostTargets = ['claude', 'codex', 'cursor', 'portable'] as const;

/**
 * A host adapter that publishes no `cli` capability row: it stands in for a
 * third-party target whose plugin root is not a directory Node executes
 * from. The routed CLI bin must be omitted there — reported, never silent.
 */
const legacyHostAdapter: TargetAdapter = Object.freeze({
  artifactLayout: Object.freeze({
    // Its one root document is its manifest; a third-party adapter always
    // gets a root of its own (AB4106).
    rootDocuments: Object.freeze(['legacy-host.json']),
    scripts: Object.freeze({ allowedSuffixes: Object.freeze(['.mjs']), directory: 'scripts' }),
  }),
  capabilities: Object.freeze({}),
  metadata: Object.freeze({ adapterRevision: 'test', observedVersion: 'test', schemas: Object.freeze([]) }),
  name: 'legacy-host',
  plan: (model: NormalizedPlugin) => Object.freeze({
    diagnostics: Object.freeze([]),
    entries: Object.freeze([{
      content: `${JSON.stringify({ name: model.metadata.name })}\n`,
      kind: 'write' as const,
      relativePath: 'legacy-host.json',
      sourceInputs: Object.freeze([model.metadata.provenance.sourcePath]),
    }]),
  }),
});

const registryWithLegacyHost = (): TargetRegistry => createDefaultRegistry().register(legacyHostAdapter);

const createFixture = async (options: {
  /** Ship a Claude skill referencing the bin through the plugin-root token (Claude-only Skill Markdown syntax). */
  readonly skill?: boolean;
  readonly targets: readonly string[];
  readonly web?: boolean;
}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-cli-bin-artifact-'));
  roots.push(root);
  // The audiobook example's installed tree supplies @agent-bundle/runtime and zod.
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        zod: '4.4.3',
      },
      name: pluginName,
      type: 'module',
      version: '3.8.7',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      'export default defineConfig({',
      `  plugin: { description: 'Artifact routed CLI fixture.', name: ${JSON.stringify(pluginName)}, version: '3.8.7' },`,
      `  targets: ${JSON.stringify(options.targets)},`,
      ...(options.web === true ? ["  web: { apps: ['curator/dashboard'] },"] : []),
      '});',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/cli/status.ts', [
      "import { agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { description: 'Report the daemon status.', positionals: ['ticket'] };",
      'export const inputSchema = z.object({ ticket: z.string().min(1).optional(), verbose: z.boolean().optional() }).strict();',
      "export const resultSchema = z.object({ invocation: z.literal('cli'), status: z.literal('idle'), surface: z.string(), ticket: z.string().optional() }).strict();",
      'export default async function status({ input, signal }) {',
      "  if (signal.aborted) throw new DOMException('aborted', 'AbortError');",
      '  const context = await agent();',
      '  return {',
      "    invocation: context.invocation.kind,",
      "    status: 'idle',",
      "    surface: input.verbose === true ? `${context.invocation.surface} (verbose)` : context.invocation.surface,",
      '    ...(input.ticket === undefined ? {} : { ticket: input.ticket }),',
      '  };',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/cli/report.tsx', [
      "import React from 'react';",
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { description: 'Render a build report.', positionals: ['root'] };",
      'export const inputSchema = z.object({ root: z.string().min(1) }).strict();',
      'export const resultSchema = z.object({ builds: z.number(), root: z.string() }).strict();',
      'export default async function Report({ input, signal }) {',
      "  if (signal.aborted) throw new DOMException('aborted', 'AbortError');",
      '  const context = await agent();',
      "  await context.progress.report({ completed: 1, message: 'scanning', total: 1 });",
      '  const result = { builds: 3, root: input.root };',
      '  return (',
      '    <Agent.Result value={result}>',
      '      <Agent.Markdown>{`Found **3** builds under ${input.root}.`}</Agent.Markdown>',
      '    </Agent.Result>',
      '  );',
      '}',
      '',
    ].join('\n')),
    // The operator `.env` probe (#469): a route and a provider that both read
    // `process.env` at module top level — what a static import evaluates
    // before any statement of the bin — and again when they run.
    writeProjectFile(root, 'src/cli/env-probe.ts', [
      "import { agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "const atImport = process.env.CLI_OPERATOR_TOKEN ?? 'unset';",
      "export const config = { description: 'Report the operator token as the bin sees it.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ atImport: z.string(), atRun: z.string(), providerAtImport: z.string() }).strict();',
      'export default async function envProbe() {',
      '  const context = await agent();',
      "  return { atImport, atRun: process.env.CLI_OPERATOR_TOKEN ?? 'unset', providerAtImport: context.providers.operatorToken };",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/providers/operator-token.ts', [
      "const atImport = process.env.CLI_OPERATOR_TOKEN ?? 'unset';",
      'export default async function operatorToken() {',
      '  return atImport;',
      '}',
      '',
    ].join('\n')),
    ...(options.web === true
      ? [
        writeProjectFile(root, 'src/mcp/curator/apps/dashboard.ts', [
          "export const config = { resourceUri: 'ui://curator/dashboard.html', template: './dashboard.html' };",
          'export default async () => ({});',
          '',
        ].join('\n')),
        writeProjectFile(
          root,
          'src/mcp/curator/apps/dashboard.html',
          '<!doctype html><html><body>dashboard</body></html>\n',
        ),
      ]
      : []),
    // A plain script route forwarding to the routed CLI through the
    // documented sibling convention: `../bin/<plugin-name>.mjs` relative to
    // the script's own `import.meta.url` inside the artifact.
    writeProjectFile(root, 'src/scripts/hauler.ts', [
      "import { spawnSync } from 'node:child_process';",
      "import { fileURLToPath } from 'node:url';",
      '',
      'export const main = async (argv: readonly string[]): Promise<number> => {',
      `  const bin = fileURLToPath(new URL('../bin/${pluginName}.mjs', import.meta.url));`,
      "  const child = spawnSync(process.execPath, [bin, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });",
      '  process.stdout.write(child.stdout);',
      '  return child.status ?? 1;',
      '};',
      '',
    ].join('\n')),
    // A skill that reaches the bin through the plugin-root token; only Claude
    // documents Skill Markdown interpolation, so the fixture ships it for
    // Claude-only builds.
    ...(options.skill === true
      ? [writeProjectFile(root, 'src/skills/daemon-status/SKILL.md', [
        '---',
        'name: daemon-status',
        'description: Check the daemon status through the routed CLI.',
        '---',
        '# Daemon status',
        '',
        `Run \`node \${CLAUDE_PLUGIN_ROOT}/bin/${pluginName}.mjs status --json\` and report the \`status\` field.`,
        '',
      ].join('\n'))]
      : []),
  ]);
  return root;
};

const webOnlyPluginName = 'web-only-artifact';
/** A live framework import surviving in a generated executable: `from "agent-bundle/..."` or `import("agent-bundle/...")`. */
const agentBundleImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]agent-bundle(?:\/[^'"]*)?['"]/u;

/**
 * A project with no `src/cli/**` at all: one MCP server with one App, exposed
 * through `web.apps` (#564). The App view and the server entry are plain
 * TypeScript, so the build needs no runtime dependencies beyond the config
 * entry the audiobook example's installed tree resolves.
 */
const createWebOnlyFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-web-only-artifact-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({ name: webOnlyPluginName, type: 'module', version: '1.0.0' })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      'export default defineConfig({',
      '  mcp: { servers: { status: {',
      "    apps: { status: { entry: './views/status.ts', resourceUri: 'ui://web-only-artifact/status.html', template: './views/status.html' } },",
      "    entry: './src/mcp/status.ts',",
      '  } } },',
      `  plugin: { description: 'Web-only artifact fixture.', name: ${JSON.stringify(webOnlyPluginName)}, version: '1.0.0' },`,
      "  targets: ['portable'],",
      "  web: { apps: ['status/status'] },",
      '});',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/status.ts', "process.stderr.write('status server\\n');\n"),
    writeProjectFile(root, 'views/status.html', '<!doctype html><html><body><main id="view"></main></body></html>\n'),
    writeProjectFile(root, 'views/status.ts', "document.querySelector('#view')!.textContent = 'web-only status';\n"),
  ]);
  return root;
};

const parseJsonLine = (stdout: string): unknown => JSON.parse(stdout) as unknown;

/**
 * The artifact-hosted routed CLI proof (#387, #555): one build ships the
 * compiled `src/cli/**` command graph once into the composite root, as
 * `bin/<plugin-name>.mjs` (+ Flight worker), whenever a selected host
 * publishes the `cli` capability; the bin runs end to end under `node`, a
 * script route reaches it as a sibling, a skill reaches it through the
 * plugin-root token, validation accepts the `bin/` layout, and a selected
 * host without the capability is reported with an inspect entry and an
 * AB4765 warning. That host is a third-party adapter, so it cannot join the
 * built-in hosts' root (`AB4106`, `build-compose.test.ts`): the same sources
 * are built into a root of its own.
 */
it('emits the routed CLI bin into every capable host artifact and omits it elsewhere', { retry: 1, timeout: 300_000 }, async () => {
  const registry = registryWithLegacyHost();
  const [root, legacyRoot] = await Promise.all([
    createFixture({ targets: [...hostTargets] }),
    createFixture({ targets: ['legacy-host'] }),
  ]);

  const [result, legacyResult] = await Promise.all([
    build({ output: 'artifact', registry, root }),
    build({ output: 'artifact', registry, root: legacyRoot }),
  ]);
  const artifactRoot = join(root, 'artifact');
  const legacyArtifactRoot = join(legacyRoot, 'artifact');

  // The composite root hosts one executable and its rendered-command worker,
  // attributed to the whole selection.
  const identity = [...hostTargets].sort().join('+');
  expect(result.build.compiledCliBins.map((bin) => bin.target)).toEqual([identity]);
  const binPath = join(artifactRoot, 'bin', `${pluginName}.mjs`);
  await expect(stat(binPath)).resolves.toMatchObject({});
  await expect(stat(join(artifactRoot, 'bin', `${pluginName}-flight.mjs`))).resolves.toMatchObject({});
  const binSource = await readFile(binPath, 'utf8');
  expect(binSource).not.toMatch(/from\s*['"]agent-bundle\/cli-entry['"]/u);
  expect(binSource).not.toMatch(/from\s*['"]agent-bundle\/meta['"]/u);
  expect(result.diagnostics.filter((entry) => entry.code === 'AB4765')).toEqual([]);

  // `node <artifact>/bin/<name>.mjs <route args>` prints the routed CLI output.
  const status = await execFile(process.execPath, [binPath, 'status', 'ticket-7', '--json']);
  expect(parseJsonLine(status.stdout)).toEqual({
    invocation: 'cli',
    status: 'idle',
    surface: 'status',
    ticket: 'ticket-7',
  });
  // The host without the capability gets no bin in its own root — reported,
  // never silent — while its other compiled surfaces are emitted as usual.
  expect(legacyResult.build.compiledCliBins).toEqual([]);
  await expect(stat(join(legacyArtifactRoot, 'bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(legacyResult.build.manifest.files.filter((file) => file.path.startsWith('bin/'))).toEqual([]);
  await expect(stat(join(legacyArtifactRoot, 'scripts', 'hauler.mjs'))).resolves.toMatchObject({});
  expect(legacyResult.diagnostics).toContainEqual(expect.objectContaining({
    code: 'AB4765',
    severity: 'warning',
    target: 'legacy-host',
  }));
  expect(legacyResult.diagnostics.filter((entry) => entry.code === 'AB4765')).toHaveLength(1);

  // Help, version, and the rendered .tsx command ride the same executable.
  const claudeBin = binPath;
  const help = await execFile(process.execPath, [claudeBin, '--help']);
  expect(help.stdout).toContain(`${pluginName} 3.8.7`);
  expect(help.stdout).toContain('Artifact routed CLI fixture.');
  expect(help.stdout).toContain('status');
  expect(help.stdout).toContain('report');
  await expect(execFile(process.execPath, [claudeBin, '--version'])).resolves.toMatchObject({ stdout: `${pluginName} 3.8.7\n` });
  const piped = await execFile(process.execPath, [claudeBin, 'report', '/builds']);
  expect(piped.stdout).toBe('Found **3** builds under /builds.\n');
  const reportJson = await execFile(process.execPath, [claudeBin, 'report', '/builds', '--json']);
  expect(parseJsonLine(reportJson.stdout)).toEqual({ builds: 3, root: '/builds' });
  await expect(execFile(process.execPath, [claudeBin, 'unknown'])).rejects.toMatchObject({ code: 2, stdout: '' });

  // A script route reaches the bin as its documented sibling and forwards argv.
  const forwarded = await execFile(process.execPath, [join(artifactRoot, 'scripts', 'hauler.mjs'), 'status', '--verbose', '--json']);
  expect(parseJsonLine(forwarded.stdout)).toEqual({ invocation: 'cli', status: 'idle', surface: 'status (verbose)' });

  // The manifest inventories the bin with bundle provenance naming every command route.
  const manifestFile = result.build.manifest.files.find((file) => file.path === `bin/${pluginName}.mjs`);
  expect(manifestFile).toMatchObject({ kind: 'bundle' });
  expect(manifestFile?.sourceInputs).toEqual(expect.arrayContaining(['src/cli/report.tsx', 'src/cli/status.ts']));
  expect(result.build.manifest.files.find((file) => file.path === `bin/${pluginName}-flight.mjs`)).toMatchObject({ kind: 'bundle' });
  expect(result.build.manifest.files.filter((file) => file.path.startsWith('bin/'))).toHaveLength(2);

  // Artifact validation accepts the framework-owned `bin/` layout on every
  // target, and a root without the bin as well.
  const [validation, legacyValidation] = await Promise.all([
    validateArtifact({ artifactRoot, registry }),
    validateArtifact({ artifactRoot: legacyArtifactRoot, registry }),
  ]);
  expect(validation.filter((entry) => entry.severity === 'error')).toEqual([]);
  expect(legacyValidation.filter((entry) => entry.severity === 'error')).toEqual([]);

  // `inspect` accounts for the bin as a `cli` component per target.
  const inspected = await inspect({ registry, root });
  expect(inspected.state).toBe('ready');
  if (inspected.state !== 'ready') throw new Error('unreachable');
  const claudePlan = inspected.plans.find((plan) => plan.target === 'claude');
  expect(claudePlan?.selected).toContainEqual({
    capability: { evidence: expect.objectContaining({ target: 'claude' }), name: 'cli', state: 'supported' },
    id: `bin:${pluginName}`,
    kind: 'cli',
    name: pluginName,
  });
  const legacyInspected = await inspect({ registry, root: legacyRoot });
  expect(legacyInspected.state).toBe('ready');
  if (legacyInspected.state !== 'ready') throw new Error('unreachable');
  const legacyPlan = legacyInspected.plans.find((plan) => plan.target === 'legacy-host');
  expect(legacyPlan?.skipped).toContainEqual({
    capability: { name: 'cli', reason: expect.stringContaining('publishes no cli capability row'), state: 'unavailable' },
    id: `bin:${pluginName}`,
    kind: 'cli',
    name: pluginName,
    reason: 'unsupported-capability',
  });

  // `inspect --bundler` dumps the composite bin composition beside the
  // scripts; the npm package bin (no target) keeps its own entry.
  const bundler = await inspect({ focus: 'bundler', registry, root });
  if (bundler.state !== 'ready') throw new Error('unreachable');
  const binEntries = (bundler.selected?.bundler?.entries ?? [])
    .filter((entry) => entry.kind === 'bin' && entry.target !== undefined);
  expect((bundler.selected?.bundler?.entries ?? []).some((entry) =>
    entry.kind === 'bin' && entry.target === undefined && entry.outputPath === `dist/bin/${pluginName}.js`)).toBe(true);
  expect(binEntries.map((entry) => entry.outputPath).sort()).toEqual([
    `bin/${pluginName}-flight.mjs`,
    `bin/${pluginName}.mjs`,
  ]);
});

it('lets a skill reach the artifact bin through the plugin-root token, and the bin applies the operator .env layer before its route and provider modules evaluate (#469)', { retry: 1, timeout: 240_000 }, async () => {
  const root = await createFixture({ skill: true, targets: ['claude'] });
  const result = await build({ output: 'artifact', root });
  const claudeRoot = join(root, 'artifact');

  // The skill's `${CLAUDE_PLUGIN_ROOT}` reference lowers to a path the same
  // artifact really ships, and that file is the working routed CLI.
  const skill = await readFile(join(claudeRoot, 'skills', 'daemon-status', 'SKILL.md'), 'utf8');
  const reference = `\${CLAUDE_PLUGIN_ROOT}/bin/${pluginName}.mjs`;
  expect(skill).toContain(reference);
  const binPath = join(claudeRoot, reference.slice('${CLAUDE_PLUGIN_ROOT}/'.length));
  await expect(stat(binPath)).resolves.toMatchObject({});
  const status = await execFile(process.execPath, [binPath, 'status', '--json']);
  expect(parseJsonLine(status.stdout)).toEqual({ invocation: 'cli', status: 'idle', surface: 'status' });
  expect(result.diagnostics.filter((entry) => entry.code === 'AB4765')).toEqual([]);

  // `<plugin root>/.env` is read before the route and provider modules
  // evaluate, so their module-level reads agree with the read at run time;
  // an exported variable still wins, and `none` disables the layer.
  const { CLI_OPERATOR_TOKEN: _token, ...hostEnv } = process.env;
  const probe = async (env: Readonly<Record<string, string>>): Promise<unknown> =>
    parseJsonLine((await execFile(process.execPath, [binPath, 'env-probe', '--json'], { env: { ...hostEnv, ...env } })).stdout);
  expect(await probe({})).toEqual({ atImport: 'unset', atRun: 'unset', providerAtImport: 'unset' });
  await writeFile(join(claudeRoot, '.env'), 'CLI_OPERATOR_TOKEN=from-file\n');
  expect(await probe({})).toEqual({ atImport: 'from-file', atRun: 'from-file', providerAtImport: 'from-file' });
  expect(await probe({ CLI_OPERATOR_TOKEN: 'from-host' })).toEqual({ atImport: 'from-host', atRun: 'from-host', providerAtImport: 'from-host' });
  expect(await probe({ AGENT_BUNDLE_ENV_FILE: 'none' })).toEqual({ atImport: 'unset', atRun: 'unset', providerAtImport: 'unset' });
});

it('emits a self-contained routed bin for a web-only plugin', { retry: 1, timeout: 240_000 }, async () => {
  const root = await createFixture({ targets: ['portable'], web: true });
  await rm(join(root, 'src', 'cli'), { force: true, recursive: true });

  const result = await build({ output: 'artifact', root });
  const binPath = join(root, 'artifact', 'bin', `${pluginName}.mjs`);
  const source = await readFile(binPath, 'utf8');

  await expect(stat(binPath)).resolves.toMatchObject({});
  expect(result.build.manifest.files.find((file) => file.path === `bin/${pluginName}.mjs`))
    .toMatchObject({ kind: 'bundle' });
  expect(source).toContain('agent-bundle-web-host-seed');
  expect(source).not.toMatch(/from\s*['"]agent-bundle\//u);
  expect((await validateArtifact({ artifactRoot: join(root, 'artifact') }))
    .filter((entry) => entry.code === 'AB6005')).toEqual([]);
});

it('lists authored commands and web in one generated artifact bin', { retry: 1, timeout: 240_000 }, async () => {
  const root = await createFixture({ targets: ['portable'], web: true });
  await build({ output: 'artifact', root });

  const binPath = join(root, 'artifact', 'bin', `${pluginName}.mjs`);
  const help = await execFile(process.execPath, [binPath, '--help']);
  expect(help.stdout).toContain('status');
  expect(help.stdout).toContain('web');
  expect(await readFile(binPath, 'utf8')).toContain('agent-bundle-web-host-seed');
});

/**
 * The `web` surface rides the same executable (#564): a project that authors
 * no `src/cli/**` command but exposes an App through `web.apps` still gets
 * `bin/<plugin>.mjs` in its composite root, self-contained, with the
 * framework-owned `web` command listed by `--help`, and the manifest's `web`
 * section naming the exposed App.
 */
it('emits bin/<plugin>.mjs for a project with web.apps and no src/cli, and its --help lists web (#564)', { retry: 1, timeout: 240_000 }, async () => {
  const root = await createWebOnlyFixture();
  const result = await build({ output: 'artifact', root });
  const artifactRoot = join(root, 'artifact');

  const binPath = join(artifactRoot, 'bin', `${webOnlyPluginName}.mjs`);
  await expect(stat(binPath)).resolves.toMatchObject({});
  expect(result.build.manifest.files.find((file) => file.path === `bin/${webOnlyPluginName}.mjs`)).toMatchObject({ kind: 'bundle' });
  expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  expect(await readFile(binPath, 'utf8')).not.toMatch(agentBundleImport);

  // `<plugin> --help` lists the framework-owned command among the plugin's.
  const help = await execFile(process.execPath, [binPath, '--help']);
  expect(help.stdout).toContain(`${webOnlyPluginName} 1.0.0`);
  expect(help.stdout).toMatch(/^Commands:$/mu);
  expect(help.stdout).toMatch(/^\s+web\b/mu);

  // The manifest's `web` section (web-host/manifest.ts) names the exposed
  // App and the compiled MCP executable the host launches.
  const manifest = JSON.parse(await readFile(join(artifactRoot, 'agent-bundle.manifest.json'), 'utf8')) as { readonly web?: unknown };
  const mcpEntries = result.build.manifest.files.filter((file) => file.path.startsWith('mcp/')).map((file) => file.path);
  expect(mcpEntries).toHaveLength(1);
  expect(manifest.web).toEqual({
    apps: [{
      allow: [],
      app: 'status/status',
      entry: mcpEntries[0]!,
      env: {},
      name: 'status',
      resourceUri: 'ui://web-only-artifact/status.html',
      server: 'status',
    }],
    open: 'never',
  });
});

it('refuses a host-emitted file that collides with the routed CLI bin (AB4766)', { timeout: 120_000 }, async () => {
  const root = await createFixture({ targets: ['claude'] });
  // A configured Claude bin directory shipping the same file name the routed
  // CLI owns: the compiler never chooses between them silently.
  await writeProjectFile(root, `host-bin/${pluginName}.mjs`, "console.log('host bin');\n");
  await chmod(join(root, 'host-bin', `${pluginName}.mjs`), 0o755);
  // A second entry differing only by case is the same file on macOS and
  // Windows, so it is a collision too and is named beside the owned path.
  const caseVariant = `${pluginName.toUpperCase()}-flight.mjs`;
  await writeProjectFile(root, `host-bin/${caseVariant}`, "console.log('host worker');\n");
  await chmod(join(root, 'host-bin', caseVariant), 0o755);
  await writeProjectFile(root, 'agent-bundle.config.ts', [
    "import { defineConfig } from 'agent-bundle/config';",
    'export default defineConfig({',
    "  claude: { bin: './host-bin' },",
    `  plugin: { description: 'Artifact routed CLI fixture.', name: ${JSON.stringify(pluginName)}, version: '3.8.7' },`,
    "  targets: ['claude'],",
    '});',
    '',
  ].join('\n'));

  const failure = build({ output: 'artifact', root });
  await expect(failure).rejects.toThrow(
    new RegExp(`\\[AB4766\\] Target "claude" already emits "bin/${pluginName}\\.mjs"`, 'u'),
  );
  await expect(failure).rejects.toThrow(
    new RegExp(`\\[AB4766\\] Target "claude" already emits "bin/${caseVariant}", which differs only by case from "bin/${pluginName}-flight\\.mjs"`, 'u'),
  );
  await expect(stat(join(root, 'artifact'))).rejects.toMatchObject({ code: 'ENOENT' });
});
