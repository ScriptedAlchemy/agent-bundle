import { resolve } from 'node:path';

import { requestFlightRender } from '../flight/request-render.js';
import { lowerHookResult } from '../runtime/lower-hook.js';
import { normalizeClaudeHook, normalizeCodexHook } from './normalize.js';

const readInput = async (): Promise<Record<string, unknown>> => {
  let contents = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    contents += chunk;
  }

  const parsed: unknown = JSON.parse(contents);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('Native hook input must be a JSON object');
  }

  return parsed as Record<string, unknown>;
};

const readHost = (): 'claude' | 'codex' => {
  const host = process.argv[process.argv.indexOf('--host') + 1];
  if (host !== 'claude' && host !== 'codex') {
    throw new Error('Expected --host claude or codex');
  }

  return host;
};

const run = async (): Promise<void> => {
  const host = readHost();
  const input = await readInput();
  const event = host === 'claude' ? normalizeClaudeHook(input) : normalizeCodexHook(input);
  const stateFile = process.env.AGENT_RUNTIME_STATE_FILE;
  if (stateFile === undefined || stateFile.trim() === '') {
    throw new Error('AGENT_RUNTIME_STATE_FILE is required');
  }

  const result = await requestFlightRender({
    event,
    stateFile: resolve(stateFile),
    type: 'hook/after-file-edit',
  });
  process.stdout.write(`${JSON.stringify(lowerHookResult(result))}\n`);
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
