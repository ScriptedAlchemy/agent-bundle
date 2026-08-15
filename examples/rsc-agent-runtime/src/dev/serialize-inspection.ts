import { isValidElement, type ReactNode } from 'react';

import type {
  DevRuntimeInspectionEnvelope,
  DevRuntimeTraceSpan,
  DevRuntimeTreeNode,
} from '../../../../packages/agent-bundle/src/dev/runtime-protocol.ts';
import type { JsonObject, JsonValue } from '../../../../packages/agent-bundle/src/dev/types.ts';

const inspectionStartedAt = '1970-01-01T00:00:00.000Z';
const flightPreviewBytes = 32 * 1024;

type JsonCandidate = JsonValue | undefined;

const freezeJson = (value: unknown, ancestors = new WeakSet<object>()): JsonCandidate => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined;
  }
  if (typeof value !== 'object' || ancestors.has(value)) return undefined;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor)) continue;
        const item = freezeJson(descriptor.value, ancestors);
        if (item !== undefined) output.push(item);
      }
      return Object.freeze(output);
    }

    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) continue;
      const item = freezeJson(descriptor.value, ancestors);
      if (item !== undefined) output[key] = item;
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
};

const labelForElement = (type: unknown): Readonly<{ kind: 'component' | 'element'; label: string }> => {
  if (typeof type === 'string') return { kind: 'element', label: type };
  if (typeof type === 'function') {
    const component = type as Readonly<{ displayName?: unknown; name?: unknown }>;
    return {
      kind: 'component',
      label:
        typeof component.displayName === 'string' && component.displayName.length > 0
          ? component.displayName
          : typeof component.name === 'string' && component.name.length > 0
            ? component.name
            : 'Anonymous',
    };
  }
  if (type === Symbol.for('react.fragment')) return { kind: 'element', label: 'Fragment' };
  return { kind: 'element', label: 'Unknown' };
};

const serializeProps = (value: unknown): JsonObject | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key === 'children') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) continue;
    const item = freezeJson(descriptor.value);
    if (item !== undefined) output[key] = item;
  }
  return Object.keys(output).length === 0 ? undefined : Object.freeze(output);
};

const serializeTree = (node: ReactNode): readonly DevRuntimeTreeNode[] => {
  let nextId = 0;
  const nodes = (value: unknown): DevRuntimeTreeNode[] => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return [];
    if (value === null || typeof value === 'boolean') {
      return [Object.freeze({ children: Object.freeze([]), id: `node-${nextId++}`, kind: 'value', label: String(value) })];
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return [Object.freeze({ children: Object.freeze([]), id: `node-${nextId++}`, kind: 'text', label: String(value) })];
    }
    if (!isValidElement(value)) {
      return [Object.freeze({ children: Object.freeze([]), id: `node-${nextId++}`, kind: 'value', label: 'Object' })];
    }

    const id = `node-${nextId++}`;
    const element = labelForElement(value.type);
    const props = serializeProps(value.props);
    const children = nodes((value.props as { children?: unknown }).children);
    return [Object.freeze({
      children: Object.freeze(children),
      id,
      kind: element.kind,
      label: element.label,
      ...(props === undefined ? {} : { props }),
    })];
  };

  return Object.freeze(nodes(node));
};

const trace = (): readonly DevRuntimeTraceSpan[] =>
  Object.freeze(['normalize', 'worker', 'flight', 'decode', 'lower'].map((phase) => Object.freeze({
    id: phase,
    phase,
    startedAt: inspectionStartedAt,
    status: 'succeeded' as const,
  })));

export interface SerializeInspectionInput {
  readonly agentVisible?: unknown;
  readonly flight: Uint8Array;
  readonly modelVisible?: unknown;
  readonly native?: unknown;
  readonly node: ReactNode;
  readonly protocol?: unknown;
  readonly stateStoreId: string;
  readonly stateVersion: number;
}

export const serializeInspection = (input: SerializeInspectionInput): DevRuntimeInspectionEnvelope => {
  const stateStoreId = input.stateStoreId.trim();
  if (stateStoreId.length === 0) throw new Error('stateStoreId must be non-empty');
  if (!Number.isSafeInteger(input.stateVersion) || input.stateVersion < 0) {
    throw new Error('stateVersion must be a non-negative safe integer');
  }

  const rawFlight = Buffer.from(input.flight);
  const agentVisible = freezeJson(input.agentVisible);
  const modelVisible = freezeJson(input.modelVisible);
  const native = freezeJson(input.native);
  const protocol = freezeJson(input.protocol);
  return Object.freeze({
    ...(agentVisible === undefined ? {} : { agentVisible }),
    flight: Object.freeze({
      bytes: rawFlight.byteLength,
      preview: rawFlight.subarray(0, flightPreviewBytes).toString('base64'),
      truncated: rawFlight.byteLength > flightPreviewBytes,
    }),
    ...(modelVisible === undefined ? {} : { modelVisible }),
    ...(native === undefined ? {} : { native }),
    ...(protocol === undefined ? {} : { protocol }),
    state: Object.freeze({ identity: Object.freeze({ stateStoreId, stateVersion: input.stateVersion }) }),
    trace: trace(),
    tree: serializeTree(input.node),
  });
};
