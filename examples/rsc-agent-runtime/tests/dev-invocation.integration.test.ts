import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import { expect, test } from '@rstest/core';

import { createRscRuntimeRsbuildConfig } from '../rsbuild.config.js';

const readChildOutput = (stream: NodeJS.ReadableStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks)));
  });

const invoke = async (entry: string, request: Record<string, unknown>) => {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(JSON.stringify(request));

  const [stdout, stderr, exitCode] = await Promise.all([
    readChildOutput(child.stdout),
    readChildOutput(child.stderr),
    new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }),
  ]);

  return { exitCode, stderr: stderr.toString('utf8'), stdout };
};

const inspectionShape = (result: { inspection: Record<string, unknown> }) => {
  const { flight: _flight, ...inspection } = result.inspection;
  return inspection;
};

const assertJsonOnly = (value: unknown): void => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return;
  expect(typeof value).not.toBe('function');
  expect(typeof value).not.toBe('symbol');
  if (Array.isArray(value)) {
    value.forEach(assertJsonOnly);
    return;
  }
  expect(value).toBeTypeOf('object');
  Object.values(value as Record<string, unknown>).forEach(assertJsonOnly);
};

test('builds a generation-contained inspection entry for Claude, Codex, and MCP fixtures', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-invoke-'));
  const workspace = join(compilerRoot, 'workspace');
  const request = {
    host: 'claude',
    input: {
      cwd: workspace,
      hook_event_name: 'PostToolUse',
      session_id: 'claude-session',
      tool_input: { file_path: 'demo.txt' },
      tool_name: 'Write',
    },
    stateStoreId: 'fixture-state',
    type: 'hook/after-file-edit',
  };

  try {
    const rsbuild = await createRsbuild({
      config: createRscRuntimeRsbuildConfig({ compilerRoot, mode: 'development' }),
      cwd: process.cwd(),
    });
    await rsbuild.build();

    const entry = join(compilerRoot, 'rsc', 'dev', 'invoke.js');
    const first = await invoke(entry, { ...request, stateFile: join(compilerRoot, 'first.jsonl') });
    const second = await invoke(entry, { ...request, stateFile: join(compilerRoot, 'second.jsonl') });

    expect(first).toMatchObject({ exitCode: 0, stderr: '' });
    expect(second).toMatchObject({ exitCode: 0, stderr: '' });
    expect(first.stdout.byteLength).toBeLessThan(1024 * 1024);
    expect(first.stdout.toString('utf8')).toMatch(/^\{[^\n]+\}\n$/u);

    const firstResult = JSON.parse(first.stdout.toString('utf8')) as {
      flightBase64: string;
      inspection: Record<string, unknown>;
    };
    const secondResult = JSON.parse(second.stdout.toString('utf8')) as typeof firstResult;
    expect(inspectionShape(secondResult)).toEqual(inspectionShape(firstResult));
    expect(firstResult.flightBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    assertJsonOnly(firstResult);
    expect(firstResult.inspection).toMatchObject({
      agentVisible: 'Recorded demo.txt from claude. Shared state now contains 1 edit.',
      native: {
        hookSpecificOutput: {
          additionalContext: 'Recorded demo.txt from claude. Shared state now contains 1 edit.',
          hookEventName: 'PostToolUse',
        },
      },
      state: { identity: { stateStoreId: 'fixture-state', stateVersion: 1 } },
      trace: [
        { id: 'normalize', phase: 'normalize', status: 'succeeded' },
        { id: 'worker', phase: 'worker', status: 'succeeded' },
        { id: 'flight', phase: 'flight', status: 'succeeded' },
        { id: 'decode', phase: 'decode', status: 'succeeded' },
        { id: 'lower', phase: 'lower', status: 'succeeded' },
      ],
      tree: [
        {
          children: [
            {
              children: [
                { children: [], id: 'node-2', kind: 'text', label: 'Recorded demo.txt from claude. Shared state now contains 1 edit.' },
              ],
              id: 'node-1',
              kind: 'element',
              label: 'agent-hook-additional-context',
            },
          ],
          id: 'node-0',
          kind: 'element',
          label: 'agent-hook-result',
        },
      ],
    });

    const codex = await invoke(entry, {
      host: 'codex',
      input: {
        cwd: workspace,
        hook_event_name: 'PostToolUse',
        session_id: 'codex-session',
        tool_input: { command: '*** Begin Patch\n*** Add File: codex.txt\n+content\n*** End Patch' },
        tool_name: 'apply_patch',
      },
      stateFile: join(compilerRoot, 'codex.jsonl'),
      stateStoreId: 'fixture-state',
      type: 'hook/after-file-edit',
    });
    expect(codex).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(codex.stdout.toString('utf8'))).toMatchObject({
      inspection: {
        agentVisible: 'Recorded codex.txt from codex. Shared state now contains 1 edit.',
        native: {
          hookSpecificOutput: {
            additionalContext: 'Recorded codex.txt from codex. Shared state now contains 1 edit.',
            hookEventName: 'PostToolUse',
          },
        },
      },
    });

    const status = await invoke(entry, {
      stateFile: join(compilerRoot, 'first.jsonl'),
      stateStoreId: 'fixture-state',
      type: 'mcp/runtime-status',
    });
    expect(status).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(status.stdout.toString('utf8'))).toMatchObject({
      inspection: {
        modelVisible: [
          { text: 'Runtime state contains 1 edit.', type: 'text' },
          {
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
            mimeType: 'image/png',
            type: 'image',
          },
        ],
        protocol: {
          content: [
            { text: 'Runtime state contains 1 edit.', type: 'text' },
            {
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
              mimeType: 'image/png',
              type: 'image',
            },
          ],
          structuredContent: { editCount: 1, stateVersion: 1 },
        },
        state: { identity: { stateStoreId: 'fixture-state', stateVersion: 1 } },
      },
    });
  } finally {
    await rm(compilerRoot, { force: true, recursive: true });
  }
});
