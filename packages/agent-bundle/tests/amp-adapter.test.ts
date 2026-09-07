import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from '@rstest/core';

import capabilityTable from '../src/adapters/capabilities/amp-0.0.0-20260907001852-gf348fed.json' with { type: 'json' };
import { ampAdapter } from '../src/adapters/amp.ts';
import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { compileEvidenceFileName } from '../src/build/compile-evidence.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import type { JsonObject } from '../src/core/strict-json.ts';
import type { NormalizedHook, NormalizedPlugin } from '../src/core/types.ts';
import { projectEventDocument } from '../src/events/projection.ts';
import { emptyCompiledRouteGraph } from '../src/routes/graph.ts';
import { build } from './support/build.ts';
import { runNodeScript } from './support/run-node-script.ts';

const configPath = '/workspace/agent-bundle.config.ts';
const skillSource = '/workspace/src/skills/review/SKILL.md';

const plugin = (): NormalizedPlugin => ({
  extensions: {},
  hooks: [],
  mcpServers: [
    {
      args: ['-y', 'example-mcp@1.0.0'],
      command: 'npx',
      env: { EXAMPLE_TOKEN: '${EXAMPLE_TOKEN}' },
      id: 'mcp:local',
      name: 'local',
      provenance: { kind: 'config', sourcePath: configPath },
      targets: ['amp'],
      transport: 'stdio',
    },
    {
      headers: { Authorization: 'Bearer ${AMP_TOKEN}' },
      id: 'mcp:remote',
      name: 'remote',
      provenance: { kind: 'config', sourcePath: configPath },
      targets: ['amp'],
      transport: 'streamable-http',
      url: 'https://mcp.example.test/mcp',
    },
  ],
  metadata: {
    description: 'Review code with Amp.',
    id: 'plugin:amp-review',
    name: 'amp-review',
    provenance: { kind: 'config', sourcePath: configPath },
    version: '1.2.3',
  },
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [{
    body: '# Review\n',
    description: 'Review code.',
    dir: '/workspace/src/skills/review',
    frontmatter: { description: 'Review code.', name: 'review' },
    id: 'skill:review',
    name: 'review',
    provenance: { kind: 'conventional', sourcePath: skillSource },
    resources: [
      { bytes: 64, relativePath: 'SKILL.md', source: skillSource },
      { bytes: 12, relativePath: 'references/checklist.md', source: '/workspace/src/skills/review/references/checklist.md' },
    ],
    source: skillSource,
    targets: ['amp'],
  }],
  targets: [{
    id: 'target:amp',
    name: 'amp',
    provenance: { kind: 'config', sourcePath: configPath },
  }],
});

const writes = (model: NormalizedPlugin): Readonly<Record<string, string>> => Object.fromEntries(
  ampAdapter.plan(model).entries
    .filter((entry): entry is Extract<typeof entry, { readonly kind: 'write' }> => entry.kind === 'write')
    .map((entry) => [entry.relativePath, entry.content]),
);

it('registers Amp as a built-in directory-plugin target with pinned evidence', () => {
  const registry = createDefaultRegistry();

  expect(registry.names()).toEqual(['portable', 'codex', 'claude', 'cursor', 'amp']);
  expect(registry.builtInHost('amp')).toBe('amp');
  expect(registry.supports('amp', 'hooks')).toBe(true);
  expect(registry.supports('amp', 'mcp')).toBe(true);
  expect(registry.supports('amp', 'skills')).toBe(true);
  expect(registry.supports('amp', 'install')).toBe(true);
  expect(registry.mcpRuntime('amp')).toBeUndefined();
  expect(registry.artifactLayout('amp')).toMatchObject({
    rootDirectories: ['.amp'],
    skills: '.amp/plugins/{plugin}/skills',
  });
  expect(registry.artifactLayout('amp').assets).toBeUndefined();
  expect(capabilityTable.pluginApi.package).toBe('@ampcode/plugin');
  expect(capabilityTable.pluginApi.version).toBe('0.0.0-20260907001852-gf348fed');
  expect(capabilityTable.runtimeProof.state).toBe('unverified');
  expect(capabilityTable.plugins.precedence).toEqual(['project', 'system', 'personal', 'workspace']);
});

