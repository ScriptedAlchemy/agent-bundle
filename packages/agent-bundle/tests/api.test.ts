import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { TargetRegistry, build, inspect, invokeMcp, listHooks, listMcp, simulateHook, validate } from '../src/api.ts';
import {
  nativeHookWrapperSource,
  planHooks,
  readStandardNativeHookCommands,
  type TargetHookContract,
} from '../src/adapters/hook-contract.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import { inspectArtifactFilesystem } from '../src/build/emit.ts';
import type { Diagnostic } from '../src/core/diagnostics.ts';
import { pathTokens, type NormalizedPlugin } from '../src/core/types.ts';
import { ProjectService } from '../src/dev/project-service.ts';
import {
  createTargetMcpRuntime,
  resolveTargetRelativeStdioArgument,
} from '../src/services/mcp-runtime.ts';
import { createMcpPathTokenResolver, standardMcpPathTokens } from '../src/services/mcp-path-tokens.ts';

const createProject = async (): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-api-parent-'));
  const root = join(parent, 'project with spaces');
  await mkdir(join(root, 'skills', 'review'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default ({ command, mode, projectRoot, selectedTargets }) => ({',
        "  plugin: { name: 'api-fixture', version: '1.0.0' },",
        '  targets: selectedTargets.length === 0 ? [\'codex\', \'claude\'] : selectedTargets,',
        "  hooks: { sessionStart: { handler: './src/hook.ts' } },",
        '  fixtureContext: { command, mode, projectRoot, selectedTargets },',
        '});',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(root, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Reviews changes\n---\n# Review\n',
    ),
    writeFile(join(root, 'src', 'hook.ts'), 'export default () => undefined;\n'),
  ]);
  return root;
};

const syntheticMetadata = Object.freeze({
  adapterRevision: 'test',
  capabilityRevision: 'test',
  capabilitySha256: '0'.repeat(64),
  observedVersion: 'test',
  schemas: Object.freeze([]),
});

const syntheticTarget = 'synthetic';
const syntheticHookContract = Object.freeze({
  commandRoot: '${PLUGIN_ROOT}',
  encodePlaygroundInput: (input) => input,
  encodePlaygroundOutput: (result) => result,
  eventNames: Object.freeze({
    afterTool: 'AfterTool',
    beforeTool: 'BeforeTool',
    sessionStart: 'SessionStart',
    stop: 'Stop',
  }),
  manifestPath: 'hooks/hooks.json',
  matchers: Object.freeze({}),
  readNativeCommands: readStandardNativeHookCommands,
  wrapperPath: (hook: NormalizedPlugin['hooks'][number]) => `hooks/${hook.name}.mjs`,
  wrapperSource: (entry) => nativeHookWrapperSource(entry, 'Codex'),
} satisfies TargetHookContract);
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

const syntheticPlan = (model: NormalizedPlugin) => {
  const hooks = planHooks(model, syntheticTarget, syntheticHookContract);
  const servers = Object.fromEntries(model.mcpServers
    .filter((server) => server.targets.includes(syntheticTarget))
    .map((server) => [server.name, {
      ...(server.args === undefined ? {} : { args: server.args }),
      command: server.command,
      ...(server.cwd === undefined ? {} : { cwd: server.cwd.replaceAll(pathTokens.pluginRoot, '${PLUGIN_ROOT}') }),
      ...(server.env === undefined ? {} : { env: server.env }),
      type: 'stdio',
    }]));
  return Object.freeze({
    diagnostics: hooks.diagnostics,
    entries: Object.freeze([
      ...(hooks.document === undefined ? [] : [{
        content: `${JSON.stringify(hooks.document)}\n`,
        kind: 'write' as const,
        relativePath: syntheticHookContract.manifestPath,
        sourceInputs: [model.metadata.provenance.sourcePath],
      }]),
      ...(Object.keys(servers).length === 0 ? [] : [{
        content: `${JSON.stringify({ mcpServers: servers })}\n`,
        kind: 'write' as const,
        relativePath: syntheticMcpRuntime.manifestPath,
        sourceInputs: [model.metadata.provenance.sourcePath],
      }]),
    ]),
    hookEntries: hooks.hookEntries,
  });
};

const syntheticAdapter: TargetAdapter = Object.freeze({
  artifactLayout: Object.freeze({
    hookWrappers: Object.freeze({ allowedSuffixes: Object.freeze(['.mjs']), directory: 'hooks' }),
    mcpEntries: Object.freeze({ allowedSuffixes: Object.freeze(['.mjs']), directory: 'mcp' }),
  }),
  capabilities: Object.freeze({ hooks: true, mcp: true }),
  configExtension: Object.freeze({ key: 'synthetic' }),
  hookContract: syntheticHookContract,
  metadata: syntheticMetadata,
  mcpRuntime: syntheticMcpRuntime,
  name: syntheticTarget,
  plan: syntheticPlan,
});

const readyInspection = async (options: Parameters<typeof inspect>[0]) => {
  const result = await inspect(options);
  if (result.state !== 'ready') throw new Error('Expected a ready inspection.');
  return result;
};

it('prepares and inspects a target owned only by the supplied advanced registry', async () => {
  const root = await createProject();
  const registry = new TargetRegistry().register(syntheticAdapter, { default: true });
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  plugin: { name: 'synthetic-api-fixture', version: '1.0.0' },",
      "  synthetic: { enabled: true },",
      "  targets: ['synthetic'],",
      '};',
      '',
    ].join('\n'));

    const result = await readyInspection({ registry, root });

    expect(result.model.extensions).toEqual({
      synthetic: expect.objectContaining({ target: 'synthetic', value: { enabled: true } }),
    });
    expect(result.plans).toEqual([expect.objectContaining({ target: 'synthetic' })]);
    expect(result.plans[0]?.skipped).toEqual([
      expect.objectContaining({ kind: 'skill', name: 'review', reason: 'unsupported-capability' }),
    ]);
    expect(registry.names()).toEqual(['synthetic']);
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
});

