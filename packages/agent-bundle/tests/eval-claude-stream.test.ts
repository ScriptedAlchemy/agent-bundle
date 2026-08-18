import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

import { EvalHarnessError } from '../src/eval/errors.ts';
import { normalizeClaudeStream } from '../src/eval/claude-stream.ts';

const readStreamFixture = async (name: string): Promise<string> =>
  readFile(new URL(`../fixtures/eval/claude/${name}.jsonl`, import.meta.url), 'utf8');

const candidate = Object.freeze({ plugin: 'review-tools', skills: Object.freeze(['review-change']) });

it('maps an authoritative Skill tool event to observed activation evidence', async () => {
  const normalized = normalizeClaudeStream(await readStreamFixture('activation-observed'), candidate);

  expect(normalized.activation).toEqual({
    activated: ['review-change', 'review-tools:review-change'],
    level: 'observed',
  });
  expect(normalized.mcpCalls).toEqual([{ server: 'project', tool: 'status_report' }]);
  expect(normalized.mcpServers).toEqual(['project']);
  expect(normalized.plugins).toEqual(['review-tools']);
  expect(normalized.hookEvents).toEqual(['PreToolUse']);
  expect(normalized.errorKinds).toEqual([]);
  expect(normalized.finalResponse).toBe('The highest-risk regression is the unguarded cache eviction.');
  expect(normalized.resultSubtype).toBe('success');
  expect(normalized.usage).toEqual({
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 3,
    costUsd: 0.0125,
    durationMs: 1200,
    inputTokens: 16,
    outputTokens: 6,
    turns: 3,
  });
  expect(normalized.trace).toEqual([
    { index: 0, kind: 'init', skills: [], subtype: 'init', tools: [], type: 'system' },
    {
      index: 1,
      kind: 'assistant',
      skills: ['review-tools:review-change'],
      tools: ['Skill'],
      type: 'assistant',
    },
    { index: 2, kind: 'tool-result', skills: [], tools: [], type: 'user' },
    { index: 3, kind: 'hook', skills: [], subtype: 'hook_completed', tools: [], type: 'system' },
    { index: 4, kind: 'assistant', skills: [], tools: ['mcp__project__status_report'], type: 'assistant' },
    { index: 5, kind: 'result', skills: [], subtype: 'success', tools: [], type: 'result' },
  ]);
});

it('keeps a weaker plugin-material signal at inferred evidence even when the trace is complete', async () => {
  const normalized = normalizeClaudeStream(await readStreamFixture('activation-inferred'), candidate);

  expect(normalized.activation).toEqual({ activated: ['review-change'], level: 'inferred' });
  expect(normalized.resultSubtype).toBe('success');
  expect(normalized.finalResponse).toBe('Reviewed the change.');
});

it('never upgrades an inferred signal when an authoritative event names a different Skill', () => {
  const stream = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Consulting review-change."},{"type":"tool_use","name":"Skill","input":{"skill":"review-tools:summarize"}}]}}',
    '{"type":"result","subtype":"success","result":"done"}',
  ].join('\n');

  expect(normalizeClaudeStream(stream, candidate).activation).toEqual({
    activated: ['review-tools:summarize', 'summarize'],
    level: 'observed',
  });
});

it('reports a complete trace without any Skill signal as observed non-activation', async () => {
  const normalized = normalizeClaudeStream(await readStreamFixture('no-activation'), candidate);

  expect(normalized.activation).toEqual({ activated: [], level: 'observed' });
  expect(normalized.incompleteTrailingRecord).toBeUndefined();
});

it('downgrades a truncated trace to inferred and reports one incomplete trailing record', async () => {
  const normalized = normalizeClaudeStream(await readStreamFixture('truncated'), candidate);

  expect(normalized.activation).toEqual({ activated: [], level: 'inferred' });
  expect(normalized.incompleteTrailingRecord).toBe('{"type":"assistant","message":{"content":[{"type":"tool_');
  expect(normalized.resultSubtype).toBeUndefined();
  expect(normalized.finalResponse).toBe('Starting the review.');
  expect(normalized.usage).toEqual({
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputTokens: 4,
    outputTokens: 2,
    turns: 0,
  });
});

it('records host error envelopes and an unloaded plugin without retaining error text', async () => {
  const normalized = normalizeClaudeStream(await readStreamFixture('plugin-error'), candidate);

  expect(normalized.errorKinds).toEqual(['plugin_load_failed', 'result:error_during_execution']);
  expect(normalized.plugins).toEqual([]);
  expect(normalized.pluginsReported).toBe(true);
  expect(normalized.mcpServers).toEqual(['project']);
  expect(JSON.stringify(normalized.trace)).not.toContain('message');
});

it('splits MCP tool names into server and tool and ignores host tools', () => {
  const stream = [
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__project__status"},{"type":"tool_use","name":"Bash"},{"type":"tool_use","name":"mcp__project__deep__probe"},{"type":"tool_use","name":"mcp__project"}]}}',
    '{"type":"result","subtype":"success","result":"done"}',
  ].join('\n');

  expect(normalizeClaudeStream(stream).mcpCalls).toEqual([
    { server: 'project', tool: 'status' },
    { server: 'project', tool: 'deep__probe' },
  ]);
});

it('rejects a malformed record that is not the trailing line as an unusable trace', () => {
  const stream = ['not json', '{"type":"result","subtype":"success"}'].join('\n');

  expect(() => normalizeClaudeStream(stream)).toThrow(EvalHarnessError);
  expect(() => normalizeClaudeStream(stream)).toThrow(/EVAL_HARNESS_INPUT_INVALID|not a JSON object|could not be parsed/iu);
});

it('reports an empty stream as unavailable activation evidence', () => {
  const normalized = normalizeClaudeStream('   \n');

  expect(normalized.activation).toEqual({ activated: [], level: 'unavailable' });
  expect(normalized.trace).toEqual([]);
  expect(normalized.finalResponse).toBe('');
});
