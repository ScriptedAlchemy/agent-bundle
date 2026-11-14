import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from '@rstest/core';

import {
  openCodeAdapter,
  openCodePluginEntrySource,
} from '../src/adapters/opencode.ts';
import { createCanonicalEventProps } from '../src/events/project.ts';
import type { NormalizedHook, NormalizedPlugin } from '../src/core/types.ts';
import { removeTree } from './support/remove-tree.ts';

const configPath = '/workspace/agent-bundle.config.ts';

const hook = (
  name: string,
  event: NormalizedHook['event'],
  eventRoute?: NormalizedHook['eventRoute'],
): NormalizedHook => ({
  event,
  ...(eventRoute === undefined ? {} : { eventRoute }),
  id: `hook:${name}`,
  name,
  provenance: { kind: 'config', sourcePath: configPath },
  source: `/workspace/src/hooks/${name}.ts`,
  targets: ['opencode'],
  tools: [],
});

const model = (): NormalizedPlugin => ({
  projectRoot: '/workspace',
  extensions: {},
  hooks: [
    hook('before', 'beforeTool'),
    hook('after', 'afterTool'),
    hook('stop', 'stop', { event: 'stop', fallback: 'none', runtime: 'shared' }),
    hook('created', 'sessionStart', { event: 'session/start', fallback: 'none', runtime: 'shared' }),
    hook('prompt', 'promptSubmit', { event: 'prompt/submit', fallback: 'none', runtime: 'shared' }),
    hook('failure', 'toolFailure', { event: 'tool/failure', fallback: 'none', runtime: 'shared' }),
  ],
  metadata: {
    id: 'plugin:hooks',
    name: 'hooks-fixture',
    provenance: { kind: 'config', sourcePath: configPath },
    version: '1.0.0',
  },
  mcpServers: [],
  runtime: { node: '22.19.0' },
  scripts: [],
  skills: [],
  targets: [{ id: 'target:opencode', name: 'opencode', provenance: { kind: 'config', sourcePath: configPath } }],
});

const wrapperFixture = `let input = '';
for await (const chunk of process.stdin) input += chunk;
const native = JSON.parse(input);
await import('node:fs/promises').then(({ appendFile }) => appendFile(process.env.HOOK_LOG, JSON.stringify(native) + '\\n'));
let output;
if (native.hook_event_name === 'tool.execute.before') {
  output = native.tool_name === 'shell'
    ? { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'shell denied' } }
    : { hookSpecificOutput: { additionalContext: 'before context', updatedInput: { filePath: 'safe.txt' } } };
} else if (native.hook_event_name === 'tool.execute.after') {
  output = { hookSpecificOutput: { additionalContext: 'after context' } };
} else if (native.hook_event_name === 'session.experimental.idle') {
  output = { decision: 'block', reason: 'continue working' };
} else if (native.hook_event_name === 'session.created') {
  output = { hookSpecificOutput: { additionalContext: 'session context' } };
} else if (native.hook_event_name === 'session.prompt') {
  output = { decision: 'block', reason: 'prompt denied' };
}
if (output !== undefined) process.stdout.write(JSON.stringify(output));
`;

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