it('emits one private directory plugin with explicit skill registration and flat skill MCP', () => {
  const plan = ampAdapter.plan(plugin());
  const documents = writes(plugin());
  const root = '.amp/plugins/amp-review';
  const entry = documents[`${root}/index.js`];

  expect(plan.diagnostics).toEqual([]);
  expect(plan.documents).toEqual({ entry: `${root}/index.js` });
  expect(entry).toContain("/** @param {import('@ampcode/plugin').PluginAPI} amp */");
  expect(entry).toContain("await amp.registerSkill({ path: 'skills/review' });");
  expect(entry?.match(/registerSkill/g)).toHaveLength(1);
  expect(entry).toContain('export const description = "Review code with Amp."');
  expect(entry).toContain('export default async function ampReview(amp)');
  expect(entry).not.toMatch(/^\s*import\s/mu);
  expect(entry).not.toContain('export function');
  expect(entry).not.toContain('export {');
  expect(plan.entries.map((candidate) => candidate.relativePath)).toEqual([
    `${root}/index.js`,
    `${root}/skills/review/SKILL.md`,
    `${root}/skills/review/mcp.json`,
    `${root}/skills/review/references/checklist.md`,
  ]);
  expect(JSON.parse(documents[`${root}/skills/review/mcp.json`]!)).toEqual({
    local: {
      args: ['-y', 'example-mcp@1.0.0'],
      command: 'npx',
      env: { EXAMPLE_TOKEN: '${EXAMPLE_TOKEN}' },
    },
    remote: {
      headers: { Authorization: 'Bearer ${AMP_TOKEN}' },
      url: 'https://mcp.example.test/mcp',
    },
  });
});

it('keeps content-only skills free of compiled runtimes', () => {
  const model = { ...plugin(), mcpServers: [] };
  const plan = ampAdapter.plan(model);

  expect(plan.diagnostics).toEqual([]);
  expect(plan.hookEntries).toEqual([]);
  expect(plan.entries.map((entry) => entry.relativePath)).toEqual([
    '.amp/plugins/amp-review/index.js',
    '.amp/plugins/amp-review/skills/review/SKILL.md',
    '.amp/plugins/amp-review/skills/review/references/checklist.md',
  ]);
});

it('emits a valid private factory name for every portable plugin path segment', () => {
  const model = plugin();
  const dotted = { ...model, metadata: { ...model.metadata, name: 'amp.review-tools' } };
  expect(writes(dotted)['.amp/plugins/amp.review-tools/index.js']).toContain(
    'export default async function ampReviewTools(amp)',
  );
});

it('preserves native frontmatter and sibling MCP precedence over generated skill MCP', () => {
  const model = plugin();
  const skill = model.skills[0]!;
  const ampSkill = {
    diagnostics: [],
    frontmatter: {
      'builtin-tools': ['review_status'],
      description: 'Review code.',
      mcpServers: {
        native: { includeTools: ['review_*'], url: 'https://native.example.test/mcp' },
      },
      name: 'review',
    },
    passThrough: false,
    sidecars: [],
    skillMarkdown: [
      '---',
      'name: review',
      'description: Review code.',
      'builtin-tools:',
      '  - review_status',
      'mcpServers:',
      '  native:',
      '    url: https://native.example.test/mcp',
      '    includeTools:',
      '      - review_*',
      '---',
      '# Review',
      '',
    ].join('\n'),
    target: 'amp',
    tokenLowering: [],
  } as const;
  const planned = ampAdapter.plan({
    ...model,
    skills: [{
      ...skill,
      hostDocuments: { amp: ampSkill },
      resources: [
        ...skill.resources,
        { bytes: 20, relativePath: 'mcp.json', source: '/workspace/src/skills/review/mcp.json' },
      ],
    }],
  });

  expect(planned.diagnostics).toContainEqual(expect.objectContaining({
    code: 'amp.mcp.precedence',
    severity: 'error',
    target: 'amp',
  }));
  expect(planned.entries.filter((entry) => entry.relativePath.endsWith('/mcp.json'))).toEqual([
    expect.objectContaining({
      kind: 'copy',
      relativePath: '.amp/plugins/amp-review/skills/review/mcp.json',
      source: '/workspace/src/skills/review/mcp.json',
    }),
  ]);
  expect(writes({
    ...model,
    mcpServers: [],
    skills: [{ ...skill, hostDocuments: { amp: ampSkill } }],
  })['.amp/plugins/amp-review/skills/review/SKILL.md']).toContain('builtin-tools:');
});

