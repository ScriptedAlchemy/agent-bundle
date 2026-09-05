import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import {
  AgentTestError,
  inspectWorkbenchSurface,
  workbenchLeafPath,
  type ApplicationGroup,
  type ApplicationLeaf,
  type WorkbenchRouteCatalogGroup,
  type WorkbenchSurface,
} from '../src/test/index.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';

const exampleRoot = (name: string): string => resolve(import.meta.dirname, '../../../examples', name);

const groupNamed = (surface: WorkbenchSurface, label: string): WorkbenchRouteCatalogGroup => {
  const group = surface.catalog.groups.find((candidate) => candidate.label === label);
  if (group === undefined) {
    throw new Error(`Expected a ${JSON.stringify(label)} group; found ${JSON.stringify(surface.catalog.groups.map((candidate) => candidate.label))}.`);
  }
  return group;
};

const applicationGroup = (surface: WorkbenchSurface, kind: ApplicationGroup['kind']): ApplicationGroup => {
  const group = surface.application.groups.find((candidate) => candidate.kind === kind);
  if (group === undefined) {
    throw new Error(`Expected an application ${JSON.stringify(kind)} group; found ${JSON.stringify(surface.application.groups.map((candidate) => candidate.kind))}.`);
  }
  return group;
};

const applicationLeaves = (surface: WorkbenchSurface): readonly ApplicationLeaf[] =>
  surface.application.groups.flatMap((group) => group.kind === 'mcp'
    ? group.servers.flatMap((server) => server.subgroups.flatMap((subgroup) => subgroup.leaves))
    : group.leaves);

/**
 * These assertions are the ones `packages/workbench/tests/examples-real.e2e.test.ts`
 * makes against the real Workbench in Chrome ("renders the flagship compiled
 * route catalog by server and kind"), restated over the helper's output. The
 * two must keep agreeing: the e2e proves the browser shows this, the helper
 * proves a consumer can assert it without one.
 */
