import { afterEach, describe, expect, it } from '@rstest/core';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-hook-'));
  temporaryDirectories.push(directory);
  return directory;
};

const runHook = async (host: 'claude' | 'codex', input: Record<string, unknown>, stateFile: string) => {
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/runtime/hook/index.js'), '--host', host], {
    env: { ...process.env, AGENT_RUNTIME_STATE_FILE: stateFile },
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

    const events = (await readFile(stateFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events.map((event) => event.host)).toEqual(['claude', 'codex']);
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
});
