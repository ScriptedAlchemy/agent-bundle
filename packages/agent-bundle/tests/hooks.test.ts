import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it, rs } from '@rstest/core';
import { rspack } from '@rslib/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { nativeHookWrapperSource, type TargetHookWrapper } from '../src/adapters/hook-contract.ts';
import { build } from './support/build.ts';
import { runNodeScript } from './support/run-node-script.ts';
import { writeHookIndex } from '../src/build/emit.ts';
import { compileHooks } from '../src/build/entries.ts';
import { generatedMetaModulePath, metaModuleSpecifier, projectMeta } from '../src/build/meta.ts';
import { buildWithRslib } from '../src/build/rslib.ts';
import type { AgentBundleMeta } from '../src/meta.ts';
import { HookService, isHookSimulationCancellation } from '../src/services/hook-service.ts';
import { parseArtifactHookIndex } from '../src/build/hook-index.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { NormalizationTargetRegistry, NormalizedPlugin } from '../src/core/types.ts';
import { validateModel, validateSource } from '../src/config/validate.ts';

const probeMeta: AgentBundleMeta = Object.freeze({
  name: 'hook-probe',
  packageName: 'hook-probe',
  packageVersion: '1.0.0',
  version: '1.0.0',
});

/**
 * Every generated executable resolves the framework identity module, so a
 * stubbed Rslib resolution has to carry what a real one would: the
 * virtual-module plugin instance and the exact-match alias.
 */
const resolvedVirtualModules = (outputRoot: string) => ({
  plugins: [new rspack.experiments.VirtualModulesPlugin({})],
  resolve: { alias: { [`${metaModuleSpecifier}$`]: generatedMetaModulePath(outputRoot) } },
});

const registry: NormalizationTargetRegistry = {
  configExtensions: () => [],
  defaultTargetNames: () => ['codex', 'claude'],
  has: (name) => name === 'portable' || name === 'codex' || name === 'claude',
  supports: (name, capability) => capability === 'hooks' && name !== 'portable',
};

it('maps promoted families only through event-route contracts', () => {
  const targetRegistry = createDefaultRegistry();
  for (const target of ['claude', 'codex', 'cursor']) {
    const contract = targetRegistry.hookContract(target);
    for (const event of ['promptSubmit', 'sessionEnd', 'toolFailure', 'compactBefore', 'compactAfter']) {
      expect(contract?.eventNames).not.toHaveProperty(event);
    }
    expect(contract?.eventRouteNames?.['prompt/submit']).toBe(
      target === 'cursor' ? 'beforeSubmitPrompt' : 'UserPromptSubmit',
    );
    expect(contract?.eventRouteNames?.['session/end']).toBe(
      target === 'cursor' ? 'sessionEnd' : 'SessionEnd',
    );
    expect(contract?.eventRouteNames?.['tool/failure']).toBe(
      target === 'codex' ? undefined : target === 'cursor' ? 'postToolUseFailure' : 'PostToolUseFailure',
    );
    expect(contract?.eventRouteNames?.['compact/before']).toBe(target === 'cursor' ? 'preCompact' : 'PreCompact');
    expect(contract?.eventRouteNames?.['compact/after']).toBe(target === 'cursor' ? undefined : 'PostCompact');
    expect(contract?.nativeEventStarter?.('prompt/submit')).toBeDefined();
    expect(contract?.nativeEventStarter?.('session/end')).toBeDefined();
    if (target === 'codex') expect(contract?.nativeEventStarter?.('tool/failure')).toBeUndefined();
    else expect(contract?.nativeEventStarter?.('tool/failure')).toBeDefined();
    expect(contract?.nativeEventStarter?.('compact/before')).toBeDefined();
    if (target === 'cursor') expect(contract?.nativeEventStarter?.('compact/after')).toBeUndefined();
    else expect(contract?.nativeEventStarter?.('compact/after')).toBeDefined();
  }
});

it('keeps the hook simulation cancellation constructor private to the executor', async () => {
  const hookServiceExports: Readonly<Record<string, unknown>> = await import('../src/services/hook-service.ts');

  expect(Object.hasOwn(hookServiceExports, 'HookSimulationAbortError')).toBe(false);
});

it('accepts only canonical frozen hook index metadata', () => {
  const bytes = '{"hooks":[{"event":"sessionStart","id":"hook:start","name":"start","path":"codex/hooks/start.mjs","target":"codex"}]}\n';
  const index = parseArtifactHookIndex(bytes);

  expect(index).toEqual({
    hooks: [{ event: 'sessionStart', id: 'hook:start', name: 'start', path: 'codex/hooks/start.mjs', target: 'codex' }],
  });
  expect(index === undefined ? false : Object.isFrozen(index)).toBe(true);
  expect(index === undefined ? false : Object.isFrozen(index.hooks)).toBe(true);
  expect(parseArtifactHookIndex('{"version":1,"hooks":[]}\n')).toBeUndefined();
  expect(parseArtifactHookIndex('{"hooks":[],"hooks":[]}\n')).toBeUndefined();
  expect(parseArtifactHookIndex('{"hooks":[{"event":"sessionStart","id":"hook:start","name":"start","path":"../start.mjs","target":"codex"}]}\n')).toBeUndefined();
  const crossTargetOrder = '{"hooks":[{"event":"sessionStart","id":"z","name":"first","path":"a/hooks/first.mjs","target":"a"},{"event":"sessionStart","id":"a","name":"second","path":"aa/hooks/second.mjs","target":"aa"}]}\n';
  expect(parseArtifactHookIndex(crossTargetOrder)).toEqual({
    hooks: [
      { event: 'sessionStart', id: 'z', name: 'first', path: 'a/hooks/first.mjs', target: 'a' },
      { event: 'sessionStart', id: 'a', name: 'second', path: 'aa/hooks/second.mjs', target: 'aa' },
    ],
  });
});

it('serializes hook index targets by tuple order without sentinel concatenation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-index-order-'));
  const hooks = [
    { event: 'sessionStart', id: 'a', name: 'second', path: 'aa/hooks/second.mjs', target: 'aa' },
    { event: 'sessionStart', id: 'z', name: 'first', path: 'a/hooks/first.mjs', target: 'a' },
  ] as const;

  try {
    await writeHookIndex({ artifactRoot: root, hooks });
    expect(await readFile(join(root, 'agent-bundle.hooks.json'), 'utf8')).toBe(
      '{"hooks":[{"event":"sessionStart","id":"z","name":"first","path":"a/hooks/first.mjs","target":"a"},{"event":"sessionStart","id":"a","name":"second","path":"aa/hooks/second.mjs","target":"aa"}]}\n',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps the Claude and Codex native wrapper codecs byte-identical apart from identifiers and the target constant', () => {
  const entry: TargetHookWrapper = {
    event: 'beforeTool',
    hook: {
      event: 'beforeTool',
      id: 'hook:before-tool:example:00000000',
      name: 'example',
      provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
      source: '/project/src/hooks/example.ts',
      targets: ['claude', 'codex'],
      tools: [],
    },
    nativeEvent: 'PreToolUse',
    relativePath: 'hooks/example.mjs',
    target: 'claude',
  };

  const stripCodecIdentifiers = (source: string): string => source
    .replaceAll(/decode(?:Claude|Codex|Universal)Native/g, 'decodeNative')
    .replaceAll(/encode(?:Claude|Codex|Universal)Native/g, 'encodeNative');

  const withoutTargetConstant = (source: string): string => source
    .split('\n')
    .filter((line) => !line.startsWith('const target ='))
    .join('\n');

  const normalize = (source: string): string => stripCodecIdentifiers(withoutTargetConstant(source));

  const claudeSource = nativeHookWrapperSource(entry, 'Claude');
  const codexSource = nativeHookWrapperSource(entry, 'Codex');

  expect(normalize(claudeSource)).toBe(normalize(codexSource));

  const universalSource = nativeHookWrapperSource(entry, 'Universal');

  expect(universalSource).toContain('process.env.PLUGIN_ROOT');
  expect(universalSource).toContain('AGENT_BUNDLE_HOOK_HOST');

  const hostDetectionLines = new Set([
    'const declaredHost = process.env.AGENT_BUNDLE_HOOK_HOST;',
    'const target = declaredHost === "claude" || declaredHost === "codex"',
    '  ? declaredHost',
    '  : process.env.PLUGIN_ROOT === undefined ? "claude" : "codex";',
  ]);
  const universalWithoutHostDetection = universalSource
    .split('\n')
    .filter((line) => !hostDetectionLines.has(line))
    .join('\n');

  expect(stripCodecIdentifiers(universalWithoutHostDetection)).toBe(normalize(claudeSource));
});

