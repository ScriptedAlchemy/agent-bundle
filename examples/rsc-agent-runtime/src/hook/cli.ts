import { resolve } from 'node:path';

import { requestAgentDocument } from '../flight/request-render.js';
import { resolveImplicitRuntimeStateFile } from '../runtime/state-file.js';
import { writeEvalProbe } from './eval-probe.js';
import { normalizeClaudeHook, normalizeCodexHook } from './normalize.js';
import { projectHookDocument } from './project-document.js';

let probeInput: Record<string, unknown> | undefined;

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

const run = async (signal: AbortSignal): Promise<void> => {
  const host = readHost();
  const input = await readInput();
  probeInput = input;
  const event = host === 'claude' ? normalizeClaudeHook(input) : normalizeCodexHook(input);
  const configuredStateFile = process.env.AGENT_RUNTIME_STATE_FILE;
  const stateFile = configuredStateFile === undefined || configuredStateFile.trim() === ''
    ? await resolveImplicitRuntimeStateFile(event.cwd)
    : resolve(configuredStateFile);

  const document = await requestAgentDocument({
    event,
    stateFile,
    type: 'hook/after-file-edit',
  }, { signal });
  process.stdout.write(`${JSON.stringify(projectHookDocument(document))}\n`);
  await writeEvalProbe(input, 0);
};

const controller = new AbortController();
const abort = (): void => controller.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);

run(controller.signal).catch(async (error: unknown) => {
  if (probeInput !== undefined) await writeEvalProbe(probeInput, 1).catch(() => undefined);
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}).finally(() => {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
});
