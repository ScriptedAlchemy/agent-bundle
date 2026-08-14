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

test('accepts only discriminated Claude hook, tool-use, and successful result events', async () => {
  const transcript = [
    JSON.stringify({ hook_event_name: 'PostToolUse', subtype: 'hook_callback', type: 'system' }),
    JSON.stringify({
      message: { content: [{ input: {}, name: 'mcp__rsc-agent-runtime__recent_edits', type: 'tool_use' }], role: 'assistant' },
      type: 'assistant',
    }),
    JSON.stringify({
      message: { content: [{ input: {}, name: 'mcp__rsc-agent-runtime__render_edit_timeline', type: 'tool_use' }], role: 'assistant' },
      type: 'assistant',
    }),
    JSON.stringify({ is_error: false, result: `${marker('claude')}\n`, subtype: 'success', type: 'result' }),
  ].join('\n');

  await expect(parseEvidence('claude', transcript)).resolves.toMatchObject({
    eventCounts: { hook: 1, mcp: 1, rscRender: 1 },
    finalMarkerObserved: true,
    mcpReadObserved: true,
    rscRenderToolObserved: true,
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
