import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { claudeAdapter } from '../src/adapters/claude.ts';
import { codexAdapter, codexArtifactPaths } from '../src/adapters/codex.ts';
import { cursorAdapter, cursorArtifactPaths } from '../src/adapters/cursor.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import { build, type BuildProjectResult, createDefaultRegistry, TargetRegistry, validate } from '../src/api.ts';
import { parseArtifactHookIndex } from '../src/build/hook-index.ts';
import { parseArtifactManifest } from '../src/build/manifest.ts';
import { sha256Hex } from '../src/core/digest.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import { createMcpPathTokenResolver, standardMcpPathTokens } from '../src/services/mcp-path-tokens.ts';
import { createTargetMcpRuntime, resolveTargetRelativeStdioArgument } from '../src/services/mcp-runtime.ts';
import { supportedCapabilities } from './support/adapter-capabilities.ts';

/**
 * Acceptance tests for the composite plugin root (#555, Wave 1): every
 * selected host projects into ONE artifact directory. Assertions are on the
 * emitted tree, never on planner internals.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeProjectFile = async (root: string, path: string, content: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
};

const nativeHookDocument = (command: string): string => `${JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ command, type: 'command' }] }] },
})}\n`;

interface FixtureOptions {
  /** Frontmatter `targets` of the conventional command; omitted → every selected host. */
  readonly commandTargets?: readonly string[];
  /** Extra frontmatter lines for the shared skill. */
  readonly skillFrontmatter?: readonly string[];
  readonly targets?: readonly string[];
}

/**
 * One project with a shared skill, a shared script, a shared MCP server, a
 * generated hook, a native hook document for Claude Code and for Codex, and
 * one conventional command. No runtime dependencies: every compiled surface
 * is plain TypeScript, so the builds stay fast.
 */
const writeProject = async (root: string, options: FixtureOptions = {}): Promise<void> => {
  const targets = options.targets === undefined ? '' : `  targets: ${JSON.stringify(options.targets)},\n`;
  const commandTargets = options.commandTargets === undefined
    ? ''
    : `targets: ${JSON.stringify(options.commandTargets)}\n`;
  await Promise.all([
    writeProjectFile(root, 'package.json', `${JSON.stringify({ name: 'composite-fixture', type: 'module', version: '1.0.0' })}\n`),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      // A plain object: the fixture has no node_modules to resolve `agent-bundle/config` from.
      'export default {',
      "  claude: { nativeHooks: './native/claude.json' },",
      "  codex: { nativeHooks: './native/codex.json' },",
      "  hooks: { sessionStart: './src/hooks/session-start.ts' },",
      "  mcp: { servers: { fixture: { entry: './src/mcp/fixture.ts' } } },",
      "  plugin: { description: 'Composite root fixture.', name: 'composite-fixture', version: '1.0.0' },",
      "  scripts: { hello: './src/tools/hello.ts' },",
      targets.trimEnd(),
      '};',
      '',
    ].filter((line) => line.length > 0).join('\n')),
    writeProjectFile(root, 'native/claude.json', nativeHookDocument('echo claude-native')),
    writeProjectFile(root, 'native/codex.json', nativeHookDocument('echo codex-native')),
    writeProjectFile(root, 'src/hooks/session-start.ts', "export default () => ({ outcome: 'continue' as const, additionalContext: 'started' });\n"),
    writeProjectFile(root, 'src/mcp/fixture.ts', "process.stderr.write('fixture server\\n');\n"),
    writeProjectFile(root, 'src/tools/hello.ts', "console.log('hello');\n"),
    writeProjectFile(root, 'src/skills/review/SKILL.md', [
      '---', 'name: review', 'description: Review changes', ...(options.skillFrontmatter ?? []), '---', '# Review', '',
    ].join('\n')),
    writeProjectFile(root, 'src/commands/summarize.md', `---\ndescription: Summarize the diff\n${commandTargets}---\nSummarize the current diff.\n`),
  ]);
};

