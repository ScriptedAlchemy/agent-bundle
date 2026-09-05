import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@rstest/core';

import { createFileRuntimeKernel } from '../src/runtime/state-file.js';
import { ensureExampleBuilt } from './support/ensure-built.js';

// This is the ordinary-CI micro-eval spot-check (`npm run eval:spot`): one
// deterministic pass over the built production artifacts, with no real Claude
// or Codex host. It proves the end-to-end runtime path in a small way: a
// native-shaped hook event renders through the compiled semantic event route
// into the framework state kernel's workspace-durable sqlite store (#98), a second hook process
// replaying the same native tool id commits nothing new, and the MCP server
// then RSC-lowers that same shared state for a tool call while linking the
// MCP App resource.
test('micro-eval spot-check: built hook and MCP server share one RSC-rendered runtime', async () => {
  await ensureExampleBuilt();
  const workspace = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-micro-eval-'));
  const stateFile = join(workspace, 'state.sqlite');
  const client = new Client({ name: 'rsc-agent-runtime-micro-eval', version: '1.0.0' });
  const transport = new StdioClientTransport({
    args: [join(process.cwd(), 'dist/runtime/mcp/stdio.js')],
    command: process.execPath,
    env: { ...process.env, AGENT_RUNTIME_STATE_FILE: stateFile },
    stderr: 'pipe',
  });

  const runHookOnce = async (): Promise<void> => {
    const hook = spawn(process.execPath, [join(process.cwd(), 'dist/plugins/hooks/event-route-tool-after.claude.mjs')], {
      env: { ...process.env, AGENT_RUNTIME_STATE_FILE: stateFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    hook.stdin.end(JSON.stringify({
      cwd: workspace,
      hook_event_name: 'PostToolUse',
      session_id: 'micro-eval-session',
      tool_input: { content: 'micro-eval\n', file_path: join(workspace, 'spot-check.txt') },
      tool_name: 'Write',
      tool_response: { success: true },
      tool_use_id: 'micro-eval-tool-1',
      transcript_path: join(workspace, 'transcript.jsonl'),
    }));
    const hookStdout: Buffer[] = [];
    const hookStderr: Buffer[] = [];
    hook.stdout.on('data', (chunk: Buffer) => hookStdout.push(chunk));
    hook.stderr.on('data', (chunk: Buffer) => hookStderr.push(chunk));
    const [hookExit] = (await once(hook, 'close')) as [number | null, NodeJS.Signals | null];

    expect(hookExit, Buffer.concat(hookStderr).toString('utf8')).toBe(0);
    expect(JSON.parse(Buffer.concat(hookStdout).toString('utf8'))).toEqual({
      hookSpecificOutput: {
        additionalContext: 'Recorded spot-check.txt from claude. Shared state now contains 1 edit.',
        hookEventName: 'PostToolUse',
      },
    });
  };

  try {
    await runHookOnce();
    // A second short-lived hook process replaying the same native tool id
    // returns the committed result instead of appending a duplicate edit.
    await runHookOnce();

    const settled = await createFileRuntimeKernel({ stateFile }).readSnapshot();
    expect(settled.stateVersion).toBe(1);
    expect(settled.edits).toHaveLength(1);
    expect(settled.edits[0]).toMatchObject({
      eventId: 'edit-1',
      host: 'claude',
      path: join(workspace, 'spot-check.txt'),
    });

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === 'render_edit_timeline')?._meta).toMatchObject({
      ui: { resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' },
    });
    await expect(client.callTool({ arguments: {}, name: 'render_edit_timeline' })).resolves.toMatchObject({
      content: [{ text: 'Showing 1 recorded edits.', type: 'text' }],
      structuredContent: {
        edits: [{ host: 'claude', path: join(workspace, 'spot-check.txt') }],
        stateVersion: 1,
      },
    });
    const resource = await client.readResource({ uri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' });
    expect(resource.contents[0]).toMatchObject({
      mimeType: 'text/html;profile=mcp-app',
      text: expect.stringContaining('<script'),
    });
  } finally {
    await client.close();
    await rm(workspace, { force: true, recursive: true });
  }
});