it('returns a frozen invalid inspection for opaque source failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-api-invalid-inspection-'));
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), "throw new Error('opaque inspect sentinel');\n");

    const result = await inspect({ root });

    expect(result).toMatchObject({
      diagnostics: [expect.objectContaining({
        code: 'AB7000',
        recovery: expect.any(String),
        severity: 'error',
      })],
      plans: [],
      state: 'invalid',
    });
    expect(JSON.stringify(result)).not.toContain('opaque inspect sentinel');
    expect('model' in result).toBe(false);
    expect('projectContext' in result).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(Object.isFrozen(result.plans)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('attaches a specific recovery to every invalid inspection diagnostic', async () => {
  const root = await createProject();
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), "export default { plugin: { version: '1.0.0' } };\n");

    const result = await inspect({ root });

    expect(result.state).toBe('invalid');
    expect(result.diagnostics).not.toEqual([]);
    expect(result.diagnostics.every((diagnostic) =>
      diagnostic.recovery !== undefined && diagnostic.recovery.trim().length > 0,
    )).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB4000',
        recovery: 'Correct the project configuration field named by this diagnostic, then inspect again.',
      }),
    ]));
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
});

it('reports one modern-MCP source diagnostic for a legacy SSE declaration', async () => {
  const root = await createProject();
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  plugin: { name: 'codex-sse', version: '1.0.0' },",
      "  targets: ['codex'],",
      "  mcp: { servers: { events: { transport: 'sse', url: 'https://mcp.example.test/events' } } },",
      '};',
      '',
    ].join('\n'));

    const result = await inspect({ root });
    const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.code === 'AB4317');

    expect(result.state).toBe('invalid');
    expect(diagnostics).toEqual([expect.objectContaining({
      code: 'AB4317',
      recovery: expect.any(String),
      severity: 'error',
    })]);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics[0])).toBe(true);
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
});

it('deduplicates identical adapter diagnostics without collapsing distinct stable identities', async () => {
  const root = await createProject();
  const diagnostic = (code: string, overrides: Partial<Diagnostic> = {}): Diagnostic => ({
    code,
    generatedPath: 'generated/a.json',
    message: 'Adapter diagnostic.',
    recovery: 'Fix this adapter diagnostic.',
    severity: 'error',
    sourcePath: 'agent-bundle.config.ts',
    target: syntheticTarget,
    ...overrides,
  });
  const pairs = [
    { expected: 1, first: diagnostic('custom.adapter.identical'), name: 'identical', second: diagnostic('custom.adapter.identical') },
    {
      expected: 2,
      name: 'source path',
      first: diagnostic('custom.adapter.source-path'),
      second: diagnostic('custom.adapter.source-path', { sourcePath: 'generated.config.ts' }),
    },
    {
      expected: 2,
      name: 'generated path',
      first: diagnostic('custom.adapter.generated-path'),
      second: diagnostic('custom.adapter.generated-path', { generatedPath: 'generated/b.json' }),
    },
    {
      expected: 2,
      name: 'severity',
      first: diagnostic('custom.adapter.severity'),
      second: diagnostic('custom.adapter.severity', { severity: 'warning' }),
    },
    {
      expected: 2,
      name: 'target',
      first: diagnostic('custom.adapter.target'),
      second: diagnostic('custom.adapter.target', { target: 'synthetic-plan' }),
    },
    {
      expected: 2,
      name: 'recovery',
      first: diagnostic('custom.adapter.recovery'),
      second: diagnostic('custom.adapter.recovery', { recovery: 'Repair this plan-specific diagnostic.' }),
    },
  ] as const;
  const planOnly = diagnostic('custom.adapter.plan-only');
  const adapter: TargetAdapter = Object.freeze({
    ...syntheticAdapter,
    plan: () => Object.freeze({
      diagnostics: Object.freeze([
        planOnly,
        planOnly,
        ...pairs.flatMap((pair) => [pair.first, pair.second]),
      ]),
      entries: Object.freeze([]),
    }),
  });
  const registry = new TargetRegistry().register(adapter, { default: true });
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  plugin: { name: 'adapter-diagnostic-identity', version: '1.0.0' },",
      "  synthetic: { enabled: true },",
      "  targets: ['synthetic'],",
      '};',
      '',
    ].join('\n'));

    const prepared = await new ProjectService({ registry, root }).prepare('inspect');
    const expected = [
      planOnly,
      ...pairs.flatMap((pair) => pair.expected === 1 ? [pair.first] : [pair.first, pair.second]),
    ];

    expect(prepared.diagnostics).toEqual(expected);
    expect(Object.isFrozen(prepared.diagnostics)).toBe(true);
    expect(prepared.diagnostics.every((entry) => Object.isFrozen(entry))).toBe(true);
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
});