/** Every regular file under `root`, as POSIX paths relative to it, with its SHA-256. */
const digestTree = async (root: string): Promise<ReadonlyMap<string, string>> => {
  const digests = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) digests.set(relative(root, path).replaceAll('\\', '/'), sha256Hex(await readFile(path)));
    }
  };
  await walk(root);
  return digests;
};

const buildFixture = async (
  targets: readonly string[] | undefined,
  { registry, ...options }: Omit<FixtureOptions, 'targets'> & { readonly registry?: TargetRegistry } = {},
): Promise<{ readonly output: string; readonly result: BuildProjectResult }> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-composite-'));
  roots.push(root);
  await writeProject(root, { ...options, ...(targets === undefined ? {} : { targets }) });
  const output = join(root, 'artifact');
  const result = await build({ output, ...(registry === undefined ? {} : { registry }), root });
  expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  return { output, result };
};

const syntheticTarget = 'synthetic';
const syntheticMcpRuntime = createTargetMcpRuntime({
  manifestPath: 'synthetic-mcp.json',
  remoteTypes: [],
  resolveStdioArgument: resolveTargetRelativeStdioArgument,
  resolveValue: createMcpPathTokenResolver({
    knownTokens: standardMcpPathTokens,
    target: syntheticTarget,
    tokens: { cwd: { '${PLUGIN_ROOT}': 'pluginRoot' } },
  }),
});

/**
 * An adapter an advanced registry adds beside the built-in hosts. It lowers
 * the fixture's MCP server into a document of its own and admits the shared
 * compiled surfaces (MCP entries, scripts), so alone it builds a clean root;
 * beside another target only `AB4106` can be at issue.
 */
const syntheticAdapterNamed = (name: string): TargetAdapter => Object.freeze({
  artifactLayout: Object.freeze({
    mcpEntries: Object.freeze({ allowedSuffixes: Object.freeze(['.mjs']), directory: 'mcp' }),
    scripts: Object.freeze({ allowedSuffixes: Object.freeze(['.mjs']), directory: 'scripts' }),
  }),
  capabilities: supportedCapabilities('mcp'),
  mcpRuntime: syntheticMcpRuntime,
  metadata: Object.freeze({ adapterRevision: 'test', observedVersion: 'test', schemas: Object.freeze([]) }),
  name,
  plan: (model: NormalizedPlugin) => {
    const servers = Object.fromEntries(model.mcpServers
      .filter((server) => server.targets.includes(name))
      .map((server) => [server.name, {
        ...(server.args === undefined ? {} : { args: server.args }),
        command: server.command,
        type: 'stdio',
      }]));
    return Object.freeze({
      diagnostics: Object.freeze([]),
      entries: Object.freeze([{
        content: `${JSON.stringify({ mcpServers: servers })}\n`,
        kind: 'write' as const,
        relativePath: syntheticMcpRuntime.manifestPath,
        sourceInputs: Object.freeze([model.metadata.provenance.sourcePath]),
      }]),
    });
  },
});

const syntheticAdapter = syntheticAdapterNamed(syntheticTarget);

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

const topLevel = async (root: string): Promise<readonly string[]> => (await readdir(root)).sort();

