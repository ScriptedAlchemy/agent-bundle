import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';

import { codexArtifactPaths } from '../src/adapters/codex.ts';
import { cursorArtifactPaths } from '../src/adapters/cursor.ts';
import { build, type BuildProjectResult, inspect, validate } from '../src/api.ts';
import { parseArtifactHookIndex } from '../src/build/hook-index.ts';
import { type ArtifactManifest, parseArtifactManifest } from '../src/build/manifest.ts';
import { type Diagnostic, DiagnosticError } from '../src/core/diagnostics.ts';

/**
 * Composite-root rules ported from the superseded #569 (#555): the ones that
 * hold whichever way the root is laid out, checked against this branch's one
 * composite root. Assertions are on the emitted tree and the public API,
 * never on planner internals. build-compose.test.ts owns the pinned layout;
 * this file covers what it leaves open: every built-in host in ONE root, the
 * install surface of a multi-host root, the Claude Code + Cursor `commands/`
 * dialect collision, and `validate`/`inspect` parity with `build`.
 */

const roots: string[] = [];
afterAll(async () => {
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
  /** Frontmatter lines of one conventional command; omitted → the project declares no command. */
  readonly commandFrontmatter?: readonly string[];
  /** Extra frontmatter lines for the shared skill. */
  readonly skillFrontmatter?: readonly string[];
  readonly targets: readonly string[];
}

/**
 * One project with a shared skill, a shared script, a shared MCP server, a
 * generated hook, a native hook document for Claude Code and for Codex, a
 * plugin logo, and optionally one conventional command. No runtime
 * dependencies: every compiled surface is plain TypeScript.
 */
const writeProject = async (root: string, options: FixtureOptions): Promise<void> => {
  const command = options.commandFrontmatter === undefined
    ? []
    : [writeProjectFile(root, 'src/commands/summarize.md', [
        ...(options.commandFrontmatter.length === 0 ? [] : ['---', ...options.commandFrontmatter, '---']),
        'Summarize the current diff.',
        '',
      ].join('\n'))];
  await Promise.all([
    writeProjectFile(root, 'package.json', `${JSON.stringify({ name: 'composite-fixture', type: 'module', version: '1.0.0' })}\n`),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      // A plain object: the fixture has no node_modules to resolve `agent-bundle/config` from.
      'export default {',
      "  claude: { nativeHooks: './native/claude.json' },",
      "  codex: { nativeHooks: './native/codex.json' },",
      "  hooks: { sessionStart: './src/hooks/session-start.ts' },",
      "  mcp: { servers: { fixture: { entry: './src/mcp/fixture.ts' } } },",
      "  plugin: { description: 'Composite root fixture.', logo: 'docs/media/logo.svg', name: 'composite-fixture', version: '1.0.0' },",
      "  scripts: { hello: './src/tools/hello.ts' },",
      `  targets: ${JSON.stringify(options.targets)},`,
      '};',
      '',
    ].join('\n')),
    writeProjectFile(root, 'docs/media/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>\n'),
    writeProjectFile(root, 'native/claude.json', nativeHookDocument('echo claude-native')),
    writeProjectFile(root, 'native/codex.json', nativeHookDocument('echo codex-native')),
    writeProjectFile(root, 'src/hooks/session-start.ts', "export default () => ({ outcome: 'continue' as const, additionalContext: 'started' });\n"),
    writeProjectFile(root, 'src/mcp/fixture.ts', "process.stderr.write('fixture server\\n');\n"),
    writeProjectFile(root, 'src/tools/hello.ts', "console.log('hello');\n"),
    writeProjectFile(root, 'src/skills/review/SKILL.md', [
      '---', 'name: review', 'description: Review changes', ...(options.skillFrontmatter ?? []), '---', '# Review', '',
    ].join('\n')),
    ...command,
  ]);
};

const temporaryProject = async (options: FixtureOptions): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-composite-rules-'));
  roots.push(root);
  await writeProject(root, options);
  return root;
};

interface BuiltRoot {
  readonly manifest: ArtifactManifest;
  readonly output: string;
  readonly result: BuildProjectResult;
}

