import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { available } from '@agent-bundle/runtime';
import {
  createGeneratedRuntimeState,
  type GeneratedRuntimeState,
} from '@agent-bundle/runtime/mount';
import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';
import { expectDocument, renderRoute, testManifest } from 'agent-bundle/test';

import { LOG_DIR_ENV } from '../../src/log.js';
import {
  capturesStateDefinition,
  type CaptureEvents,
  type CapturesState,
} from '../../src/state.js';

const manifest = testManifest();

let stateRoot: string;
let logDir: string;
let runtimeState: GeneratedRuntimeState<CapturesState, CaptureEvents>;
let sequence = 0;

const eventInput = (
  event: 'agent/start' | 'agent/stop' | 'session/start' | 'tool/before',
  native: Record<string, unknown>,
  host = 'claude',
) => ({
  canonical: {
    event,
    idempotencyKey: `${event}:${String(sequence)}`,
    observedAt: `2026-09-03T08:00:${String(sequence++).padStart(2, '0')}.000Z`,
    provenance: {
      host,
      hostContractRevision: 'route-unit',
      nativeEvent: native.hook_event_name as string,
      source: 'native',
    },
    sequence,
  },
  native,
});

const render = async (route: string, input: unknown, sessionId = 'root-session', host = 'claude') => {
  const bindings = await runtimeState.requestBindings();
  try {
    return await renderRoute(route, {
      context: {
        host: available({ name: host }, 'native'),
        noticeLedger: bindings.noticeLedger,
        session: available({ sessionId }, 'native'),
        state: bindings.state,
        workspace: available({ root: '/repo' }, 'native'),
      },
      input,
    });
  } finally {
    await bindings.close();
  }
};

const readLogLines = async (): Promise<Record<string, unknown>[]> =>
  (await readFile(join(logDir, 'captures.ndjson'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'host-test-route-unit-'));
  logDir = join(stateRoot, 'log');
  process.env[LOG_DIR_ENV] = logDir;
  runtimeState = createGeneratedRuntimeState({
    definition: capturesStateDefinition,
    driver: createSqliteStateDriver({ root: stateRoot }),
  });
  sequence = 0;
});

afterEach(async () => {
  delete process.env[LOG_DIR_ENV];
  await runtimeState.close();
  await rm(stateRoot, { force: true, recursive: true });
});