it('contains hostile source getters as reusable preparation diagnostics', async () => {
  const root = await createProject();
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      "const hostile = { toString() { throw new Error('hostile source getter was stringified'); } };",
      'hostile.self = hostile;',
      'const config = { plugin: { name: \'hostile-config\', version: \'1.0.0\' }, targets: [\'codex\'] };',
      "Object.defineProperty(config, 'hooks', { enumerable: true, get() { throw hostile; } });",
      'export default config;',
      '',
    ].join('\n'));

    const service = new ProjectService({ root });
    const invalid = await service.prepare('inspect');

    expect(invalid).toMatchObject({
      diagnostics: [expect.objectContaining({
        code: 'AB7001',
        message: 'Unable to validate project source.',
        recovery: expect.any(String),
      })],
      source: { state: 'invalid' },
    });
    expect(JSON.stringify(invalid)).not.toContain('hostile source getter was stringified');
    expect(invalid.model).toBeUndefined();
    expect(invalid.projectContext).toBeUndefined();
    expect(Object.isFrozen(invalid)).toBe(true);
    expect(Object.isFrozen(invalid.diagnostics)).toBe(true);
    await expect(build({ root })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB7001' })],
    });

    await writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  plugin: { name: 'recovered-config', version: '1.0.0' },",
      "  targets: ['codex'],",
      '};',
      '',
    ].join('\n'));
    const recovered = await service.prepare('inspect');
    expect(recovered.source.state).toBe('ready');
    expect(recovered.model?.targets).toEqual([expect.objectContaining({ name: 'codex' })]);
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
});

const hostileAdapterError = (): object => {
  const error = Object.create(null) as Record<string, unknown>;
  error.self = error;
  Object.defineProperty(error, 'toString', {
    enumerable: true,
    value: () => {
      throw new Error('hostile adapter error was stringified');
    },
  });
  return error;
};

it('contains a throwing adapter plan as a reusable preparation diagnostic', async () => {
  const root = await createProject();
  let throwFromAdapter = true;
  const adapter: TargetAdapter = Object.freeze({
    ...syntheticAdapter,
    plan: (model: NormalizedPlugin) => {
      if (throwFromAdapter) throw hostileAdapterError();
      return syntheticPlan(model);
    },
  });
  const registry = new TargetRegistry().register(adapter, { default: true });
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  plugin: { name: 'hostile-adapter', version: '1.0.0' },",
      "  synthetic: { enabled: true },",
      "  targets: ['synthetic'],",
      '};',
      '',
    ].join('\n'));

    const service = new ProjectService({ registry, root });
    const invalid = await service.prepare('inspect');

    expect(invalid).toMatchObject({
      diagnostics: [expect.objectContaining({
        code: 'AB7001',
        message: 'Unable to validate normalized project.',
        recovery: expect.any(String),
      })],
      source: { state: 'invalid' },
    });
    expect(JSON.stringify(invalid)).not.toContain('hostile adapter error was stringified');
    expect(invalid.model).toBeUndefined();
    expect(invalid.projectContext).toBeUndefined();
    expect(Object.isFrozen(invalid)).toBe(true);
    expect(Object.isFrozen(invalid.diagnostics)).toBe(true);

    throwFromAdapter = false;
    const recovered = await service.prepare('inspect');
    expect(recovered.source.state).toBe('ready');
    expect(recovered.model?.targets).toEqual([expect.objectContaining({ name: syntheticTarget })]);
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
});

