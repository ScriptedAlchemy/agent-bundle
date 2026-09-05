import { supportedCapabilities } from './support/adapter-capabilities.ts';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  canonicalHookEventFor,
  planHooks,
  readStandardNativeHookCommands,
  readTargetNativeHookCommands,
  type TargetHookContract,
} from '../src/adapters/hook-contract.ts';
import { TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import { normalizeProject, type NormalizationTargetRegistry } from '../src/config/index.ts';
import type { AgentBundleConfig, NormalizedHook, NormalizedPlugin } from '../src/core/types.ts';
import { build } from './support/build.ts';
import { emptyCompiledRouteGraph } from '../src/routes/graph.ts';

const metadata = Object.freeze({
  adapterRevision: 'test',
  observedVersion: 'test',
  schemas: Object.freeze([]),
});

const playgroundCodec = Object.freeze({
  encodePlaygroundInput: (input: Readonly<Record<string, unknown>>) => input,
  encodePlaygroundOutput: (result: Readonly<Record<string, unknown>> | undefined) => result,
});

const planningModel = (hooks: readonly NormalizedHook[]): NormalizedPlugin => ({
  extensions: {},
  hooks,
  mcpServers: [],
  metadata: {
    id: 'plugin:synthetic',
    name: 'synthetic',
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    version: '1.0.0',
  },
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [],
  targets: [{
    id: 'target:synthetic',
    name: 'synthetic',
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
  }],
});

const planningHook = (
  event: NormalizedHook['event'],
  tools: NormalizedHook['tools'],
): NormalizedHook => ({
  event,
  id: `hook:${event}`,
  name: event,
  provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
  source: `/workspace/src/${event}.ts`,
  targets: ['synthetic'],
  tools,
});

const runWrapper = async (wrapper: string): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [wrapper], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(stderr));
    });
  });

it('keeps event-route-only hook identities out of config hook parsing', () => {
  expect(canonicalHookEventFor('sessionStart')).toBe('sessionStart');
  expect(canonicalHookEventFor('sessionEnd')).toBeUndefined();
  expect(canonicalHookEventFor('promptSubmit')).toBeUndefined();
  expect(canonicalHookEventFor('toolFailure')).toBeUndefined();
  expect(canonicalHookEventFor('compactBefore')).toBeUndefined();
  expect(canonicalHookEventFor('compactAfter')).toBeUndefined();
});

it('plans route-only hook identities through event route mappings', () => {
  const hook: NormalizedHook = {
    ...planningHook('promptSubmit', []),
    eventRoute: { event: 'prompt/submit', fallback: 'none', runtime: 'shared' },
  };
  const plan = planHooks(planningModel([hook]), 'synthetic', {
    commandRoot: '${SYNTHETIC_PLUGIN_ROOT}',
    ...playgroundCodec,
    eventNames: {},
    eventRouteNames: { 'prompt/submit': 'SyntheticPromptSubmit' },
    manifestPath: 'native-events/registration.json',
    matchers: {},
    wrapperPath: (candidate) => `hooks/${candidate.name}.mjs`,
    wrapperSource: () => 'config-hook-only\n',
  });

  expect(plan.diagnostics).toEqual([]);
  expect(plan.document).toEqual({
    hooks: {
      SyntheticPromptSubmit: [{
        hooks: [{
          command: 'node "${SYNTHETIC_PLUGIN_ROOT}/hooks/promptSubmit.mjs"',
          type: 'command',
        }],
      }],
    },
  });
});

