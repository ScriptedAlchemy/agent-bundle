import { Buffer } from 'node:buffer';

import { snapshotJsonValue, type JsonSnapshotBudget, type JsonValue } from './lower-mcp.js';

export const AGENT_DOCUMENT_VERSION = 1 as const;

/** Host-visible cancellation error shared by the render pipeline. */
export const agentRenderAbortError = (): DOMException =>
  new DOMException('Agent render was aborted', 'AbortError');

export type AgentDocumentStatus = 'success' | 'represented-error' | 'failed';

export interface AgentResultNode {
  readonly children: readonly AgentDocumentNode[];
  readonly kind: 'result';
  readonly metadata?: JsonValue;
}

export interface AgentMarkdownNode {
  readonly kind: 'markdown';
  readonly text: string;
}

export interface AgentTextNode {
  readonly kind: 'text';
  readonly text: string;
}

/** Guidance intended for the host's immediate additional-context channel. */
export interface AgentContextNode {
  readonly kind: 'context';
  readonly text: string;
}

export interface AgentJsonNode {
  readonly kind: 'json';
  readonly value: JsonValue;
}

export interface AgentProgressNode {
  readonly completed: number;
  readonly kind: 'progress';
  readonly message?: string;
  readonly total?: number;
}

export interface AgentImageNode {
  readonly data: string;
  readonly kind: 'image';
  readonly mimeType: string;
}

export interface AgentAudioNode {
  readonly data: string;
  readonly kind: 'audio';
  readonly mimeType: string;
}

export interface AgentResourceNode {
  readonly kind: 'resource';
  readonly mimeType?: string;
  readonly name: string;
  readonly uri: string;
}

export interface AgentErrorNode {
  readonly code: string;
  readonly kind: 'error';
  readonly message: string;
}

export type AgentDocumentNode =
  | AgentResultNode
  | AgentMarkdownNode
  | AgentTextNode
  | AgentContextNode
  | AgentJsonNode
  | AgentProgressNode
  | AgentImageNode
  | AgentAudioNode
  | AgentResourceNode
  | AgentErrorNode;

export interface AgentDocument {
  readonly root: AgentDocumentNode;
  readonly status: AgentDocumentStatus;
  readonly value?: JsonValue;
  readonly version: typeof AGENT_DOCUMENT_VERSION;
}

export type AgentDocumentSnapshot = AgentDocument;

export interface AgentRenderError {
  readonly code: string;
  readonly data?: JsonValue;
  readonly message: string;
}

export type AgentRenderEvent =
  | { readonly document: AgentDocumentSnapshot; readonly sequence: number; readonly type: 'shell' }
  | {
    readonly completed: number;
    readonly message?: string;
    readonly sequence: number;
    readonly total?: number;
    readonly type: 'progress';
  }
  | {
    readonly boundaryId: string;
    readonly document: AgentDocumentSnapshot;
    readonly sequence: number;
    readonly type: 'replace';
  }
  | {
    readonly boundaryId?: string;
    readonly error: AgentRenderError;
    readonly sequence: number;
    readonly type: 'error';
  }
  | { readonly document: AgentDocumentSnapshot; readonly sequence: number; readonly type: 'complete' };

export type AgentRenderEventInput =
  | { readonly document: AgentDocument; readonly type: 'shell' }
  | { readonly completed: number; readonly message?: string; readonly total?: number; readonly type: 'progress' }
  | { readonly boundaryId: string; readonly document: AgentDocument; readonly type: 'replace' }
  | { readonly boundaryId?: string; readonly error: AgentRenderError; readonly type: 'error' }
  | { readonly document: AgentDocument; readonly type: 'complete' };

export interface AgentRenderLimits {
  readonly maxDocumentBytes: number;
  readonly maxDocumentDepth: number;
  readonly maxDocumentNodes: number;
  readonly maxElapsedMs: number;
  readonly maxEventBytes: number;
  readonly maxEventRate: number;
  readonly maxEvents: number;
}

export const DEFAULT_AGENT_RENDER_LIMITS: AgentRenderLimits = Object.freeze({
  maxDocumentBytes: 1024 * 1024,
  maxDocumentDepth: 64,
  maxDocumentNodes: 10_000,
  maxElapsedMs: 60_000,
  maxEventBytes: 1024 * 1024 + 1024,
  maxEventRate: 1_000,
  maxEvents: 10_000,
});