const runPublishedHook = async (wrapper: string, input: string) => runNodeScript({ args: [wrapper], input });

const runNativeHook = async (wrapper: string, input: Record<string, unknown>) =>
  runNodeScript({ args: [wrapper], input: JSON.stringify(input) });

const importPublishedHook = async (wrapper: string) =>
  runNodeScript({
    args: ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(wrapper).href)}); process.exit(0);`],
    cwd: dirname(wrapper),
  });

it('does not share a persistent Rslib cache between generated executables', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-rslib-cache-output-'));
  const createOptions: unknown[] = [];
  const rslib = {
    build: async () => ({
      close: async () => undefined,
      stats: {
        toJson: () => ({
          assets: [{ name: 'hooks/cache-probe.mjs' }],
          modules: [],
        }),
      },
    }),
    inspectConfig: async () => ({
      origin: {
        bundlerConfigs: [{
          name: 'agent-bundle-cache-probe',
          output: { asyncChunks: false, path: outputRoot },
          performance: { buildCache: false },
          target: 'node',
          ...resolvedVirtualModules(outputRoot),
        }],
        environmentConfigs: { 'agent-bundle-cache-probe': { output: { cleanDistPath: false } } },
      },
    }),
  };

  try {
    await mkdir(join(outputRoot, 'hooks'), { recursive: true });
    await writeFile(join(outputRoot, 'hooks', 'cache-probe.mjs'), 'export default undefined;\n');
    await buildWithRslib({
      cwd: '/tmp',
      entries: [{
        name: 'cache-probe',
        outputRelativePath: 'hooks/cache-probe.mjs',
        source: '/tmp/hook.ts',
        sourceInputs: ['/tmp/hook.ts'],
      }],
      meta: probeMeta,
      outputRoot,
    }, {
      createRslib: async (options) => {
        createOptions.push(options);
        return rslib as never;
      },
    });
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }

  const [{ config }] = createOptions as [{
    readonly config: {
      readonly lib: readonly [{ readonly performance?: { readonly buildCache?: boolean } }];
    };
  }];
  expect(config.lib[0].performance).toEqual({ buildCache: false });
});

it('closes the Rslib build result and serves the generated wrapper entry virtually without touching disk', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-rslib-close-output-'));
  const virtualEntryPath = join(outputRoot, '.agent-bundle-virtual', 'close-probe-entry.mjs');
  const close = rs.fn(async () => undefined);
  const buildResult = {
    close,
    stats: {
      toJson: () => ({
        assets: [{ name: 'hooks/close-probe.mjs' }],
        modules: [],
      }),
    },
  };
  let reservedNamespaceDuringBuild: unknown;
  const createOptions: unknown[] = [];
  const rslib = {
    build: async () => {
      // The generated wrapper entry is served from memory: its reserved
      // namespace must not exist on disk even while the build is running.
      reservedNamespaceDuringBuild = await readdir(join(outputRoot, '.agent-bundle-virtual'))
        .then(() => undefined, (error: unknown) => error);
      return buildResult;
    },
    inspectConfig: async () => ({
      origin: {
        bundlerConfigs: [{
          entry: { 'close-probe': [virtualEntryPath] },
          name: 'agent-bundle-close-probe',
          output: { asyncChunks: false, path: outputRoot },
          target: 'node',
          ...resolvedVirtualModules(outputRoot),
        }],
        environmentConfigs: { 'agent-bundle-close-probe': { output: { cleanDistPath: false } } },
      },
    }),
  };

  try {
    await mkdir(join(outputRoot, 'hooks'), { recursive: true });
    await writeFile(join(outputRoot, 'hooks', 'close-probe.mjs'), 'export default undefined;\n');
    await buildWithRslib({
      cwd: '/tmp',
      entries: [{
        name: 'close-probe',
        outputRelativePath: 'hooks/close-probe.mjs',
        source: '/tmp/hook.ts',
        sourceInputs: ['/tmp/hook.ts'],
        virtualSource: 'export default undefined;',
      }],
      meta: probeMeta,
      outputRoot,
    }, {
      createRslib: async (options) => {
        createOptions.push(options);
        return rslib as never;
      },
    });

    expect(close).toHaveBeenCalledOnce();
    expect(reservedNamespaceDuringBuild).toMatchObject({ code: 'ENOENT' });
    await expect(readdir(join(outputRoot, '.agent-bundle-virtual'))).rejects.toMatchObject({ code: 'ENOENT' });

    // The composed profile keys the entry on the authored program (Rslib
    // checks entry existence on the real filesystem), and the invariant hook
    // redirects the lowered Rspack entry to the guaranteed-nonexistent
    // virtual path it registers with VirtualModulesPlugin.
    const [{ config }] = createOptions as [{
      readonly config: {
        readonly lib: readonly [{
          readonly source: { readonly entry: Readonly<Record<string, string>> };
          readonly tools?: { readonly rspack?: unknown };
        }];
      };
    }];
    expect(config.lib[0].source.entry).toEqual({ 'close-probe': '/tmp/hook.ts' });
    const hooksChain = config.lib[0].tools?.rspack;
    const mutators = (Array.isArray(hooksChain) ? hooksChain : [hooksChain])
      .filter((mutator): mutator is (value: object) => object => typeof mutator === 'function');
    expect(mutators.length).toBeGreaterThan(0);
    const resolved: { entry?: unknown; plugins?: readonly unknown[] } = {
      entry: { 'close-probe': ['/tmp/hook.ts'] },
    };
    for (const mutator of mutators) mutator(resolved);
    expect(resolved.entry).toEqual({ 'close-probe': [virtualEntryPath] });
    const virtualPlugins = (resolved.plugins ?? [])
      .filter((plugin) => plugin instanceof rspack.experiments.VirtualModulesPlugin);
    expect(virtualPlugins).toHaveLength(1);
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
});

it('fails closed when the resolved environment lost its virtual modules or wrapper entry', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-rslib-lost-virtual-'));
  const virtualEntryPath = join(outputRoot, '.agent-bundle-virtual', 'lost-probe-entry.mjs');
  const rslibFor = (bundlerConfig: Record<string, unknown>) => ({
    build: async () => {
      throw new Error('inspection must fail before the build starts');
    },
    inspectConfig: async () => ({
      origin: {
        bundlerConfigs: [{
          name: 'agent-bundle-lost-probe',
          output: { asyncChunks: false, path: outputRoot },
          target: 'node',
          ...bundlerConfig,
        }],
        environmentConfigs: { 'agent-bundle-lost-probe': { output: { cleanDistPath: false } } },
      },
    }),
  });
  const buildLostProbe = async (bundlerConfig: Record<string, unknown>) => buildWithRslib({
    cwd: '/tmp',
    entries: [{
      name: 'lost-probe',
      outputRelativePath: 'hooks/lost-probe.mjs',
      source: '/tmp/hook.ts',
      sourceInputs: ['/tmp/hook.ts'],
      virtualSource: 'export default undefined;',
    }],
    meta: probeMeta,
    outputRoot,
  }, { createRslib: async () => rslibFor(bundlerConfig) as never });

  try {
    // A resolved config without the plugin would resolve the
    // guaranteed-nonexistent generated paths against the real filesystem.
    await expect(buildLostProbe({ entry: { 'lost-probe': [virtualEntryPath] } }))
      .rejects.toThrow(/without its virtual modules/u);
    // A resolved config still keyed on the authored program would compile
    // without the generated wrapper.
    await expect(buildLostProbe({
      entry: { 'lost-probe': ['/tmp/hook.ts'] },
      ...resolvedVirtualModules(outputRoot),
    })).rejects.toThrow(/without its generated wrapper entry/u);
    // A resolved config that lost the framework identity alias would resolve
    // agent-bundle/meta to the published throwing stub instead.
    await expect(buildLostProbe({
      entry: { 'lost-probe': [virtualEntryPath] },
      plugins: [new rspack.experiments.VirtualModulesPlugin({})],
    })).rejects.toThrow(/without its reserved module aliases/u);
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
});

it('fails closed when an emitted bundle retains a residual reserved import', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-rslib-residual-output-'));
  const rslib = {
    build: async () => ({
      close: async () => undefined,
      stats: {
        toJson: () => ({
          assets: [{ name: 'hooks/residual-probe.mjs' }],
          modules: [],
        }),
      },
    }),
    inspectConfig: async () => ({
      origin: {
        bundlerConfigs: [{
          name: 'agent-bundle-residual-probe',
          output: { asyncChunks: false, path: outputRoot },
          target: 'node',
          ...resolvedVirtualModules(outputRoot),
        }],
        environmentConfigs: { 'agent-bundle-residual-probe': { output: { cleanDistPath: false } } },
      },
    }),
  };

  try {
    await mkdir(join(outputRoot, 'hooks'), { recursive: true });
    await writeFile(
      join(outputRoot, 'hooks', 'residual-probe.mjs'),
      'import { runGeneratedStdioMcpEntry } from "agent-bundle/mcp-entry";\nawait runGeneratedStdioMcpEntry({});\n',
    );
    await expect(buildWithRslib({
      cwd: '/tmp',
      entries: [{
        name: 'residual-probe',
        outputRelativePath: 'hooks/residual-probe.mjs',
        source: '/tmp/hook.ts',
        sourceInputs: ['/tmp/hook.ts'],
      }],
      meta: probeMeta,
      outputRoot,
    }, { createRslib: async () => rslib as never })).rejects.toThrow(/not self-contained/u);
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
});

it('closes the Rslib build result when provenance stats are unavailable', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-rslib-close-error-output-'));
  const close = rs.fn(async () => undefined);
  const rslib = {
    build: async () => ({ close }),
    inspectConfig: async () => ({
      origin: {
        bundlerConfigs: [{
          name: 'agent-bundle-close-error-probe',
          output: { asyncChunks: false, path: outputRoot },
          target: 'node',
          ...resolvedVirtualModules(outputRoot),
        }],
        environmentConfigs: { 'agent-bundle-close-error-probe': { output: { cleanDistPath: false } } },
      },
    }),
  };

  try {
    await expect(buildWithRslib({
      cwd: '/tmp',
      entries: [{
        name: 'close-error-probe',
        outputRelativePath: 'hooks/close-error-probe.mjs',
        source: '/tmp/hook.ts',
        sourceInputs: ['/tmp/hook.ts'],
      }],
      meta: probeMeta,
      outputRoot,
    }, { createRslib: async () => rslib as never })).rejects.toThrow(/stats/i);

    expect(close).toHaveBeenCalledOnce();
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
});

it('normalizes a shorthand session-start hook into a frozen stable record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-normalize-'));
  const configPath = join(root, 'agent-bundle.config.ts');
  const loaded: LoadedConfig = {
    config: {
      hooks: { sessionStart: './src/hooks/session-start.ts' },
      plugin: { name: 'review-tools', version: '1.0.0' },
    },
    configPath,
    context: {
      command: 'build',
      mode: 'production',
      projectRoot: root,
      selectedTargets: [],
    },
  };

  try {
    const model = await normalizeProject(loaded, { skills: [] }, registry);
    const hooks = Reflect.get(model, 'hooks');

    expect(hooks).toEqual([
      {
        event: 'sessionStart',
        id: 'hook:session-start:session-start:7ab7e8a5',
        name: 'session-start-session-start-7ab7e8a5',
        provenance: { kind: 'config', sourcePath: configPath },
        source: join(root, 'src', 'hooks', 'session-start.ts'),
        targets: ['claude', 'codex'],
        tools: [],
      },
    ]);
    expect(Object.isFrozen(hooks)).toBe(true);
    expect(Object.isFrozen((hooks as readonly unknown[])[0]!)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('filters inherited hook targets through adapter hook capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-capabilities-'));
  const configPath = join(root, 'agent-bundle.config.ts');
  const targetRegistry = createDefaultRegistry();
  const loaded: LoadedConfig = {
    config: {
      hooks: { sessionStart: './src/hooks/session-start.ts' },
      plugin: { name: 'review-tools', version: '1.0.0' },
      targets: ['portable', 'codex', 'claude'],
    },
    configPath,
    context: { command: 'build', mode: 'production', projectRoot: root, selectedTargets: [] },
  };

  try {
    const model = await normalizeProject(loaded, { skills: [] }, targetRegistry);

    expect(model.hooks[0]?.targets).toEqual(['claude', 'codex']);
    expect(validateModel(model, targetRegistry).map((diagnostic) => diagnostic.code)).not.toContain('AB4204');
    expect(targetRegistry.get('portable').plan(model).hookEntries).toEqual([]);
    expect(targetRegistry.get('codex').plan(model).hookEntries).toHaveLength(1);
    expect(targetRegistry.get('claude').plan(model).hookEntries).toHaveLength(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('loads and deterministically merges target-native hook documents after generated groups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-native-documents-'));
  const configPath = join(root, 'agent-bundle.config.ts');
  const codexNative = join(root, 'codex-hooks.json');
  const claudeNative = join(root, 'claude-hooks.json');
  const targetRegistry = createDefaultRegistry();
  const loaded: LoadedConfig = {
    config: {
      claude: { nativeHooks: './claude-hooks.json' },
      codex: { nativeHooks: './codex-hooks.json' },
      hooks: { sessionStart: './src/hooks/session-start.ts' },
      plugin: { name: 'review-tools', version: '1.0.0' },
      targets: ['codex', 'claude'],
    },
    configPath,
    context: { command: 'build', mode: 'production', projectRoot: root, selectedTargets: [] },
  };

  const nativeDocument = (description: string, command: string) => ({
    description,
    hooks: {
      SessionStart: [{ hooks: [{ command, type: 'command' }] }],
      UserPromptSubmit: [{ hooks: [{ command: `${command} user-prompt`, type: 'command' }] }],
    },
  });

  try {
    await Promise.all([
      writeFile(codexNative, `${JSON.stringify(nativeDocument('Codex escape hatch', 'echo codex'))}\n`),
      writeFile(claudeNative, `${JSON.stringify(nativeDocument('Claude escape hatch', 'echo claude'))}\n`),
    ]);
    const model = await normalizeProject(loaded, { skills: [] }, targetRegistry);
    const nativeHooks = model.nativeHooks ?? [];

    expect(nativeHooks).toEqual([
      {
        document: nativeDocument('Claude escape hatch', 'echo claude'),
        provenance: { kind: 'config', sourcePath: configPath },
        source: claudeNative,
        target: 'claude',
      },
      {
        document: nativeDocument('Codex escape hatch', 'echo codex'),
        provenance: { kind: 'config', sourcePath: configPath },
        source: codexNative,
        target: 'codex',
      },
    ]);
    expect(Object.isFrozen(nativeHooks)).toBe(true);
    expect(Object.isFrozen(nativeHooks[0]!)).toBe(true);

    for (const [target, generatedRoot, nativeCommand] of [
      ['claude', '${CLAUDE_PLUGIN_ROOT}', 'echo claude'],
      ['codex', '${PLUGIN_ROOT}', 'echo codex'],
    ] as const) {
      const plan = targetRegistry.get(target).plan(model);
      const writes = Object.fromEntries(plan.entries.flatMap((entry) =>
        entry.kind === 'write' ? [[entry.relativePath, entry.content]] : []));
      expect(plan.diagnostics).toEqual([]);
      expect(JSON.parse(writes['hooks/hooks.json']!)).toEqual({
        description: target === 'codex' ? 'Codex escape hatch' : 'Claude escape hatch',
        hooks: {
          SessionStart: [
            { hooks: [{ command: `node "${generatedRoot}/hooks/session-start-session-start-7ab7e8a5.mjs"`, type: 'command' }] },
            { hooks: [{ command: nativeCommand, type: 'command' }] },
          ],
          UserPromptSubmit: [{ hooks: [{ command: `${nativeCommand} user-prompt`, type: 'command' }] }],
        },
      });
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports stable target-native hook file diagnostics before merge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-native-invalid-'));
  const targetRegistry = createDefaultRegistry();
  const loaded: LoadedConfig = {
    config: {
      claude: { nativeHooks: './claude-broken.json' },
      codex: { nativeHooks: './missing-codex.json' },
      plugin: { name: 'review-tools', version: '1.0.0' },
      targets: ['codex', 'claude'],
    },
    configPath: join(root, 'agent-bundle.config.ts'),
    context: { command: 'build', mode: 'production', projectRoot: root, selectedTargets: [] },
  };

  try {
    await writeFile(join(root, 'claude-broken.json'), '{not json\n');
    const broken = await normalizeProject(loaded, { skills: [] }, targetRegistry);

    expect(targetRegistry.get('codex').plan(broken).diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['codex.native-hooks.missing']);
    expect(targetRegistry.get('claude').plan(broken).diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['claude.native-hooks.parse']);

    await writeFile(join(root, 'invalid-codex.json'), '{"hooks":{"SessionStart":"invalid"}}\n');
    const invalidSchema = await normalizeProject({
      ...loaded,
      config: { ...loaded.config, codex: { nativeHooks: './invalid-codex.json' } },
    }, { skills: [] }, targetRegistry);
    expect(targetRegistry.get('codex').plan(invalidSchema).diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['codex.native-hooks.schema']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('lists and simulates only validated wrappers from a clean copied artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-service-source-'));
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-service-consumer-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const artifact = join(consumer, 'installed-plugin');
  const model = hookModel(root);
  const service = new HookService();

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(sourceRoot, 'session-start.ts'), "export default (event: { source?: string }) => ({ outcome: 'continue' as const, additionalContext: `start:${event.source}` });\n"),
      writeFile(join(sourceRoot, 'check-command.ts'), [
        'export default (event: { toolInput?: { command?: string } }) => event.toolInput?.command === "blocked"',
        "  ? { outcome: 'deny' as const, reason: 'blocked command' }",
        "  : { outcome: 'continue' as const, updatedInput: { command: 'rewritten' }, additionalContext: 'checked' };",
        '',
      ].join('\n')),
      writeFile(join(sourceRoot, 'record.ts'), "export default () => ({ outcome: 'continue' as const, additionalContext: 'recorded' });\n"),
      writeFile(join(sourceRoot, 'stop.ts'), "export default () => ({ outcome: 'continue' as const });\n"),
    ]);
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });
    await cp(outputRoot, artifact, { recursive: true });
    await rm(root, { force: true, recursive: true });

    await expect(importPublishedHook(join(artifact, 'codex', 'hooks', 'session-start-session-start-7ab7e8a5.mjs'))).resolves.toEqual({
      code: 0,
      stderr: '',
      stdout: '',
    });

    const listed = await service.list({ artifact });
    expect(listed).toEqual([
      expect.objectContaining({ event: 'afterTool', target: 'claude' }),
      expect.objectContaining({ event: 'beforeTool', target: 'claude' }),
      expect.objectContaining({ event: 'sessionStart', target: 'claude' }),
      expect.objectContaining({ event: 'stop', target: 'claude' }),
      expect.objectContaining({ event: 'afterTool', target: 'codex' }),
      expect.objectContaining({ event: 'beforeTool', target: 'codex' }),
      expect.objectContaining({ event: 'sessionStart', target: 'codex' }),
      expect.objectContaining({ event: 'stop', target: 'codex' }),
    ]);
    expect(listed.find((hook) => hook.id === 'hook:session-start:session-start:7ab7e8a5' && hook.target === 'codex')).toMatchObject({
      path: 'codex/hooks/session-start-session-start-7ab7e8a5.mjs',
    });
    const epochMarker = join(artifact, '.agent-bundle-epoch-stage.json');
    await writeFile(epochMarker, '{"token":"00000000-0000-4000-8000-000000000000"}\n');
    await expect(service.list({ artifact })).rejects.toThrow(/artifact files do not match/i);
    await expect(service.list({ allowEpochStagingMarker: true, artifact })).resolves.toHaveLength(8);
    await rm(epochMarker, { force: true });
    const commonInput = { cwd: '/workspace', sessionId: 'session-1', transcriptPath: '/workspace/transcript.json' };
    for (const target of ['codex', 'claude'] as const) {
      await expect(service.simulate({
        artifact,
        hook: 'hook:session-start:session-start:7ab7e8a5',
        input: { ...commonInput, source: 'startup' },
        target,
      })).resolves.toEqual({ additionalContext: 'start:startup', outcome: 'continue' });
      await expect(service.simulate({
        artifact,
        hook: 'hook:before-tool:check-command:1f5b5818',
        input: { ...commonInput, toolInput: { command: 'blocked' }, toolName: 'Bash', toolUseId: 'use-1' },
        target,
      })).resolves.toEqual({ outcome: 'deny', reason: 'blocked command' });
      await expect(service.simulate({
        artifact,
        hook: 'hook:before-tool:check-command:1f5b5818',
        input: { ...commonInput, toolInput: { command: 'safe' }, toolName: 'Bash', toolUseId: 'use-2' },
        target,
      })).resolves.toEqual({
        additionalContext: 'checked',
        outcome: 'continue',
        updatedInput: { command: 'rewritten' },
      });
      await expect(service.simulate({
        artifact,
        hook: 'hook:after-tool:record:87785f02',
        input: { ...commonInput, toolInput: {}, toolName: 'Write', toolResponse: { value: 'ok' }, toolUseId: 'use-3' },
        target,
      })).resolves.toEqual({ additionalContext: 'recorded', outcome: 'continue' });
      await expect(service.simulate({
        artifact,
        hook: 'hook:stop:stop:bb2d7935',
        input: { ...commonInput, lastAssistantMessage: 'done', stopHookActive: false },
        target,
      })).resolves.toBeUndefined();
    }

    await writeFile(join(artifact, 'codex', 'hooks', 'session-start-session-start-7ab7e8a5.mjs'), 'broken');
    await expect(service.simulate({
      artifact,
      hook: 'hook:session-start:session-start:7ab7e8a5',
      input: { ...commonInput, source: 'tampered' },
      target: 'codex',
    })).rejects.toThrow(/artifact files do not match/i);
  } finally {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(consumer, { force: true, recursive: true }),
    ]);
  }
}, 15_000);

it('escalates timed-out and aborted wrapper process trees from TERM to KILL before settling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-service-termination-'));
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-service-termination-consumer-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const artifact = join(consumer, 'installed-plugin');
  const base = hookModel(root);
  const model: NormalizedPlugin = {
    ...base,
    hooks: [{ ...base.hooks[1]!, targets: ['codex'], timeoutMs: 1_000 }],
    targets: [base.targets[0]!],
  };
  const service = new HookService();
  const descendantPidPath = join(root, 'descendant.pid');
  const previousDescendantPidPath = process.env.AGENT_BUNDLE_HOOK_TREE_TEST_PID;
  const input = {
    cwd: '/workspace',
    sessionId: 'session-1',
    toolInput: { command: 'hang' },
    toolName: 'Bash',
    toolUseId: 'use-1',
    transcriptPath: '/workspace/transcript.json',
  };

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(sourceRoot, 'check-command.ts'), [
        "import { spawn } from 'node:child_process';",
        "import { writeFile } from 'node:fs/promises';",
        "process.on('SIGTERM', () => process.stderr.write('ignored TERM\\n'));",
        "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], { stdio: 'inherit' });",
        "if (process.env.AGENT_BUNDLE_HOOK_TREE_TEST_PID !== undefined) await writeFile(process.env.AGENT_BUNDLE_HOOK_TREE_TEST_PID, String(descendant.pid), 'utf8');",
        'setInterval(() => undefined, 1_000);',
        'export default () => new Promise(() => undefined);',
        '',
      ].join('\n')),
    ]);
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });
    await cp(outputRoot, artifact, { recursive: true });
    process.env.AGENT_BUNDLE_HOOK_TREE_TEST_PID = descendantPidPath;

    const timedOut = service.simulate({
      artifact,
      hook: base.hooks[1]!.id,
      input,
      target: 'codex',
    });
    const settlement = await Promise.race([
      timedOut.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ error, status: 'rejected' as const }),
      ),
      new Promise<{ readonly status: 'overdue' }>((resolvePromise) => {
        setTimeout(() => resolvePromise({ status: 'overdue' }), 2_000);
      }),
    ]);
    if (settlement.status === 'overdue') {
      if (process.platform !== 'win32') {
        const descendantPid = Number(await readFile(descendantPidPath, 'utf8'));
        process.kill(descendantPid, 'SIGKILL');
      }
      await timedOut.catch(() => undefined);
      throw new Error('Hook simulation did not settle after its wrapper was terminated because a descendant retained its pipes.');
    }
    if (settlement.status === 'resolved') throw new Error('Expected timed-out hook simulation to reject.');
    expect(settlement.error).toBeInstanceOf(Error);
    expect((settlement.error as Error).message).toBe('Hook simulation timed out.');

    const controller = new AbortController();
    const pending = service.simulate({
      artifact,
      hook: base.hooks[1]!.id,
      input,
      signal: controller.signal,
      target: 'codex',
    });
    setTimeout(() => controller.abort(), 25);
    const cancellation = await pending.catch((error: unknown) => error);
    expect(cancellation).toMatchObject({
      code: 'hook.simulation.aborted',
      message: 'Hook simulation aborted.',
      name: 'AbortError',
    });
    expect(isHookSimulationCancellation(cancellation)).toBe(true);

    let taskkillCalls = 0;
    const failedWindowsTaskkill = new HookService({
      platform: 'win32',
      taskkill: () => {
        taskkillCalls += 1;
        const command = new EventEmitter() as ChildProcess;
        setImmediate(() => { command.emit('close', 1); });
        return command;
      },
    });
    await expect(failedWindowsTaskkill.simulate({
      artifact,
      hook: base.hooks[1]!.id,
      input,
      target: 'codex',
    })).rejects.toMatchObject({ code: 'hook.simulation.termination.unsettled' });
    expect(taskkillCalls).toBeGreaterThan(0);
    const descendantPid = Number(await readFile(descendantPidPath, 'utf8'));
    try {
      process.kill(descendantPid, 'SIGKILL');
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  } finally {
    if (previousDescendantPidPath === undefined) delete process.env.AGENT_BUNDLE_HOOK_TREE_TEST_PID;
    else process.env.AGENT_BUNDLE_HOOK_TREE_TEST_PID = previousDescendantPidPath;
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(consumer, { force: true, recursive: true }),
    ]);
  }
}, 10_000);

it('waits for an admitted Windows taskkill cleanup after its wrapper leader closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-service-windows-termination-'));
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-service-windows-termination-consumer-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const artifact = join(consumer, 'installed-plugin');
  const startedPath = join(root, 'started');
  const base = hookModel(root);
  const model: NormalizedPlugin = {
    ...base,
    hooks: [{ ...base.hooks[0]!, targets: ['codex'] }],
    targets: [base.targets[0]!],
  };
  const previousStartedPath = process.env.AGENT_BUNDLE_HOOK_SIMULATION_STARTED_PATH;
  let taskkillCommand: EventEmitter | undefined;
  let taskkillPid: number | undefined;
  let resolveTaskkillStarted: (() => void) | undefined;
  const taskkillStarted = new Promise<void>((resolvePromise) => { resolveTaskkillStarted = resolvePromise; });
  const service = new HookService({
    platform: 'win32',
    taskkill: (arguments_) => {
      taskkillPid = Number(arguments_[1]);
      taskkillCommand = new EventEmitter();
      resolveTaskkillStarted?.();
      return taskkillCommand as ChildProcess;
    },
  });

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(sourceRoot, 'session-start.ts'), [
        "import { writeFile } from 'node:fs/promises';",
        "process.once('SIGTERM', () => process.exit(0));",
        "export default async () => {",
        "  await writeFile(process.env.AGENT_BUNDLE_HOOK_SIMULATION_STARTED_PATH!, 'started', 'utf8');",
        '  setInterval(() => undefined, 1_000);',
        '  return new Promise(() => undefined);',
        '};',
        '',
      ].join('\n')),
    ]);
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });
    await cp(outputRoot, artifact, { recursive: true });
    process.env.AGENT_BUNDLE_HOOK_SIMULATION_STARTED_PATH = startedPath;

    const controller = new AbortController();
    let settled = false;
    const pending = service.simulate({
      artifact,
      hook: base.hooks[0]!.id,
      input: { cwd: '/workspace', sessionId: 'session-1', source: 'startup', transcriptPath: '/workspace/transcript.json' },
      signal: controller.signal,
      target: 'codex',
    }).finally(() => { settled = true; });
    void pending.catch(() => undefined);
    await expect.poll(async () => readFile(startedPath, 'utf8'), { timeout: 2_000 }).toBe('started');

    controller.abort();
    await taskkillStarted;
    process.kill(taskkillPid!, 'SIGTERM');
    await expect.poll(() => {
      try {
        process.kill(taskkillPid!, 0);
        return true;
      } catch (error) {
        return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
      }
    }, { timeout: 2_000 }).toBe(false);
    await new Promise<void>((resolvePromise) => { setImmediate(resolvePromise); });
    expect(settled).toBe(false);

    taskkillCommand!.emit('close', 1);
    await expect(pending).rejects.toMatchObject({ code: 'hook.simulation.termination.unsettled' });
  } finally {
    if (previousStartedPath === undefined) delete process.env.AGENT_BUNDLE_HOOK_SIMULATION_STARTED_PATH;
    else process.env.AGENT_BUNDLE_HOOK_SIMULATION_STARTED_PATH = previousStartedPath;
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(consumer, { force: true, recursive: true }),
    ]);
  }
}, 10_000);

it('compiles each native hook through a virtual Rslib entry without sibling chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-build-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const repeatedOutputRoot = join(root, 'dist-repeat');
  const model = hookModel(root);
  const names = model.hooks.map((hook) => hook.name).sort();

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(sourceRoot, 'shared.ts'), "export const context = 'compiled from local TypeScript';\n"),
      ...model.hooks.map((hook) => writeFile(
        hook.source,
        [
          "import { context } from './shared.ts';",
          'export default (event: Record<string, unknown>) => ({',
          "  additionalContext: `${context}:${String(event.hookEventName ?? '')}` ,",
          "  outcome: 'continue' as const,",
          '});',
          '',
        ].join('\n'),
      )),
    ]);

    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });
    await build({ model, outputRoot: repeatedOutputRoot, projectRoot: root, registry: createDefaultRegistry() });

    const hookIndex = await readFile(join(outputRoot, 'agent-bundle.hooks.json'), 'utf8');
    expect(await readFile(join(repeatedOutputRoot, 'agent-bundle.hooks.json'), 'utf8')).toBe(hookIndex);

    for (const target of ['codex', 'claude']) {
      const hooksRoot = join(outputRoot, target, 'hooks');
      expect((await readdir(hooksRoot)).filter((name) => name.endsWith('.mjs')).sort()).toEqual(
        names.map((name) => `${name}.mjs`),
      );
      for (const name of names) {
        const wrapper = await readFile(join(hooksRoot, `${name}.mjs`), 'utf8');
        expect(wrapper).toContain('compiled from local TypeScript');
        expect(wrapper).not.toMatch(/from\s+['"](?:agent-bundle|@rstackjs\/|@rspack\/)[^'"]*['"]/);
      }
    }
    expect(await readdir(join(root, 'src', 'hooks'))).toEqual([
      'check-command.ts',
      'record.ts',
      'session-start.ts',
      'shared.ts',
      'stop.ts',
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('runs the embedded Codex and Claude native codecs through their published wrappers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-native-codecs-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const model = hookModel(root);

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(sourceRoot, 'session-start.ts'), "export default (event: { sessionId?: string }) => ({ outcome: 'continue' as const, additionalContext: event.sessionId });\n"),
      writeFile(join(sourceRoot, 'check-command.ts'), "export default (event: { toolName?: string }) => ({ outcome: event.toolName === 'Bash' ? 'deny' as const : 'continue' as const, reason: 'blocked command' });\n"),
      writeFile(join(sourceRoot, 'record.ts'), "export default (event: { toolResponse?: unknown }) => ({ outcome: 'continue' as const, additionalContext: String(event.toolResponse) });\n"),
      writeFile(join(sourceRoot, 'stop.ts'), "export default () => ({ outcome: 'continue' as const });\n"),
    ]);
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });

    for (const target of ['codex', 'claude']) {
      const hooksRoot = join(outputRoot, target, 'hooks');
      await expect(runNativeHook(join(hooksRoot, 'session-start-session-start-7ab7e8a5.mjs'), {
        cwd: '/workspace', hook_event_name: 'SessionStart', session_id: 'session-1', source: 'startup', transcript_path: '/workspace/transcript.json',
      })).resolves.toEqual({
        code: 0,
        stderr: '',
        stdout: '{"hookSpecificOutput":{"additionalContext":"session-1","hookEventName":"SessionStart"}}',
      });
      await expect(runNativeHook(join(hooksRoot, 'before-tool-check-command-1f5b5818.mjs'), {
        cwd: '/workspace', hook_event_name: 'PreToolUse', session_id: 'session-1', tool_input: { command: 'blocked' }, tool_name: 'Bash', tool_use_id: 'use-1', transcript_path: '/workspace/transcript.json',
      })).resolves.toEqual({
        code: 0,
        stderr: '',
        stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked command"}}',
      });
      await expect(runNativeHook(join(hooksRoot, 'after-tool-record-87785f02.mjs'), {
        cwd: '/workspace', hook_event_name: 'PostToolUse', session_id: 'session-1', tool_input: {}, tool_response: { value: 'observed' }, tool_name: 'Write', tool_use_id: 'use-2', transcript_path: '/workspace/transcript.json',
      })).resolves.toEqual({
        code: 0,
        stderr: '',
        stdout: '{"hookSpecificOutput":{"additionalContext":"[object Object]","hookEventName":"PostToolUse"}}',
      });
      await expect(runNativeHook(join(hooksRoot, 'stop-stop-bb2d7935.mjs'), {
        cwd: '/workspace', hook_event_name: 'Stop', last_assistant_message: 'done', session_id: 'session-1', stop_hook_active: false, transcript_path: '/workspace/transcript.json',
      })).resolves.toEqual({ code: 0, stderr: '', stdout: '' });
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

it('runs the Cursor workspace/open lifecycle starter through a generated wrapper with empty stdout', async () => {
  const buildRoot = join(process.cwd(), 'examples', 'audiobook-curator');
  const fixtureParent = join(buildRoot, 'node_modules', '.cache');
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, 'agent-bundle-cursor-workspace-open-'));
  const sourceRoot = join(root, 'src', 'events', 'workspace');
  const outputRoot = join(root, 'dist', 'cursor');
  const wrapper = join(outputRoot, 'hooks', 'event-route-workspace-open.mjs');
  const base = hookModel(root);
  const model: NormalizedPlugin = {
    ...base,
    hooks: [{
      event: 'workspaceOpen',
      eventRoute: { event: 'workspace/open', fallback: 'none', runtime: 'standalone' },
      id: 'hook:event-route:workspace-open',
      name: 'event-route-workspace-open',
      provenance: { kind: 'conventional', sourcePath: join(sourceRoot, 'open.mjs') },
      source: join(sourceRoot, 'open.mjs'),
      targets: ['cursor'],
      tools: [],
    }],
    targets: [{
      id: 'target:cursor',
      name: 'cursor',
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
    }],
  };

  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'open.mjs'), [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      '',
      'export default async function WorkspaceOpen() {',
      '  return createElement(Agent.Result);',
      '}',
      '',
    ].join('\n'));
    const targetRegistry = createDefaultRegistry();
    const plan = targetRegistry.get('cursor').plan(model);
    const generated = plan.hookEntries?.find((entry) => entry.relativePath === 'hooks/event-route-workspace-open.mjs');
    const starter = targetRegistry.hookContract('cursor')?.nativeEventStarter?.('workspace/open');

    expect(plan.diagnostics).toEqual([]);
    expect(generated).toBeDefined();
    await compileHooks(plan.hookEntries ?? [], {
      artifactEpoch: 'cursor-workspace-open-test',
      cwd: buildRoot,
      meta: projectMeta(model.metadata),
      outDir: outputRoot,
      plugin: { name: model.metadata.name, version: model.metadata.version },
    });
    expect(starter).toEqual({
      cursor_version: 'lifecycle-replay',
      hook_event_name: 'workspaceOpen',
      user_email: null,
      workspace_roots: ['/tmp'],
    });
    await expect(runNativeHook(wrapper, starter!)).resolves.toEqual({
      code: 0,
      stderr: '',
      stdout: '',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

it('round-trips Claude and Codex subagent fields through published wrappers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-subagent-hook-codecs-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const base = hookModel(root);
  const model: NormalizedPlugin = {
    ...base,
    hooks: [
      {
        ...base.hooks[0]!,
        event: 'agentStart',
        id: 'hook:agent-start:subagent-start',
        name: 'subagent-start',
        source: join(sourceRoot, 'subagent-start.ts'),
      },
      {
        ...base.hooks[3]!,
        event: 'agentStop',
        id: 'hook:agent-stop:subagent-stop',
        name: 'subagent-stop',
        source: join(sourceRoot, 'subagent-stop.ts'),
      },
    ],
  };

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(
        join(sourceRoot, 'subagent-start.ts'),
        "export default (event: Record<string, unknown>) => ({ outcome: 'continue' as const, additionalContext: `${String(event.sessionId)}:${String(event.agentId)}:${String(event.agentType)}:${String(event.turnId)}` });\n",
      ),
      writeFile(
        join(sourceRoot, 'subagent-stop.ts'),
        "export default (event: Record<string, unknown>) => ({ outcome: 'deny' as const, reason: `${String(event.agentTranscriptPath)}:${String(event.stopHookActive)}:${String(event.lastAssistantMessage)}` });\n",
      ),
    ]);
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });

    for (const target of ['codex', 'claude'] as const) {
      const manifest = JSON.parse(await readFile(join(outputRoot, target, 'hooks', 'hooks.json'), 'utf8')) as {
        readonly hooks: Readonly<Record<string, readonly unknown[]>>;
      };
      expect(manifest.hooks.SubagentStart).toHaveLength(1);
      expect(manifest.hooks.SubagentStop).toHaveLength(1);

      const startInput = JSON.parse(await readFile(
        new URL(`./fixtures/events/${target}-subagent-start.json`, import.meta.url),
        'utf8',
      )) as Record<string, unknown>;
      const stopInput = JSON.parse(await readFile(
        new URL(`./fixtures/events/${target}-subagent-stop.json`, import.meta.url),
        'utf8',
      )) as Record<string, unknown>;
      const expectedTurn = target === 'codex' ? 'turn-codex-1' : 'undefined';
      await expect(runNativeHook(join(outputRoot, target, 'hooks', 'subagent-start.mjs'), startInput)).resolves.toEqual({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          hookSpecificOutput: {
            additionalContext: `${String(startInput.session_id)}:${String(startInput.agent_id)}:${String(startInput.agent_type)}:${expectedTurn}`,
            hookEventName: 'SubagentStart',
          },
        }),
      });
      await expect(runNativeHook(join(outputRoot, target, 'hooks', 'subagent-stop.mjs'), stopInput)).resolves.toEqual({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          decision: 'block',
          reason: `${String(stopInput.agent_transcript_path)}:${String(stopInput.stop_hook_active)}:${String(stopInput.last_assistant_message)}`,
        }),
      });
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

it('rejects malformed event-specific native input before calling generated Codex and Claude hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-native-input-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const model = hookModel(root);
  const common = { cwd: '/workspace', session_id: 'session-1', transcript_path: '/workspace/transcript.json' };

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      ...model.hooks.map((hook) => writeFile(hook.source, 'export default () => undefined;\n')),
    ]);
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });

    for (const target of ['codex', 'claude']) {
      const hooksRoot = join(outputRoot, target, 'hooks');
      await expect(runNativeHook(join(hooksRoot, 'session-start-session-start-7ab7e8a5.mjs'), {})).resolves.toEqual({
        code: 1,
        stderr: 'Agent Bundle hook error: native session_id must be a string\n',
        stdout: '',
      });
      await expect(runNativeHook(join(hooksRoot, 'session-start-session-start-7ab7e8a5.mjs'), {
        ...common, hook_event_name: 'SessionStart',
      })).resolves.toEqual({
        code: 1,
        stderr: 'Agent Bundle hook error: native source must be a string\n',
        stdout: '',
      });
      await expect(runNativeHook(join(hooksRoot, 'before-tool-check-command-1f5b5818.mjs'), {
        ...common, hook_event_name: 'PreToolUse', tool_input: [], tool_name: 'Bash', tool_use_id: 'use-1',
      })).resolves.toEqual({
        code: 1,
        stderr: 'Agent Bundle hook error: native PreToolUse tool_input must be an object\n',
        stdout: '',
      });
      await expect(runNativeHook(join(hooksRoot, 'after-tool-record-87785f02.mjs'), {
        ...common, hook_event_name: 'PostToolUse', tool_input: {}, tool_name: 'Write', tool_response: 'observed', tool_use_id: 'use-2',
      })).resolves.toEqual({
        code: 1,
        stderr: 'Agent Bundle hook error: native PostToolUse tool_response must be an object\n',
        stdout: '',
      });
      await expect(runNativeHook(join(hooksRoot, 'stop-stop-bb2d7935.mjs'), {
        ...common, hook_event_name: 'Stop', last_assistant_message: 'done', stop_hook_active: 'false',
      })).resolves.toEqual({
        code: 1,
        stderr: 'Agent Bundle hook error: native Stop stop_hook_active must be a boolean\n',
        stdout: '',
      });
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

it('rejects canonical reason combinations whose selected native hook cannot represent them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-result-fields-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const base = hookModel(root);
  const model: NormalizedPlugin = {
    ...base,
    hooks: [
      { ...base.hooks[0]!, id: 'hook:session-start:reason:00000001', name: 'session-reason-00000001', source: join(sourceRoot, 'session.ts'), targets: ['codex'] },
      { ...base.hooks[1]!, id: 'hook:before-tool:allow-reason:00000002', name: 'before-allow-reason-00000002', source: join(sourceRoot, 'before-allow.ts'), targets: ['codex'] },
      { ...base.hooks[1]!, id: 'hook:before-tool:deny-reason:00000003', name: 'before-deny-reason-00000003', source: join(sourceRoot, 'before-deny.ts'), targets: ['codex'] },
      { ...base.hooks[2]!, id: 'hook:after-tool:reason:00000004', name: 'after-reason-00000004', source: join(sourceRoot, 'after.ts'), targets: ['codex'] },
      { ...base.hooks[3]!, id: 'hook:stop:continue-reason:00000005', name: 'stop-continue-reason-00000005', source: join(sourceRoot, 'stop-continue.ts'), targets: ['codex'] },
      { ...base.hooks[3]!, id: 'hook:stop:deny-reason:00000006', name: 'stop-deny-reason-00000006', source: join(sourceRoot, 'stop-deny.ts'), targets: ['codex'] },
    ],
  };
  const common = { cwd: '/workspace', session_id: 'session-1', transcript_path: '/workspace/transcript.json' };

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(sourceRoot, 'session.ts'), "export default () => ({ outcome: 'continue' as const, reason: 'ignored' });\n"),
      writeFile(join(sourceRoot, 'before-allow.ts'), "export default () => ({ outcome: 'continue' as const, reason: 'ignored' });\n"),
      writeFile(join(sourceRoot, 'before-deny.ts'), "export default () => ({ outcome: 'deny' as const });\n"),
      writeFile(join(sourceRoot, 'after.ts'), "export default () => ({ outcome: 'continue' as const, reason: 'ignored' });\n"),
      writeFile(join(sourceRoot, 'stop-continue.ts'), "export default () => ({ outcome: 'continue' as const, reason: 'ignored' });\n"),
      writeFile(join(sourceRoot, 'stop-deny.ts'), "export default () => ({ outcome: 'deny' as const, reason: '' });\n"),
    ]);
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });
    const hooksRoot = join(outputRoot, 'codex', 'hooks');
    const assertions: readonly [string, Record<string, unknown>, string][] = [
      ['session-reason-00000001.mjs', { ...common, hook_event_name: 'SessionStart', source: 'startup' }, 'reason is only valid for a denied beforeTool, stop, or agentStop hook'],
      ['before-allow-reason-00000002.mjs', { ...common, hook_event_name: 'PreToolUse', tool_input: {}, tool_name: 'Bash', tool_use_id: 'use-1' }, 'reason is only valid for a denied beforeTool, stop, or agentStop hook'],
      ['before-deny-reason-00000003.mjs', { ...common, hook_event_name: 'PreToolUse', tool_input: {}, tool_name: 'Bash', tool_use_id: 'use-2' }, 'denied beforeTool hook requires a nonempty reason'],
      ['after-reason-00000004.mjs', { ...common, hook_event_name: 'PostToolUse', tool_input: {}, tool_name: 'Write', tool_response: {}, tool_use_id: 'use-3' }, 'reason is only valid for a denied beforeTool, stop, or agentStop hook'],
      ['stop-continue-reason-00000005.mjs', { ...common, hook_event_name: 'Stop', last_assistant_message: 'done', stop_hook_active: false }, 'reason is only valid for a denied beforeTool, stop, or agentStop hook'],
      ['stop-deny-reason-00000006.mjs', { ...common, hook_event_name: 'Stop', last_assistant_message: 'done', stop_hook_active: false }, 'denied stop hook requires a nonempty reason'],
    ];
    for (const [name, input, message] of assertions) {
      await expect(runNativeHook(join(hooksRoot, name), input)).resolves.toEqual({
        code: 1,
        stderr: `Agent Bundle hook error: ${message}\n`,
        stdout: '',
      });
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

it('rejects malformed native hook input, exports, and handler results concisely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-errors-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const base = hookModel(root);
  const model: NormalizedPlugin = {
    ...base,
    hooks: [
      { ...base.hooks[0]!, id: 'hook:session-start:valid:00000001', name: 'valid-00000001', source: join(sourceRoot, 'valid.ts'), targets: ['codex'] },
      { ...base.hooks[0]!, id: 'hook:session-start:export:00000002', name: 'export-00000002', source: join(sourceRoot, 'no-default.ts'), targets: ['codex'] },
      { ...base.hooks[0]!, id: 'hook:session-start:result:00000003', name: 'result-00000003', source: join(sourceRoot, 'bad-result.ts'), targets: ['codex'] },
    ],
    targets: [base.targets[0]!],
  };

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(sourceRoot, 'valid.ts'), 'export default () => undefined;\n'),
      writeFile(join(sourceRoot, 'no-default.ts'), 'export const value = true;\n'),
      writeFile(join(sourceRoot, 'bad-result.ts'), "export default () => 'not a result';\n"),
    ]);
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });

    await expect(runPublishedHook(join(outputRoot, 'codex', 'hooks', 'valid-00000001.mjs'), '{not json')).resolves.toEqual({
      code: 1,
      stderr: 'Agent Bundle hook error: stdin must contain exactly one JSON value\n',
      stdout: '',
    });
    await expect(runPublishedHook(join(outputRoot, 'codex', 'hooks', 'export-00000002.mjs'), '{}')).resolves.toEqual({
      code: 1,
      stderr: 'Agent Bundle hook error: default export must be a function\n',
      stdout: '',
    });
    await expect(runPublishedHook(join(outputRoot, 'codex', 'hooks', 'result-00000003.mjs'), JSON.stringify({
      cwd: '/workspace', hook_event_name: 'SessionStart', session_id: 'session-1', source: 'startup', transcript_path: '/workspace/transcript.json',
    }))).resolves.toEqual({
      code: 1,
      stderr: 'Agent Bundle hook error: handler must return void or a result object\n',
      stdout: '',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

const hookModel = (root: string): NormalizedPlugin => ({
  extensions: {},
  hooks: [
    {
      event: 'sessionStart',
      id: 'hook:session-start:session-start:7ab7e8a5',
      name: 'session-start-session-start-7ab7e8a5',
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
      source: join(root, 'src', 'hooks', 'session-start.ts'),
      targets: ['claude', 'codex'],
      tools: [],
    },
    {
      event: 'beforeTool',
      id: 'hook:before-tool:check-command:1f5b5818',
      name: 'before-tool-check-command-1f5b5818',
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
      source: join(root, 'src', 'hooks', 'check-command.ts'),
      targets: ['claude', 'codex'],
      timeoutMs: 7_000,
      tools: ['shell'],
    },
    {
      event: 'afterTool',
      id: 'hook:after-tool:record:87785f02',
      name: 'after-tool-record-87785f02',
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
      source: join(root, 'src', 'hooks', 'record.ts'),
      targets: ['claude', 'codex'],
      tools: ['file.write'],
    },
    {
      event: 'stop',
      id: 'hook:stop:stop:bb2d7935',
      name: 'stop-stop-bb2d7935',
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
      source: join(root, 'src', 'hooks', 'stop.ts'),
      targets: ['claude', 'codex'],
      tools: [],
    },
  ],
  runtime: { node: '22.12.0' },
  mcpServers: [],
  metadata: {
    id: 'plugin:review-tools',
    name: 'review-tools',
    provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
    version: '1.0.0',
  },
  scripts: [],
  skills: [],
  targets: [
    { id: 'target:codex', name: 'codex', provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') } },
    { id: 'target:claude', name: 'claude', provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') } },
  ],
});

it('plans deterministic Codex and Claude hook configurations from the same model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-plan-'));

  try {
    const model = hookModel(root);
    const registry = createDefaultRegistry();
    const codex = registry.get('codex').plan(model);
    const claude = registry.get('claude').plan(model);
    const writes = (entries: readonly { readonly kind: string; readonly relativePath: string; readonly content?: string }[]) =>
      Object.fromEntries(entries.flatMap((entry) => entry.kind === 'write' ? [[entry.relativePath, entry.content]] : []));

    expect(JSON.parse(writes(codex.entries)['.codex-plugin/plugin.json']!)).toMatchObject({
      hooks: './hooks/hooks.json',
    });
    expect(JSON.parse(writes(claude.entries)['.claude-plugin/plugin.json']!)).toMatchObject({
      hooks: './hooks/hooks.json',
    });
    expect(JSON.parse(writes(codex.entries)['hooks/hooks.json']!)).toEqual({
      hooks: {
        PostToolUse: [{
          hooks: [{ command: 'node "${PLUGIN_ROOT}/hooks/after-tool-record-87785f02.mjs"', type: 'command' }],
          matcher: '^(?:apply_patch|Edit|Write)$',
        }],
        PreToolUse: [{
          hooks: [{ command: 'node "${PLUGIN_ROOT}/hooks/before-tool-check-command-1f5b5818.mjs"', timeout: 7, type: 'command' }],
          matcher: '^Bash$',
        }],
        SessionStart: [{ hooks: [{ command: 'node "${PLUGIN_ROOT}/hooks/session-start-session-start-7ab7e8a5.mjs"', type: 'command' }] }],
        Stop: [{ hooks: [{ command: 'node "${PLUGIN_ROOT}/hooks/stop-stop-bb2d7935.mjs"', type: 'command' }] }],
      },
    });
    expect(JSON.parse(writes(claude.entries)['hooks/hooks.json']!)).toMatchObject({
      hooks: {
        PostToolUse: [{ matcher: '^(?:Write|Edit)$' }],
        PreToolUse: [{ matcher: '^Bash$' }],
      },
    });
    expect(Reflect.get(codex, 'hookEntries')).toMatchObject([
      { relativePath: 'hooks/session-start-session-start-7ab7e8a5.mjs' },
      { relativePath: 'hooks/before-tool-check-command-1f5b5818.mjs' },
      { relativePath: 'hooks/after-tool-record-87785f02.mjs' },
      { relativePath: 'hooks/stop-stop-bb2d7935.mjs' },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('normalizes a mixed hook fixture and reports malformed hook declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-contract-'));
  const configPath = join(root, 'agent-bundle.config.ts');
  const loaded: LoadedConfig = {
    config: {
      hooks: {
        afterTool: {
          handler: './src/hooks/record.ts',
          tools: ['file.write', 'shell', 'file.write'],
        },
        beforeTool: [
          { handler: './src/hooks/check-command.ts', targets: ['codex', 'claude', 'codex'], timeout: 7, tools: ['shell', 'shell'] },
          { handler: './src/hooks/check-command.ts', targets: ['claude', 'codex'], timeout: 7, tools: ['shell'] },
        ],
        sessionStart: './src/hooks/session-start.ts',
        stop: './src/hooks/stop.ts',
      },
      plugin: { name: 'review-tools', version: '1.0.0' },
    },
    configPath,
    context: { command: 'build', mode: 'production', projectRoot: root, selectedTargets: [] },
  };
  const invalid: LoadedConfig = {
    ...loaded,
    config: {
      ...loaded.config,
      hooks: {
        afterTool: { handler: './src/hooks/record.ts', tools: ['unknown-tool'] },
        beforeTool: { handler: './src/hooks/check-command.ts', targets: ['portable', ''] },
        sessionStart: { tools: ['shell'] } as unknown as { handler: string },
      },
    },
  };

  try {
    const model = await normalizeProject(loaded, { skills: [] }, registry);

    expect(model.hooks.map((hook) => ({
      event: hook.event,
      name: hook.name,
      targets: hook.targets,
      timeoutMs: hook.timeoutMs,
      tools: hook.tools,
    // Normalization orders hooks by their stable id, not by declaration
    // order, so mixed configured and conventional hooks emit deterministically.
    }))).toEqual([
      {
        event: 'afterTool',
        name: 'after-tool-record-87785f02',
        targets: ['claude', 'codex'],
        timeoutMs: undefined,
        tools: ['file.write', 'shell'],
      },
      {
        event: 'beforeTool',
        name: 'before-tool-check-command-1f5b5818',
        targets: ['claude', 'codex'],
        timeoutMs: 7_000,
        tools: ['shell'],
      },
      {
        event: 'beforeTool',
        name: 'before-tool-check-command-1f5b5818',
        targets: ['claude', 'codex'],
        timeoutMs: 7_000,
        tools: ['shell'],
      },
      {
        event: 'sessionStart',
        name: 'session-start-session-start-7ab7e8a5',
        targets: ['claude', 'codex'],
        timeoutMs: undefined,
        tools: [],
      },
      {
        event: 'stop',
        name: 'stop-stop-bb2d7935',
        targets: ['claude', 'codex'],
        timeoutMs: undefined,
        tools: [],
      },
    ]);
    expect(validateModel(model, registry).map((diagnostic) => diagnostic.code)).toContain('AB4101');
    expect(validateSource(invalid, { skills: [] }, registry).map((diagnostic) => diagnostic.code)).toEqual([
      'AB4200',
      'AB4201',
      'AB4204',
      'AB4203',
      'AB4202',
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