it('refuses generated local MCP, ambiguous skill scope, and unregistered prebuilt hooks', () => {
  const model = plugin();
  const generated = ampAdapter.plan({
    ...model,
    mcpServers: [{
      ...model.mcpServers[0]!,
      args: ['mcp/mcp-local-deadbeef.mjs'],
      source: '/workspace/src/mcp/local.ts',
    }],
  });
  const secondSkill = {
    ...model.skills[0]!,
    id: 'skill:other',
    name: 'other',
    source: '/workspace/src/skills/other/SKILL.md',
    targets: ['amp'],
  };
  const ambiguous = ampAdapter.plan({ ...model, skills: [...model.skills, secondSkill] });
  const prebuilt = ampAdapter.plan({
    ...model,
    hooks: [{
      args: ['--check'],
      event: 'beforeTool',
      id: 'hook:prebuilt',
      name: 'prebuilt',
      prebuiltPath: 'payload/prebuilt.mjs',
      provenance: { kind: 'prebuilt', sourcePath: configPath },
      source: '/workspace/payload/prebuilt.mjs',
      targets: ['amp'],
      tools: [],
    }],
  });

  expect(generated.diagnostics).toContainEqual(expect.objectContaining({
    code: 'amp.mcp.generated-local',
    severity: 'error',
  }));
  expect(ambiguous.diagnostics).toContainEqual(expect.objectContaining({
    code: 'amp.mcp.skill-scope',
    severity: 'error',
  }));
  expect(prebuilt.diagnostics).toContainEqual(expect.objectContaining({
    code: 'amp.hook.prebuilt',
    severity: 'error',
  }));
});

const eventHook = (
  id: string,
  event: NormalizedHook['event'],
  canonical: NonNullable<NormalizedHook['eventRoute']>['event'],
): NormalizedHook => ({
  event,
  eventRoute: {
    event: canonical,
    fallback: 'standalone',
    runtime: 'standalone',
  },
  id: `event:${id}`,
  name: id,
  provenance: { kind: 'conventional', sourcePath: `/workspace/src/events/${id}.tsx` },
  source: `/workspace/src/events/${id}.tsx`,
  targets: ['amp'],
  tools: [],
});

const callbackPlugin = (): NormalizedPlugin => ({
  ...plugin(),
  hooks: [
    eventHook('session-start', 'sessionStart', 'session/start'),
    eventHook('tool-before', 'beforeTool', 'tool/before'),
    eventHook('tool-after', 'afterTool', 'tool/after'),
    eventHook('prompt-submit', 'promptSubmit', 'prompt/submit'),
    eventHook('stop', 'stop', 'stop'),
  ],
  mcpServers: [],
});

interface SpawnInput {
  readonly hook_event_name?: unknown;
  readonly status?: unknown;
  readonly tool_name?: unknown;
}

