import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import { planHooks } from '../src/adapters/hook-contract.ts';
import { inspect, type BundlerInspectionEntry, type ReadyInspectResult } from '../src/api.ts';
import { appRuntimePath } from '../src/build/app-runtime.ts';
import { launchEnvRuntimePath, mcpEntryRuntimePath, terminalCapabilityRuntimePath } from '../src/build/entry-shell.ts';
import { composeBundlerInspection } from '../src/build/inspect-bundler.ts';
import { stableJson } from '../src/core/digest.ts';
import type { NormalizedHook, NormalizedPlugin } from '../src/core/types.ts';
import type { CompiledEventPreflight } from '../src/routes/types.ts';
import { workspaceNodeModules } from './helpers/workspace-paths.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/**
 * The lowering runs the same Rslib/Rsbuild config resolution the build runs,
 * which reads every authored entry from disk and — for the `dts` lib entry —
 * resolves the project's own TypeScript, so the fixture links one in.
 */
const createProject = async (): Promise<string> => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-inspect-bundler-')));
  roots.push(parent);
  const root = join(parent, 'project');
  await mkdir(join(root, 'src', 'mcp'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await Promise.all([
    symlink(join(workspaceNodeModules, 'typescript'), join(root, 'node_modules', 'typescript'), 'dir'),
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'bundler-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        "  scripts: { tool: './src/tool.ts' },",
        '  mcp: {',
        '    servers: {',
        '      curator: {',
        '        apps: {',
        "          dashboard: { entry: './src/view.tsx', resourceUri: 'ui://bundler-fixture/dashboard' },",
        '        },',
        '      },',
        '    },',
        '  },',
        '  tools: {',
        "    rsbuild: { resolve: { alias: { '@fixture': './src' } } },",
        "    rspack: { resolve: { extensionAlias: { '.js': ['.js', '.ts'] } } },",
        '  },',
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'src', 'tool.ts'), 'export const main = async () => 0;\n'),
    writeFile(join(root, 'src', 'cli.ts'), 'export const main = async () => 0;\n'),
    writeFile(join(root, 'src', 'index.ts'), 'export const answer = 42;\n'),
    writeFile(
      join(root, 'src', 'mcp', 'curator.ts'),
      'export default () => ({ close() {}, async connect() {} });\n',
    ),
    writeFile(join(root, 'src', 'view.tsx'), 'export default () => null;\n'),
  ]);
  return root;
};

const bundlerEntries = (result: ReadyInspectResult): readonly BundlerInspectionEntry[] => {
  const bundler = result.selected?.bundler;
  if (bundler === undefined) throw new Error('Bundler inspection was not selected.');
  return bundler.entries;
};

const entryOf = (
  entries: readonly BundlerInspectionEntry[],
  kind: BundlerInspectionEntry['kind'],
  name: string,
): BundlerInspectionEntry => {
  const entry = entries.find((candidate) => candidate.kind === kind && candidate.name === name);
  if (entry === undefined) throw new Error(`Missing bundler inspection entry ${kind}:${name}.`);
  return entry;
};

/** The lowered Rspack configuration of one entry, typed loosely for the assertions. */
interface LoweredConfig {
  readonly context?: string;
  readonly entry?: Readonly<Record<string, readonly string[]>>;
  readonly externals?: readonly unknown[];
  readonly mode?: string;
  readonly module?: { readonly parser?: { readonly javascript?: Readonly<Record<string, unknown>> } };
  readonly name?: string;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly plugins?: readonly string[];
  readonly resolve?: {
    readonly alias?: Readonly<Record<string, string>>;
    readonly extensionAlias?: Readonly<Record<string, readonly string[]>>;
    readonly tsConfig?: { readonly configFile?: string };
  };
  readonly target?: readonly string[];
}

const loweredConfig = (entry: BundlerInspectionEntry): LoweredConfig => entry.config as LoweredConfig;

