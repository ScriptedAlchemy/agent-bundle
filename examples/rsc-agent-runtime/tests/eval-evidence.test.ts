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

type NativeEvidenceEnvelope = {
  capturedAt: string;
  claims: Array<{ basis: string; evidence: 'inferred' | 'observed' | 'unavailable'; id: string }>;
  host: 'claude' | 'codex';
  hostVersion: string;
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

const classifyEvidence = async (
  host: 'claude' | 'codex',
  result: Record<string, unknown>,
  capturedAt: string,
): Promise<NativeEvidenceEnvelope> => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/eval-evidence.mjs')).href;
  const source = [
    `import { classifyNativeEvidence } from ${JSON.stringify(moduleUrl)};`,
    `process.stdout.write(JSON.stringify(classifyNativeEvidence(${JSON.stringify(host)}, ${JSON.stringify(result)}, { capturedAt: ${JSON.stringify(capturedAt)} })));`,
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
  return JSON.parse(stdout) as NativeEvidenceEnvelope;
};

const sanitizeEnvironment = async (
  environment: Record<string, string | undefined>,
  owned: { codexHome: string; hookProbeFile: string; stateFile: string },
): Promise<Record<string, string>> => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/eval-host-environment.mjs')).href;
  const source = [
    `import { sanitizedHostEnvironment } from ${JSON.stringify(moduleUrl)};`,
    `process.stdout.write(JSON.stringify(sanitizedHostEnvironment(${JSON.stringify(environment)}, ${JSON.stringify(owned)})));`,
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
  return JSON.parse(stdout) as Record<string, string>;
};

const unavailableHostEnvelope = async (): Promise<{ capturedAt: string; hosts: NativeEvidenceEnvelope[]; schemaVersion: number }> => {
  const child = spawn(process.execPath, ['scripts/eval-hosts.mjs', '--host', 'claude'], {
    cwd: process.cwd(),
    env: { HOME: '/tmp', LANG: 'C', PATH: '', TERM: 'dumb' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const [exitCode] = (await once(child, 'close')) as [number | null];

  expect(exitCode).toBe(1);
  expect(stderr).toBe('');
  return JSON.parse(stdout) as { capturedAt: string; hosts: NativeEvidenceEnvelope[]; schemaVersion: number };
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

test('classifies complete Claude native evidence as literal claim-level observations', async () => {
  const capturedAt = '2026-08-14T20:00:00.000Z';
  const completeClaude = {
    editObservedByHook: true,
    editObservedByMcp: true,
    finalMarkerObserved: true,
    rscRenderToolObserved: true,
    sessionAvailable: true,
    version: '2.1.232',
  };

  await expect(classifyEvidence('claude', completeClaude, capturedAt)).resolves.toEqual({
    capturedAt,
    claims: [
      { basis: 'native terminal marker and loaded plugin session', evidence: 'observed', id: 'package-activation' },
      { basis: 'value-free hook launch probe exited 0', evidence: 'observed', id: 'hook-dispatch' },
      { basis: 'completed recent_edits call with native success result', evidence: 'observed', id: 'mcp-read' },
      { basis: 'completed render_edit_timeline call with native success result', evidence: 'observed', id: 'rsc-render' },
      { basis: 'hook-recorded state was returned by recent_edits', evidence: 'observed', id: 'shared-hook-mcp-state' },
      { basis: 'Claude Code CLI is not an MCP Apps iframe host', evidence: 'unavailable', id: 'mcp-app-iframe' },
    ],
    host: 'claude',
    hostVersion: '2.1.232',
  });
});

test('keeps Codex hook claims unavailable under exec ephemeral despite completed MCP calls', async () => {
  const capturedAt = '2026-08-14T20:00:00.000Z';
  const incompleteCodex = {
    editObservedByHook: true,
    editObservedByMcp: true,
    finalMarkerObserved: true,
    rscRenderToolObserved: true,
    sessionAvailable: true,
    version: '0.147.0',
  };

  await expect(classifyEvidence('codex', incompleteCodex, capturedAt)).resolves.toEqual({
    capturedAt,
    claims: [
      { basis: 'native terminal marker and loaded plugin session', evidence: 'observed', id: 'package-activation' },
      { basis: 'Codex exec --ephemeral does not prove native hook dispatch', evidence: 'unavailable', id: 'hook-dispatch' },
      { basis: 'completed recent_edits call with native success result', evidence: 'observed', id: 'mcp-read' },
      { basis: 'completed render_edit_timeline call with native success result', evidence: 'observed', id: 'rsc-render' },
      { basis: 'Codex exec --ephemeral has no native hook-recorded state correlation', evidence: 'unavailable', id: 'shared-hook-mcp-state' },
      { basis: 'Codex CLI is not an MCP Apps iframe host', evidence: 'unavailable', id: 'mcp-app-iframe' },
    ],
    host: 'codex',
    hostVersion: '0.147.0',
  });
});

test('keeps unavailable-host claims bounded and removes ambient credentials from child environments', async () => {
  const capturedAt = '2026-08-14T20:00:00.000Z';
  const missing = await classifyEvidence('claude', {}, capturedAt);
  expect(missing).toEqual({
    capturedAt,
    claims: [
      { basis: 'installed host/version/session unavailable', evidence: 'unavailable', id: 'package-activation' },
      { basis: 'installed host/version/session unavailable', evidence: 'unavailable', id: 'hook-dispatch' },
      { basis: 'installed host/version/session unavailable', evidence: 'unavailable', id: 'mcp-read' },
      { basis: 'installed host/version/session unavailable', evidence: 'unavailable', id: 'rsc-render' },
      { basis: 'installed host/version/session unavailable', evidence: 'unavailable', id: 'shared-hook-mcp-state' },
      { basis: 'Claude Code CLI is not an MCP Apps iframe host', evidence: 'unavailable', id: 'mcp-app-iframe' },
    ],
    host: 'claude',
    hostVersion: 'unavailable',
  });
  expect(JSON.stringify(missing)).not.toMatch(/secret|auth|prompt|transcript|\/private/iu);

  const environment = {
    ANTHROPIC_API_KEY: 'anthropic-secret',
    ANTHROPIC_AUTH_TOKEN: 'anthropic-auth',
    ANTHROPIC_BASE_URL: 'https://private.example',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    EXAMPLE_API_KEY: 'example-secret',
    LANG: 'en_US.UTF-8',
    NODE_OPTIONS: '--require /private/module.cjs',
    NODE_PATH: '/private/modules',
    OPENAI_API_KEY: 'openai-secret',
    PATH: '/safe/bin',
    TERM: 'xterm-256color',
    openai_api_key: 'case-insensitive-secret',
  };
  const before = { ...environment };
  await expect(sanitizeEnvironment(environment, {
    codexHome: '/tmp/owned-codex-home',
    hookProbeFile: '/tmp/owned-hook-probe.jsonl',
    stateFile: '/tmp/owned-state.jsonl',
  })).resolves.toEqual({
    AGENT_RUNTIME_HOOK_PROBE_FILE: '/tmp/owned-hook-probe.jsonl',
    AGENT_RUNTIME_STATE_FILE: '/tmp/owned-state.jsonl',
    CODEX_HOME: '/tmp/owned-codex-home',
    LANG: 'en_US.UTF-8',
    PATH: '/safe/bin',
    TERM: 'xterm-256color',
  });
  expect(environment).toEqual(before);
});

test('emits one schema-v2 envelope and fails truthfully when the selected native host is unavailable', async () => {
  const envelope = await unavailableHostEnvelope();

  expect(Object.keys(envelope).sort()).toEqual(['capturedAt', 'hosts', 'schemaVersion']);
  expect(envelope.schemaVersion).toBe(2);
  expect(envelope.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(envelope.hosts).toEqual([
    {
      capturedAt: envelope.capturedAt,
      claims: [
        { basis: 'installed host/version/session unavailable', evidence: 'unavailable', id: 'package-activation' },
        { basis: 'installed host/version/session unavailable', evidence: 'unavailable', id: 'hook-dispatch' },
        { basis: 'installed host/version/session unavailable', evidence: 'unavailable', id: 'mcp-read' },
        { basis: 'installed host/version/session unavailable', evidence: 'unavailable', id: 'rsc-render' },
        { basis: 'installed host/version/session unavailable', evidence: 'unavailable', id: 'shared-hook-mcp-state' },
        { basis: 'Claude Code CLI is not an MCP Apps iframe host', evidence: 'unavailable', id: 'mcp-app-iframe' },
      ],
      host: 'claude',
      hostVersion: 'unavailable',
    },
  ]);
});