it('compiles every canonical event family plus the MCP and CLI surfaces', () => {
  expect(manifest.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  const routes = Object.keys(manifest.routes);
  for (const family of [
    'session/start', 'session/end', 'tool/before', 'tool/after', 'tool/failure', 'stop', 'stop/failure',
    'agent/start', 'agent/stop', 'agent/idle', 'workspace/open', 'prompt/submit', 'compact/before',
    'compact/after', 'permission/request', 'permission/denied', 'file/change', 'config/change',
    'task/create', 'task/complete',
  ]) {
    expect(routes, family).toContain(`event:${family}`);
  }
  expect(routes).toEqual(expect.arrayContaining(['tool:host-test/dump', 'tool:host-test/reset', 'cli:dump']));
});

it('records the complete native envelope, the request context, and env names for every event', async () => {
  const rendered = await render('event:session/start', eventInput('session/start', {
    cwd: '/repo',
    hook_event_name: 'SessionStart',
    session_id: 'root-session',
    source: 'startup',
    transcript_path: '/tmp/transcript.jsonl',
  }));
  expectDocument(rendered).toHaveStatus('success').toContainContext('host-test probe is recording');
  expectDocument(rendered).toContainContext(join(logDir, 'captures.ndjson'));

  const [record] = await readLogLines();
  expect(record).toMatchObject({
    event: {
      canonical: { event: 'session/start', provenance: { host: 'claude', nativeEvent: 'SessionStart' } },
      native: { hook_event_name: 'SessionStart', session_id: 'root-session', source: 'startup' },
    },
    host: 'claude',
    ids: { session_id: 'root-session', source: 'startup' },
    kind: 'event',
    request: {
      hasState: true,
      host: { state: 'available', value: { name: 'claude' } },
      invocation: { kind: 'event' },
      session: { state: 'available', value: { sessionId: 'root-session' } },
    },
  });
  const env = (record as { env: { names: string[] } }).env.names;
  expect(env).toContain(LOG_DIR_ENV);
  expect(JSON.stringify(record)).not.toContain(logDir.replace('captures.ndjson', 'value-should-not-appear'));
});

it('redacts secret-looking native values but keeps ids intact', async () => {
  await render('event:tool/before', eventInput('tool/before', {
    cwd: '/repo',
    hook_event_name: 'PreToolUse',
    session_id: 'root-session',
    tool_input: { api_key: 'sk-live-abcdefghijklmnopqrstuvwxyz', command: 'pwd' },
    tool_name: 'Bash',
    tool_use_id: 'toolu_01',
    transcript_path: '/tmp/transcript.jsonl',
  }));
  const [record] = await readLogLines();
  const native = (record as { event: { native: Record<string, unknown> } }).event.native;
  expect(native.tool_input).toEqual({ api_key: '[redacted]', command: 'pwd' });
  expect(native.tool_use_id).toBe('toolu_01');
});

it('keeps a bounded durable summary and dumps by any carried id', async () => {
  await render('event:agent/start', eventInput('agent/start', {
    agent_id: 'agent-1',
    agent_type: 'general-purpose',
    cwd: '/repo',
    hook_event_name: 'SubagentStart',
    session_id: 'root-session',
    transcript_path: '/tmp/transcript.jsonl',
  }));
  await render('event:agent/stop', eventInput('agent/stop', {
    agent_id: 'agent-1',
    agent_transcript_path: null,
    agent_type: 'general-purpose',
    cwd: '/repo',
    hook_event_name: 'SubagentStop',
    last_assistant_message: null,
    session_id: 'root-session',
    stop_hook_active: false,
    transcript_path: '/tmp/transcript.jsonl',
  }));
  await render('event:session/start', eventInput('session/start', {
    cwd: '/repo',
    hook_event_name: 'SessionStart',
    session_id: 'other-session',
    source: 'startup',
    transcript_path: '/tmp/transcript.jsonl',
  }), 'other-session');

  const dumped = await render('tool:host-test/dump', { conversation: 'agent-1' });
  expectDocument(dumped).toHaveStatus('success');
  expect(dumped.document.value).toMatchObject({
    matched: 2,
    records: [
      expect.objectContaining({ event: 'agent/start', ids: expect.objectContaining({ agent_id: 'agent-1' }) }),
      expect.objectContaining({ event: 'agent/stop', ids: expect.objectContaining({ agent_id: 'agent-1' }) }),
    ],
    state: { revision: 4, state: 'available', summarized: 4, total: 4 },
    // Three events plus the dump call itself.
    total: 4,
  });

  const everything = await render('tool:host-test/dump', { full: true });
  expect(everything.document.value).toMatchObject({ matched: 5, total: 5 });
  const records = (everything.document.value as { records: Record<string, unknown>[] }).records;
  expect(records.at(-1)).toMatchObject({ kind: 'mcp', observed: { tool: 'dump' }, request: { invocation: { kind: 'tool' } } });
});

it('reset clears the log and the durable summary', async () => {
  await render('event:session/start', eventInput('session/start', {
    cwd: '/repo',
    hook_event_name: 'SessionStart',
    session_id: 'root-session',
    source: 'startup',
    transcript_path: '/tmp/transcript.jsonl',
  }));
  const reset = await render('tool:host-test/reset', {});
  expect(reset.document.value).toMatchObject({ state: 'cleared' });
  const dumped = await render('tool:host-test/dump', {});
  expect(dumped.document.value).toMatchObject({
    matched: 1,
    records: [expect.objectContaining({ kind: 'mcp' })],
    state: { state: 'available', summarized: 1, total: 1 },
  });
});
