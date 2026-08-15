import { requestFlightRenderWithFlight } from '../flight/request-render.js';
import { writeSync } from 'node:fs';
import { lowerHookResult } from '../runtime/lower-hook.js';
import { lowerMcpResult } from '../runtime/lower-mcp.js';
import type {
  DevRuntimeInspectionRequest,
  DevRuntimeInspectionResponse,
  EditEvent,
  RenderRequest,
  RuntimeSnapshot,
} from '../runtime/contracts.js';
import { normalizeClaudeHook, normalizeCodexHook } from '../hook/normalize.js';

import { hasInspectionCredential, isInspectionSensitiveKey } from './inspection-security.js';
import { serializeInspection } from './serialize-inspection.js';

const maximumInvocationRequestBytes = 1024 * 1024;
const maximumInvocationFlightBytes = 4 * 1024 * 1024;
const maximumInvocationResponseBytes = 4 * 1024 * 1024;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const readRequiredString = (value: Record<string, unknown>, key: string): string => {
  const item = value[key];
  if (typeof item !== 'string' || item.trim() === '') throw new Error(`Invocation request requires ${key}`);
  return item;
};

const assertExactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) throw new Error('Invocation request contains unsupported fields');
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) throw new Error('Invocation request is missing required fields');
};

const assertNoSnapshotCredentials = (value: Record<string, unknown>): void => {
  for (const [key, item] of Object.entries(value)) {
    if (isInspectionSensitiveKey(key) || (typeof item === 'string' && hasInspectionCredential(item))) {
      throw new Error('Runtime snapshot contains sensitive data');
    }
  }
};

const parseEdit = (value: unknown): EditEvent => {
  const event = asRecord(value);
  if (event === undefined) throw new Error('Runtime snapshot contains an invalid edit');
  assertNoSnapshotCredentials(event);
  assertExactKeys(event, ['eventId', 'host', 'path', 'recordedAt', 'sessionId', 'toolName']);
  const host = readRequiredString(event, 'host');
  if (host !== 'claude' && host !== 'codex') throw new Error('Runtime snapshot contains an invalid edit host');
  return {
    eventId: readRequiredString(event, 'eventId'),
    host,
    path: readRequiredString(event, 'path'),
    recordedAt: readRequiredString(event, 'recordedAt'),
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
    !Number.isSafeInteger(stateVersion) ||
    stateVersion < 0
  ) {
    throw new Error('Invocation request requires a valid runtime snapshot');
  }
  assertNoSnapshotCredentials(snapshot);
  assertExactKeys(snapshot, ['edits', 'stateVersion']);
  if (!Array.isArray(snapshot.edits)) throw new Error('Invocation request requires a valid runtime snapshot');
  return { edits: snapshot.edits.map(parseEdit), stateVersion };
};

const parseRequest = (value: unknown): DevRuntimeInspectionRequest => {
  const request = asRecord(value);
  if (request === undefined) throw new Error('Invocation request must be a JSON object');

  const type = readRequiredString(request, 'type');
  if (type === 'hook/after-file-edit') {
    assertExactKeys(request, ['host', 'input', 'stateFile', 'stateStoreId', 'type']);
    const host = readRequiredString(request, 'host');
    if (host !== 'claude' && host !== 'codex') throw new Error('Hook invocation host must be claude or codex');
    const input = asRecord(request.input);
    if (input === undefined) throw new Error('Hook invocation requires an object input');
    return {
      host,
      input,
      stateFile: readRequiredString(request, 'stateFile'),
      stateStoreId: readRequiredString(request, 'stateStoreId'),
      type,
    };
  }

  if (type === 'mcp/render-timeline') {
    assertExactKeys(request, ['snapshot', 'stateFile', 'stateStoreId', 'type']);
    return {
      snapshot: parseSnapshot(request.snapshot),
      stateFile: readRequiredString(request, 'stateFile'),
      stateStoreId: readRequiredString(request, 'stateStoreId'),
      type,
    };
  }

  if (type === 'mcp/runtime-status') {
    assertExactKeys(request, ['stateFile', 'stateStoreId', 'type']);
    return {
      stateFile: readRequiredString(request, 'stateFile'),
      stateStoreId: readRequiredString(request, 'stateStoreId'),
      type,
    };
  }

  throw new Error(`Unsupported invocation request type: ${type}`);
};

