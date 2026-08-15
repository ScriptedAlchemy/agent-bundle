import { isValidElement, type ReactNode } from 'react';

import type {
  DevRuntimeInspectionEnvelope,
  DevRuntimeTraceSpan,
  DevRuntimeTreeNode,
} from '../../../../packages/agent-bundle/src/dev/runtime-protocol.ts';
import type { JsonObject, JsonValue } from '../../../../packages/agent-bundle/src/dev/types.ts';

const inspectionStartedAt = '1970-01-01T00:00:00.000Z';
const flightPreviewBytes = 32 * 1024;

const stripped = Symbol('inspection-stripped');
type JsonCandidate = JsonValue | typeof stripped;

const inspectionJsonError = (message: string): Error => new Error(`Inspection JSON contains ${message}.`);

const isArrayIndex = (key: string, length: number): boolean => {
  if (key === '0') return length > 0;
  if (!/^[1-9]\d*$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < length;
};

/**
 * Inspection output intentionally drops function and symbol values because they
 * cannot cross the JSON boundary. Every other non-JSON shape is rejected so a
 * decoded Flight value can never be silently changed while being inspected.
 */
const freezeJson = (value: unknown, references = new WeakSet<object>()): JsonCandidate => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw inspectionJsonError('a non-finite number');
    return value;
  }
  if (typeof value === 'function' || typeof value === 'symbol') return stripped;
  if (typeof value !== 'object') throw inspectionJsonError('a non-JSON value');
  if (references.has(value)) throw inspectionJsonError('a repeated or cyclic value');

  references.add(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some((key) => key !== 'length' && (typeof key !== 'string' || !isArrayIndex(key, value.length)))
    ) {
      throw inspectionJsonError('a sparse or decorated array');
    }

    const output: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw inspectionJsonError('a sparse array');
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) throw inspectionJsonError('an array accessor');
      const item = freezeJson(descriptor.value, references);
      if (item !== stripped) output.push(item);
    }
    return Object.freeze(output);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw inspectionJsonError('a non-plain object');

  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw inspectionJsonError('a symbol key');
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw inspectionJsonError('a non-enumerable or accessor property');
    }
    const item = freezeJson(descriptor.value, references);
    if (item !== stripped) output[key] = item;
  }
  return Object.freeze(Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right))));
};

const freezeOptionalJson = (value: unknown): JsonCandidate | undefined =>
  value === undefined ? undefined : freezeJson(value);

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

const ownDataProperties = (value: unknown, name: string): readonly (readonly [string, unknown])[] => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Inspection tree ${name} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Inspection tree ${name} must be a plain object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw new Error(`Inspection tree ${name} contains a symbol key.`);
  return Object.freeze((keys as string[]).sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`Inspection tree ${name} contains a non-enumerable or accessor property.`);
    }
    return [key, descriptor.value] as const;
  }));
};

const serializeProps = (value: unknown, references: WeakSet<object>): JsonObject | undefined => {
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, itemValue] of ownDataProperties(value, 'props')) {
    if (key === 'children') continue;
    const item = freezeJson(itemValue, references);
    if (item !== stripped) output[key] = item;
  }
  return Object.keys(output).length === 0 ? undefined : Object.freeze(output);
};

const childrenFor = (value: unknown): unknown => {
  for (const [key, item] of ownDataProperties(value, 'props')) {
    if (key === 'children') return item;
  }
  return undefined;
};

const assertTreeArray = (value: readonly unknown[]): void => {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => key !== 'length' && (typeof key !== 'string' || !isArrayIndex(key, value.length)))
  ) {
    throw new Error('Inspection tree contains a sparse or decorated array.');
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error('Inspection tree contains a sparse array.');
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) throw new Error('Inspection tree contains an array accessor.');
  }
};

const serializeTree = (node: ReactNode): readonly DevRuntimeTreeNode[] => {
  let nextId = 0;
  const jsonReferences = new WeakSet<object>();
  const nodes = (value: unknown, ancestors = new WeakSet<object>()): DevRuntimeTreeNode[] => {
    if (Array.isArray(value)) {
      if (ancestors.has(value)) throw new Error('Inspection tree contains a cyclic value.');
      ancestors.add(value);
      try {
        assertTreeArray(value);
        const output: DevRuntimeTreeNode[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined || !('value' in descriptor)) throw new Error('Inspection tree contains an array accessor.');
          output.push(...nodes(descriptor.value, ancestors));
        }
        return output;
      } finally {
        ancestors.delete(value);
      }
    }
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return [];
    if (value === null || typeof value === 'boolean') {
      return [Object.freeze({ children: Object.freeze([]), id: `node-${nextId++}`, kind: 'value', label: String(value) })];
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return [Object.freeze({ children: Object.freeze([]), id: `node-${nextId++}`, kind: 'text', label: String(value) })];
    }
    if (!isValidElement(value)) {
      void freezeJson(value, jsonReferences);
      return [Object.freeze({ children: Object.freeze([]), id: `node-${nextId++}`, kind: 'value', label: 'Object' })];
    }

    if (ancestors.has(value)) throw new Error('Inspection tree contains a cyclic value.');
    ancestors.add(value);
    try {
      const id = `node-${nextId++}`;
      const element = labelForElement(value.type);
      const props = serializeProps(value.props, jsonReferences);
      const children = nodes(childrenFor(value.props), ancestors);
      return [Object.freeze({
        children: Object.freeze(children),
        id,
        kind: element.kind,
        label: element.label,
        ...(props === undefined ? {} : { props }),
      })];
    } finally {
      ancestors.delete(value);
    }
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
  const agentVisible = freezeOptionalJson(input.agentVisible);
  const modelVisible = freezeOptionalJson(input.modelVisible);
  const native = freezeOptionalJson(input.native);
  const protocol = freezeOptionalJson(input.protocol);
  return Object.freeze({
    ...(agentVisible === undefined || agentVisible === stripped ? {} : { agentVisible }),
    flight: Object.freeze({
      bytes: rawFlight.byteLength,
      preview: rawFlight.subarray(0, flightPreviewBytes).toString('base64'),
      truncated: rawFlight.byteLength > flightPreviewBytes,
    }),
    ...(modelVisible === undefined || modelVisible === stripped ? {} : { modelVisible }),
    ...(native === undefined || native === stripped ? {} : { native }),
    ...(protocol === undefined || protocol === stripped ? {} : { protocol }),
    state: Object.freeze({ identity: Object.freeze({ stateStoreId, stateVersion: input.stateVersion }) }),
    trace: trace(),
    tree: serializeTree(input.node),
  });
};
