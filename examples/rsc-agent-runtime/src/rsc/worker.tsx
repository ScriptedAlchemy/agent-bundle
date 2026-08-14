import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { resolve } from 'node:path';

import { renderToReadableStream } from 'react-server-dom-rspack/server.node';

import type { CanonicalPostToolUse, RenderRequest } from '../runtime/contracts.js';
import { withRenderContext } from '../runtime/request-context.js';
import { createFileRuntimeKernel } from '../runtime/state-file.js';
import { renderHookRoute } from './routes.js';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

const readString = (value: Record<string, unknown>, key: string): string | undefined =>
  typeof value[key] === 'string' ? value[key] : undefined;

const parseEvent = (value: unknown): CanonicalPostToolUse => {
  const event = asRecord(value);
  if (event === undefined) {
    throw new Error('RSC worker received an invalid event');
  }

  const host = readString(event, 'host');
  const sessionId = readString(event, 'sessionId');
  const cwd = readString(event, 'cwd');
  const toolName = readString(event, 'toolName');
  const path = readString(event, 'path');
  if (
    (host !== 'claude' && host !== 'codex') ||
    sessionId === undefined ||
    cwd === undefined ||
    toolName === undefined ||
    path === undefined
  ) {
    throw new Error('RSC worker received an invalid event');
  }

  return { host, sessionId, cwd, toolName, path };
};

const parseRequest = (value: unknown): RenderRequest => {
  const request = asRecord(value);
  if (request === undefined || request.type !== 'hook/after-file-edit') {
    throw new Error('RSC worker received an unsupported render request');
  }

  const stateFile = readString(request, 'stateFile');
  if (stateFile === undefined || stateFile.trim() === '') {
    throw new Error('RSC worker requires a state file');
  }

  return {
    event: parseEvent(request.event),
    stateFile: resolve(stateFile),
    type: 'hook/after-file-edit',
  };
};

const readRequest = async (): Promise<RenderRequest> => {
  let contents = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    contents += chunk;
  }

  return parseRequest(JSON.parse(contents));
};

const render = async (): Promise<void> => {
  const request = await readRequest();
  const runtime = createFileRuntimeKernel({ stateFile: request.stateFile });
  const snapshot = await runtime.recordEdit({
    host: request.event.host,
    path: request.event.path,
    sessionId: request.event.sessionId,
    toolName: request.event.toolName,
  });

  await withRenderContext({ edit: request.event, snapshot }, async () => {
    const flight = renderToReadableStream(renderHookRoute(request));
    const output = Readable.fromWeb(flight);
    output.pipe(process.stdout, { end: false });
    await finished(output);
  });
};

render().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
