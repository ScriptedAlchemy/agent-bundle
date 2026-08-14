import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { requestFlightRender } from '../flight/request-render.js';
import { lowerHookResult } from '../runtime/lower-hook.js';
import { normalizeClaudeHook, normalizeCodexHook } from './normalize.js';

let probeInput: Record<string, unknown> | undefined;

const valueType = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const writeEvalProbe = async (input: Record<string, unknown>, exitStatus: number): Promise<void> => {
  const probeFile = process.env.AGENT_RUNTIME_HOOK_PROBE_FILE;
  if (probeFile === undefined || probeFile.trim() === '') return;

  const toolInput = input.tool_input;
  const toolInputRecord = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
    ? toolInput as Record<string, unknown>
    : undefined;
  const topLevelKeys = Object.keys(input).sort();
  const toolInputKeys = toolInputRecord === undefined ? [] : Object.keys(toolInputRecord).sort();
  await appendFile(probeFile, `${JSON.stringify({
    commandLaunched: true,
    exitStatus,
    toolInputKeys,
    toolInputValueTypes: Object.fromEntries(toolInputKeys.map((key) => [key, valueType(toolInputRecord?.[key])])),
    toolName: typeof input.tool_name === 'string' ? input.tool_name : undefined,
    topLevelKeys,
    topLevelValueTypes: Object.fromEntries(topLevelKeys.map((key) => [key, valueType(input[key])])),
  })}\n`);
};

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
  probeInput = input;
  const event = host === 'claude' ? normalizeClaudeHook(input) : normalizeCodexHook(input);
  const configuredStateFile = process.env.AGENT_RUNTIME_STATE_FILE;
  const stateFile = configuredStateFile === undefined || configuredStateFile.trim() === ''
    ? resolve(event.cwd, '.agent-runtime-demo', 'events.jsonl')
    : resolve(configuredStateFile);

  const result = await requestFlightRender({
    event,
    stateFile,
    type: 'hook/after-file-edit',
  });
  process.stdout.write(`${JSON.stringify(lowerHookResult(result))}\n`);
  await writeEvalProbe(input, 0);
};

run().catch(async (error: unknown) => {
  if (probeInput !== undefined) await writeEvalProbe(probeInput, 1).catch(() => undefined);
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