const readRequest = async (): Promise<DevRuntimeInspectionRequest> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumInvocationRequestBytes) {
      throw new Error(`Invocation request exceeded ${maximumInvocationRequestBytes} bytes`);
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error('Invocation request must not be empty');

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error('Invocation request must be valid UTF-8 JSON');
  }
  return parseRequest(JSON.parse(decoded));
};

const renderRequestFor = (request: DevRuntimeInspectionRequest): RenderRequest => {
  if (request.type === 'hook/after-file-edit') {
    return {
      event: request.host === 'claude' ? normalizeClaudeHook(request.input) : normalizeCodexHook(request.input),
      stateFile: request.stateFile,
      type: request.type,
    };
  }
  if (request.type === 'mcp/render-timeline') {
    return { snapshot: request.snapshot, stateFile: request.stateFile, type: request.type };
  }
  return { stateFile: request.stateFile, type: request.type };
};

const hookStateVersion = (native: ReturnType<typeof lowerHookResult>): number => {
  const match = /\bShared state now contains (\d+) edits?\./u.exec(native.hookSpecificOutput.additionalContext);
  if (match === null) throw new Error('Rendered hook result did not contain a state version');
  const stateVersion = Number(match[1]);
  if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) {
    throw new Error('Rendered hook result contained an invalid state version');
  }
  return stateVersion;
};

const statusStateVersion = (protocol: ReturnType<typeof lowerMcpResult>): number => {
  const structuredContent = protocol.structuredContent;
  if (structuredContent === null || typeof structuredContent !== 'object' || Array.isArray(structuredContent)) {
    throw new Error('Rendered MCP result did not contain a state version');
  }
  const stateVersion = (structuredContent as Record<string, unknown>).stateVersion;
  if (typeof stateVersion !== 'number' || !Number.isSafeInteger(stateVersion) || stateVersion < 0) {
    throw new Error('Rendered MCP result contained an invalid state version');
  }
  return stateVersion;
};

interface InvocationOutput {
  readonly flight: Buffer;
  readonly response: DevRuntimeInspectionResponse;
}

const invoke = async (signal?: AbortSignal): Promise<InvocationOutput> => {
  const request = await readRequest();
  const rendered = await requestFlightRenderWithFlight(renderRequestFor(request), {
    maximumFlightBytes: maximumInvocationFlightBytes,
    signal,
  });

  if (request.type === 'hook/after-file-edit') {
    const native = lowerHookResult(rendered.node);
    return Object.freeze({
      flight: Buffer.from(rendered.flight),
      response: Object.freeze({
        flightBytes: rendered.flight.byteLength,
        inspection: serializeInspection({
        agentVisible: native.hookSpecificOutput.additionalContext,
        flight: rendered.flight,
        native,
        node: rendered.node,
        stateStoreId: request.stateStoreId,
        stateVersion: hookStateVersion(native),
        }),
      }),
    });
  }

  const protocol = lowerMcpResult(rendered.node);
  const stateVersion = request.type === 'mcp/render-timeline' ? request.snapshot.stateVersion : statusStateVersion(protocol);
  return Object.freeze({
    flight: Buffer.from(rendered.flight),
    response: Object.freeze({
      flightBytes: rendered.flight.byteLength,
      inspection: serializeInspection({
      flight: rendered.flight,
      modelVisible: protocol.content,
      node: rendered.node,
      protocol,
      stateStoreId: request.stateStoreId,
      stateVersion,
      }),
    }),
  });
};

const controller = new AbortController();
const abort = (): void => controller.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);

const writeFlight = (flight: Buffer): void => {
  let offset = 0;
  while (offset < flight.byteLength) {
    offset += writeSync(3, flight, offset, flight.byteLength - offset);
  }
};

const writeResponse = ({ flight, response }: InvocationOutput): void => {
  writeFlight(flight);
  const line = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(line, 'utf8') > maximumInvocationResponseBytes) {
    throw new Error('Inspection response exceeded output limit');
  }
  process.stdout.write(line);
};

const reportFailure = (error: unknown): void => {
  const message = error instanceof Error ? error.message : 'Invocation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

void invoke(controller.signal).then(writeResponse).catch(reportFailure).finally(() => {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
});
