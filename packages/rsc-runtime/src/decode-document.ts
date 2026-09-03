import { Children, isValidElement, type ReactNode } from 'react';

import {
  AgentContractError,
  admitDocumentNode,
  createAgentDocument,
  expectDocumentDepth,
  resolveAgentRenderLimits,
  type AgentDocument,
  type AgentDocumentNode,
  type AgentRenderLimits,
  type AgentResultNode,
} from './agent-document.js';
import { snapshotJsonValue, type JsonSnapshotBudget, type JsonValue } from './lower-mcp.js';

const agentElementTypes = Object.freeze([
  'agent-result',
  'agent-markdown',
  'agent-text',
  'agent-context',
  'agent-json',
  'agent-progress',
  'agent-image',
  'agent-audio',
  'agent-resource',
  'agent-error',
] as const);

type AgentElementType = typeof agentElementTypes[number];

interface AgentProtocolElement {
  readonly props: Record<string, unknown>;
  readonly type: AgentElementType;
}

const isAgentElementType = (value: string): value is AgentElementType =>
  (agentElementTypes as readonly string[]).includes(value);

const protocolElement = (node: ReactNode): AgentProtocolElement => {
  if (
    !isValidElement(node) ||
    typeof node.type !== 'string' ||
    !isAgentElementType(node.type)
  ) {
    throw new AgentContractError(
      'invalid-document',
      'Flight output must contain only Agent protocol elements; function components and HTML are unsupported',
    );
  }
  return { props: node.props as Record<string, unknown>, type: node.type };
};

const textChild = (children: unknown, type: AgentElementType): string => {
  const values = Children.toArray(children as ReactNode);
  if (values.length !== 1 || typeof values[0] !== 'string') {
    throw new AgentContractError('invalid-document', `${type} requires exactly one string child`);
  }
  return values[0];
};

/** A result's `value` with the depth of the result that declared it; `charged` once it is a budgeted snapshot. */
interface DeclaredValue {
  readonly charged: boolean;
  readonly depth: number;
  readonly value: JsonValue;
}

interface DecodeState {
  bytes: number;
  /** Serialized bytes of authored metadata that merging overwrote or dropped, so they never leave the finished document's byte budget. */
  discardedBytes: number;
  readonly limits: AgentRenderLimits;
  nodes: number;
  representedError: boolean;
  /** The `value` each decoded result node declared, or adopted from a merged container child. */
  readonly resultValues: WeakMap<AgentDocumentNode, DeclaredValue>;
}

/**
 * The decode pass's JSON budget, charging the same node, depth, and byte
 * limits `createAgentDocument` enforces on the finished document. Merging
 * removes the inner result, splices its children one level toward the root,
 * and may overwrite its keys, so every JSON payload — result metadata, JSON
 * node values, and the adopted result value — is charged here at the depth it
 * was authored, before anything moves or is dropped.
 */