const fakeSpawn = (
  seen: SpawnInput[],
): ((command: readonly string[]) => Readonly<Record<string, unknown>>) => () => {
  let input = '';
  let output = '';
  let settle!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await exited;
      if (output !== '') controller.enqueue(new TextEncoder().encode(output));
      controller.close();
    },
  });
  return {
    exited,
    stderr: new ReadableStream<Uint8Array>({
      async start(controller) {
        await exited;
        controller.close();
      },
    }),
    stdin: {
      end() {
        const native = JSON.parse(input) as SpawnInput;
        seen.push(native);
        if (native.hook_event_name === 'tool.call') {
          if (native.tool_name === 'deny') output = JSON.stringify({ action: 'reject-and-continue', message: 'denied' });
          if (native.tool_name === 'modify') output = JSON.stringify({ action: 'modify', input: { changed: true } });
          if (native.tool_name === 'synthesize') output = JSON.stringify({ action: 'synthesize', result: { exitCode: 7, output: 'synthetic' } });
        }
        if (native.hook_event_name === 'tool.result') {
          output = JSON.stringify({ output: 'replaced', status: 'done' });
        }
        if (native.hook_event_name === 'agent.start') {
          output = JSON.stringify({ message: { content: 'context' } });
        }
        if (native.hook_event_name === 'agent.end') {
          output = JSON.stringify({ action: 'continue', userMessage: 'follow up' });
        }
        settle(0);
      },
      write(chunk: string | Uint8Array) {
        input += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      },
    },
    stdout: body,
  };
};

it('registers inline documented callbacks and maps every native result exactly', async () => {
  const source = writes(callbackPlugin())['.amp/plugins/amp-review/index.js']!;
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-amp-factory-'));
  const entry = join(root, 'index.mjs');
  const seen: SpawnInput[] = [];
  const handlers = new Map<string, (event: Record<string, unknown>, context: Record<string, unknown>) => unknown>();
  const previousBun = Reflect.get(globalThis, 'Bun');
  Reflect.set(globalThis, 'Bun', { spawn: fakeSpawn(seen) });
  await writeFile(entry, source);
  try {
    const loaded = await import(`${pathToFileURL(entry).href}?run=${Date.now()}`) as {
      readonly default: (amp: Record<string, unknown>) => Promise<void>;
      readonly description: string;
    };
    const registrations: string[] = [];
    await loaded.default({
      on(event: string, handler: (value: Record<string, unknown>, context: Record<string, unknown>) => unknown) {
        handlers.set(event, handler);
        return {};
      },
      async registerSkill(definition: { readonly path: string }) {
        registrations.push(definition.path);
        return {};
      },
    });

    expect(loaded.description).toBe('Review code with Amp.');
    expect(Object.keys(loaded).sort()).toEqual(['default', 'description']);
    expect(registrations).toEqual(['skills/review']);
    expect([...handlers.keys()]).toEqual(['session.start', 'tool.call', 'tool.result', 'agent.start', 'agent.end']);

    const thread = { id: 'thread-1' };
    await handlers.get('session.start')!({ thread }, {});
    await expect(handlers.get('tool.call')!({ input: {}, thread, tool: 'pass', toolUseID: '1' }, {})).resolves.toEqual({ action: 'allow' });
    await expect(handlers.get('tool.call')!({ input: {}, thread, tool: 'deny', toolUseID: '2' }, {})).resolves.toEqual({
      action: 'reject-and-continue',
      message: 'denied',
    });
    await expect(handlers.get('tool.call')!({ input: {}, thread, tool: 'modify', toolUseID: '3' }, {})).resolves.toEqual({
      action: 'modify',
      input: { changed: true },
    });
    await expect(handlers.get('tool.call')!({ input: {}, thread, tool: 'synthesize', toolUseID: '4' }, {})).resolves.toEqual({
      action: 'synthesize',
      result: { exitCode: 7, output: 'synthetic' },
    });
    await expect(handlers.get('tool.result')!({
      input: {},
      output: 'original',
      status: 'done',
      thread,
      tool: 'replace',
      toolUseID: '5',
    }, {})).resolves.toEqual({ output: 'replaced', status: 'done' });
    await expect(handlers.get('agent.start')!({ id: 'message-1', message: 'hello', thread }, {})).resolves.toEqual({
      message: { content: 'context' },
    });
    await expect(handlers.get('agent.end')!({
      id: 'message-1',
      message: 'hello',
      messages: [],
      status: 'done',
      thread,
    }, {})).resolves.toEqual({ action: 'continue', userMessage: 'follow up' });
    expect(seen.every((event) => event.hook_event_name !== 'session.end')).toBe(true);
  } finally {
    if (previousBun === undefined) Reflect.deleteProperty(globalThis, 'Bun');
    else Reflect.set(globalThis, 'Bun', previousBun);
    await rm(root, { force: true, recursive: true });
  }
});