it('renders the lowered Rspack configuration of every compiled output with the tools hatch applied', async () => {
  const root = await createProject();
  const result = await inspect({ focus: 'bundler', root });
  expect(result.state).toBe('ready');
  const ready = result as ReadyInspectResult;
  const entries = bundlerEntries(ready);

  expect(entries.map((entry) => `${entry.target ?? 'package'}:${entry.kind}:${entry.name}`)).toEqual([
    'package:bin:bundler-fixture',
    'package:lib:index',
    'portable:mcp-app:dashboard',
    'portable:mcp-entry:curator',
    'portable:script:tool',
  ]);
  expect(entries.map((entry) => loweredConfig(entry).name)).toEqual([
    'agent-bundle-bin-bundler-fixture',
    'agent-bundle-index',
    'dashboard',
    expect.stringMatching(/^agent-bundle-mcp-mcp-curator-[a-f\d]{8}$/u),
    'agent-bundle-scripts-tool',
  ]);

  const script = entryOf(entries, 'script', 'tool');
  expect(script).toMatchObject({
    bundler: 'rslib',
    outputPath: 'scripts/tool.mjs',
    source: `${root}/src/tool.ts`,
    target: 'portable',
  });
  // The generated executable envelope wraps the `main` export, and the
  // lowered entry is redirected to it in the reserved virtual namespace.
  expect(script.generatedEntry).toContain('process.argv.slice(2)');
  const scriptConfig = loweredConfig(script);
  expect(scriptConfig).toMatchObject({
    context: root,
    entry: { tool: [`${root}/.agent-bundle-virtual/tool-entry.mjs`] },
    mode: 'production',
    // Generated code spells run-time paths as `new URL(…, import.meta.url)`;
    // the invariant layer keeps the bundler from turning them into assets.
    module: { parser: { javascript: { url: false, worker: false } } },
    output: {
      asyncChunks: false,
      // Rslib lowers the per-entry filename to its own resolver function.
      filename: '[function jsFilename]',
      module: true,
      // The per-build artifact root appears as the stable token.
      path: '<output>',
    },
    resolve: {
      alias: {
        // The consumer rsbuild hatch merges over the framework profile.
        '@fixture': `${root}/src`,
        // The framework's reserved aliases land as exact-match keys.
        'agent-bundle/meta$': `${root}/.agent-bundle-virtual/meta.mjs`,
        'agent-bundle/terminal-capability$': terminalCapabilityRuntimePath(),
      },
    },
  });
  expect(scriptConfig.target).toContain('node');
  // The consumer rspack hatch is merged before the invariant hook and lands in
  // the lowered config after Rsbuild's own defaults.
  expect(scriptConfig.resolve?.extensionAlias?.['.js']?.slice(-2)).toEqual(['.js', '.ts']);
  // Rslib's node target leaves only the Node built-ins (and pnpapi) external.
  expect(scriptConfig.externals).toEqual(expect.arrayContaining(['fs', '[regexp /^node:/]', 'pnpapi']));
  // Framework plugins survive the hatch: the generated sources are served
  // from memory and the dependency audit reads the final module graph.
  expect(scriptConfig.plugins).toEqual(expect.arrayContaining([
    '[object VirtualModulesPlugin]',
    '[object ArtifactDependencyAuditPlugin]',
  ]));

  const mcpEntry = entryOf(entries, 'mcp-entry', 'curator');
  expect(mcpEntry.generatedEntry).toContain('runGeneratedStdioMcpEntry');
  expect(mcpEntry.source).toBe(`${root}/src/mcp/curator.ts`);
  expect(mcpEntry.outputPath).toMatch(/^mcp\/mcp-curator-[a-f\d]{8}\.mjs$/u);
  expect(loweredConfig(mcpEntry)).toMatchObject({
    output: { filename: '[function jsFilename]', path: '<output>' },
    resolve: {
      alias: {
        'agent-bundle/launch-env$': launchEnvRuntimePath(),
        'agent-bundle/mcp-entry$': mcpEntryRuntimePath(),
      },
    },
  });

  const bin = entryOf(entries, 'bin', 'bundler-fixture');
  expect(bin).toMatchObject({
    outputPath: 'dist/bin/bundler-fixture.js',
    source: `${root}/src/cli.ts`,
  });
  expect(bin.generatedEntry).toContain('process.argv.slice(2)');
  const binConfig = loweredConfig(bin);
  // The package build's output root is its published destination.
  expect(binConfig.output).toMatchObject({ filename: '[function jsFilename]', path: `${root}/dist` });
  // The shebang banner lowers to Rspack's banner plugin.
  expect(binConfig.plugins).toContain('[object BannerPlugin]');

  const lib = entryOf(entries, 'lib', 'index');
  expect(lib.outputPath).toBe('dist/index.js');
  expect(loweredConfig(lib).resolve?.tsConfig).toEqual({ configFile: '<generated-dts-tsconfig>', references: 'auto' });

  const app = entryOf(entries, 'mcp-app', 'dashboard');
  expect(app).toMatchObject({
    bundler: 'rsbuild',
    outputPath: 'mcp-apps/dashboard.html',
    source: `${root}/src/view.tsx`,
    target: 'portable',
  });
  expect(app.generatedEntry).toBeUndefined();
  const appConfig = loweredConfig(app);
  expect(appConfig).toMatchObject({
    entry: { dashboard: [`${root}/src/view.tsx`] },
    mode: 'production',
    output: { asyncChunks: false, path: '<output>' },
    resolve: {
      alias: {
        // The consumer rsbuild hatch also merges over the view profile.
        '@fixture': `${root}/src`,
        'agent-bundle/app$': appRuntimePath(),
        'agent-bundle/meta$': `${root}/.agent-bundle-virtual/meta.mjs`,
      },
    },
  });
  expect(appConfig.target).toContain('web');
  expect(appConfig.plugins).toEqual(expect.arrayContaining([
    '[object NormalModuleReplacementPlugin]',
    '[object VirtualModulesPlugin]',
    '[object ArtifactDependencyAuditPlugin]',
  ]));
});