const decodeBudget = (state: DecodeState): JsonSnapshotBudget => ({
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

const isJsonObject = (value: JsonValue | undefined): value is Record<string, JsonValue> =>
  value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A declared JSON prop as the plain JSON the document contract admits,
 * snapshotted through the same wire boundary and budget `createAgentDocument`
 * applies, at the depth it was authored. Merging spreads metadata and lifts a
 * value toward the root, so each must be validated first: a `Date`, a class
 * instance, an accessor, a cyclic value, or an over-limit object fails closed
 * here exactly as it does on a layout-free result instead of being flattened,
 * shallowed, or overwritten away.
 */
const budgetedJson = (value: JsonValue, message: string, depth: number, state: DecodeState): JsonValue => {
  try {
    return snapshotJsonValue(value, message, { depth, limits: decodeBudget(state) });
  } catch (error) {
    if (error instanceof AgentContractError) throw error;
    throw new AgentContractError('invalid-document', error instanceof Error ? error.message : message, { cause: error });
  }
};

const jsonMetadata = (value: JsonValue | undefined, depth: number, state: DecodeState): JsonValue | undefined =>
  value === undefined ? undefined : budgetedJson(value, 'Agent result metadata must be JSON-serializable', depth, state);

/** The value a container adopts from its merged child, charged once at the depth of the result that declared it. */
const adoptedValue = (declared: DeclaredValue, state: DecodeState): DeclaredValue => declared.charged
  ? declared
  : {
    charged: true,
    depth: declared.depth,
    value: budgetedJson(declared.value, 'Agent Document value must be JSON-serializable', declared.depth, state),
  };

/**
 * Metadata of a merged container: two JSON objects merge key by key with the
 * container winning conflicts, so nested layouts and the route each
 * contribute their own keys; any other declared shape — including an explicit
 * JSON `null` — lets the container win outright. Only a container that
 * declares no metadata at all adopts the inner result's. Both operands are
 * already budgeted snapshots (every result charges its metadata where it was
 * authored), so nested layouts pay for each authored object exactly once.
 * Whatever the merge overwrites or drops is recorded in `discardedBytes`: the
 * finished document is measured together with it, so splitting a payload
 * between overwritten metadata and retained content cannot slip past
 * `maxDocumentBytes`.
 */
const mergedMetadata = (
  outer: JsonValue | undefined,
  nested: JsonValue | undefined,
  state: DecodeState,
): JsonValue | undefined => {
  if (outer === undefined) return nested;
  if (nested === undefined) return outer;
  if (isJsonObject(outer) && isJsonObject(nested)) {
    const merged = { ...nested, ...outer };
    state.discardedBytes += jsonBytes(nested) + jsonBytes(outer) - jsonBytes(merged);
    return merged;
  }
  state.discardedBytes += jsonBytes(nested);
  return outer;
};

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Decodes one `agent-result` element. A result that declares no `value` is a
 * container — the shape a conventional layout renders around a route. When a
 * container directly holds a result that does carry a value, the two merge:
 * the inner result's value becomes the container's, its children take its
 * place, and the metadata combine per {@link mergedMetadata}. Only the first
 * valued child merges; a container with no valued child stays a plain
 * grouping node, exactly as before.
 */
const decodeResult = (
  props: Record<string, unknown>,
  depth: number,
  state: DecodeState,
): AgentResultNode => {
  const decoded = Children.toArray(props.children as ReactNode).map((child) => decodeNode(child, depth + 1, state));
  const ownValue = props.value as JsonValue | undefined;
  const ownMetadata = jsonMetadata(props.metadata as JsonValue | undefined, depth, state);
  const mergeIndex = ownValue === undefined
    ? decoded.findIndex((child) => child.kind === 'result' && state.resultValues.has(child))
    : -1;
  const merged = mergeIndex === -1 ? undefined : decoded[mergeIndex] as AgentResultNode;
  const children = merged === undefined
    ? decoded
    : [...decoded.slice(0, mergeIndex), ...merged.children, ...decoded.slice(mergeIndex + 1)];
  const metadata = merged === undefined ? ownMetadata : mergedMetadata(ownMetadata, merged.metadata, state);
  const node: AgentResultNode = {
    children,
    kind: 'result',
    ...(metadata === undefined ? {} : { metadata }),
  };
  if (merged === undefined) {
    if (ownValue !== undefined) state.resultValues.set(node, { charged: false, depth, value: ownValue });
    return node;
  }
  state.resultValues.set(node, adoptedValue(state.resultValues.get(merged)!, state));
  return node;
};

const decodeNode = (node: ReactNode, depth: number, state: DecodeState): AgentDocumentNode => {
  expectDocumentDepth(depth, state.limits);
  admitDocumentNode(state);
  const element = protocolElement(node);
  const { props } = element;
  switch (element.type) {
    case 'agent-result':
      return decodeResult(props, depth, state);
    case 'agent-markdown':
      return { kind: 'markdown', text: textChild(props.children, element.type) };
    case 'agent-text':
      return { kind: 'text', text: textChild(props.children, element.type) };
    case 'agent-context':
      return { kind: 'context', text: textChild(props.children, element.type) };
    case 'agent-json':
      return {
        kind: 'json',
        value: budgetedJson(props.value as JsonValue, 'Agent JSON node value must be JSON-serializable', depth, state),
      };
    case 'agent-progress':
      return {
        completed: props.completed as number,
        kind: 'progress',
        ...(props.message === undefined ? {} : { message: props.message as string }),
        ...(props.total === undefined ? {} : { total: props.total as number }),
      };
    case 'agent-image':
      return { data: props.data as string, kind: 'image', mimeType: props.mimeType as string };
    case 'agent-audio':
      return { data: props.data as string, kind: 'audio', mimeType: props.mimeType as string };
    case 'agent-resource':
      return {
        kind: 'resource',
        ...(props.mimeType === undefined ? {} : { mimeType: props.mimeType as string }),
        name: props.name as string,
        uri: props.uri as string,
      };
    case 'agent-error':
      state.representedError = true;
      return {
        code: props.code as string,
        kind: 'error',
        message: textChild(props.children, element.type),
      };
    default: {
      const exhaustive: never = element.type;
      throw new AgentContractError('invalid-document', `Unsupported Agent protocol element: ${String(exhaustive)}`);
    }
  }
};

export const decodeAgentDocument = (
  node: ReactNode,
  limits: Partial<AgentRenderLimits> = {},
): AgentDocument => {
  const resolved = resolveAgentRenderLimits(limits);
  const root = protocolElement(node);
  if (root.type !== 'agent-result') {
    throw new AgentContractError('invalid-document', 'Flight output must have Agent.Result as its root');
  }
  const state: DecodeState = {
    bytes: 0,
    discardedBytes: 0,
    limits: resolved,
    nodes: 0,
    representedError: false,
    resultValues: new WeakMap(),
  };
  const documentRoot = decodeNode(node, 1, state);
  const value = state.resultValues.get(documentRoot)?.value;
  const document = createAgentDocument({
    root: documentRoot,
    status: state.representedError ? 'represented-error' : 'success',
    ...(value === undefined ? {} : { value }),
    version: 1,
  }, resolved);
  // The authored tree is what the budget bounds: metadata a merge discarded
  // still counts alongside the document that replaced it.
  if (state.discardedBytes > 0 && state.discardedBytes + jsonBytes(document) > resolved.maxDocumentBytes) {
    throw new AgentContractError(
      'document-bytes-exceeded',
      `Agent Document bytes exceed ${String(resolved.maxDocumentBytes)}`,
    );
  }
  return document;
};

