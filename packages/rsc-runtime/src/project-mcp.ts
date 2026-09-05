import { Effect, Stream } from 'effect';

import {
  AgentContractError,
  type AgentDocument,
  type AgentDocumentNode,
  type AgentProgressNode,
  type AgentRenderEvent,
} from './agent-document.js';
import { interruptWhenAborted, runPromise, toRuntimeError } from './effect/boundary.js';
import {
  snapshotJsonValue,
  type JsonObject,
  type JsonValue,
  type McpCallToolResult,
  type McpContentBlock,
} from './lower-mcp.js';

export const MCP_PROGRESS_MESSAGE_MAX = 200;

export type McpProgressToken = string | number;

export interface McpProgressNotificationParams {
  readonly message?: string;
  readonly progress: number;
  readonly progressToken: McpProgressToken;
  readonly total?: number;
}

export interface McpRichContentCapabilities {
  readonly audio: boolean;
  readonly image: boolean;
  readonly resource: boolean;
}

export const DEFAULT_MCP_RICH_CONTENT_CAPABILITIES: McpRichContentCapabilities = Object.freeze({
  audio: true,
  image: true,
  resource: true,
});

export type McpRichContentFallback = 'text' | 'fail';

export type McpProjectionErrorCode = 'unsupported-rich-content' | 'invalid-result-metadata';

export type McpRichContentKind = 'audio' | 'image' | 'resource';

export class McpProjectionError extends Error {
  readonly code: McpProjectionErrorCode;
  readonly kind?: McpRichContentKind;

  constructor(
    code: McpProjectionErrorCode,
    message: string,
    options?: ErrorOptions & { readonly kind?: McpRichContentKind },
  ) {
    super(message, options);
    this.code = code;
    this.name = 'McpProjectionError';
    this.kind = options?.kind;
  }
}

export interface ProjectMcpRenderOptions {
  readonly capabilities?: Partial<McpRichContentCapabilities>;
  readonly progressToken?: McpProgressToken;
  readonly richContentFallback?: McpRichContentFallback;
  readonly sendProgress?: (params: McpProgressNotificationParams) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly structuredContent?: unknown;
}

export interface McpProjectedToolResult {
  readonly document: AgentDocument;
  readonly result: McpCallToolResult;
}

const resolveCapabilities = (
  partial?: Partial<McpRichContentCapabilities>,
): McpRichContentCapabilities => Object.freeze({
  ...DEFAULT_MCP_RICH_CONTENT_CAPABILITIES,
  ...partial,
});

export const shortenMcpProgressMessage = (message: string): string => {
  const trimmed = message.trim();
  if (trimmed.length <= MCP_PROGRESS_MESSAGE_MAX) return trimmed;
  return `${trimmed.slice(0, MCP_PROGRESS_MESSAGE_MAX - 1)}…`;
};

const gatedBlock = (
  kind: McpRichContentKind,
  summary: string,
  fallback: McpRichContentFallback,
): McpContentBlock => {
  switch (fallback) {
    case 'text':
      return { text: summary, type: 'text' };
    case 'fail':
      throw new McpProjectionError(
        'unsupported-rich-content',
        `MCP projector cannot emit ${kind} content because the selected capability does not support it`,
        { kind },
      );
    default: {
      const exhaustive: never = fallback;
      return exhaustive;
    }
  }
};