describe('the Workbench surface of the audiobook curator', () => {
  const surfacePromise = inspectWorkbenchSurface({ root: exampleRoot('audiobook-curator') });

  it('stamps the workbench-surface level and the compiler pass identity', async () => {
    const surface = await surfacePromise;

    expect(surface.provenance).toMatchObject({
      manifestDigest: surface.manifest.digest,
      projectRoot: exampleRoot('audiobook-curator'),
      proofLevel: 'workbench-surface',
      sourceRevision: surface.manifest.sourceRevision,
      targets: ['claude', 'codex'],
    });
    expect(surface.catalog.diagnostics).toEqual([]);
  });

  it('projects the effective State declaration', async () => {
    const { catalog } = await surfacePromise;

    expect(catalog.stateDefinition).toMatchObject({
      driver: 'sqlite',
      id: 'audiobook-curator/shelf',
      lifetime: 'workspace-durable',
      source: 'src/state.ts',
    });
  });

  it('groups every MCP kind under the one generated curator server', async () => {
    const surface = await surfacePromise;

    expect(surface.catalog.servers).toEqual([{ id: 'mcp:curator', mode: 'generated', name: 'curator', routeCount: 18 }]);
    for (const label of ['curator · Tools', 'curator · Resources', 'curator · Prompts']) {
      expect(groupNamed(surface, label)).toMatchObject({ mode: 'generated', server: 'curator', serverId: 'mcp:curator' });
    }
    const tools = groupNamed(surface, 'curator · Tools');
    expect(tools.entries).toHaveLength(16);
    expect(tools.entries.map((entry) => entry.route.id)).toEqual(expect.arrayContaining([
      'tool:curator/convert_audiobook',
      'tool:curator/inventory_sources',
      'tool:curator/review_curation_shelf',
    ]));
    const convert = tools.entries.find((entry) => entry.route.id === 'tool:curator/convert_audiobook');
    expect(convert?.route.source).toBe('src/mcp/curator/tools/convert_audiobook.tsx');
    expect(convert?.route.provenance).toEqual({ kind: 'conventional' });
    // The extracted config is summarized, never inlined as nested JSON.
    expect(convert?.route.config).toEqual(expect.arrayContaining([{ key: 'annotations', kind: 'object', value: '2 keys' }]));
    const inventory = tools.entries.find((entry) => entry.route.id === 'tool:curator/inventory_sources');
    expect(inventory?.route.inputSchema).toMatchObject({
      properties: { report: expect.anything(), source: expect.anything(), strict: { type: 'boolean' } },
      required: ['source'],
    });

    expect(groupNamed(surface, 'curator · Resources').entries.map((entry) => entry.route.id)).toContain('resource:curator/catalog');
    expect(groupNamed(surface, 'curator · Resources').entries.find((entry) => entry.route.id === 'resource:curator/catalog')?.route.config)
      .toEqual(expect.arrayContaining([{ key: 'uri', kind: 'string', value: 'audiobook-curator://catalog' }]));
    expect(groupNamed(surface, 'curator · Prompts').entries.map((entry) => entry.route.id)).toContain('prompt:curator/curate');

    const mcp = applicationGroup(surface, 'mcp');
    if (mcp.kind !== 'mcp') throw new Error('Expected the MCP application group.');
    expect(mcp.servers).toHaveLength(1);
    expect(mcp.servers[0]).toMatchObject({ label: 'curator', mode: 'generated', server: 'curator' });
    expect(mcp.servers[0]?.subgroups.map((subgroup) => subgroup.label)).toEqual(['Tools', 'Resources', 'Prompts']);
    const search = applicationLeaves(surface).find((leaf) => leaf.routeId === 'tool:curator/search_audible');
    expect(search).toMatchObject({
      execution: 'invoke',
      label: 'search_audible',
      source: 'src/mcp/curator/tools/search_audible.tsx',
    });
    expect(search === undefined ? undefined : workbenchLeafPath(search)).toBe('/routes/mcp/curator/tool/search_audible');
  });

  it('lists the 16 authored commands beside one projected command per tool', async () => {
    const surface = await surfacePromise;
    const cli = groupNamed(surface, 'CLI commands');
    const routeIds = cli.entries.map((entry) => entry.route.id);
    const authored = routeIds.filter((routeId) => routeId.startsWith('cli:'));
    const projected = routeIds.filter((routeId) => routeId.startsWith('tool:'));

    expect(cli.mode).toBe('generated');
    expect(authored).toEqual([
      'cli:acoustic-identify',
      'cli:acoustic-verify',
      'cli:apply-chapters',
      'cli:apply-metadata',
      'cli:audible-cache',
      'cli:audible-search',
      'cli:audible-select',
      'cli:audit',
      'cli:convert',
      'cli:inspect',
      'cli:inventory',
      'cli:library-audit',
      'cli:prepare',
      'cli:select',
      'cli:shelf',
      'cli:whisper-verify',
    ]);
    expect(projected).toEqual(groupNamed(surface, 'curator · Tools').entries.map((entry) => entry.route.id));
    expect(new Set(routeIds).size).toBe(routeIds.length);
    expect(routeIds).toHaveLength(authored.length + projected.length);
    const byId = new Map(cli.entries.map((entry) => [entry.route.id, entry]));
    expect(byId.get('cli:library-audit')?.route.source).toBe('src/cli/library-audit.tsx');
    expect(byId.get('cli:shelf')?.route.source).toBe('src/cli/shelf.tsx');
    expect(byId.get('cli:library-audit')?.commandUsage)
      .toBe('library-audit <sources...> [--concurrency <number>] --report <string> [--strict]');
    expect(byId.get('cli:inspect')?.commandUsage).toBe('inspect <root> [--max-files <number>]');
    // Projected commands carry their MCP provenance and the annotation-derived
    // confirmation policy: read-only tools run without --yes, mutation-capable
    // tools fail closed without it.
    expect(byId.get('tool:curator/inspect_sources')?.command?.mcp).toEqual({
      confirm: false,
      server: 'curator',
      tool: 'inspect_sources',
    });
    expect(byId.get('tool:curator/convert_audiobook')?.command?.mcp).toEqual({
      confirm: true,
      server: 'curator',
      tool: 'convert_audiobook',
    });
  });

  it('reports the route graph identity and invents nothing', async () => {
    const surface = await surfacePromise;

    // 18 MCP routes plus 16 authored and 16 projected CLI routes.
    expect(surface.catalog.routeCount).toBe(50);
    expect(surface.catalog.groups.map((group) => group.kind)).not.toContain('event-route');
    expect(surface.catalog.groups.map((group) => group.kind)).not.toContain('script');
    expect(surface.catalog.providers).toEqual([{ id: 'provider:library', name: 'library', source: 'src/providers/library.ts' }]);
    expect(surface.lifecycles).toEqual([]);
    expect(surface.manifest.events).toEqual([]);
    expect(surface.manifest.scripts).toEqual([]);
  });

  it('derives the application tree and Advanced sections for this project', async () => {
    const surface = await surfacePromise;

    expect(surface.application.state).toBe('fresh');
    expect(surface.application.groups.map((group) => group.kind)).toEqual(['mcp', 'cli', 'skills']);
    expect(applicationGroup(surface, 'cli')).toMatchObject({ label: 'CLI', leaves: expect.any(Array) });
    expect(applicationGroup(surface, 'skills')).toMatchObject({
      label: 'Skills',
      leaves: [expect.objectContaining({ execution: 'document', label: 'curate-audiobooks' })],
    });
    expect(surface.application.leafCount).toBe(applicationLeaves(surface).length);
    expect(surface.advanced).toEqual(['artifact', 'protocol', 'hosts', 'logs']);
    // One MCP server shipped to two hosts: two instances, as the artifact inventory lists them.
    expect(surface.counts).toMatchObject({ hooks: 0, mcpServers: 2, scripts: 0, skills: 1, targets: 2 });
  });
});