it('keeps the bundler inspection deterministic, JSON-serializable, and free of the staged output path', async () => {
  const root = await createProject();
  const [first, second] = await Promise.all([
    inspect({ focus: 'bundler', root }),
    inspect({ focus: 'bundler', root }),
  ]);
  expect(first.state).toBe('ready');
  const rendered = stableJson((first as ReadyInspectResult).selected);
  expect(rendered).toBe(stableJson((second as ReadyInspectResult).selected));
  expect(rendered).not.toContain(`${root}/<output>`);
  expect(rendered).not.toContain(`${root}/<generated-dts-tsconfig>`);
});

it('keeps the bundler focus out of unfocused inspections', async () => {
  const root = await createProject();
  const result = await inspect({ root });
  expect(result.state).toBe('ready');
  expect((result as ReadyInspectResult).selected).toBeUndefined();
});

it('reports a tools hatch the lowering refuses as an invalid inspection naming the refusal', async () => {
  const root = await createProject();
  await writeFile(
    join(root, 'agent-bundle.config.ts'),
    [
      'export default {',
      "  plugin: { name: 'bundler-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      "  scripts: { tool: './src/tool.ts' },",
      // Aliasing a reserved specifier is refused only once the invariant hook
      // runs over the lowered config, so it surfaces from the inspection.
      "  tools: { rspack: { resolve: { alias: { 'agent-bundle/meta': './src/index.ts' } } } },",
      '};',
      '',
    ].join('\n'),
  );
  const result = await inspect({ focus: 'bundler', root });
  expect(result.state).toBe('invalid');
  expect(result.diagnostics).toEqual([expect.objectContaining({
    code: 'AB7001',
    message: expect.stringContaining('The tools escape hatch must not alias the reserved specifier matched by "agent-bundle/meta"'),
  })]);
});