const document = (
  value?: JsonObject,
  context?: string,
) => ({
  root: {
    children: context === undefined ? [] : [{ kind: 'context' as const, text: context }],
    kind: 'result' as const,
  },
  status: 'success' as const,
  ...(value === undefined ? {} : { value }),
  version: 1 as const,
});

it('projects only documented Amp event outcomes', () => {
  const tool = {
    hook_event_name: 'tool.call',
    session_id: 'thread-1',
    tool_input: {},
    tool_name: 'shell',
    tool_use_id: 'tool-1',
  };
  expect(projectEventDocument(document({ outcome: 'allow' }), 'tool/before', 'amp', 'tool.call', tool)).toEqual({ action: 'allow' });
  expect(projectEventDocument(document({ outcome: 'deny', reason: 'no' }), 'tool/before', 'amp', 'tool.call', tool)).toEqual({
    action: 'reject-and-continue',
    message: 'no',
  });
  expect(projectEventDocument(document({ updatedInput: { safe: true } }), 'tool/before', 'amp', 'tool.call', tool)).toEqual({
    action: 'modify',
    input: { safe: true },
  });
  expect(projectEventDocument(document({ exitCode: 2, outcome: 'synthesize', output: 'cached' }), 'tool/before', 'amp', 'tool.call', tool)).toEqual({
    action: 'synthesize',
    result: { exitCode: 2, output: 'cached' },
  });
  expect(projectEventDocument(document({ output: 'replacement', status: 'done' }), 'tool/after', 'amp', 'tool.result', {
    ...tool,
    hook_event_name: 'tool.result',
    status: 'done',
    tool_response: 'original',
  })).toEqual({ output: 'replacement', status: 'done' });
  expect(projectEventDocument(document(undefined, 'extra context'), 'prompt/submit', 'amp', 'agent.start', {
    hook_event_name: 'agent.start',
    prompt: 'hello',
    session_id: 'thread-1',
  })).toEqual({ message: { content: 'extra context' } });
  expect(projectEventDocument(document({ outcome: 'deny', reason: 'verify' }), 'stop', 'amp', 'agent.end', {
    hook_event_name: 'agent.end',
    session_id: 'thread-1',
    status: 'done',
  })).toEqual({ action: 'continue', userMessage: 'verify' });
  expect(() => projectEventDocument(document(), 'session/end', 'amp', 'session.end', {})).toThrow();
});

