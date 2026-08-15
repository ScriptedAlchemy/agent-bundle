import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { resolve } from 'node:path';

import { renderToReadableStream } from 'react-server-dom-rspack/server.node';

import type { CanonicalPostToolUse, RenderRequest, RuntimeSnapshot } from '../runtime/contracts.js';
import { withRenderContext } from '../runtime/request-context.js';
import { createFileRuntimeKernel } from '../runtime/state-file.js';
import { renderRoute } from './routes.js';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

const readString = (value: Record<string, unknown>, key: string): string | undefined =>
  typeof value[key] === 'string' ? value[key] : undefined;

const readRequiredString = (value: Record<string, unknown>, key: string): string => {
  const result = readString(value, key);
  if (result === undefined || result.trim() === '') {
    throw new Error(`RSC worker requires a nonempty ${key}`);
  }
  return result;
};

const parseEvent = (value: unknown): CanonicalPostToolUse => {
  const event = asRecord(value);
  if (event === undefined) {
    throw new Error('RSC worker received an invalid event');
  }

  const host = readString(event, 'host');
  if (host !== 'claude' && host !== 'codex') {
    throw new Error('RSC worker received an invalid event');
  }
  return {
    cwd: readRequiredString(event, 'cwd'),
    host,
    idempotencyKey: readRequiredString(event, 'idempotencyKey'),
    path: readRequiredString(event, 'path'),
    sessionId: readRequiredString(event, 'sessionId'),
    toolName: readRequiredString(event, 'toolName'),
  };
};

const parseSnapshot = (value: unknown): RuntimeSnapshot => {
  const snapshot = asRecord(value);
  const stateVersion = snapshot?.stateVersion;
  if (
    snapshot === undefined ||
    typeof stateVersion !== 'number' ||
    !Number.isInteger(stateVersion) ||
    stateVersion < 0 ||
    !Array.isArray(snapshot.edits)
  ) {
    throw new Error('RSC worker received an invalid runtime snapshot');
  }

  return { edits: snapshot.edits as RuntimeSnapshot['edits'], stateVersion };
};

const parseRequest = (value: unknown): RenderRequest => {
  const request = asRecord(value);
  if (request === undefined) {
    throw new Error('RSC worker received an unsupported render request');
  }

  const stateFile = readRequiredString(request, 'stateFile');

  if (request.type === 'hook/after-file-edit') {
    return {
      event: parseEvent(request.event),
      stateFile: resolve(stateFile),
      type: 'hook/after-file-edit',
    };
  }

  if (request.type === 'mcp/render-timeline') {
    return {
      snapshot: parseSnapshot(request.snapshot),
      stateFile: resolve(stateFile),
      type: 'mcp/render-timeline',
    };
  }

  if (request.type === 'mcp/runtime-status') {
    return { stateFile: resolve(stateFile), type: 'mcp/runtime-status' };
  }

  throw new Error('RSC worker received an unsupported render request');
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
  const workspaceFallbackRoot =
    request.type === 'hook/after-file-edit' &&
    request.stateFile === resolve(request.event.cwd, '.agent-runtime-demo', 'events.jsonl')
      ? request.event.cwd
      : undefined;
  const runtime = createFileRuntimeKernel({ stateFile: request.stateFile, workspaceFallbackRoot });
  const snapshot =
    request.type === 'hook/after-file-edit'
      ? await runtime.recordEdit({
          host: request.event.host,
          idempotencyKey: request.event.idempotencyKey,
          path: request.event.path,
          sessionId: request.event.sessionId,
          toolName: request.event.toolName,
        })
      : request.type === 'mcp/render-timeline'
        ? request.snapshot
        : await runtime.readSnapshot();

  const renderFlight = async (): Promise<void> => {
    const flight = renderToReadableStream(renderRoute(request, snapshot));
    const output = Readable.from(flight);
    output.pipe(process.stdout, { end: false });
    await finished(output);
  };

  if (request.type === 'hook/after-file-edit') {
    await withRenderContext({ edit: request.event, snapshot }, renderFlight);
    return;
  }

  await renderFlight();
};

render().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