const buildProject = async (root: string): Promise<BuiltRoot> => {
  const output = join(root, 'artifact');
  const result = await build({ output, root });
  expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  return { manifest: parseArtifactManifest(await readFile(join(output, 'agent-bundle.manifest.json'), 'utf8')), output, result };
};

/** The diagnostics `build` refused the root with; fails when the build went through. */
const buildRefusal = async (root: string): Promise<readonly Diagnostic[]> => {
  const failure = await build({ output: join(root, 'artifact'), root }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(DiagnosticError);
  return (failure as DiagnosticError).diagnostics;
};

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

const topLevel = async (root: string): Promise<readonly string[]> => (await readdir(root)).sort();

const errors = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  diagnostics.filter((entry) => entry.severity === 'error');

/** How many times `path` is listed in the artifact manifest's file table. */
const listed = (manifest: ArtifactManifest, path: string): number =>
  manifest.files.filter((file) => file.path === path).length;

const hostManifestPaths: Readonly<Record<'claude' | 'codex' | 'cursor' | 'portable', string>> = Object.freeze({
  claude: '.claude-plugin/plugin.json',
  codex: codexArtifactPaths.plugin,
  cursor: cursorArtifactPaths.plugin,
  portable: 'plugin.json',
});

describe('one root projecting every built-in host (#569 "lays every host manifest over one shared plugin root")', () => {
  // Written in an arbitrary order on purpose: every composite output must
  // come out in host-name order regardless (acceptance 5).
  const selection = ['portable', 'cursor', 'codex', 'claude'];
  let built: BuiltRoot;
  beforeAll(async () => {
    built = await buildProject(await temporaryProject({ targets: selection }));
  }, 180_000);

  it('places each selected host\'s manifest at the root exactly once and never lists one path twice', async () => {
    expect(built.manifest.targets.map((target) => target.name)).toEqual(['claude', 'codex', 'cursor', 'portable']);
    for (const path of Object.values(hostManifestPaths)) {
      await expect(readFile(join(built.output, path), 'utf8')).resolves.toContain('"composite-fixture"');
      expect(listed(built.manifest, path), path).toBe(1);
    }
    const paths = built.manifest.files.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    // Codex and Cursor read their hook and MCP documents through manifest
    // pointers beside their manifests; Claude Code auto-loads hooks/hooks.json
    // and reports a manifest pointer at it as a duplicate, so it names none.
    expect(await readJson(join(built.output, hostManifestPaths.codex))).toMatchObject({
      hooks: `./${codexArtifactPaths.hooksManifest}`,
      mcpServers: `./${codexArtifactPaths.mcp}`,
    });
    expect(await readJson(join(built.output, hostManifestPaths.cursor))).toMatchObject({
      hooks: `./${cursorArtifactPaths.hooks}`,
      mcpServers: `./${cursorArtifactPaths.mcp}`,
    });
    expect(await readJson(join(built.output, hostManifestPaths.claude))).not.toHaveProperty('hooks');
  });

  it('emits every shared surface once — skill, script, MCP entry, logo — and points each host document at the same file', async () => {
    expect(listed(built.manifest, 'skills/review/SKILL.md')).toBe(1);
    expect(listed(built.manifest, 'scripts/hello.mjs')).toBe(1);
    expect(built.result.build.compiledEntries).toHaveLength(1);
    expect(built.result.build.compiledMcpEntries).toHaveLength(1);
    const mcpEntries = built.manifest.files.map((file) => file.path).filter((path) => path.startsWith('mcp/'));
    expect(mcpEntries).toHaveLength(1);
    const [entryName] = mcpEntries;
    expect(entryName).toMatch(/^mcp\/mcp-fixture-[a-f\d]{8}\.mjs$/u);

    const serverArguments = async (document: string): Promise<readonly string[]> =>
      ((await readJson(join(built.output, document))) as { mcpServers: { fixture: { args: string[] } } }).mcpServers.fixture.args;
    expect(await serverArguments('.mcp.json')).toEqual([`\${CLAUDE_PLUGIN_ROOT}/${entryName}`]);
    expect(await serverArguments(codexArtifactPaths.mcp)).toEqual([`./${entryName}`]);
    expect(await serverArguments(cursorArtifactPaths.mcp)).toEqual([`\${CURSOR_PLUGIN_ROOT}/${entryName}`]);
    expect(await serverArguments('mcp.json')).toEqual([entryName]);

    // The logo is copied once; only the manifests whose host reads a logo
    // name it (Cursor at the top level), never Claude Code's.
    expect(built.manifest.files.map((file) => file.path).filter((path) => path.startsWith('assets/'))).toEqual(['assets/docs/media/logo.svg']);
    expect(await readJson(join(built.output, hostManifestPaths.cursor))).toMatchObject({ logo: './assets/docs/media/logo.svg' });
    expect(await readJson(join(built.output, hostManifestPaths.claude))).not.toHaveProperty('logo');
    expect(await readJson(join(built.output, hostManifestPaths.codex))).not.toHaveProperty('logo');
  });

  it('writes one INSTALL.md for the whole root with a section per selected host, and one installer', async () => {
    expect(listed(built.manifest, 'INSTALL.md')).toBe(1);
    expect(listed(built.manifest, 'install.mjs')).toBe(1);
    const install = await readFile(join(built.output, 'INSTALL.md'), 'utf8');
    // One second-level heading per selected host, in the fixed host order —
    // not the order `targets` was written in.
    expect(install.split('\n').filter((line) => line.startsWith('## '))).toEqual([
      '## Claude Code',
      '## Codex',
      '## Cursor',
      '## Portable Agent Plugin',
    ]);
    expect(install).toContain('claude plugin install composite-fixture@composite-fixture-marketplace --scope user');
    expect(install).toContain('codex plugin add composite-fixture@composite-fixture-marketplace');
    expect(install).toContain('node ./install.mjs');
    expect(await readFile(join(built.output, 'install.mjs'), 'utf8')).toContain("join(cursorRoot, 'plugins', 'local')");
  });

  it('compiles one wrapper per hook host, indexes each once, and keeps every native hook document', async () => {
    const wrappers = (await topLevel(join(built.output, 'hooks'))).filter((name) => name.endsWith('.mjs'));
    // Portable hosts no hooks; the other three each get a host-suffixed wrapper of one stem.
    const stems = new Set(wrappers.map((name) => name.replace(/\.(?:claude|codex|cursor)\.mjs$/u, '')));
    expect([...stems]).toHaveLength(1);
    const [stem] = stems;
    expect(wrappers).toEqual([`${stem}.claude.mjs`, `${stem}.codex.mjs`, `${stem}.cursor.mjs`]);
    for (const wrapper of wrappers) expect(listed(built.manifest, `hooks/${wrapper}`)).toBe(1);

    const index = parseArtifactHookIndex(await readFile(join(built.output, 'agent-bundle.hooks.json'), 'utf8'));
    expect(index?.hooks.map((hook) => [hook.target, hook.path])).toEqual([
      ['claude', `hooks/${stem}.claude.mjs`],
      ['codex', `hooks/${stem}.codex.mjs`],
      ['cursor', `hooks/${stem}.cursor.mjs`],
    ]);

    type ClaudeFormat = { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
    const commands = (document: ClaudeFormat): readonly string[] =>
      document.hooks.SessionStart.flatMap((group) => group.hooks.map((hook) => hook.command));
    // Generated groups first, each host's own native groups after.
    expect(commands(await readJson(join(built.output, 'hooks', 'hooks.json')) as ClaudeFormat)).toEqual([
      `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${stem}.claude.mjs"`,
      'echo claude-native',
    ]);
    expect(commands(await readJson(join(built.output, codexArtifactPaths.hooksManifest)) as ClaudeFormat)).toEqual([
      `node "\${PLUGIN_ROOT}/hooks/${stem}.codex.mjs"`,
      'echo codex-native',
    ]);
    const cursor = await readJson(join(built.output, cursorArtifactPaths.hooks)) as { hooks: Record<string, { command: string }[]> };
    expect(cursor.hooks['sessionStart']).toEqual([{ command: `node "\${CURSOR_PLUGIN_ROOT}/hooks/${stem}.cursor.mjs"` }]);
  });
});

describe('the commands/ directory Claude Code and Cursor share (#569 "Claude-format commands", AB4104 there)', () => {
  it('refuses a command both hosts select once their dialects differ (AB4103), and shares a frontmatter-free one', { timeout: 180_000 }, async () => {
    // Claude Code lowers `description` into frontmatter; Cursor's commands
    // surface is frontmatter-free and keeps the body only. Both read
    // `commands/summarize.md`, so the root cannot hold the two documents.
    const collision = await temporaryProject({ commandFrontmatter: ['description: Summarize the diff'], targets: ['claude', 'cursor'] });
    expect(await buildRefusal(collision)).toEqual([expect.objectContaining({
      code: 'AB4103',
      generatedPath: 'commands/summarize.md',
      message: expect.stringContaining('planned with different contents by the claude and cursor projections'),
      severity: 'error',
    })]);

    // With nothing to lower, both projections plan the same bytes: emitted
    // once, and Cursor's manifest points at the directory Claude Code scans.
    const shared = await buildProject(await temporaryProject({ commandFrontmatter: [], targets: ['claude', 'cursor'] }));
    expect(await topLevel(join(shared.output, 'commands'))).toEqual(['summarize.md']);
    expect(listed(shared.manifest, 'commands/summarize.md')).toBe(1);
    await expect(readFile(join(shared.output, 'commands', 'summarize.md'), 'utf8')).resolves.toBe('Summarize the current diff.\n');
    expect(await readJson(join(shared.output, hostManifestPaths.cursor))).toMatchObject({ commands: './commands/' });
  });
});

interface CompositionRefusal {
  /** Hosts that, selected alone, make a valid root of the same project. */
  readonly alone: readonly string[];
  /** The field that locates the refusal (`generatedPath` for a collision, `sourcePath` for a scope leak). */
  readonly location: Readonly<Record<string, unknown>>;
  readonly project: FixtureOptions;
}

/** The two composition refusals build-compose.test.ts pins for `build`, with the projects that trigger them. */
const compositionRefusals: readonly (readonly [string, CompositionRefusal])[] = [
  ['AB4103', {
    alone: ['claude', 'codex'],
    location: { generatedPath: 'skills/review/SKILL.md' },
    project: { skillFrontmatter: ['targets:', '  claude:', '    effort: high'], targets: ['claude', 'codex'] },
  }],
  ['AB4105', {
    alone: ['claude'],
    location: { sourcePath: expect.stringMatching(/\/src\/commands\/summarize\.md$/u) },
    project: { commandFrontmatter: ['description: Summarize the diff', 'targets: ["claude"]'], targets: ['claude', 'cursor'] },
  }],
];

describe('validate and inspect judge the shared root exactly as build does (#569 "judges the one plugin root every selected target shares")', () => {
  // An operator running `validate` or `inspect` before `build` must see the
  // composition refusal there, not a ready project that the build then throws on.
  it.each(compositionRefusals)('reports %s from validate and inspect, not only from build', { timeout: 180_000 }, async (code, refusal) => {
    const root = await temporaryProject(refusal.project);
    const expected = [expect.objectContaining({ code, severity: 'error', ...refusal.location })];
    expect(errors(await buildRefusal(root))).toEqual(expected);

    // Soft, so one report shows both surfaces' verdicts.
    const validated = await validate({ root });
    expect.soft(errors(validated.diagnostics), 'validate').toEqual(expected);

    const inspected = await inspect({ root });
    expect.soft(inspected.state, 'inspect').toBe('invalid');
    expect.soft(errors(inspected.diagnostics), 'inspect').toEqual(expected);

    // Each host alone is a valid root over the same project.
    for (const target of refusal.alone) {
      expect(errors((await validate({ root, targets: [target] })).diagnostics), target).toEqual([]);
    }
  });
});
