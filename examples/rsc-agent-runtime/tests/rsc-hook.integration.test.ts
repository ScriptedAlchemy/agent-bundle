import { afterEach, describe, expect, it } from '@rstest/core';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { normalizeClaudeHook, normalizeCodexHook } from '../src/hook/normalize.js';

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-hook-'));
  temporaryDirectories.push(directory);
  return directory;
};

const runHook = async (
  host: 'claude' | 'codex',
  input: Record<string, unknown>,
  stateFile: string | undefined,
  additionalEnvironment: Record<string, string> = {},
) => {
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/runtime/hook/index.js'), '--host', host], {
    env: {
      ...process.env,
      ...(stateFile === undefined ? {} : { AGENT_RUNTIME_STATE_FILE: stateFile }),
      ...additionalEnvironment,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.end(JSON.stringify(input));

  const [stdout, stderr, exitCode] = await Promise.all([
    new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
      });
      child.stdout.on('error', reject);
      child.stdout.on('end', () => resolve(output));
    }),
    new Promise<string>((resolve, reject) => {
      let output = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        output += chunk;
      });
      child.stderr.on('error', reject);
      child.stderr.on('end', () => resolve(output));
    }),
    new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    }),
  ]);

  return { exitCode, stderr, stdout };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('built RSC hook entry', () => {
  it('uses native tool ids before host event ids for durable mutation idempotency', () => {
    expect(
      normalizeClaudeHook({
        cwd: '/workspace',
        event_id: 'event-1',
        hook_event_name: 'PostToolUse',
        session_id: 'session-1',
        tool_input: { file_path: 'demo.txt' },
        tool_name: 'Write',
        tool_use_id: 'tool-1',
      }),
    ).toMatchObject({ idempotencyKey: 'claude:tool:tool-1' });
    expect(
      normalizeCodexHook({
        cwd: '/workspace',
        event_id: 'event-2',
        hook_event_name: 'PostToolUse',
        session_id: 'session-1',
        tool_input: { command: '*** Begin Patch\n*** Add File: demo.txt\n+demo\n*** End Patch' },
        tool_name: 'apply_patch',
      }),
    ).toMatchObject({ idempotencyKey: 'codex:event:event-2' });
    expect(() =>
      normalizeClaudeHook({
        cwd: '/workspace',
        hook_event_name: 'PostToolUse',
        session_id: 'session-1',
        tool_input: { file_path: 'demo.txt' },
        tool_name: 'Write',
      }),
    ).toThrow('tool_use_id or event_id');
  });

  it('renders native Claude and Codex outputs through Flight while retaining file-backed state', async () => {
    const workspace = await createTemporaryDirectory();
    const stateFile = join(workspace, 'state.jsonl');

    const first = await runHook(
      'claude',
      {
        session_id: 'claude-session',
        cwd: workspace,
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: `${workspace}/demo.txt`, content: 'hello\n' },
        tool_response: { success: true },
        tool_use_id: 'tool-1',
      },
      stateFile,
    );

    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Recorded demo.txt from claude. Shared state now contains 1 edit.',
      },
    });

    const replay = await runHook(
      'claude',
      {
        session_id: 'claude-session',
        cwd: workspace,
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: `${workspace}/demo.txt`, content: 'hello\n' },
        tool_response: { success: true },
        tool_use_id: 'tool-1',
      },
      stateFile,
    );
    expect(replay.exitCode).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Recorded demo.txt from claude. Shared state now contains 1 edit.',
      },
    });

    const second = await runHook(
      'codex',
      {
        session_id: 'codex-session',
        cwd: workspace,
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch\n*** Add File: second.txt\n+second\n*** End Patch' },
        tool_response: { success: true },
        tool_use_id: 'tool-2',
      },
      stateFile,
    );

    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Recorded second.txt from codex. Shared state now contains 2 edits.',
      },
    });

    const records = (await readFile(stateFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.map((record) => record.event.host)).toEqual(['claude', 'codex']);
    expect(records.map((record) => record.idempotencyKey)).toEqual(['claude:tool:tool-1', 'codex:tool:tool-2']);
  });

  it('rejects unsupported native hook input without writing stdout', async () => {
    const workspace = await createTemporaryDirectory();
    const result = await runHook(
      'claude',
      {
        session_id: 'claude-session',
        cwd: workspace,
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: `${workspace}/demo.txt` },
      },
      join(workspace, 'state.jsonl'),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('falls back to the workspace state file when a native host omits the configured environment', async () => {
    const workspace = await createTemporaryDirectory();
    const result = await runHook(
      'codex',
      {
        session_id: 'codex-session',
        cwd: workspace,
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch\n*** Add File: fallback.txt\n+fallback\n*** End Patch' },
        event_id: 'fallback-event-1',
      },
      undefined,
    );

    expect(result.exitCode).toBe(0);
    const stateFile = join(workspace, '.agent-runtime-demo', 'events.jsonl');
    expect((await readFile(stateFile, 'utf8')).trim()).toContain('fallback.txt');
  });

  it('emits only a value-free optional eval hook probe', async () => {
    const workspace = await createTemporaryDirectory();
    const probeFile = join(workspace, 'hook-probe.jsonl');
    const result = await runHook(
      'codex',
      {
        session_id: 'codex-session',
        cwd: workspace,
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch\n*** Add File: secret.txt\n+do-not-persist-this-value\n*** End Patch' },
        event_id: 'probe-event-1',
      },
      join(workspace, 'state.jsonl'),
      { AGENT_RUNTIME_HOOK_PROBE_FILE: probeFile },
    );

    expect(result.exitCode).toBe(0);
    const probe = JSON.parse(await readFile(probeFile, 'utf8'));
    expect(probe).toEqual({
      commandLaunched: true,
      exitStatus: 0,
      toolInputKeys: ['command'],
      toolInputValueTypes: { command: 'string' },
      toolName: 'apply_patch',
      topLevelKeys: ['cwd', 'event_id', 'hook_event_name', 'session_id', 'tool_input', 'tool_name'],
      topLevelValueTypes: { cwd: 'string', event_id: 'string', hook_event_name: 'string', session_id: 'string', tool_input: 'object', tool_name: 'string' },
    });
    expect(await readFile(probeFile, 'utf8')).not.toContain('do-not-persist-this-value');
  });
});