it('contains an adapter planner that fails after preparation during inspect', async () => {
  const root = await createProject();
  let planCalls = 0;
  const adapter: TargetAdapter = Object.freeze({
    ...syntheticAdapter,
    plan: (model: NormalizedPlugin) => {
      planCalls += 1;
      if (planCalls > 1) throw hostileAdapterError();
      return syntheticPlan(model);
    },
  });
  const registry = new TargetRegistry().register(adapter, { default: true });
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  plugin: { name: 'inspection-planner', version: '1.0.0' },",
      "  synthetic: { enabled: true },",
      "  targets: ['synthetic'],",
      '};',
      '',
    ].join('\n'));

    const result = await inspect({ registry, root });

    expect(result).toMatchObject({
      diagnostics: [expect.objectContaining({
        code: 'AB7001',
        message: 'Unable to prepare inspection plans.',
        recovery: expect.any(String),
      })],
      plans: [],
      state: 'invalid',
    });
    expect(JSON.stringify(result)).not.toContain('hostile adapter error was stringified');
    expect('model' in result).toBe(false);
    expect('projectContext' in result).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
});

it('returns an invalid inspection for selected targets outside the normalized project', async () => {
  const root = await createProject();
  try {
    const valid = await inspect({ root, target: 'codex' });
    expect(valid).toMatchObject({ plans: [expect.objectContaining({ target: 'codex' })], state: 'ready' });

    for (const target of ['portable', 'codec']) {
      const invalid = await inspect({ root, target });
      expect(invalid).toMatchObject({
        diagnostics: [expect.objectContaining({
          code: 'AB7004',
          recovery: expect.any(String),
          severity: 'error',
          target,
        })],
        plans: [],
        state: 'invalid',
      });
      expect('model' in invalid).toBe(false);
      expect('projectContext' in invalid).toBe(false);
      expect(Object.isFrozen(invalid)).toBe(true);
      expect(Object.isFrozen(invalid.diagnostics)).toBe(true);
      expect(Object.isFrozen(invalid.plans)).toBe(true);
    }
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
});

it('reports skipped target/component pairs with intersection-rule reasons', async () => {
  const root = await createProject();
  try {
    await writeFile(join(root, 'src', 'report.ts'), 'export const report = true;\n');
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  hooks: { sessionStart: { handler: './src/hook.ts' } },",
      "  plugin: { name: 'api-fixture', version: '1.0.0' },",
      "  scripts: { report: { entry: './src/report.ts', targets: ['codex'] } },",
      "  targets: ['portable', 'codex'],",
      '};',
      '',
    ].join('\n'));

    const result = await readyInspection({ root });
    const planFor = (target: string) => result.plans.find((plan) => plan.target === target);

    expect(planFor('portable')?.skipped).toEqual([
      expect.objectContaining({ kind: 'hook', name: 'sessionStart', reason: 'unsupported-capability' }),
      expect.objectContaining({ kind: 'script', name: 'report', reason: 'excluded-by-targets' }),
    ]);
    expect(planFor('codex')?.skipped).toEqual([]);
    expect(Object.isFrozen(planFor('portable')?.skipped)).toBe(true);
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
});

it('surfaces the computed native matcher on inspected hook entries', async () => {
  const root = await createProject();
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      '  hooks: {',
      "    beforeTool: { handler: './src/hook.ts', tools: ['shell', 'file.write'] },",
      "    sessionStart: { handler: './src/hook.ts' },",
      '  },',
      "  plugin: { name: 'api-fixture', version: '1.0.0' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'));

    const result = await readyInspection({ root });
    const hookEntries = result.plans[0]?.hookEntries ?? [];
    const beforeTool = hookEntries.find((entry) => entry.event === 'beforeTool');
    const sessionStart = hookEntries.find((entry) => entry.event === 'sessionStart');

    expect(beforeTool?.nativeMatcher).toEqual(expect.any(String));
    expect(beforeTool?.nativeMatcher?.length).toBeGreaterThan(0);
    expect(sessionStart).toBeDefined();
    expect(sessionStart?.nativeMatcher).toBeUndefined();
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
});