describe('composite plugin root (#555)', () => {
  it('emits one root whose top-level entries are exactly the selected projections and shared surfaces (acceptance 1)', { timeout: 120_000 }, async () => {
    const { output } = await buildFixture(['claude', 'codex']);

    // The pinned layout of a Claude Code + Codex root. Every entry has one
    // obvious purpose; a future step that adds an entry here must justify it.
    expect(await topLevel(output)).toEqual([
      '.agents', // Codex marketplace catalog (.agents/plugins/marketplace.json)
      '.claude-plugin', // Claude Code manifest + marketplace catalog
      '.codex-plugin', // Codex manifest, hooks document, MCP document
      '.mcp.json', // Claude Code MCP document (conventional root path)
      'INSTALL.md',
      'agent-bundle.hooks.json',
      'agent-bundle.manifest.json',
      'commands',
      'hooks', // Claude Code hooks document + every compiled hook wrapper
      'mcp', // compiled MCP entries, shared by every selected host
      'scripts', // compiled scripts, shared by every selected host
      'skills',
    ]);
    expect(await topLevel(join(output, '.claude-plugin'))).toEqual(['marketplace.json', 'plugin.json']);
    expect(await topLevel(join(output, '.codex-plugin'))).toEqual(['hooks.json', 'mcp.json', 'plugin.json']);
    expect(await topLevel(join(output, '.agents'))).toEqual(['plugins']);
    expect(await topLevel(join(output, 'hooks'))).toEqual([
      'hooks.json',
      'session-start-session-start-7ab7e8a5.claude.mjs',
      'session-start-session-start-7ab7e8a5.codex.mjs',
    ]);
    expect(await topLevel(join(output, 'scripts'))).toEqual(['hello.mjs']);
    expect(await topLevel(join(output, 'skills'))).toEqual(['review']);
    expect(await topLevel(join(output, 'commands'))).toEqual(['summarize.md']);
    const mcpEntries = await topLevel(join(output, 'mcp'));
    expect(mcpEntries).toHaveLength(1);
    expect(mcpEntries[0]).toMatch(/^mcp-fixture-[a-f\d]{8}\.mjs$/u);
  });

  it('omits every unselected projection: a Codex-only root carries no Claude, Cursor, or portable files (acceptance 1, 7)', { timeout: 120_000 }, async () => {
    const { output } = await buildFixture(['codex']);

    expect(await topLevel(output)).toEqual([
      '.agents',
      '.codex-plugin',
      'INSTALL.md',
      'agent-bundle.hooks.json',
      'agent-bundle.manifest.json',
      'hooks',
      'mcp',
      'scripts',
      'skills',
    ]);
    // A hook reaching one selected host keeps the unsuffixed wrapper name,
    // and only Codex's native hook document is merged in.
    // (The hook name hashes its target set, so a Codex-only selection names it differently.)
    expect(await topLevel(join(output, 'hooks'))).toEqual(['session-start-session-start-db39ea0c.mjs']);
    const hooks = await readJson(join(output, codexArtifactPaths.hooksManifest)) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(hooks.hooks.SessionStart.flatMap((group) => group.hooks.map((hook) => hook.command))).toEqual([
      'node "${PLUGIN_ROOT}/hooks/session-start-session-start-db39ea0c.mjs"',
      'echo codex-native',
    ]);
  });

  it('defaults to the portable projection when targets are omitted (acceptance 4)', { timeout: 120_000 }, async () => {
    const { output, result } = await buildFixture(undefined);

    expect(result.build.manifest.targets.map((target) => target.name)).toEqual(['portable']);
    expect(await topLevel(output)).toEqual([
      'INSTALL.md',
      'agent-bundle.hooks.json', // always written; empty here since portable hosts no hooks
      'agent-bundle.manifest.json',
      'install.mjs', // the self-contained local installer (S5 narrows it to Cursor)
      'mcp',
      'mcp.json', // portable Agent Plugins MCP document
      'plugin.json', // portable Agent Plugins manifest
      'scripts',
      'skills',
    ]);
  });

  it('emits byte-identical roots however the targets are ordered (acceptance 5)', { timeout: 180_000 }, async () => {
    // One project, selected twice through `--target` in opposite orders, so
    // the only variable is the order itself.
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-composite-order-'));
    roots.push(root);
    await writeProject(root);
    // The same output directory both times: the build excludes its own output
    // from the project's source inputs, so a second directory would show up
    // as source of the second build.
    const output = join(root, 'artifact');
    const digestBuild = async (targets: readonly string[]): Promise<ReadonlyMap<string, string>> => {
      const result = await build({ output, root, targets });
      expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
      return digestTree(output);
    };
    const forwardTree = await digestBuild(['claude', 'codex']);
    const reversedTree = await digestBuild(['codex', 'claude']);

    expect([...reversedTree.keys()].sort()).toEqual([...forwardTree.keys()].sort());
    const differing = [...forwardTree].filter(([path, digest]) => reversedTree.get(path) !== digest).map(([path]) => path);
    expect(differing).toEqual([]);
  });

  it('compiles shared surfaces once and points every selected host document at the same file (acceptance 6)', { timeout: 120_000 }, async () => {
    const { output, result } = await buildFixture(['claude', 'codex', 'portable']);
    const manifest = parseArtifactManifest(await readFile(join(output, 'agent-bundle.manifest.json'), 'utf8'));

    // One compiled MCP entry, one compiled script, one skill tree — each
    // listed once in the manifest file table.
    const [mcpEntry] = result.build.compiledMcpEntries;
    expect(result.build.compiledMcpEntries).toHaveLength(1);
    expect(result.build.compiledEntries.map((entry) => relative(output, entry.output))).toEqual(['scripts/hello.mjs']);
    const bundles = manifest.files.filter((file) => file.path.startsWith('mcp/') || file.path.startsWith('scripts/'));
    expect(bundles.map((file) => file.path).sort()).toEqual([relative(output, mcpEntry!.output), 'scripts/hello.mjs']);
    expect(manifest.files.filter((file) => file.path === 'skills/review/SKILL.md')).toHaveLength(1);

    // Each host document names the shared entry in its own dialect.
    const entryName = relative(output, mcpEntry!.output);
    const serverArguments = (document: unknown): readonly string[] =>
      (document as { mcpServers: { fixture: { args: string[] } } }).mcpServers.fixture.args;
    expect(serverArguments(await readJson(join(output, '.mcp.json')))).toEqual([`\${CLAUDE_PLUGIN_ROOT}/${entryName}`]);
    expect(serverArguments(await readJson(join(output, codexArtifactPaths.mcp)))).toEqual([`./${entryName}`]);
    expect(serverArguments(await readJson(join(output, 'mcp.json')))).toEqual([entryName]);
  });

  it('keeps every selected host\'s native hook document and drops unselected hosts\' hook files (acceptance 7)', { timeout: 180_000 }, async () => {
    const [both, cursorOnly] = await Promise.all([buildFixture(['claude', 'codex']), buildFixture(['cursor'])]);

    const claude = await readJson(join(both.output, 'hooks', 'hooks.json')) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
    const codex = await readJson(join(both.output, codexArtifactPaths.hooksManifest)) as typeof claude;
    const commands = (document: typeof claude): readonly string[] =>
      document.hooks.SessionStart.flatMap((group) => group.hooks.map((hook) => hook.command));
    // The old composite stripped native hooks; the composite root keeps each
    // host's own document, generated groups first, native groups after.
    expect(commands(claude)).toEqual([
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-session-start-7ab7e8a5.claude.mjs"',
      'echo claude-native',
    ]);
    expect(commands(codex)).toEqual([
      'node "${PLUGIN_ROOT}/hooks/session-start-session-start-7ab7e8a5.codex.mjs"',
      'echo codex-native',
    ]);
    expect(await topLevel(both.output)).not.toContain('.cursor-plugin');

    // A Cursor-only root has Cursor's documents and none of the other hosts'.
    expect(await topLevel(cursorOnly.output)).toEqual([
      '.cursor-plugin',
      'INSTALL.md',
      'agent-bundle.hooks.json',
      'agent-bundle.manifest.json',
      'commands',
      'hooks',
      'install.mjs',
      'mcp',
      'scripts',
      'skills',
    ]);
    expect(await topLevel(join(cursorOnly.output, '.cursor-plugin'))).toEqual(['hooks.json', 'mcp.json', 'plugin.json']);
    expect(await topLevel(join(cursorOnly.output, 'hooks'))).toEqual(['session-start-session-start-9781e2c5.mjs']);
    const cursor = await readJson(join(cursorOnly.output, cursorArtifactPaths.hooks)) as { hooks: Record<string, { command: string }[]> };
    expect(cursor.hooks['sessionStart']).toEqual([{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/session-start-session-start-9781e2c5.mjs"' }]);
  });

  it('records only the selected projections in the artifact manifest and hook index (acceptance 8)', { timeout: 120_000 }, async () => {
    const { output } = await buildFixture(['codex', 'claude']);
    const manifest = parseArtifactManifest(await readFile(join(output, 'agent-bundle.manifest.json'), 'utf8'));
    const index = parseArtifactHookIndex(await readFile(join(output, 'agent-bundle.hooks.json'), 'utf8'));

    expect(manifest.targets.map((target) => target.name)).toEqual(['claude', 'codex']);
    expect(index?.hooks.map((hook) => [hook.target, hook.path])).toEqual([
      ['claude', 'hooks/session-start-session-start-7ab7e8a5.claude.mjs'],
      ['codex', 'hooks/session-start-session-start-7ab7e8a5.codex.mjs'],
    ]);
    // Nothing in the tree is namespaced by host.
    for (const path of manifest.files.map((file) => file.path)) {
      expect(path).not.toMatch(/^(?:claude|codex|cursor|portable|plugin)\//u);
    }
  });

  it('refuses one path planned with different bytes by two selected projections (AB4103)', { timeout: 120_000 }, async () => {
    // A Claude-only frontmatter extension lowers the skill to different
    // Markdown for Claude Code than for Codex, yet both hosts read
    // `skills/review/SKILL.md`; one root cannot hold both documents.
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-composite-collision-'));
    roots.push(root);
    await writeProject(root, { skillFrontmatter: ['targets:', '  claude:', '    effort: high'], targets: ['codex', 'claude'] });
    const failure = await build({ output: join(root, 'artifact'), root }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DiagnosticError);
    expect((failure as DiagnosticError).diagnostics).toEqual([expect.objectContaining({
      code: 'AB4103',
      generatedPath: 'skills/review/SKILL.md',
      message: expect.stringContaining('planned with different contents by the claude and codex projections'),
      severity: 'error',
    })]);
  });

  it('refuses a host-scoped component another selected host would discover conventionally (AB4105, decision D5)', { timeout: 120_000 }, async () => {
    // Claude Code and Cursor both read `commands/`; a Claude-only command
    // cannot be isolated inside one root they share.
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-composite-leak-'));
    roots.push(root);
    await writeProject(root, { commandTargets: ['claude'], targets: ['claude', 'cursor'] });
    const failure = await build({ output: join(root, 'artifact'), root }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DiagnosticError);
    expect((failure as DiagnosticError).diagnostics).toEqual([expect.objectContaining({
      code: 'AB4105',
      message: expect.stringContaining('Command "summarize" is scoped to "claude" but "cursor" also discover "commands/" conventionally'),
      severity: 'error',
    })]);

    // Codex does not read `commands/`, so the same component beside Codex is
    // simply Claude's: it is emitted once and only Claude's manifest sees it.
    const { output } = await buildFixture(['claude', 'codex'], { commandTargets: ['claude'] });
    expect(await topLevel(join(output, 'commands'))).toEqual(['summarize.md']);
  });

  it('refuses an advanced-registry adapter selected beside any other target, and builds it alone (AB4106)', { timeout: 180_000 }, async () => {
    // The built-in hosts agree on how one root is shared; an adapter a
    // registry adds has made no such agreement, so beside Claude Code it is
    // refused on the model — by `validate` and by `build` alike — and named
    // with the config that selected it.
    const registry = createDefaultRegistry().register(syntheticAdapter);
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-composite-registry-'));
    roots.push(root);
    await writeProject(root, { targets: ['claude', 'synthetic'] });
    const refused = {
      code: 'AB4106',
      message: 'Target "synthetic" cannot share one composite root with the other selected targets (claude): only the built-in hosts (claude, codex, cursor, portable) project into a shared root.',
      recovery: 'Build "synthetic" alone — targets: ["synthetic"] — into its own --output, and the other targets into another.',
      severity: 'error',
      sourcePath: join(root, 'agent-bundle.config.ts'),
      target: 'synthetic',
    };
    const validated = await validate({ registry, root });
    expect(validated.diagnostics.filter((entry) => entry.code === 'AB4106')).toEqual([refused]);
    const failure = await build({ output: join(root, 'artifact'), registry, root }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DiagnosticError);
    expect((failure as DiagnosticError).diagnostics.filter((entry) => entry.code === 'AB4106')).toEqual([refused]);

    // Alone, the same adapter gets a root of its own; the built-in hosts still
    // share one, with the adapter registered but unselected.
    const [alone, builtIn] = await Promise.all([
      buildFixture(['synthetic'], { registry }),
      buildFixture(['claude', 'codex'], { registry }),
    ]);
    expect(alone.result.build.manifest.targets.map((target) => target.name)).toEqual(['synthetic']);
    expect(await topLevel(alone.output)).toContain(syntheticMcpRuntime.manifestPath);
    expect(builtIn.result.build.manifest.targets.map((target) => target.name)).toEqual(['claude', 'codex']);
    expect(await topLevel(builtIn.output)).not.toContain(syntheticMcpRuntime.manifestPath);
  });

  it('judges the built-in hosts by adapter identity, so a custom adapter named like one earns no install surface (#592)', { timeout: 120_000 }, async () => {
    // An advanced registry may register its own adapter under a built-in
    // host's name. The install surface belongs to the shipped adapters, so the
    // composite root emits none for it — and the artifact validators demand
    // none — while the shipped adapters keep theirs under their own names.
    const registry = new TargetRegistry()
      .register(syntheticAdapterNamed('portable'), { default: true })
      .register(claudeAdapter)
      .register(codexAdapter)
      .register(cursorAdapter);
    expect(registry.builtInHost('portable')).toBeUndefined();
    expect(registry.builtInHost('claude')).toBe('claude');
    expect(registry.builtInHosts(['portable', 'cursor', 'unknown', 'claude'])).toEqual(['cursor', 'claude']);
    expect(createDefaultRegistry().builtInHost('portable')).toBe('portable');

    const [custom, shipped] = await Promise.all([
      buildFixture(['portable'], { registry }),
      buildFixture(['portable'], {}),
    ]);
    expect(custom.result.build.manifest.targets.map((target) => target.name)).toEqual(['portable']);
    const customTree = await topLevel(custom.output);
    expect(customTree).toContain(syntheticMcpRuntime.manifestPath);
    expect(customTree).not.toContain('INSTALL.md');
    expect(customTree).not.toContain('install.mjs');
    expect(custom.result.diagnostics.filter((entry) => entry.code === 'AB6023' || entry.code === 'AB6024')).toEqual([]);
    expect(await topLevel(shipped.output)).toEqual(expect.arrayContaining(['INSTALL.md', 'install.mjs', 'plugin.json']));

    // The same identity judgment gates the shared root (`AB4106`) and the
    // host validators: beside Claude Code the custom `portable` is refused
    // like any advanced-registry adapter, and alone it is held to no shipped
    // host's validator.
    const mixed = await mkdtemp(join(tmpdir(), 'agent-bundle-composite-identity-'));
    roots.push(mixed);
    await writeProject(mixed, { targets: ['claude', 'portable'] });
    const refused = await validate({ registry, root: mixed });
    expect(refused.diagnostics.filter((entry) => entry.code === 'AB4106').map((entry) => entry.target)).toEqual(['portable']);
    const alone = await mkdtemp(join(tmpdir(), 'agent-bundle-composite-identity-'));
    roots.push(alone);
    await writeProject(alone, { targets: ['portable'] });
    const validated = await validate({ hostValidation: true, registry, root: alone });
    expect(validated.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(validated.hostValidation).toBeUndefined();
  });
});