it('builds a relocatable self-contained Amp artifact with manifest and evidence records', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-amp-build-'));
  const config = join(projectRoot, 'agent-bundle.config.ts');
  const skillDir = join(projectRoot, 'src', 'skills', 'review');
  const skill = join(skillDir, 'SKILL.md');
  const outputRoot = join(projectRoot, 'artifact');
  const relocated = join(projectRoot, 'relocated');
  await mkdir(skillDir, { recursive: true });
  await writeFile(config, 'export default {};\n');
  await writeFile(skill, '---\nname: review\ndescription: Review code.\n---\n# Review\n');
  const model: NormalizedPlugin = {
    ...plugin(),
    mcpServers: [],
    metadata: {
      ...plugin().metadata,
      provenance: { kind: 'config', sourcePath: config },
    },
    skills: [{
      ...plugin().skills[0]!,
      dir: skillDir,
      provenance: { kind: 'conventional', sourcePath: skill },
      resources: [{ bytes: (await readFile(skill)).length, relativePath: 'SKILL.md', source: skill }],
      source: skill,
    }],
    targets: [{
      id: 'target:amp',
      name: 'amp',
      provenance: { kind: 'config', sourcePath: config },
    }],
  };

  try {
    const registry = createDefaultRegistry();
    const result = await build({
      model,
      outputRoot,
      projectRoot,
      registry,
      routeGraph: emptyCompiledRouteGraph,
    });
    const entryPath = '.amp/plugins/amp-review/index.js';
    expect(result.manifest.manifestVersion).toBe(4);
    expect(result.manifest.projections).toEqual([{
      builtInHost: 'amp',
      documents: { entry: entryPath },
      host: 'amp',
    }]);
    expect(result.manifest.compiler.adapters).toEqual([{
      adapterRevision: '1.0.0',
      host: 'amp',
      observedVersion: '0.0.0-20260907001852-gf348fed',
      schemas: [],
    }]);
    expect(result.manifest.compiler.provenance).toContainEqual({
      path: entryPath,
      sourceInputs: ['agent-bundle.config.ts', 'src/skills/review/SKILL.md'],
    });
    await expect(readFile(join(outputRoot, compileEvidenceFileName), 'utf8')).resolves.toContain('"name":"closed-world-externals","revision":1');
    const entry = await readFile(join(outputRoot, entryPath), 'utf8');
    expect(entry).not.toMatch(/^\s*import\s/mu);
    expect(result.manifest.files.filter((file) => file.path.includes('/hooks/') || file.path.startsWith('mcp/'))).toEqual([]);
    expect(await validateArtifact({ artifactRoot: outputRoot, registry })).toEqual([]);

    await rename(outputRoot, relocated);
    expect(await validateArtifact({ artifactRoot: relocated, registry })).toEqual([]);
    const registrations: string[] = [];
    const loaded = await import(`${pathToFileURL(join(relocated, entryPath)).href}?relocated=${Date.now()}`) as {
      readonly default: (api: Readonly<Record<string, unknown>>) => Promise<void>;
    };
    await loaded.default({
      on() {
        throw new Error('Content-only Amp factory must not register event callbacks.');
      },
      async registerSkill(value: { readonly path: string }) {
        registrations.push(value.path);
        return {};
      },
    });
    expect(registrations).toEqual(['skills/review']);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

it('compiles a nested Amp hook wrapper that returns the documented tool.call decision', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-amp-hook-'));
  const config = join(projectRoot, 'agent-bundle.config.ts');
  const handler = join(projectRoot, 'src', 'hooks', 'before.ts');
  const outputRoot = join(projectRoot, 'artifact');
  await mkdir(join(projectRoot, 'src', 'hooks'), { recursive: true });
  await writeFile(config, 'export default {};\n');
  await writeFile(handler, "export default () => ({ outcome: 'deny', reason: 'blocked' });\n");
  const base = plugin();
  const model: NormalizedPlugin = {
    ...base,
    hooks: [{
      event: 'beforeTool',
      id: 'hook:before',
      name: 'before',
      provenance: { kind: 'config', sourcePath: config },
      source: handler,
      targets: ['amp'],
      tools: [],
    }],
    mcpServers: [],
    metadata: { ...base.metadata, provenance: { kind: 'config', sourcePath: config } },
    skills: [],
    targets: [{
      id: 'target:amp',
      name: 'amp',
      provenance: { kind: 'config', sourcePath: config },
    }],
  };

  try {
    const built = await build({
      model,
      outputRoot,
      projectRoot,
      registry: createDefaultRegistry(),
      routeGraph: emptyCompiledRouteGraph,
    });
    const wrapper = '.amp/plugins/amp-review/hooks/before.mjs';
    expect(built.manifest.executables.hooks).toContainEqual(expect.objectContaining({
      event: 'beforeTool',
      host: 'amp',
      path: wrapper,
    }));
    const result = await runNodeScript({
      args: [join(outputRoot, wrapper)],
      input: JSON.stringify({
        hook_event_name: 'tool.call',
        session_id: 'thread-1',
        tool_input: { command: 'rm -rf /' },
        tool_name: 'shell',
        tool_use_id: 'tool-1',
      }),
    });
    expect(result).toEqual({
      code: 0,
      stderr: '',
      stdout: '{"action":"reject-and-continue","message":"blocked"}',
    });
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});
