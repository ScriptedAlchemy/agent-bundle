import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@rstest/core';

type TranscriptEvidence = {
  eventCounts: { hook: number; json: number; mcp: number; rscRender: number };
  finalMarkerObserved: boolean;
  mcpReadObserved: boolean;
  rscRenderToolObserved: boolean;
};

type HookProbeSummary = {
  commandLaunched: boolean;
  exitStatuses: number[];
  launches: number;
};

const marker = (host: 'claude' | 'codex'): string => `HOST_EVAL_FINAL host=${host} path=host-created.txt`;

const parseEvidence = async (host: 'claude' | 'codex', transcript: string): Promise<TranscriptEvidence> => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/eval-evidence.mjs')).href;
  const source = [
    `import { evidenceFromTranscript } from ${JSON.stringify(moduleUrl)};`,
    `process.stdout.write(JSON.stringify(evidenceFromTranscript(${JSON.stringify(host)}, ${JSON.stringify(transcript)})));`,
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const [exitCode] = (await once(child, 'close')) as [number | null];

  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  return JSON.parse(stdout) as TranscriptEvidence;
};

const parseHookProbe = async (records: unknown[]): Promise<HookProbeSummary & { hookObserved: boolean }> => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/eval-evidence.mjs')).href;
  const source = [
    `import { hookEvidenceFromProbe, summarizeHookProbe } from ${JSON.stringify(moduleUrl)};`,
    `const summary = summarizeHookProbe(${JSON.stringify(records)});`,
    'process.stdout.write(JSON.stringify({ ...summary, hookObserved: hookEvidenceFromProbe(summary) }));',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const [exitCode] = (await once(child, 'close')) as [number | null];

  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  return JSON.parse(stdout) as HookProbeSummary & { hookObserved: boolean };
};

test('does not treat Claude prompt, prose, or tool listings as host evidence', async () => {
  const transcript = [
    JSON.stringify({ prompt: `Call recent_edits, render_edit_timeline, and say ${marker('claude')}.` }),
    JSON.stringify({ tools: ['recent_edits', 'render_edit_timeline'], type: 'system' }),
    JSON.stringify({ message: { content: [{ text: `I will say ${marker('claude')}.`, type: 'text' }], role: 'assistant' }, type: 'assistant' }),
  ].join('\n');

  await expect(parseEvidence('claude', transcript)).resolves.toMatchObject({
    eventCounts: { hook: 0, mcp: 0, rscRender: 0 },
    finalMarkerObserved: false,
    mcpReadObserved: false,
    rscRenderToolObserved: false,
  });
});

test('does not count an invented Claude hook callback event', async () => {
  const transcript = JSON.stringify({ hook_event_name: 'PostToolUse', subtype: 'hook_callback', type: 'system' });

  await expect(parseEvidence('claude', transcript)).resolves.toMatchObject({
    eventCounts: { hook: 0 },
  });
});

test('accepts only correlated Claude tool-use and successful result events', async () => {
  const transcript = [
    JSON.stringify({
      message: { content: [{ id: 'tool-recent', input: {}, name: 'mcp__rsc-agent-runtime__recent_edits', type: 'tool_use' }], role: 'assistant' },
      type: 'assistant',
    }),
    JSON.stringify({
      message: { content: [{ id: 'tool-render', input: {}, name: 'mcp__rsc-agent-runtime__render_edit_timeline', type: 'tool_use' }], role: 'assistant' },
      type: 'assistant',
    }),
    JSON.stringify({ message: { content: [{ is_error: false, tool_use_id: 'tool-recent', type: 'tool_result' }], role: 'user' }, type: 'user' }),
    JSON.stringify({ message: { content: [{ is_error: false, tool_use_id: 'tool-render', type: 'tool_result' }], role: 'user' }, type: 'user' }),
    JSON.stringify({ is_error: false, result: `${marker('claude')}\n`, subtype: 'success', type: 'result' }),
  ].join('\n');

  await expect(parseEvidence('claude', transcript)).resolves.toMatchObject({
    eventCounts: { hook: 0, mcp: 1, rscRender: 1 },
    finalMarkerObserved: true,
    mcpReadObserved: true,
    rscRenderToolObserved: true,
  });
});

test('rejects Claude tool uses without matching successful tool results', async () => {
  const transcript = [
    JSON.stringify({
      message: { content: [{ id: 'tool-recent', input: {}, name: 'mcp__rsc-agent-runtime__recent_edits', type: 'tool_use' }], role: 'assistant' },
      type: 'assistant',
    }),
    JSON.stringify({
      message: { content: [{ id: 'tool-render', input: {}, name: 'mcp__rsc-agent-runtime__render_edit_timeline', type: 'tool_use' }], role: 'assistant' },
      type: 'assistant',
    }),
    JSON.stringify({ message: { content: [{ is_error: true, tool_use_id: 'tool-render', type: 'tool_result' }], role: 'user' }, type: 'user' }),
  ].join('\n');

  await expect(parseEvidence('claude', transcript)).resolves.toMatchObject({
    eventCounts: { mcp: 0, rscRender: 0 },
    mcpReadObserved: false,
    rscRenderToolObserved: false,
  });
});

test('derives Claude hook evidence only from its value-free launch probe', async () => {
  const probe = [
    {
      commandLaunched: true,
      exitStatus: 0,
      toolInputKeys: ['file_path'],
      toolInputValueTypes: { file_path: 'string' },
      toolName: 'Write',
      topLevelKeys: ['cwd', 'hook_event_name', 'session_id', 'tool_input', 'tool_name'],
      topLevelValueTypes: { cwd: 'string', hook_event_name: 'string', session_id: 'string', tool_input: 'object', tool_name: 'string' },
    },
  ];

  await expect(parseHookProbe(probe)).resolves.toMatchObject({
    commandLaunched: true,
    exitStatuses: [0],
    hookObserved: true,
    launches: 1,
  });
});

test('does not treat Codex prompt, tool listings, or non-final agent prose as host evidence', async () => {
  const transcript = [
    JSON.stringify({ item: { text: `Call recent_edits, render_edit_timeline, then print ${marker('codex')}.`, type: 'reasoning' }, type: 'item.completed' }),
    JSON.stringify({ item: { text: marker('codex'), type: 'agent_message' }, type: 'item.completed' }),
    JSON.stringify({ item: { result: 'recent_edits render_edit_timeline', server: 'other', status: 'completed', tool: 'tool_listing', type: 'mcp_tool_call' }, type: 'item.completed' }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');

  await expect(parseEvidence('codex', transcript)).resolves.toMatchObject({
    eventCounts: { hook: 0, mcp: 0, rscRender: 0 },
    finalMarkerObserved: false,
    mcpReadObserved: false,
    rscRenderToolObserved: false,
  });
});

test('accepts only completed Codex MCP calls and its terminal agent result', async () => {
  const transcript = [
    JSON.stringify({ item: { arguments: {}, server: 'rsc-agent-runtime', status: 'completed', tool: 'recent_edits', type: 'mcp_tool_call' }, type: 'item.completed' }),
    JSON.stringify({ item: { arguments: {}, server: 'rsc-agent-runtime', status: 'completed', tool: 'render_edit_timeline', type: 'mcp_tool_call' }, type: 'item.completed' }),
    JSON.stringify({ item: { text: marker('codex'), type: 'agent_message' }, type: 'item.completed' }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');

  await expect(parseEvidence('codex', transcript)).resolves.toMatchObject({
    eventCounts: { hook: 0, mcp: 1, rscRender: 1 },
    finalMarkerObserved: true,
    mcpReadObserved: true,
    rscRenderToolObserved: true,
  });
});