/**
 * Configured-only surfaces have no compiled route catalog, but authored
 * hooks, scripts, and Skills still appear as application leaves.
 */
describe('the Workbench surface of the configured-only examples', () => {
  it('keeps configured leaves while reporting an empty compiled graph for the MCP App example', async () => {
    const surface = await inspectWorkbenchSurface({ root: exampleRoot('mcp-app') });

    expect(surface.catalog.routeCount).toBe(0);
    expect(surface.catalog.groups).toEqual([]);
    expect(surface.catalog.stateDefinition).toBeUndefined();
    expect(surface.application.groups.map((group) => group.kind)).toEqual(['events', 'scripts', 'skills']);
    expect(applicationGroup(surface, 'events')).toMatchObject({ label: 'Events / Hooks' });
    expect(applicationGroup(surface, 'scripts')).toMatchObject({ label: 'Scripts' });
    expect(surface.advanced).toEqual(['evals', 'artifact', 'protocol', 'hosts', 'logs']);
    expect(surface.counts).toMatchObject({ evalSuites: 1, skills: 1, targets: 3 });
    expect(surface.counts.hooks).toBeGreaterThan(0);
    expect(surface.counts.mcpServers).toBeGreaterThan(0);
    expect(surface.counts.scripts).toBeGreaterThan(0);
  });

  it('shows only Skill leaves for the Skills Starter', async () => {
    const surface = await inspectWorkbenchSurface({ root: exampleRoot('skills-starter') });

    expect(surface.application.groups.map((group) => group.kind)).toEqual(['skills']);
    expect(applicationGroup(surface, 'skills')).toMatchObject({ leaves: expect.arrayContaining([
      expect.objectContaining({ label: 'dependency-upgrade' }),
      expect.objectContaining({ label: 'incident-triage' }),
      expect.objectContaining({ label: 'release-review' }),
    ]) });
    expect(surface.advanced).toEqual(['evals', 'artifact', 'hosts', 'logs']);
    expect(surface.counts).toMatchObject({ hooks: 0, mcpServers: 0, scripts: 0, skills: 3, targets: 3 });
  });
});

/**
 * The Workbench counts what the built artifact lists — one instance per
 * declaration per target. A declaration whose `targets` select none of the project's targets
 * is declared but emitted nowhere, so it must not count.
 */