it('snapshots target-native hook commands through the contract gateway', () => {
  const contract = {
    commandRoot: '${SYNTHETIC_PLUGIN_ROOT}',
    ...playgroundCodec,
    eventNames: {
      afterTool: 'SyntheticAfterTool',
      beforeTool: 'SyntheticBeforeTool',
      sessionStart: 'SyntheticSessionStart',
      stop: 'SyntheticStop',
    },
    manifestPath: 'native-events/registration.json',
    matchers: {},
    readNativeCommands: () => ({
      commands: [{ command: 'echo native' }, { command: 'node "${SYNTHETIC_PLUGIN_ROOT}/hooks/start.mjs"' }],
      status: 'found' as const,
    }),
    wrapperPath: (hook: NormalizedHook) => `hooks/${hook.name}.mjs`,
    wrapperSource: () => 'export default undefined;\n',
  } satisfies TargetHookContract;

  const result = readTargetNativeHookCommands(contract, { nonstandard: true });
  expect(result).toEqual({
    commands: [{ command: 'echo native' }, { command: 'node "${SYNTHETIC_PLUGIN_ROOT}/hooks/start.mjs"' }],
    status: 'found',
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(result.status === 'found' && Object.isFrozen(result.commands)).toBe(true);
  expect(readTargetNativeHookCommands({ ...contract, readNativeCommands: () => null as never }, {})).toEqual({ status: 'invalid' });
});

it('rejects malformed custom native hook command results', () => {
  const commands = [{ command: 'echo native' }];
  Object.defineProperty(commands, Symbol('extra'), { value: true });
  const contract = {
    commandRoot: '${SYNTHETIC_PLUGIN_ROOT}',
    ...playgroundCodec,
    eventNames: { afterTool: 'After', beforeTool: 'Before', sessionStart: 'Start', stop: 'Stop' },
    manifestPath: 'native-events/registration.json',
    matchers: {},
    readNativeCommands: () => ({ commands, status: 'found' as const }),
    wrapperPath: (hook: NormalizedHook) => `hooks/${hook.name}.mjs`,
    wrapperSource: () => 'export default undefined;\n',
  } satisfies TargetHookContract;

  expect(readTargetNativeHookCommands(contract, {})).toEqual({ status: 'invalid' });
});

it('builds adapter-owned native hook event, layout, and wrapper source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-target-hook-contract-'));
  const outputRoot = join(root, 'dist');
  const configPath = join(root, 'agent-bundle.config.ts');
  const source = join(root, 'src', 'hook.ts');
  const hook = {
    event: 'beforeTool' as const,
    id: 'hook:before-tool:synthetic',
    name: 'synthetic-before-tool',
    provenance: { kind: 'config' as const, sourcePath: configPath },
    source,
    targets: ['synthetic'],
    tools: ['file.write' as const],
  };
  const model: NormalizedPlugin = {
    extensions: {},
    hooks: [hook],
    mcpServers: [],
    metadata: {
      id: 'plugin:synthetic',
      name: 'synthetic',
      provenance: { kind: 'config', sourcePath: configPath },
      version: '1.0.0',
    },
    runtime: { node: '22.12.0' },
    scripts: [],
    skills: [],
    targets: [{
      id: 'target:synthetic',
      name: 'synthetic',
      provenance: { kind: 'config', sourcePath: configPath },
    }],
  };
  const contract = {
    commandRoot: '${SYNTHETIC_PLUGIN_ROOT}',
    ...playgroundCodec,
    eventNames: {
      afterTool: 'SyntheticAfterTool',
      beforeTool: 'SyntheticBeforeWrite',
      sessionStart: 'SyntheticSessionStart',
      stop: 'SyntheticStop',
    },
    manifestPath: 'native-events/registration.json',
    matchers: { 'file.write': '^SyntheticWrite$' },
    readNativeCommands: readStandardNativeHookCommands,
    wrapperPath: (selectedHook) => `runtime/${selectedHook.name}.mjs`,
    wrapperSource: (entry) => [
      `import handler from ${JSON.stringify(entry.hook.source)};`,
      `const result = await handler({ nativeEvent: ${JSON.stringify(entry.nativeEvent)} });`,
      'process.stdout.write(`synthetic-wrapper-marker:${JSON.stringify(result)}`);',
      '',
    ].join('\n'),
  } satisfies TargetHookContract;
  const staleTargetContract = { ...contract, target: 'contract-target' };
  const adapter: TargetAdapter = {
    artifactLayout: { hookWrappers: { allowedSuffixes: ['.mjs'], directory: 'runtime' } },
    capabilities: supportedCapabilities('hooks'),
    hookContract: contract,
    metadata,
    name: 'synthetic',
    plan: (selectedModel) => {
      const generated = planHooks(selectedModel, 'synthetic', staleTargetContract);
      return {
        diagnostics: generated.diagnostics,
        entries: generated.document === undefined ? [] : [{
          content: `${JSON.stringify(generated.document)}\n`,
          kind: 'write' as const,
          relativePath: contract.manifestPath,
          sourceInputs: [configPath],
        }],
        hookEntries: generated.hookEntries,
      };
    },
  };

  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await Promise.all([
      writeFile(configPath, 'export default {};\n'),
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(source, 'export default ({ nativeEvent }) => ({ nativeEvent });\n'),
    ]);

    const result = await build({
      model,
      outputRoot,
      projectRoot: root,
      registry: new TargetRegistry().register(adapter, { default: true }),
      routeGraph: emptyCompiledRouteGraph,
    });

    expect(result.compiledHooks[0]).toMatchObject({ target: 'synthetic' });
    const wrapper = join(outputRoot, 'runtime', 'synthetic-before-tool.mjs');
    await expect(readFile(wrapper, 'utf8')).resolves.toContain('synthetic-wrapper-marker');
    await expect(runWrapper(wrapper)).resolves.toBe('synthetic-wrapper-marker:{"nativeEvent":"SyntheticBeforeWrite"}');
    await expect(readFile(join(outputRoot, 'native-events', 'registration.json'), 'utf8')
      .then(JSON.parse)).resolves.toEqual({
      hooks: {
        SyntheticBeforeWrite: [{
          hooks: [{
            command: 'node "${SYNTHETIC_PLUGIN_ROOT}/runtime/synthetic-before-tool.mjs"',
            type: 'command',
          }],
          matcher: '^SyntheticWrite$',
        }],
      },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects missing and blank native event mappings before creating hook entries', () => {
  const missingEventMapping = {
    afterTool: 'SyntheticAfterTool',
    beforeTool: 'SyntheticBeforeTool',
    sessionStart: 'SyntheticSessionStart',
    stop: 'SyntheticStop',
  } satisfies TargetHookContract['eventNames'];
  Reflect.deleteProperty(missingEventMapping, 'beforeTool');
  const eventMappings = [
    missingEventMapping,
    {
      afterTool: 'SyntheticAfterTool',
      beforeTool: '',
      sessionStart: 'SyntheticSessionStart',
      stop: 'SyntheticStop',
    },
  ];

  for (const eventNames of eventMappings) {
    const plan = planHooks(planningModel([planningHook('beforeTool', [])]), 'synthetic', {
      commandRoot: '${SYNTHETIC_PLUGIN_ROOT}',
      ...playgroundCodec,
      eventNames,
      manifestPath: 'native-events/registration.json',
      matchers: {},
      readNativeCommands: () => ({ commands: [], status: 'found' as const }),
      wrapperPath: (hook) => `hooks/${hook.name}.mjs`,
      wrapperSource: () => 'export default undefined;\n',
    });

    expect(plan.diagnostics).toEqual([{
      code: 'synthetic.hook.event.before-tool',
      message: 'synthetic cannot map canonical hook event "beforeTool".',
      severity: 'error',
      target: 'synthetic',
    }]);
    expect(plan.document).toBeUndefined();
    expect(plan.hookEntries).toEqual([]);
  }
});

it('plans a thin epoch-bound event-route client and keeps standalone execution explicit', () => {
  const contract: TargetHookContract = {
    hostContractRevision: 'synthetic-1',
    commandRoot: '${SYNTHETIC_PLUGIN_ROOT}',
    ...playgroundCodec,
    eventNames: {},
    eventRouteNames: { 'tool/after': 'SyntheticAfterTool' },
    manifestPath: 'native-events/registration.json',
    matchers: {},
    readNativeCommands: () => ({ commands: [], status: 'found' as const }),
    wrapperPath: (hook) => `hooks/${hook.name}.mjs`,
    wrapperSource: () => 'config-hook-only\n',
  };
  const shared: NormalizedHook = {
    ...planningHook('afterTool', []),
    eventRoute: { event: 'tool/after', fallback: 'none', runtime: 'shared' },
    timeoutMs: 1_250,
  };
  const sharedPlan = planHooks(planningModel([shared]), 'synthetic', contract);
  const sharedSource = sharedPlan.hookEntries[0]!.virtualSource;

  expect(sharedSource).toContain('requestEventRuntime');
  expect(sharedSource).toContain('__AGENT_BUNDLE_EVENT_ARTIFACT_EPOCH__');
  expect(sharedSource).toContain('hostContractRevision: capabilityRevision');
  expect(sharedSource).toContain('const timeoutMs = 1250;');
  expect(sharedSource).not.toContain('import * as routeModule');
  expect(sharedPlan.document).toMatchObject({
    hooks: {
      SyntheticAfterTool: [{
        hooks: [{ timeout: 2 }],
      }],
    },
  });

  const degraded: NormalizedHook = {
    ...shared,
    eventRoute: { event: 'tool/after', fallback: 'standalone', runtime: 'shared' },
  };
  const degradedSource = planHooks(planningModel([degraded]), 'synthetic', contract).hookEntries[0]!.virtualSource;
  expect(degradedSource).toContain('new URL(/* webpackIgnore: true */ "./hooks-flight.mjs", import.meta.url)');
  expect(degradedSource).toContain('createAgentRenderDispatcher');
  expect(degradedSource).toContain('projectEventDocument');
  expect(degradedSource).toContain('error.code === "runtime-unavailable"');
  expect(degradedSource).toContain('Array.isArray(native.workspace_roots)');
  expect(degradedSource).toContain('native.workspace_roots[0]');
  // Standalone lineage reads the Codex rollout the payload names (#423), so it is awaited.
  expect(degradedSource).toContain("resolveStandaloneLineage, runAgentRequest, unavailable } from '@agent-bundle/runtime'");
  expect(degradedSource).toContain('await resolveStandaloneLineage(target, native)');
  expect(degradedSource).not.toContain('import * as routeModule');
  expect(degradedSource).not.toContain('renderStandaloneEventRoute');
});

it('continues planning valid hooks after a prior hook mapping error', () => {
  const plan = planHooks(planningModel([
    planningHook('beforeTool', ['shell']),
    planningHook('afterTool', []),
  ]), 'synthetic', {
    commandRoot: '${SYNTHETIC_PLUGIN_ROOT}',
    ...playgroundCodec,
    eventNames: {
      afterTool: 'SyntheticAfterTool',
      beforeTool: 'SyntheticBeforeTool',
      sessionStart: 'SyntheticSessionStart',
      stop: 'SyntheticStop',
    },
    manifestPath: 'native-events/registration.json',
    matchers: {},
    readNativeCommands: () => ({ commands: [], status: 'found' as const }),
    wrapperPath: (hook) => `hooks/${hook.name}.mjs`,
    wrapperSource: () => 'export default undefined;\n',
  });

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['synthetic.hook.tool.shell']);
  expect(plan.document).toEqual({
    hooks: {
      SyntheticAfterTool: [{
        hooks: [{ command: 'node "${SYNTHETIC_PLUGIN_ROOT}/hooks/afterTool.mjs"', type: 'command' }],
      }],
    },
  });
  expect(plan.hookEntries.map((entry) => entry.event)).toEqual(['afterTool']);
});

