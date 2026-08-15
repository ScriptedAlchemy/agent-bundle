import { afterEach, describe, expect, it } from '@rstest/core';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

const runRscWorker = async (request: Record<string, unknown>) => {
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/runtime/rsc/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify(request));
  const [stdout, exitCode] = await Promise.all([
    new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
      });
      child.stdout.on('error', reject);
      child.stdout.on('end', () => resolve(output));
    }),
    new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    }),
  ]);
  return { exitCode, stdout };
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

  it('rejects every empty RSC mutation field before creating state', async () => {
    const workspace = await createTemporaryDirectory();
    for (const emptyField of ['cwd', 'idempotencyKey', 'path', 'sessionId', 'toolName']) {
      const stateFile = join(workspace, `${emptyField}.jsonl`);
      const event = {
        cwd: workspace,
        host: 'claude',
        idempotencyKey: 'claude:tool:worker-fields',
        path: join(workspace, 'demo.txt'),
        sessionId: 'session-1',
        toolName: 'Write',
        [emptyField]: '',
      };
      const result = await runRscWorker({ event, stateFile, type: 'hook/after-file-edit' });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      await expect(readFile(stateFile, 'utf8')).rejects.toThrow();
    }
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

  it('falls back to tool-owned external state when a native host omits the configured environment', async () => {
    const workspace = await createTemporaryDirectory();
    const stateHome = await createTemporaryDirectory();
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
      { XDG_STATE_HOME: stateHome },
    );

    expect(result.exitCode).toBe(0);
    const workspaceId = createHash('sha256').update(await realpath(workspace)).digest('hex');
    const stateFile = join(stateHome, 'agent-bundle', 'rsc-agent-runtime', workspaceId, 'events.jsonl');
    expect((await readFile(stateFile, 'utf8')).trim()).toContain('fallback.txt');
    await expect(access(join(workspace, '.agent-runtime-demo'))).rejects.toThrow();
  });

  it('ignores workspace fallback symlink swaps and never modifies their external target', async () => {
    const workspace = await createTemporaryDirectory();
    const external = await createTemporaryDirectory();
    const stateHome = await createTemporaryDirectory();
    const externalState = join(external, 'events.jsonl');
    await writeFile(externalState, '', 'utf8');
    const workspaceFallback = join(workspace, '.agent-runtime-demo');
    let keepSwapping = true;
    const swapper = (async () => {
      while (keepSwapping) {
        await rm(workspaceFallback, { force: true, recursive: true });
        await mkdir(workspaceFallback);
        await rm(workspaceFallback, { force: true, recursive: true });
        await symlink(external, workspaceFallback, 'dir');
      }
    })();

    let result: Awaited<ReturnType<typeof runHook>>;
    try {
      result = await runHook(
        'codex',
        {
          session_id: 'codex-session',
          cwd: workspace,
          event_id: 'symlink-fallback-event',
          hook_event_name: 'PostToolUse',
          tool_name: 'apply_patch',
          tool_input: { command: '*** Begin Patch\n*** Add File: protected.txt\n+protected\n*** End Patch' },
        },
        undefined,
        { XDG_STATE_HOME: stateHome },
      );
    } finally {
      keepSwapping = false;
      await swapper;
    }

    expect(result.exitCode).toBe(0);
    await expect(readFile(externalState, 'utf8')).resolves.toBe('');
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