describe('capability counts', () => {
  it('counts declaration instances per selected target, not declarations', async () => {
    const project = await createProjectFixture({
      config: [
        'export default {',
        "  plugin: { name: 'workbench-surface-counts', version: '1.0.0' },",
        "  targets: ['claude', 'codex'],",
        "  hooks: { PostToolUse: [{ handler: 'src/hooks/audit.ts', targets: [] }] },",
        '  scripts: {',
        "    everywhere: 'src/tools/everywhere.ts',",
        "    'codex-only': { entry: 'src/tools/codex-only.ts', targets: ['codex'] },",
        "    nowhere: { entry: 'src/tools/nowhere.ts', targets: [] },",
        '  },',
        '};',
        '',
      ].join('\n'),
      files: {
        'package.json': '{"type":"module"}\n',
        'src/hooks/audit.ts': 'export const main = async () => 0;\n',
        'src/tools/codex-only.ts': 'export const main = async () => 0;\n',
        'src/tools/everywhere.ts': 'export const main = async () => 0;\n',
        'src/tools/nowhere.ts': 'export const main = async () => 0;\n',
      },
      prefix: 'agent-bundle-workbench-surface-counts-',
    });
    try {
      const surface = await inspectWorkbenchSurface({ root: project.root });

      // everywhere × 2 targets + codex-only × 1 + nowhere × 0; the hook selects no target.
      expect(surface.counts).toMatchObject({ hooks: 0, mcpServers: 0, scripts: 3, targets: 2 });
      expect(applicationGroup(surface, 'scripts')).toMatchObject({ leaves: expect.any(Array) });
      expect(surface.application.groups.map((group) => group.kind)).not.toContain('events');
    } finally {
      await rm(project.root, { force: true, recursive: true });
    }
  });

  it('counts only compiled hook wrappers: a prebuilt hook is never indexed, so it never counts', async () => {
    // One prebuilt hook per target (never indexed) beside one compiled hook
    // selected for claude alone: the artifact index — and the Workbench —
    // holds exactly one entry.
    const project = await createProjectFixture({
      config: [
        'export default {',
        "  plugin: { name: 'workbench-surface-prebuilt-hooks', version: '1.0.0' },",
        "  targets: ['claude', 'codex'],",
        "  payload: { runtime: './built/runtime' },",
        '  hooks: { afterTool: [',
        "    { args: ['--host', 'claude'], handler: { prebuilt: './built/runtime/hook.js' }, targets: ['claude'], tools: ['file.write'] },",
        "    { args: ['--host', 'codex'], handler: { prebuilt: './built/runtime/hook.js' }, targets: ['codex'], tools: ['file.write'] },",
        "    { handler: 'src/hooks/audit.ts', targets: ['claude'], tools: ['file.write'] },",
        '  ] },',
        '};',
        '',
      ].join('\n'),
      files: {
        'built/runtime/hook.js': 'process.stdout.write("{}");\n',
        'package.json': '{"type":"module"}\n',
        'src/hooks/audit.ts': 'export const main = async () => 0;\n',
      },
      prefix: 'agent-bundle-workbench-surface-prebuilt-hooks-',
    });
    try {
      const surface = await inspectWorkbenchSurface({ root: project.root });

      expect(surface.counts).toMatchObject({ hooks: 1, targets: 2 });
      expect(applicationGroup(surface, 'events')).toMatchObject({ leaves: expect.any(Array) });

      const prebuiltOnly = await createProjectFixture({
        config: [
          'export default {',
          "  plugin: { name: 'workbench-surface-prebuilt-only', version: '1.0.0' },",
          "  targets: ['claude'],",
          "  payload: { runtime: './built/runtime' },",
          "  hooks: { afterTool: [{ args: ['--host', 'claude'], handler: { prebuilt: './built/runtime/hook.js' }, targets: ['claude'], tools: ['file.write'] }] },",
          '};',
          '',
        ].join('\n'),
        files: {
          'built/runtime/hook.js': 'process.stdout.write("{}");\n',
          'package.json': '{"type":"module"}\n',
        },
        prefix: 'agent-bundle-workbench-surface-prebuilt-only-',
      });
      try {
        const hidden = await inspectWorkbenchSurface({ root: prebuiltOnly.root });

        expect(hidden.counts).toMatchObject({ hooks: 0, targets: 1 });
        expect(applicationGroup(hidden, 'events')).toMatchObject({ leaves: expect.any(Array) });
      } finally {
        await rm(prebuiltOnly.root, { force: true, recursive: true });
      }
    } finally {
      await rm(project.root, { force: true, recursive: true });
    }
  });

  it('keeps application groups empty when every declaration selects no target', async () => {
    const project = await createProjectFixture({
      config: [
        'export default {',
        "  plugin: { name: 'workbench-surface-nothing-emitted', version: '1.0.0' },",
        "  targets: ['claude'],",
        "  hooks: { PostToolUse: [{ handler: 'src/hooks/audit.ts', targets: [] }] },",
        "  scripts: { nowhere: { entry: 'src/tools/nowhere.ts', targets: [] } },",
        '};',
        '',
      ].join('\n'),
      files: {
        'package.json': '{"type":"module"}\n',
        'src/hooks/audit.ts': 'export const main = async () => 0;\n',
        'src/tools/nowhere.ts': 'export const main = async () => 0;\n',
      },
      prefix: 'agent-bundle-workbench-surface-nothing-',
    });
    try {
      const surface = await inspectWorkbenchSurface({ root: project.root });

      expect(surface.counts).toMatchObject({ hooks: 0, scripts: 0, targets: 1 });
      expect(surface.application.groups).toEqual([]);
    } finally {
      await rm(project.root, { force: true, recursive: true });
    }
  });
});

