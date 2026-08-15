import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { planHooks, type TargetHookContract } from '../src/adapters/hook-contract.ts';
import { TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import { build } from './support/build.ts';

const metadata = Object.freeze({
  adapterRevision: 'test',
  capabilityRevision: 'test',
  capabilitySha256: '0'.repeat(64),
  observedVersion: 'test',
  schemas: Object.freeze([]),
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
    eventNames: {
      afterTool: 'SyntheticAfterTool',
      beforeTool: 'SyntheticBeforeWrite',
      sessionStart: 'SyntheticSessionStart',
      stop: 'SyntheticStop',
    },
    manifestPath: 'native-events/registration.json',
    matchers: { 'file.write': '^SyntheticWrite$' },
    target: 'synthetic',
    wrapperPath: (selectedHook) => `runtime/native/${selectedHook.name}.mjs`,
    wrapperSource: (entry) => [
      `import handler from ${JSON.stringify(entry.hook.source)};`,
      `const result = await handler({ nativeEvent: ${JSON.stringify(entry.nativeEvent)} });`,
      'process.stdout.write(`synthetic-wrapper-marker:${JSON.stringify(result)}`);',
      '',
    ].join('\n'),
  } satisfies TargetHookContract;
  const adapter: TargetAdapter = {
    capabilities: { hooks: true },
    metadata,
    name: 'synthetic',
    plan: (selectedModel) => {
      const generated = planHooks(selectedModel, contract);
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

    await build({
      model,
      outputRoot,
      projectRoot: root,
      registry: new TargetRegistry().register(adapter, { default: true }),
    });

    const wrapper = join(outputRoot, 'synthetic', 'runtime', 'native', 'synthetic-before-tool.mjs');
    await expect(readFile(wrapper, 'utf8')).resolves.toContain('synthetic-wrapper-marker');
    await expect(runWrapper(wrapper)).resolves.toBe('synthetic-wrapper-marker:{"nativeEvent":"SyntheticBeforeWrite"}');
    await expect(readFile(join(outputRoot, 'synthetic', 'native-events', 'registration.json'), 'utf8')
      .then(JSON.parse)).resolves.toEqual({
      hooks: {
        SyntheticBeforeWrite: [{
          hooks: [{
            command: 'node "${SYNTHETIC_PLUGIN_ROOT}/runtime/native/synthetic-before-tool.mjs"',
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