it('inspects the per-host preflight wrapper under the composite identity', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-inspect-hooks-')));
  roots.push(parent);
  const root = join(parent, 'project');
  await mkdir(join(root, 'src', 'events', 'tool'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'src', 'events', 'tool', 'before.tsx'), 'export default () => undefined;\n'),
    writeFile(join(root, 'src', 'events', 'tool', 'before.preflight.ts'), 'export default () => true;\n'),
  ]);
  const preflight: CompiledEventPreflight = Object.freeze({
    provenance: Object.freeze({ kind: 'conventional' as const, relativePath: 'src/events/tool/before.preflight.ts' }),
    source: `${root}/src/events/tool/before.preflight.ts`,
  });
  const hook: NormalizedHook = {
    event: 'beforeTool',
    eventRoute: { event: 'tool/before', fallback: 'none', preflight, runtime: 'shared' },
    id: 'hook:event-route:tool-before',
    name: 'event-route-tool-before',
    provenance: { kind: 'conventional', sourcePath: `${root}/src/events/tool/before.tsx` },
    source: `${root}/src/events/tool/before.tsx`,
    targets: ['claude', 'codex'],
    tools: [],
  };
  const model: NormalizedPlugin = {
    extensions: {},
    hooks: [hook],
    mcpServers: [],
    metadata: {
      id: 'plugin:preflight-inspect',
      name: 'preflight-inspect',
      provenance: { kind: 'config', sourcePath: `${root}/agent-bundle.config.ts` },
      version: '1.0.0',
    },
    runtime: { node: '22.12.0' },
    scripts: [],
    skills: [],
    targets: ['claude', 'codex'].map((name) => ({
      id: `target:${name}`,
      name,
      provenance: { kind: 'config' as const, sourcePath: `${root}/agent-bundle.config.ts` },
    })),
  };
  const hookEntries = ['claude', 'codex'].flatMap((host) => planHooks(model, host, {
    commandRoot: host === 'claude' ? '${CLAUDE_PLUGIN_ROOT}' : '${PLUGIN_ROOT}',
    encodePlaygroundInput: (input) => input,
    encodePlaygroundOutput: (result) => result,
    eventNames: {},
    eventRouteNames: { 'tool/before': 'PreToolUse' },
    hostContractRevision: '2026-09-02',
    manifestPath: 'hooks/hooks.json',
    matchers: {},
    wrapperPath: () => `hooks/${hook.name}.${host}.mjs`,
    wrapperSource: () => 'config-hook-only\n',
  }).hookEntries);
  const inspection = await composeBundlerInspection({
    composite: {
      cliBin: false,
      hookEntries,
      identity: 'claude+codex',
      noticeDelivery: undefined,
      selected: ['claude', 'codex'],
    },
    model,
    projectRoot: root,
  });
  const hooks = inspection.entries.filter((entry) => entry.kind === 'hook');
  expect(hooks.map((entry) => entry.outputPath).sort()).toEqual([
    'hooks/event-route-tool-before.claude.mjs',
    'hooks/event-route-tool-before.codex.mjs',
  ]);
  for (const entry of hooks) {
    expect(entry.target).toBe('claude+codex');
    expect(entry.generatedEntry).toContain('executeEventPreflight');
    expect(entry.generatedEntry).toContain(preflight.source);
    expect(entry.generatedEntry).toContain('agent-bundle/event-project');
    expect(entry.generatedEntry).toContain('.execute.mjs');
    expect(entry.generatedEntry).not.toContain('AGENT_BUNDLE_HOOK_HOST');
    expect(loweredConfig(entry)).toMatchObject({
      name: `agent-bundle-${entry.outputPath.replace(/\.mjs$/u, '').replaceAll('/', '-')}`,
      output: { filename: '[function jsFilename]', path: '<output>' },
      resolve: { alias: { 'agent-bundle/launch-env$': launchEnvRuntimePath() } },
    });
  }
});
