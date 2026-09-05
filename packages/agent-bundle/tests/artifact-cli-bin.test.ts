import { execFile as executeFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it } from '@rstest/core';

import { compositeTargetName } from '../src/adapters/composite.ts';
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
    rootDocuments: Object.freeze(['plugin.json']),
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
      relativePath: 'plugin.json',
      sourceInputs: Object.freeze([model.metadata.provenance.sourcePath]),
    }]),
  }),
});

const registryWithLegacyHost = (): TargetRegistry => createDefaultRegistry().register(legacyHostAdapter);

const createFixture = async (options: {
  /** Ship a Claude skill referencing the bin through the plugin-root token (Claude-only Skill Markdown syntax). */
  readonly skill?: boolean;
  readonly targets: readonly string[];
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

const parseJsonLine = (stdout: string): unknown => JSON.parse(stdout) as unknown;

/**
 * The artifact-hosted routed CLI proof (#387) on the composite plugin root
 * (#555): one build ships the compiled `src/cli/**` command graph once, as
 * `bin/<plugin-name>.mjs` (+ Flight worker) at the root every selected host
 * shares, the bin runs end to end under `node`, a script route reaches it as
 * a sibling, validation accepts the `bin/` layout, and `inspect` accounts
 * for it as a `cli` component of every projected host.
 */
it('emits the routed CLI bin once into the plugin root every capable host shares', { retry: 1, timeout: 300_000 }, async () => {
  const root = await createFixture({ targets: hostTargets });

  const result = await build({ output: 'artifact', root });
  const artifactRoot = join(root, 'artifact');

  // The root hosts one executable and one rendered-command worker; no host
  // gets a namespaced copy of its own.
  expect(result.build.compiledCliBins.map((bin) => bin.target)).toEqual([compositeTargetName(hostTargets)]);
  const binPath = join(artifactRoot, 'bin', `${pluginName}.mjs`);
  await expect(stat(binPath)).resolves.toMatchObject({});
  await expect(stat(join(artifactRoot, 'bin', `${pluginName}-flight.mjs`))).resolves.toMatchObject({});
  for (const target of hostTargets) {
    await expect(stat(join(artifactRoot, target, 'bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
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

  // Help, version, and the rendered .tsx command ride the same executable.
  const help = await execFile(process.execPath, [binPath, '--help']);
  expect(help.stdout).toContain(`${pluginName} 3.8.7`);
  expect(help.stdout).toContain('Artifact routed CLI fixture.');
  expect(help.stdout).toContain('status');
  expect(help.stdout).toContain('report');
  await expect(execFile(process.execPath, [binPath, '--version'])).resolves.toMatchObject({ stdout: `${pluginName} 3.8.7\n` });
  const piped = await execFile(process.execPath, [binPath, 'report', '/builds']);
  expect(piped.stdout).toBe('Found **3** builds under /builds.\n');
  const reportJson = await execFile(process.execPath, [binPath, 'report', '/builds', '--json']);
  expect(parseJsonLine(reportJson.stdout)).toEqual({ builds: 3, root: '/builds' });
  await expect(execFile(process.execPath, [binPath, 'unknown'])).rejects.toMatchObject({ code: 2, stdout: '' });

  // A script route reaches the bin as its documented sibling and forwards argv.
  const forwarded = await execFile(process.execPath, [join(artifactRoot, 'scripts', 'hauler.mjs'), 'status', '--verbose', '--json']);
  expect(parseJsonLine(forwarded.stdout)).toEqual({ invocation: 'cli', status: 'idle', surface: 'status (verbose)' });

  // The multi-host root's AGENTS.md documents the shared executable.
  const agents = await readFile(join(artifactRoot, 'AGENTS.md'), 'utf8');
  expect(agents).toContain(`\`bin/${pluginName}.mjs\``);

  // The manifest lists every projected host and inventories the bin once,
  // with bundle provenance naming every command route.
  expect(result.build.manifest.targets.map((target) => target.name).sort()).toEqual([...hostTargets].sort());
  const manifestFile = result.build.manifest.files.find((file) => file.path === `bin/${pluginName}.mjs`);
  expect(manifestFile).toMatchObject({ kind: 'bundle' });
  expect(manifestFile?.sourceInputs).toEqual(expect.arrayContaining(['src/cli/report.tsx', 'src/cli/status.ts']));
  expect(result.build.manifest.files.find((file) => file.path === `bin/${pluginName}-flight.mjs`)).toMatchObject({ kind: 'bundle' });
  expect(result.build.manifest.files.filter((file) => file.path.includes('/bin/'))).toEqual([]);

  // Artifact validation accepts the framework-owned `bin/` layout of the root.
  const validation = await validateArtifact({ artifactRoot });
  expect(validation.filter((entry) => entry.severity === 'error')).toEqual([]);

  // `inspect` accounts for the bin as a `cli` component of every projected host.
  const inspected = await inspect({ root });
  expect(inspected.state).toBe('ready');
  if (inspected.state !== 'ready') throw new Error('unreachable');
  for (const target of hostTargets) {
    const plan = inspected.plans.find((candidate) => candidate.target === target);
    expect(plan?.selected).toContainEqual({
      capability: { evidence: expect.objectContaining({ target }), name: 'cli', state: 'supported' },
      id: `bin:${pluginName}`,
      kind: 'cli',
      name: pluginName,
    });
  }
});

/**
 * A third-party host without the `cli` capability is built one target per
 * root (#555): that root receives no `bin/` at all, while its other compiled
 * surfaces are untouched, and the omission is reported — an AB4765 warning
 * from the build and a skipped `cli` component from `inspect`.
 */
it('omits the routed CLI bin from a host without the cli capability and reports it', { retry: 1, timeout: 240_000 }, async () => {
  const root = await createFixture({ targets: ['legacy-host'] });
  const registry = registryWithLegacyHost();

  const result = await build({ output: 'artifact', registry, root });
  const artifactRoot = join(root, 'artifact');

  expect(result.build.compiledCliBins).toEqual([]);
  await expect(stat(join(artifactRoot, 'bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(artifactRoot, 'scripts', 'hauler.mjs'))).resolves.toMatchObject({});
  expect(result.build.manifest.files.some((file) => file.path.startsWith('bin/'))).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: 'AB4765',
    severity: 'warning',
    target: 'legacy-host',
  }));
  expect(result.diagnostics.filter((entry) => entry.code === 'AB4765')).toHaveLength(1);

  const inspected = await inspect({ registry, root });
  expect(inspected.state).toBe('ready');
  if (inspected.state !== 'ready') throw new Error('unreachable');
  const legacyPlan = inspected.plans.find((plan) => plan.target === 'legacy-host');
  expect(legacyPlan?.skipped).toContainEqual({
    capability: { name: 'cli', reason: expect.stringContaining('publishes no cli capability row'), state: 'unavailable' },
    id: `bin:${pluginName}`,
    kind: 'cli',
    name: pluginName,
    reason: 'unsupported-capability',
  });
});

/**
 * `inspect --bundler` describes the composition the build really runs: one
 * Rslib pass over the root, so the bin and its worker appear once at their
 * root-relative output paths, while the npm package bin (no target) keeps
 * its own entry.
 */
it('inspects the routed CLI bin composition once for the plugin root', { timeout: 120_000 }, async () => {
  const root = await createFixture({ targets: hostTargets });

  const bundler = await inspect({ focus: 'bundler', root });
  expect(bundler.state).toBe('ready');
  if (bundler.state !== 'ready') throw new Error('unreachable');
  const entries = bundler.selected?.bundler?.entries ?? [];
  expect(entries.some((entry) =>
    entry.kind === 'bin' && entry.target === undefined && entry.outputPath === `dist/bin/${pluginName}.js`)).toBe(true);
  const binEntries = entries.filter((entry) => entry.kind === 'bin' && entry.target !== undefined);
  expect(binEntries.map((entry) => entry.outputPath).sort()).toEqual([
    `bin/${pluginName}-flight.mjs`,
    `bin/${pluginName}.mjs`,
  ]);
});

it('lets a skill reach the artifact bin through the plugin-root token', { retry: 1, timeout: 240_000 }, async () => {
  const root = await createFixture({ skill: true, targets: ['claude'] });
  const result = await build({ output: 'artifact', root });
  const artifactRoot = join(root, 'artifact');

  // The skill's `${CLAUDE_PLUGIN_ROOT}` reference lowers to a path the same
  // artifact really ships, and that file is the working routed CLI.
  const skill = await readFile(join(artifactRoot, 'skills', 'daemon-status', 'SKILL.md'), 'utf8');
  const reference = `\${CLAUDE_PLUGIN_ROOT}/bin/${pluginName}.mjs`;
  expect(skill).toContain(reference);
  const binPath = join(artifactRoot, reference.slice('${CLAUDE_PLUGIN_ROOT}/'.length));
  await expect(stat(binPath)).resolves.toMatchObject({});
  const status = await execFile(process.execPath, [binPath, 'status', '--json']);
  expect(parseJsonLine(status.stdout)).toEqual({ invocation: 'cli', status: 'idle', surface: 'status' });
  expect(result.diagnostics.filter((entry) => entry.code === 'AB4765')).toEqual([]);
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