it('keeps one supplied registry through advanced artifact, hook, and MCP operations', async () => {
  const root = await createProject();
  const registry = new TargetRegistry().register(syntheticAdapter, { default: true });
  const artifact = join(root, 'artifact');
  try {
    await Promise.all([
      writeFile(join(root, 'src', 'hook.ts'), "export default () => ({ additionalContext: 'synthetic hook' });\n"),
      writeFile(join(root, 'src', 'mcp-server.ts'), [
        "let buffer = '';",
        'const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: \'2.0\', id, result })}\\n`);',
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        "  for (let newline; (newline = buffer.indexOf('\\n')) >= 0;) {",
        '    const line = buffer.slice(0, newline).trim();',
        '    buffer = buffer.slice(newline + 1);',
        '    if (!line) continue;',
        '    const request = JSON.parse(line);',
        "    if (request.method === 'initialize') send(request.id, { capabilities: { tools: {} }, protocolVersion: request.params.protocolVersion, serverInfo: { name: 'synthetic', version: '1.0.0' } });",
        "    if (request.method === 'tools/list') send(request.id, { tools: [{ description: 'Synthetic tool', inputSchema: { properties: {}, type: 'object' }, name: 'synthetic-tool' }] });",
        "    if (request.method === 'tools/call') send(request.id, { content: [{ text: 'synthetic result', type: 'text' }], structuredContent: { synthetic: true } });",
        '  }',
        '});',
        '',
      ].join('\n')),
      writeFile(join(root, 'agent-bundle.config.ts'), [
        'export default {',
        "  hooks: { sessionStart: { handler: './src/hook.ts' } },",
        "  mcp: { servers: { synthetic: { entry: './src/mcp-server.ts' } } },",
        "  plugin: { name: 'synthetic-api-fixture', version: '1.0.0' },",
        "  synthetic: { enabled: true },",
        "  targets: ['synthetic'],",
        '};',
        '',
      ].join('\n')),
    ]);

    const [inspection, built] = await Promise.all([
      inspect({ registry, root }),
      build({ output: artifact, registry, root }),
    ]);
    expect(inspection.plans).toEqual([expect.objectContaining({
      hookEntries: [expect.objectContaining({ target: syntheticTarget })],
      target: syntheticTarget,
    })]);
    expect(built.build.manifest.targets).toEqual([expect.objectContaining({ name: syntheticTarget })]);
    expect(built.build.manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'synthetic/synthetic-mcp.json' }),
    ]));
    const filesystem = await inspectArtifactFilesystem(artifact);
    expect(filesystem.entries
      .filter((entry) => entry.kind === 'directory')
      .every((directory) => filesystem.files.some((file) => file.path.startsWith(`${directory.path}/`))))
      .toBe(true);
    await expect(validate({ artifact, registry, root })).resolves.toEqual({ diagnostics: [] });
    await expect(validate({ artifact, root })).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB6009', target: syntheticTarget })],
    });
    const hooks = await listHooks({ artifact, registry, root, target: syntheticTarget });
    expect(hooks).toEqual([expect.objectContaining({ target: syntheticTarget })]);
    await expect(simulateHook({
      artifact,
      hook: hooks[0]!.id,
      input: { cwd: root, sessionId: 'session', source: 'startup', transcriptPath: '/tmp/transcript' },
      registry,
      root,
      target: syntheticTarget,
    })).resolves.toEqual({ additionalContext: 'synthetic hook', outcome: 'continue' });
    await expect(listMcp({ registry, root, server: 'synthetic', target: syntheticTarget })).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: 'synthetic-tool' })],
    });
    await expect(invokeMcp({
      artifact,
      input: {},
      registry,
      root,
      server: 'synthetic',
      target: syntheticTarget,
      tool: 'synthetic-tool',
    })).resolves.toMatchObject({ result: { structuredContent: { synthetic: true } } });
    await expect(inspect({ root })).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'AB4100', recovery: expect.any(String) })]),
      plans: [],
      state: 'invalid',
    });
    expect(registry.names()).toEqual([syntheticTarget]);
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 60_000);