const nativeSelectorContract = (matchers: TargetHookContract['matchers']): TargetHookContract => ({
  commandRoot: '${SYNTHETIC_PLUGIN_ROOT}',
  ...playgroundCodec,
  eventNames: {
    afterTool: 'SyntheticAfterTool',
    beforeTool: 'SyntheticBeforeTool',
    sessionStart: 'SyntheticSessionStart',
    stop: 'SyntheticStop',
  },
  manifestPath: 'native-events/registration.json',
  matchers,
  readNativeCommands: () => ({ commands: [], status: 'found' as const }),
  wrapperPath: (hook) => `hooks/${hook.name}.mjs`,
  wrapperSource: () => 'export default undefined;\n',
});

it('folds explicit host-native tool selectors into the target matcher with escaping', () => {
  const hook: NormalizedHook = {
    ...planningHook('beforeTool', ['shell']),
    nativeTools: [
      { name: 'WebSearch', target: 'synthetic' },
      { name: 'weird.tool+name', target: 'synthetic' },
      { name: 'ElsewhereOnly', target: 'other-host' },
    ],
  };

  const plan = planHooks(planningModel([hook]), 'synthetic', nativeSelectorContract({ shell: '^Bash$' }));

  expect(plan.diagnostics).toEqual([]);
  expect(plan.hookEntries[0]?.nativeMatcher).toBe(String.raw`(?:^Bash$|^WebSearch$|^weird\.tool\+name$)`);
});