it('registers and applies native V2 hook outputs through the emitted structural plugin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-opencode-hooks-'));
  try {
    const selected: NormalizedPlugin = { ...model(), hooks: [{
      ...model().hooks[0]!,
      nativeTools: [{ name: 'browser_click', target: 'opencode' }],
      tools: ['shell', 'mcp', 'file.read'],
    }, ...model().hooks.slice(1)] };
    const plan = openCodeAdapter.plan(selected);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.hookEntries?.map((entry) => entry.nativeEvent).sort()).toEqual([
      'session.created',
      'session.experimental.idle',
      'session.prompt',
      'tool.execute.after',
      'tool.execute.after.error',
      'tool.execute.before',
    ]);

    await mkdir(join(root, 'hooks'), { recursive: true });
    await writeFile(join(root, 'index.js'), openCodePluginEntrySource(selected, undefined, plan.hookEntries ?? []));
    for (const entry of plan.hookEntries ?? []) {
      await writeFile(join(root, entry.relativePath), wrapperFixture);
    }
    const log = join(root, 'events.ndjson');
    process.env.HOOK_LOG = log;
    const imported = await import(pathToFileURL(join(root, 'index.js')).href);
    const callbacks = new Map<string, ((event: never) => Promise<void>)[]>();
    const registrations: { dispose(): Promise<void> }[] = [];
    const instructionEntries: Record<string, unknown>[] = [];
    const synthetic: Record<string, unknown>[] = [];
    const subscribeCalls: { types?: readonly string[]; signal?: AbortSignal }[] = [];
    const ctx = {
      location: { directory: '/workspace' },
      mcp: {
        list: async () => [{ name: 'generated-native-fixture', status: { status: 'connected' } }],
        transform: async () => ({ dispose: async () => undefined }),
      },
      skill: { transform: async () => ({ dispose: async () => undefined }) },
      command: { transform: async () => ({ dispose: async () => undefined }) },
      tool: {
        hook: async (name: string, callback: (event: never) => Promise<void>) => {
          callbacks.set(`tool.${name}`, [...callbacks.get(`tool.${name}`) ?? [], callback]);
          const registration = { dispose: async () => undefined };
          registrations.push(registration);
          return registration;
        },
      },
      session: {
        hook: async (name: string, callback: (event: never) => Promise<void>) => {
          callbacks.set(`session.${name}`, [...callbacks.get(`session.${name}`) ?? [], callback]);
          const registration = { dispose: async () => undefined };
          registrations.push(registration);
          return registration;
        },
        instructions: {
          entry: {
            put: async (entry: Record<string, unknown>) => { instructionEntries.push(entry); },
          },
        },
        synthetic: async (entry: Record<string, unknown>) => { synthetic.push(entry); },
      },
      event: {
        subscribe: (options: { types?: readonly string[]; signal?: AbortSignal }) => {
          subscribeCalls.push(options);
          return (async function* () {
            yield {
              type: 'session.created',
              data: { sessionID: 'session-native', location: { directory: '/workspace' } },
            };
            await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
          })();
        },
      },
    };
    const cleanup = await imported.default.setup(ctx);
    await flush();

    const before = {
      id: 'call-1', input: { filePath: 'unsafe.txt' }, sessionID: 'session-1', tool: 'generated-native-fixture_generated_native_echo',
    };
    await callbacks.get('tool.execute.before')![0]!(before as never);
    const nativePositive = {
      id: 'native-positive', input: { filePath: 'unsafe.txt' }, sessionID: 'session-1', tool: 'browser_click',
    };
    await callbacks.get('tool.execute.before')![0]!(nativePositive as never);
    expect(nativePositive.input).toEqual({ filePath: 'safe.txt' });
    await callbacks.get('tool.execute.before')![0]!({
      id: 'builtin-not-mcp', input: {}, sessionID: 'session-1', tool: 'opencode_session_rename',
    } as never);
    expect(before.input).toEqual({ filePath: 'safe.txt' });
    await expect(callbacks.get('tool.execute.before')![0]!({
      id: 'call-denied', input: {}, sessionID: 'session-1', tool: 'shell',
    } as never)).rejects.toThrow('shell denied');
    expect(instructionEntries).toContainEqual(expect.objectContaining({
      key: expect.stringMatching(/^agent-bundle-[0-9a-f]{24}$/u),
      sessionID: 'session-1',
      value: 'before context',
    }));

    await callbacks.get('tool.execute.after')![0]!({
      id: 'call-2', input: {}, result: { content: 'ok' }, sessionID: 'session-1', status: 'completed', tool: 'read',
    } as never);
    expect(instructionEntries).toContainEqual(expect.objectContaining({ value: 'after context' }));

    await callbacks.get('tool.execute.after')![1]!({
      error: { message: 'failed' }, id: 'call-3', input: {}, sessionID: 'session-1', status: 'error', tool: 'read',
    } as never);

    await expect(callbacks.get('session.prompt')![0]!({
      prompt: { text: 'unsafe prompt' }, sessionID: 'session-1',
    } as never)).rejects.toThrow('prompt denied');

    await callbacks.get('session.experimental.idle')![0]!({ sessionID: 'session-1' } as never);
    expect(synthetic).toEqual([expect.objectContaining({ sessionID: 'session-1', text: 'continue working' })]);
    expect(instructionEntries).toContainEqual(expect.objectContaining({
      sessionID: 'session-native',
      value: 'session context',
    }));
    expect(subscribeCalls[0]?.types).toEqual(['session.created']);

    const native = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(native.map((entry) => entry['hook_event_name']).sort()).toEqual([
      'session.created',
      'session.experimental.idle',
      'session.prompt',
      'tool.execute.after',
      'tool.execute.after.error',
      'tool.execute.before',
      'tool.execute.before',
      'tool.execute.before',
    ]);
    expect(native.some((entry) => entry['tool_use_id'] === 'builtin-not-mcp')).toBe(false);
    expect(native.find((entry) => entry['hook_event_name'] === 'session.created')).toMatchObject({
      session_id: 'session-native',
      source: 'startup',
    });

    await cleanup();
    expect(registrations.length).toBeGreaterThan(0);
  } finally {
    delete process.env.HOOK_LOG;
    await removeTree(root);
  }
}, 30_000);