it('prepares a factory-configured project into a frozen inspection and build result', async () => {
  const root = await createProject();
  try {
    const inspection = await readyInspection({ root, targets: ['portable'] });

    expect(inspection.model).toMatchObject({
      metadata: { name: 'api-fixture' },
      targets: [{ name: 'portable' }],
    });
    expect(inspection.plans).toHaveLength(1);
    expect(inspection.state).toBe('ready');
    expect(inspection.projectContext).toEqual(expect.objectContaining({ revision: expect.any(String) }));
    expect(Object.isFrozen(inspection.model)).toBe(true);
    expect(Object.isFrozen(inspection.projectContext)).toBe(true);

    const result = await build({ output: join(root, 'artifact'), root, targets: ['portable'] });
    expect(result).toMatchObject({
      build: { outputRoot: join(root, 'artifact') },
      model: { metadata: { name: 'api-fixture' } },
    });

    const hookArtifact = join(root, 'hooks-artifact');
    const hooks = await build({ output: hookArtifact, root });
    for (const target of ['claude', 'codex']) {
      expect(hooks.build.manifest.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: expect.stringMatching(new RegExp(`^${target}/hooks/.+\\.mjs$`, 'u')) }),
      ]));
    }
    await expect(validate({ artifact: hookArtifact, root })).resolves.toEqual({ diagnostics: [] });
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('returns an output-independent project context without absolute project paths', async () => {
  const [leftRoot, rightRoot] = await Promise.all([createProject(), createProject()]);
  try {
    const [left, right] = await Promise.all([
      build({ output: join(leftRoot, 'custom-artifact'), root: leftRoot, targets: ['portable'] }),
      build({ output: join(rightRoot, 'another-artifact'), root: rightRoot, targets: ['portable'] }),
    ]);

    expect(left.projectContext).toEqual(right.projectContext);
    expect(Object.keys(left.projectContext)).toEqual([
      'configDigest',
      'configPath',
      'modelDigest',
      'revision',
      'sourceInputs',
    ]);
    expect(JSON.stringify(left.projectContext)).not.toContain(leftRoot);
    expect(JSON.stringify(right.projectContext)).not.toContain(rightRoot);
    expect(JSON.stringify(left.projectContext)).not.toContain('custom-artifact');
    expect(JSON.stringify(right.projectContext)).not.toContain('another-artifact');
    expect(Object.isFrozen(left.projectContext)).toBe(true);
  } finally {
    await Promise.all([
      rm(join(leftRoot, '..'), { force: true, recursive: true }),
      rm(join(rightRoot, '..'), { force: true, recursive: true }),
    ]);
  }
}, 30_000);

