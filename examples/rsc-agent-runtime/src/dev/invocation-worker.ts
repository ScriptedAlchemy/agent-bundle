import { createFileRuntimeKernel } from '../runtime/state-file.js';
import { requestFlightRenderWithFlight } from '../flight/request-render.js';
import { lowerHookResult } from '../runtime/lower-hook.js';
import { lowerMcpResult } from '../runtime/lower-mcp.js';
import type {
  DevRuntimeInspectionRequest,
  DevRuntimeInspectionResponse,
  RenderRequest,
  RuntimeSnapshot,
} from '../runtime/contracts.js';
import { normalizeClaudeHook, normalizeCodexHook } from '../hook/normalize.js';

import { serializeInspection } from './serialize-inspection.js';

const maximumInvocationRequestBytes = 1024 * 1024;
const maximumInvocationFlightBytes = 2 * 1024 * 1024;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const readRequiredString = (value: Record<string, unknown>, key: string): string => {
  const item = value[key];
  if (typeof item !== 'string' || item.trim() === '') throw new Error(`Invocation request requires ${key}`);
  return item;
};

const assertExactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) throw new Error(`Invocation request has unsupported fields: ${unexpected.sort().join(', ')}`);
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) throw new Error(`Invocation request requires ${missing.join(', ')}`);
};

const parseSnapshot = (value: unknown): RuntimeSnapshot => {
  const snapshot = asRecord(value);
  const stateVersion = snapshot?.stateVersion;
  if (
    snapshot === undefined ||
    !Array.isArray(snapshot.edits) ||
    typeof stateVersion !== 'number' ||
    !Number.isSafeInteger(stateVersion) ||
    stateVersion < 0
  ) {
    throw new Error('Invocation request requires a valid runtime snapshot');
  }
  return { edits: snapshot.edits as RuntimeSnapshot['edits'], stateVersion };
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

const invoke = async (): Promise<DevRuntimeInspectionResponse> => {
  const request = await readRequest();
  const rendered = await requestFlightRenderWithFlight(renderRequestFor(request), {
    maximumFlightBytes: maximumInvocationFlightBytes,
  });
  const snapshot = await createFileRuntimeKernel({ stateFile: request.stateFile }).readSnapshot();

  if (request.type === 'hook/after-file-edit') {
    const native = lowerHookResult(rendered.node);
    return Object.freeze({
      flightBase64: Buffer.from(rendered.flight).toString('base64'),
      inspection: serializeInspection({
        agentVisible: native.hookSpecificOutput.additionalContext,
        flight: rendered.flight,
        native,
        node: rendered.node,
        stateStoreId: request.stateStoreId,
        stateVersion: snapshot.stateVersion,
      }),
    });
  }

  const protocol = lowerMcpResult(rendered.node);
  return Object.freeze({
    flightBase64: Buffer.from(rendered.flight).toString('base64'),
    inspection: serializeInspection({
      flight: rendered.flight,
      modelVisible: protocol.content,
      node: rendered.node,
      protocol,
      stateStoreId: request.stateStoreId,
      stateVersion: snapshot.stateVersion,
    }),
  });
};

invoke().then(
  (response) => process.stdout.write(`${JSON.stringify(response)}\n`),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
);