/**
 * The Workbench server prepares a project in development mode from the
 * configuration file it was pointed at; the helper must prepare the same
 * way, or a configuration that branches on the mode or lives at a
 * non-default path projects a surface the Workbench never shows.
 */
describe('preparation parity with the Workbench server', () => {
  it('prepares in development mode and discovers eval suites through the selected configuration', async () => {
    const assertionsModule = resolve(import.meta.dirname, '../src/eval/assertions.ts');
    const suiteModule = resolve(import.meta.dirname, '../src/eval/suite.ts');
    const configFactory = (name: string, evalsDir: string): string => [
      'export default (context) => ({',
      `  plugin: { name: ${JSON.stringify(name)}, version: '1.0.0' },`,
      // Production selects claude alone; the Workbench (development) sees both.
      "  targets: context.mode === 'development' ? ['claude', 'codex'] : ['claude'],",
      `  evals: { include: [${JSON.stringify(`${evalsDir}/**/*.eval.ts`)}] },`,
      '});',
      '',
    ].join('\n');
    const suiteSource = [
      `import { expectExitCode } from ${JSON.stringify(assertionsModule)};`,
      `import { defineEvalSuite } from ${JSON.stringify(suiteModule)};`,
      '',
      'export default defineEvalSuite({',
      '  cases: [{',
      '    assertions: [expectExitCode(0)],',
      "    fixture: './fixtures/repo',",
      "    hosts: { claude: { model: 'claude-sonnet-4-5' } },",
      "    id: 'case-a',",
      "    invocation: { mode: 'automatic' },",
      "    prompt: 'Do the task.',",
      '  }],',
      "  name: 'review-change',",
      '});',
      '',
    ].join('\n');
    // The default configuration finds no suite; only the selected one does.
    const project = await createProjectFixture({
      config: configFactory('workbench-surface-default-config', 'nowhere'),
      files: {
        'checks/review.eval.ts': suiteSource,
        'package.json': '{"type":"module"}\n',
        'workbench.config.ts': configFactory('workbench-surface-selected-config', 'checks'),
      },
      prefix: 'agent-bundle-workbench-surface-preparation-',
    });
    try {
      const surface = await inspectWorkbenchSurface({ configPath: 'workbench.config.ts', root: project.root });

      expect(surface.provenance.configPath).toBe(resolve(project.root, 'workbench.config.ts'));
      expect(surface.provenance.targets).toEqual(['claude', 'codex']);
      expect(surface.counts).toMatchObject({ evalSuites: 1, targets: 2 });
      expect(surface.advanced).toContain('evals');

      const byDefault = await inspectWorkbenchSurface({ root: project.root });
      expect(byDefault.provenance.configPath).toBe(project.configPath);
      expect(byDefault.counts).toMatchObject({ evalSuites: 0, targets: 2 });
      expect(byDefault.advanced).not.toContain('evals');
    } finally {
      await rm(project.root, { force: true, recursive: true });
    }
  });
});

describe('an unusable project', () => {
  it('reports the manifest unavailable the way the dev server would, with the compiler cause', async () => {
    const error = await inspectWorkbenchSurface({ root: resolve(import.meta.dirname, 'fixtures/target-capabilities') })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('manifest-unavailable');
    expect((error as AgentTestError).message).toContain('dev server would report the route manifest unavailable');
  });

  it('rejects a project that normalizes but fails validation, as the dev server never serves an invalid preparation', async () => {
    // An unknown target normalizes into a model and a revision, then
    // `validateModel` reports AB4100: source state `invalid`, which the dev
    // server never assigns to its served preparation.
    const project = await createProjectFixture({
      config: [
        'export default {',
        "  plugin: { name: 'workbench-surface-invalid', version: '1.0.0' },",
        "  targets: ['claude', 'no-such-host'],",
        '};',
        '',
      ].join('\n'),
      files: { 'package.json': '{"type":"module"}\n' },
      prefix: 'agent-bundle-workbench-surface-invalid-',
    });
    try {
      const error = await inspectWorkbenchSurface({ root: project.root }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(AgentTestError);
      expect((error as AgentTestError).code).toBe('manifest-unavailable');
      expect((error as AgentTestError).message).toContain('source state invalid');
      expect((error as AgentTestError).message).toContain('AB4100');
    } finally {
      await rm(project.root, { force: true, recursive: true });
    }
  });
});