it('isolates session.created hook failures per definition and keeps later sessions active', async () => {
  const selected: NormalizedPlugin = { ...model(), hooks: [
    hook('created-bad', 'sessionStart', { event: 'session/start', fallback: 'none', runtime: 'shared' }),
    hook('created-good', 'sessionStart', { event: 'session/start', fallback: 'none', runtime: 'shared' }),
  ] };
  const plan = openCodeAdapter.plan(selected);
  expect(plan.diagnostics).toEqual([]);
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-opencode-created-isolation-'));
  try {
    await mkdir(join(root, 'hooks'), { recursive: true });
    await writeFile(join(root, 'index.js'), openCodePluginEntrySource(selected, undefined, plan.hookEntries ?? []));
    await writeFile(join(root, 'hooks', 'created-bad.mjs'), 'throw new Error("intentional first hook failure");\n');
    await writeFile(join(root, 'hooks', 'created-good.mjs'), wrapperFixture);
    process.env.HOOK_LOG = join(root, 'events.ndjson');
    const plugin = await import(pathToFileURL(join(root, 'index.js')).href);
    const entries: Record<string, unknown>[] = [];
    const controller = new AbortController();
    await plugin.default.setup({
      location: { directory: '/workspace' },
      session: {
        instructions: { entry: { put: async (entry: Record<string, unknown>) => { entries.push(entry); } } },
      },
      event: {
        subscribe: (options: { signal?: AbortSignal }) => {
          options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
          return (async function* () {
            for (const sessionID of ['session-first', 'session-second']) {
              yield { type: 'session.created', data: { sessionID, location: { directory: '/workspace' } } };
            }
            await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
          })();
        },
      },
    });
    for (let attempt = 0; attempt < 200 && entries.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry['sessionID'])).toEqual(['session-first', 'session-second']);
    expect(entries.every((entry) => entry['value'] === 'session context')).toBe(true);
    expect(entries.every((entry) => /^agent-bundle-[0-9a-f]{24}$/u.test(String(entry['key'])))).toBe(true);
    controller.abort();
  } finally {
    delete process.env.HOOK_LOG;
    await removeTree(root);
  }
}, 30_000);

it('projects OpenCode payload provenance from the actual V2 envelope keys without inventing fields', () => {
  const native = {
    cwd: '/workspace',
    hook_event_name: 'tool.execute.before',
    session_id: 'ses_v2',
    tool_input: { filePath: 'movie.json' },
    tool_name: 'read',
    tool_use_id: 'call-v2',
  };
  const props = createCanonicalEventProps('tool/before', native, 'opencode', 'tool.execute.before', '2.2.6', new AbortController().signal);
  expect(props.canonical.provenance).toEqual({
    host: 'opencode',
    hostContractRevision: '2.2.6',
    nativeEvent: 'tool.execute.before',
    source: 'native',
  });
  expect(props.canonical.payload).toEqual({
    cwd: { nativeKey: 'cwd', value: '/workspace' },
    sessionId: { nativeKey: 'session_id', value: 'ses_v2' },
    toolInput: { nativeKey: 'tool_input', value: { filePath: 'movie.json' } },
    toolName: { nativeKey: 'tool_name', value: 'read' },
    toolUseId: { nativeKey: 'tool_use_id', value: 'call-v2' },
  });
  expect(() => createCanonicalEventProps('session/start', {
    hook_event_name: 'session.created',
    session_id: 'ses_v2',
    source: 'startup',
  }, 'opencode', 'session.created', '2.2.6', new AbortController().signal)).not.toThrow();
});

it('does not advertise session-end or other unrepresentable V2 event routes', () => {
  expect(openCodeAdapter.capabilities['event:session/end']?.state).toBe('unavailable');
  expect(openCodeAdapter.capabilities['event:agent/start']?.state).toBe('unavailable');
  expect(openCodeAdapter.capabilities['event:session/start']?.state).toBe('supported');
});