it('rejects a target left without any applicable tool selector', () => {
  const hook: NormalizedHook = {
    ...planningHook('beforeTool', []),
    nativeTools: [{ name: 'ElsewhereOnly', target: 'other-host' }],
  };

  const plan = planHooks(planningModel([hook]), 'synthetic', nativeSelectorContract({}));

  expect(plan.diagnostics).toEqual([{
    code: 'synthetic.hook.tool.unselected',
    message: expect.stringContaining('receives no tool selector'),
    severity: 'error',
    target: 'synthetic',
  }]);
  expect(plan.hookEntries).toEqual([]);
});

it('keeps a mismatched native selector visible so normalized planning fails closed', async () => {
  const registry: NormalizationTargetRegistry = {
    configExtensions: () => [],
    defaultTargetNames: () => ['codex'],
    has: (name) => name === 'claude' || name === 'codex',
    supports: (_name, capability) => capability === 'hooks',
  };
  const config = {
    hooks: { beforeTool: { handler: './hooks/guard.ts', tools: ['claude:WebSearch'] } },
    plugin: { name: 'native-selector-fixture', version: '1.0.0' },
    targets: ['codex'],
  } satisfies AgentBundleConfig;
  const model = await normalizeProject({
    config,
    configPath: '/workspace/agent-bundle.config.ts',
    context: {
      command: 'build',
      mode: 'production',
      projectRoot: '/workspace',
      selectedTargets: [],
    },
  }, { skills: [] }, registry);

  const plan = planHooks(model, 'codex', nativeSelectorContract({}));

  expect(model.hooks[0]?.nativeTools).toEqual([{ name: 'WebSearch', target: 'claude' }]);
  expect(plan.diagnostics.map(({ code }) => code)).toEqual(['codex.hook.tool.unselected']);
  expect(plan.document).toBeUndefined();
  expect(plan.hookEntries).toEqual([]);
});
