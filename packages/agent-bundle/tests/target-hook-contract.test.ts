import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  planHooks,
  readStandardNativeHookCommands,
  readTargetNativeHookCommands,
  type TargetHookContract,
} from '../src/adapters/hook-contract.ts';
import { TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import type { NormalizedHook, NormalizedPlugin } from '../src/core/types.ts';
import { build } from './support/build.ts';

const metadata = Object.freeze({
  adapterRevision: 'test',
  capabilityRevision: 'test',
  capabilitySha256: '0'.repeat(64),
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
    capabilities: { hooks: true },
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
    validateModel: () => [],
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
    });

    expect(result.compiledHooks[0]).toMatchObject({ target: 'synthetic' });
    const wrapper = join(outputRoot, 'synthetic', 'runtime', 'synthetic-before-tool.mjs');
    await expect(readFile(wrapper, 'utf8')).resolves.toContain('synthetic-wrapper-marker');
    await expect(runWrapper(wrapper)).resolves.toBe('synthetic-wrapper-marker:{"nativeEvent":"SyntheticBeforeWrite"}');
    await expect(readFile(join(outputRoot, 'synthetic', 'native-events', 'registration.json'), 'utf8')
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