const appendNode = (
  node: AgentDocumentNode,
  content: McpContentBlock[],
  capabilities: McpRichContentCapabilities,
  fallback: McpRichContentFallback,
): void => {
  switch (node.kind) {
    case 'result':
      for (const child of node.children) appendNode(child, content, capabilities, fallback);
      break;
    case 'context':
    case 'markdown':
    case 'text':
      content.push({ text: node.text, type: 'text' });
      break;
    case 'json':
      content.push({ text: JSON.stringify(node.value), type: 'text' });
      break;
    case 'progress':
      break;
    case 'image':
      content.push(capabilities.image
        ? { data: node.data, mimeType: node.mimeType, type: 'image' }
        : gatedBlock('image', `[image ${node.mimeType}]`, fallback));
      break;
    case 'audio':
      content.push(capabilities.audio
        ? { data: node.data, mimeType: node.mimeType, type: 'audio' }
        : gatedBlock('audio', `[audio ${node.mimeType}]`, fallback));
      break;
    case 'resource':
      content.push(capabilities.resource
        ? {
          ...(node.mimeType === undefined ? {} : { mimeType: node.mimeType }),
          name: node.name,
          type: 'resource_link',
          uri: node.uri,
        }
        : gatedBlock('resource', `[resource ${node.name} ${node.uri}]`, fallback));
      break;
    case 'error':
      content.push({ text: `[${node.code}] ${node.message}`, type: 'text' });
      break;
    default: {
      const exhaustive: never = node;
      throw new AgentContractError(
        'invalid-document',
        `Unsupported Agent Document node: ${String((exhaustive as { kind?: unknown }).kind)}`,
      );
    }
  }
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const objectStructuredContent = (value: unknown): JsonObject | undefined => {
  if (value === undefined) return undefined;
  const snapshot = snapshotJsonValue(value, 'MCP structured content must be JSON-serializable');
  return isJsonObject(snapshot) ? snapshot : undefined;
};

/**
 * `Agent.Result metadata` is the route's result-level `CallToolResult._meta`
 * (#383). MCP `_meta` is an object, so anything else fails the projection
 * closed instead of being dropped or coerced: a route that renders scalar
 * metadata has said something the wire cannot carry.
 */
const resultMetadata = (document: AgentDocument): JsonObject | undefined => {
  if (document.root.kind !== 'result') return undefined;
  const metadata = document.root.metadata;
  if (metadata === undefined) return undefined;
  const snapshot = snapshotJsonValue(metadata, 'MCP result _meta must be JSON-serializable');
  if (!isJsonObject(snapshot)) {
    throw new McpProjectionError(
      'invalid-result-metadata',
      'MCP result _meta must be a JSON object; Agent.Result metadata projects to CallToolResult._meta',
    );
  }
  return snapshot;
};

export const documentToCallToolResult = (
  document: AgentDocument,
  options: Pick<ProjectMcpRenderOptions, 'capabilities' | 'richContentFallback' | 'structuredContent'> = {},
): McpCallToolResult => {
  const content: McpContentBlock[] = [];
  appendNode(
    document.root,
    content,
    resolveCapabilities(options.capabilities),
    options.richContentFallback ?? 'fail',
  );
  const structured = objectStructuredContent(options.structuredContent ?? document.value);
  const metadata = resultMetadata(document);
  return {
    ...(metadata === undefined ? {} : { _meta: metadata }),
    content,
    ...(document.status === 'success' ? {} : { isError: true }),
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
};

export const attachMcpStructuredContent = (
  result: McpCallToolResult,
  value: unknown,
): McpCallToolResult => {
  const structured = objectStructuredContent(value);
  if (structured === undefined) return result;
  return { ...result, structuredContent: structured };
};

/** The progress fields a render `progress` event and an `Agent.Progress` node share. */
interface McpProgressSource {
  readonly completed: number;
  readonly message?: string;
  readonly total?: number;
}

const notifyProgress = (
  source: McpProgressSource,
  token: McpProgressToken,
  sendProgress: (params: McpProgressNotificationParams) => Promise<void>,
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    catch: (error) => toRuntimeError(error),
    try: () => sendProgress({
      progress: source.completed,
      progressToken: token,
      ...(source.message === undefined ? {} : { message: shortenMcpProgressMessage(source.message) }),
      ...(source.total === undefined ? {} : { total: source.total }),
    }),
  });

const appendProgressNodes = (node: AgentDocumentNode, nodes: AgentProgressNode[]): void => {
  switch (node.kind) {
    case 'result':
      for (const child of node.children) appendProgressNodes(child, nodes);
      break;
    case 'progress':
      nodes.push(node);
      break;
    case 'audio':
    case 'context':
    case 'error':
    case 'image':
    case 'json':
    case 'markdown':
    case 'resource':
    case 'text':
      break;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

/**
 * The `Agent.Progress` nodes of a streamed `shell` or `replace` document, in
 * document order. A `Suspense` fallback rendered as `Agent.Progress` is the
 * framework's streaming progress surface, so the projector reads it from the
 * partial documents the reconciler streams instead of requiring the route to
 * repeat the same message through `progress.report()` (#448).
 */
const documentProgressNodes = (document: AgentDocument): readonly AgentProgressNode[] => {
  const nodes: AgentProgressNode[] = [];
  appendProgressNodes(document.root, nodes);
  return nodes;
};

export const projectMcpEventStream = Effect.fnUntraced(function*(
  events: Stream.Stream<AgentRenderEvent, Error>,
  options: ProjectMcpRenderOptions = {},
) {
  let lastProgress = Number.NEGATIVE_INFINITY;
  let complete: AgentDocument | undefined;
  const token = options.progressToken;
  const sendProgress = options.sendProgress;
  // One monotonic rule for both sources: MCP requires `progress` to increase
  // with every notification, so a fallback re-streamed on the next chunk, a
  // fallback whose `completed` an explicit report already reached, or a report
  // that repeats a fallback's `completed` is dropped rather than duplicated.
  const notify = (source: McpProgressSource): Effect.Effect<void, Error> => {
    if (token === undefined || sendProgress === undefined) return Effect.void;
    if (!(source.completed > lastProgress)) return Effect.void;
    lastProgress = source.completed;
    return notifyProgress(source, token, sendProgress);
  };
  yield* Stream.runForEach(events, (event) =>
    Effect.gen(function*() {
      switch (event.type) {
        case 'progress':
          yield* notify(event);
          return;
        case 'shell':
        case 'replace':
          for (const node of documentProgressNodes(event.document)) yield* notify(node);
          return;
        case 'error':
          return;
        case 'complete':
          complete = event.document;
          return;
        default: {
          const exhaustive: never = event;
          return exhaustive;
        }
      }
    }),
  );
  if (complete === undefined) {
    return yield* Effect.fail(new AgentContractError(
      'invalid-document',
      'MCP projector requires a complete document; the stream ended without one',
    ));
  }
  return Object.freeze({
    document: complete,
    result: documentToCallToolResult(complete, options),
  });
});

export const projectMcpRenderStream = async (
  events: ReadableStream<AgentRenderEvent>,
  options: ProjectMcpRenderOptions = {},
): Promise<McpProjectedToolResult> => {
  const program = projectMcpEventStream(
    Stream.fromReadableStream({
      evaluate: () => events,
      onError: (error) => toRuntimeError(error),
    }),
    options,
  );
  return runPromise(
    options.signal === undefined ? program : interruptWhenAborted(program, options.signal),
    options.signal === undefined ? undefined : { signal: options.signal },
  );
};