export type AgentContractErrorCode =
  | 'invalid-document'
  | 'document-depth-exceeded'
  | 'document-node-count-exceeded'
  | 'document-bytes-exceeded'
  | 'event-count-exceeded'
  | 'event-bytes-exceeded'
  | 'event-rate-exceeded'
  | 'elapsed-time-exceeded'
  | 'handoff-required';

export class AgentContractError extends Error {
  readonly code: AgentContractErrorCode;

  constructor(code: AgentContractErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'AgentContractError';
  }
}

export const resolveAgentRenderLimits = (overrides: Partial<AgentRenderLimits> = {}): AgentRenderLimits => {
  const limits = { ...DEFAULT_AGENT_RENDER_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AgentContractError('invalid-document', `${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentContractError('invalid-document', `${field} must be a non-empty string`);
  }
  return value;
};

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new AgentContractError('invalid-document', `${field} must be a string`);
  }
  return value;
};

const optionalString = (value: unknown, field: string): string | undefined =>
  value === undefined ? undefined : requiredString(value, field);

export const elapsedTimeExceeded = (maxElapsedMs: number): AgentContractError =>
  new AgentContractError(
    'elapsed-time-exceeded',
    `Agent render elapsed time exceeds ${String(maxElapsedMs)}ms`,
  );

/** Single source for the depth-limit contract shared by snapshotting and Flight decode. */
export const expectDocumentDepth = (depth: number, limits: AgentRenderLimits): void => {
  if (depth > limits.maxDocumentDepth) {
    throw new AgentContractError(
      'document-depth-exceeded',
      `Agent Document depth exceeds ${String(limits.maxDocumentDepth)}`,
    );
  }
};

/** Single source for the node-count contract shared by snapshotting and Flight decode. */
export const admitDocumentNode = (state: { readonly limits: AgentRenderLimits; nodes: number }): void => {
  state.nodes += 1;
  if (state.nodes > state.limits.maxDocumentNodes) {
    throw new AgentContractError(
      'document-node-count-exceeded',
      `Agent Document node count exceeds ${String(state.limits.maxDocumentNodes)}`,
    );
  }
};

const jsonBudget = (state: NodeSnapshotState): JsonSnapshotBudget => ({
  addBytes(n) {
    state.bytes += n;
    if (state.bytes > state.limits.maxDocumentBytes) {
      throw new AgentContractError(
        'document-bytes-exceeded',
        `Agent Document bytes exceed ${String(state.limits.maxDocumentBytes)}`,
      );
    }
  },
  addNode() {
    admitDocumentNode(state);
  },
  checkDepth(depth) {
    expectDocumentDepth(depth, state.limits);
  },
});

const snapshotJson = (
  value: unknown,
  message: string,
  depth: number,
  state: NodeSnapshotState,
): JsonValue => {
  try {
    return snapshotJsonValue(value, message, { depth, limits: jsonBudget(state) });
  } catch (error) {
    if (error instanceof AgentContractError) throw error;
    throw new AgentContractError('invalid-document', error instanceof Error ? error.message : message, { cause: error });
  }
};

const progressNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AgentContractError('invalid-document', `${field} must be a finite non-negative number`);
  }
  return value;
};

interface NodeSnapshotState {
  readonly ancestors: Set<object>;
  readonly limits: AgentRenderLimits;
  bytes: number;
  nodes: number;
}

const snapshotNode = (node: AgentDocumentNode, depth: number, state: NodeSnapshotState): AgentDocumentNode => {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new AgentContractError('invalid-document', 'Agent Document nodes must be plain objects');
  }
  if (state.ancestors.has(node)) {
    throw new AgentContractError('invalid-document', 'Agent Document node tree must not be cyclic');
  }
  expectDocumentDepth(depth, state.limits);
  admitDocumentNode(state);

  state.ancestors.add(node);
  try {
    switch (node.kind) {
      case 'result': {
        if (!Array.isArray(node.children)) {
          throw new AgentContractError('invalid-document', 'Agent result children must be an array');
        }
        const children = Object.freeze(node.children.map((child) => snapshotNode(child, depth + 1, state)));
        const metadata = node.metadata === undefined
          ? undefined
          : snapshotJson(node.metadata, 'Agent result metadata must be JSON-serializable', depth, state);
        return Object.freeze({
          children,
          kind: 'result',
          ...(metadata === undefined ? {} : { metadata }),
        });
      }
      case 'markdown':
        return Object.freeze({ kind: 'markdown', text: text(node.text, 'Agent markdown text') });
      case 'text':
        return Object.freeze({ kind: 'text', text: text(node.text, 'Agent text') });
      case 'context':
        return Object.freeze({ kind: 'context', text: text(node.text, 'Agent context text') });
      case 'json':
        return Object.freeze({
          kind: 'json',
          value: snapshotJson(node.value, 'Agent JSON node value must be JSON-serializable', depth, state),
        });
      case 'progress': {
        const completed = progressNumber(node.completed, 'Agent progress completed');
        const total = node.total === undefined ? undefined : progressNumber(node.total, 'Agent progress total');
        if (total !== undefined && completed > total) {
          throw new AgentContractError('invalid-document', 'Agent progress completed must not exceed total');
        }
        const message = optionalString(node.message, 'Agent progress message');
        return Object.freeze({
          completed,
          kind: 'progress',
          ...(message === undefined ? {} : { message }),
          ...(total === undefined ? {} : { total }),
        });
      }
      case 'image':
        return Object.freeze({
          data: requiredString(node.data, 'Agent image data'),
          kind: 'image',
          mimeType: requiredString(node.mimeType, 'Agent image mimeType'),
        });
      case 'audio':
        return Object.freeze({
          data: requiredString(node.data, 'Agent audio data'),
          kind: 'audio',
          mimeType: requiredString(node.mimeType, 'Agent audio mimeType'),
        });
      case 'resource': {
        const mimeType = optionalString(node.mimeType, 'Agent resource mimeType');
        return Object.freeze({
          kind: 'resource',
          ...(mimeType === undefined ? {} : { mimeType }),
          name: requiredString(node.name, 'Agent resource name'),
          uri: requiredString(node.uri, 'Agent resource uri'),
        });
      }
      case 'error':
        return Object.freeze({
          code: requiredString(node.code, 'Agent error code'),
          kind: 'error',
          message: text(node.message, 'Agent error message'),
        });
      default: {
        const exhaustive: never = node;
        throw new AgentContractError(
          'invalid-document',
          `Unsupported Agent Document node kind: ${String((exhaustive as { kind?: unknown }).kind)}`,
        );
      }
    }
  } finally {
    state.ancestors.delete(node);
  }
};

const documentStatus = (status: AgentDocumentStatus): AgentDocumentStatus => {
  switch (status) {
    case 'success':
    case 'represented-error':
    case 'failed':
      return status;
    default: {
      const exhaustive: never = status;
      throw new AgentContractError('invalid-document', `Unsupported Agent Document status: ${String(exhaustive)}`);
    }
  }
};

export const createAgentDocument = (
  input: AgentDocument,
  limitOverrides: Partial<AgentRenderLimits> = {},
): AgentDocument => {
  if (input.version !== AGENT_DOCUMENT_VERSION) {
    throw new AgentContractError(
      'invalid-document',
      `Unsupported Agent Document version: ${String(input.version)}`,
    );
  }
  const limits = resolveAgentRenderLimits(limitOverrides);
  const state: NodeSnapshotState = { ancestors: new Set(), bytes: 0, limits, nodes: 0 };
  const root = snapshotNode(input.root, 1, state);
  const value = input.value === undefined
    ? undefined
    : snapshotJson(input.value, 'Agent Document value must be JSON-serializable', 1, state);
  const document: AgentDocument = Object.freeze({
    root,
    status: documentStatus(input.status),
    ...(value === undefined ? {} : { value }),
    version: AGENT_DOCUMENT_VERSION,
  });
  const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
  if (bytes > limits.maxDocumentBytes) {
    throw new AgentContractError(
      'document-bytes-exceeded',
      `Agent Document bytes exceed ${String(limits.maxDocumentBytes)}`,
    );
  }
  return document;
};

const snapshotRenderError = (error: AgentRenderError, limits: AgentRenderLimits): AgentRenderError => {
  const data = error.data === undefined
    ? undefined
    : snapshotJson(
      error.data,
      'Agent render error data must be JSON-serializable',
      1,
      { ancestors: new Set(), bytes: 0, limits, nodes: 0 },
    );
  return Object.freeze({
    code: requiredString(error.code, 'Agent render error code'),
    ...(data === undefined ? {} : { data }),
    message: text(error.message, 'Agent render error message'),
  });
};

const snapshotEvent = (
  input: AgentRenderEventInput,
  sequence: number,
  limits: AgentRenderLimits,
): AgentRenderEvent => {
  switch (input.type) {
    case 'shell':
      return Object.freeze({ document: createAgentDocument(input.document, limits), sequence, type: 'shell' });
    case 'progress': {
      const completed = progressNumber(input.completed, 'Agent render progress completed');
      const total = input.total === undefined ? undefined : progressNumber(input.total, 'Agent render progress total');
      if (total !== undefined && completed > total) {
        throw new AgentContractError('invalid-document', 'Agent render progress completed must not exceed total');
      }
      const message = optionalString(input.message, 'Agent render progress message');
      return Object.freeze({
        completed,
        ...(message === undefined ? {} : { message }),
        sequence,
        ...(total === undefined ? {} : { total }),
        type: 'progress',
      });
    }
    case 'replace':
      return Object.freeze({
        boundaryId: requiredString(input.boundaryId, 'Agent render boundaryId'),
        document: createAgentDocument(input.document, limits),
        sequence,
        type: 'replace',
      });
    case 'error': {
      const boundaryId = optionalString(input.boundaryId, 'Agent render boundaryId');
      return Object.freeze({
        ...(boundaryId === undefined ? {} : { boundaryId }),
        error: snapshotRenderError(input.error, limits),
        sequence,
        type: 'error',
      });
    }
    case 'complete':
      return Object.freeze({ document: createAgentDocument(input.document, limits), sequence, type: 'complete' });
    default: {
      const exhaustive: never = input;
      throw new AgentContractError(
        'invalid-document',
        `Unsupported Agent render event: ${String((exhaustive as { type?: unknown }).type)}`,
      );
    }
  }
};

export interface AgentRenderEventSequence {
  readonly completed: boolean;
  readonly maxElapsedMs: number;
  readonly nextSequence: number;
  readonly remainingMs: number;
  readonly emit: (input: AgentRenderEventInput) => AgentRenderEvent;
}

/**
 * `now` is the sequence's only time source (elapsed-time and event-rate
 * bounds); it defaults to the wall clock and exists so a render pipeline can
 * run every deadline against one injected clock.
 */
export const createAgentRenderEventSequence = (
  limitOverrides: Partial<AgentRenderLimits> = {},
  now: () => number = Date.now,
): AgentRenderEventSequence => {
  const limits = resolveAgentRenderLimits(limitOverrides);
  const startedAt = now();
  const recentTimes: number[] = [];
  let completed = false;
  let nextSequence = 0;
  return Object.freeze({
    get completed() {
      return completed;
    },
    get maxElapsedMs() {
      return limits.maxElapsedMs;
    },
    emit(input: AgentRenderEventInput): AgentRenderEvent {
      if (completed) {
        throw new AgentContractError(
          'handoff-required',
          'The render is complete; later work requires a new invocation handoff',
        );
      }
      const emittedAt = now();
      if (emittedAt - startedAt > limits.maxElapsedMs) {
        throw elapsedTimeExceeded(limits.maxElapsedMs);
      }
      recentTimes.push(emittedAt);
      const windowStart = emittedAt - 1000;
      while (recentTimes[0] !== undefined && recentTimes[0] < windowStart) {
        recentTimes.shift();
      }
      if (recentTimes.length > limits.maxEventRate) {
        throw new AgentContractError(
          'event-rate-exceeded',
          `Agent render event rate exceeds ${String(limits.maxEventRate)} per second`,
        );
      }
      if (nextSequence >= limits.maxEvents) {
        throw new AgentContractError(
          'event-count-exceeded',
          `Agent render event count exceeds ${String(limits.maxEvents)}`,
        );
      }
      const event = snapshotEvent(input, nextSequence, limits);
      const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (bytes > limits.maxEventBytes) {
        throw new AgentContractError(
          'event-bytes-exceeded',
          `Agent render event bytes exceed ${String(limits.maxEventBytes)}`,
        );
      }
      nextSequence += 1;
      if (event.type === 'complete') completed = true;
      return event;
    },
    get nextSequence() {
      return nextSequence;
    },
    get remainingMs() {
      return limits.maxElapsedMs - (now() - startedAt);
    },
  });
};