it('rejects an output beneath an escaping symlink before loading source or writing outside the project', async () => {
  const root = await createProject();
  const external = join(root, '..', 'external-output');
  const marker = join(external, 'config-evaluated.txt');
  try {
    await mkdir(external, { recursive: true });
    await symlink(external, join(root, 'escape'), 'dir');
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'evaluated\\n');`,
      'export default {',
      "  plugin: { name: 'escaping-output', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'));

    await expect(build({ output: 'escape/artifact', root })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB7002', recovery: expect.any(String) })],
    });
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(external, 'artifact'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('rejects a dangling output symlink before loading source', async () => {
  const root = await createProject();
  const marker = join(root, '..', 'config-evaluated.txt');
  try {
    await symlink(join(root, '..', 'missing-output', 'artifact'), join(root, 'escape'), 'dir');
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'evaluated\\n');`,
      'export default {',
      "  plugin: { name: 'dangling-output', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'));

    await expect(build({ output: 'escape/artifact', root })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB7002', recovery: expect.any(String) })],
    });
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('rejects an output symlink to the project root before loading source', async () => {
  const root = await createProject();
  const marker = join(root, '..', 'config-evaluated.txt');
  try {
    await symlink(root, join(root, 'alias'), 'dir');
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'evaluated\\n');`,
      'export default {',
      "  plugin: { name: 'root-output', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'));

    await expect(build({ output: 'alias', root })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB7002', recovery: expect.any(String) })],
    });
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('allows an output below a symlink to the project root', async () => {
  const root = await createProject();
  try {
    await symlink(root, join(root, 'alias'), 'dir');

    const result = await build({ output: 'alias/artifact', root, targets: ['portable'] });

    expect(result.build.outputRoot).toBe(join(root, 'alias', 'artifact'));
    expect((await stat(join(root, 'artifact'))).isDirectory()).toBe(true);
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('excludes a contained symlinked output tree from project context identity', async () => {
  const [leftRoot, rightRoot] = await Promise.all([createProject(), createProject()]);
  try {
    const fixtures = [
      { bytes: 'first generated output\n', root: leftRoot },
      { bytes: 'second generated output\n', root: rightRoot },
    ];
    await Promise.all(fixtures.map(async ({ bytes, root }) => {
      const actual = join(root, 'actual-output');
      await mkdir(join(actual, 'artifact'), { recursive: true });
      await Promise.all([
        symlink(actual, join(root, 'output-alias'), 'dir'),
        writeFile(join(actual, 'artifact', 'generated.js'), bytes),
      ]);
    }));

    const [left, right] = await Promise.all([
      build({ output: 'output-alias/artifact', root: leftRoot, targets: ['portable'] }),
      build({ output: 'output-alias/artifact', root: rightRoot, targets: ['portable'] }),
    ]);

    expect(left.projectContext).toEqual(right.projectContext);
    expect(left.projectContext.sourceInputs.map((input) => input.path)).not.toContain(
      'actual-output/artifact/generated.js',
    );
    expect(JSON.stringify(left.projectContext)).not.toContain('actual-output');
    expect(JSON.stringify(right.projectContext)).not.toContain('actual-output');
  } finally {
    await Promise.all([
      rm(join(leftRoot, '..'), { force: true, recursive: true }),
      rm(join(rightRoot, '..'), { force: true, recursive: true }),
    ]);
  }
}, 30_000);

it('normalizes named top-level scripts with stable IDs, modes, and sorted targets', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-scripts-parent-'));
  const root = join(parent, 'project with spaces');
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'script-fixture', version: '1.0.0' },",
        "  targets: ['codex', 'claude'],",
        '  scripts: {',
        "    bundle: { entry: './src/bundle.ts', targets: ['codex', 'claude'] },",
        "    shell: './src/run.sh',",
        "    python: './src/run.py',",
        '  },',
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'src', 'bundle.ts'), "export const value = 'bundled';\n"),
    writeFile(join(root, 'src', 'run.sh'), '#!/usr/bin/env sh\nprintf shell\\n'),
    writeFile(join(root, 'src', 'run.py'), '#!/usr/bin/env python3\nprint("python")\n'),
  ]);

  try {
    const result = await readyInspection({ root });

    expect(result.model.scripts).toEqual([
      {
        id: 'script:bundle',
        mode: 'bundle',
        name: 'bundle',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        source: join(root, 'src', 'bundle.ts'),
        targets: ['claude', 'codex'],
      },
      {
        id: 'script:python',
        mode: 'copy',
        name: 'python',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        source: join(root, 'src', 'run.py'),
        targets: ['claude', 'codex'],
      },
      {
        id: 'script:shell',
        mode: 'copy',
        name: 'shell',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        source: join(root, 'src', 'run.sh'),
        targets: ['claude', 'codex'],
      },
    ]);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

it('copies every supported top-level script output suffix byte-for-byte with source modes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-copy-scripts-parent-'));
  const root = join(parent, 'project with spaces');
  const sourceBash = join(root, 'src', 'run.BASH');
  const sourceBundle = join(root, 'src', 'bundle.ts');
  const sourceShell = join(root, 'src', 'run.SH');
  const sourcePython = join(root, 'src', 'run.Py');
  const output = join(root, 'artifact');
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'copy-script-fixture', version: '1.0.0' },",
        "  targets: ['portable', 'codex', 'claude'],",
        '  scripts: {',
        "    bash: './src/run.BASH',",
        "    bundle: { entry: './src/bundle.ts' },",
        "    shell: './src/run.SH',",
        "    python: './src/run.Py',",
        '  },',
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(sourceBash, '#!/usr/bin/env bash\nprintf "bash\\n"\r\n'),
    writeFile(sourceBundle, "export const output = 'bundle';\n"),
    writeFile(sourceShell, '#!/usr/bin/env sh\nprintf "shell\\n"\r\n'),
    writeFile(sourcePython, '#!/usr/bin/env python3\r\nprint("python")\r\n'),
  ]);
  await Promise.all([chmod(sourceBash, 0o741), chmod(sourceShell, 0o751), chmod(sourcePython, 0o711)]);

  try {
    await build({ output, root });

    const copyOutputs = [
      [sourceBash, 'bash.bash'],
      [sourceShell, 'shell.sh'],
      [sourcePython, 'python.py'],
    ] as const;
    const checks = await Promise.all(['claude', 'codex', 'portable'].flatMap((target) =>
      copyOutputs.map(([source, name]) => [source, join(output, target, 'scripts', name)] as const),
    ).map(async ([source, generated]) => {
      const [sourceContents, generatedContents, sourceMetadata, generatedMetadata] = await Promise.all([
        readFile(source!),
        readFile(generated!),
        stat(source!),
        stat(generated!),
      ]);
      return {
        generatedContents,
        generatedMode: generatedMetadata.mode & 0o777,
        sourceContents,
        sourceMode: sourceMetadata.mode & 0o777,
      };
    }));

    for (const check of checks) {
      expect(check.generatedContents).toEqual(check.sourceContents);
      expect(check.generatedMode).toBe(check.sourceMode);
    }

    const manifest = JSON.parse(await readFile(join(output, 'agent-bundle.manifest.json'), 'utf8')) as {
      readonly files: readonly {
        readonly kind: 'bundle' | 'copy' | 'generated';
        readonly mode?: number;
        readonly path: string;
        readonly sourceInputs: readonly string[];
      }[];
    };
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'copy',
        mode: 0o741,
        path: 'portable/scripts/bash.bash',
        sourceInputs: ['agent-bundle.config.ts', 'src/run.BASH'],
      }),
      expect.objectContaining({
        kind: 'bundle',
        path: 'portable/scripts/bundle.mjs',
        sourceInputs: ['agent-bundle.config.ts', 'src/bundle.ts'],
      }),
      expect.objectContaining({
        kind: 'copy',
        mode: 0o751,
        path: 'portable/scripts/shell.sh',
        sourceInputs: ['agent-bundle.config.ts', 'src/run.SH'],
      }),
      expect.objectContaining({
        kind: 'copy',
        mode: 0o711,
        path: 'portable/scripts/python.py',
        sourceInputs: ['agent-bundle.config.ts', 'src/run.Py'],
      }),
    ]));
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });

    await chmod(join(output, 'portable', 'scripts', 'shell.sh'), 0o644);
    await expect(validate({ artifact: output, root })).resolves.toMatchObject({
      diagnostics: [{ code: 'AB6004', generatedPath: 'agent-bundle.manifest.json' }],
    });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}, 30_000);

it('canonicalizes copied script extensions in emitted artifact paths', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-uppercase-script-parent-'));
  const root = join(parent, 'project');
  const source = join(root, 'src', 'run.SH');
  const output = join(root, 'artifact');
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  plugin: { name: 'uppercase-script-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      "  scripts: { upper: './src/run.SH' },",
      '};',
      '',
    ].join('\n')),
    writeFile(source, '#!/usr/bin/env sh\nprintf "uppercase\\n"\n'),
  ]);

  try {
    const result = await build({ output, root });
    const generated = join(output, 'portable', 'scripts', 'upper.sh');

    await expect(readFile(generated, 'utf8')).resolves.toBe(await readFile(source, 'utf8'));
    await expect(readFile(join(output, 'portable', 'scripts', 'upper.SH'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(result.build.manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'copy',
        path: 'portable/scripts/upper.sh',
        sourceInputs: ['agent-bundle.config.ts', 'src/run.SH'],
      }),
    ]));
    expect(result.build.outputProvenance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'copy',
        path: 'portable/scripts/upper.sh',
        sourceInputs: ['agent-bundle.config.ts', 'src/run.SH'],
      }),
    ]));
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

it('documents a versioned MCP App resource URI accepted by source validation', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-readme-uri-parent-'));
  const root = join(parent, 'project');
  const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');
  const resourceUri = /resourceUri: '([^']+)'/u.exec(readme)?.[1];
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'views'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'readme-uri-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '  mcp: { servers: { local: {',
        "    entry: './src/server.ts',",
        `    apps: { dashboard: { entry: './views/dashboard.ts', resourceUri: ${JSON.stringify(resourceUri)} } },`,
        '  } } },',
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'src', 'server.ts'), 'export {}\n'),
    writeFile(join(root, 'views', 'dashboard.ts'), 'export {}\n'),
  ]);

  try {
    const result = await validate({ root });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('AB4329');
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

it('rejects unsafe, unsupported, missing, non-file, and unknown-target named scripts', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-invalid-scripts-parent-'));
  const root = join(parent, 'project');
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'invalid-script-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '  scripts: {',
        "    '../unsafe': './src/run.sh',",
        "    unsupported: './src/run.txt',",
        "    missing: './src/missing.ts',",
        "    directory: './src',",
        "    outside: '../outside.ts',",
        "    target: { entry: './src/run.sh', targets: ['unknown'] },",
        '  },',
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'src', 'run.sh'), '#!/usr/bin/env sh\n'),
    writeFile(join(root, 'src', 'run.txt'), 'unsupported\n'),
    writeFile(join(parent, 'outside.ts'), 'export {};\n'),
  ]);

  try {
    const result = await validate({ root });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'AB4401',
      'AB4403',
      'AB4404',
      'AB4405',
      'AB4406',
    ]));
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

it('lists hooks across artifact targets and rejects an explicit unknown target', async () => {
  const root = await createProject();
  try {
    const artifact = join(root, 'artifact');
    await build({ output: artifact, root });

    await expect(listHooks({ artifact, root })).resolves.toMatchObject([
      { event: 'sessionStart', target: 'claude' },
      { event: 'sessionStart', target: 'codex' },
    ]);
    await expect(listHooks({ artifact, root, target: 'unsupported' })).rejects.toThrow('Unknown target');
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);

it('validates an explicit artifact without loading its project source', async () => {
  const root = await createProject();
  try {
    const artifact = join(root, 'artifact');
    await build({ output: artifact, root });
    await writeFile(join(root, 'agent-bundle.config.ts'), 'this source must not be loaded\n');

    const result = await validate({ artifact, root });

    expect(result).toEqual({ diagnostics: [] });
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  } finally {
    await rm(join(root, '..'), { force: true, recursive: true });
  }
}, 30_000);
