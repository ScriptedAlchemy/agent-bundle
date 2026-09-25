import { Buffer } from 'node:buffer';

import type { CallToolResult } from '@modelcontextprotocol/server';

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/** One `CallToolResult.content` block, as the MCP SDK types it. */
export type McpContentBlock = CallToolResult['content'][number];

/**
 * The MCP `CallToolResult` this package emits. The content blocks are the
 * SDK's own; `_meta` and `structuredContent` are the finite JSON objects the
 * projectors copy through the wire boundary, stated as such rather than as the
 * SDK's `unknown`. That keeps the value assignable to the `CallToolResult` of
 * `@modelcontextprotocol/server` 2.x and of the SDK's 1.x line (which types
 * `structuredContent` as a record) alike. A type alias, not an interface: only
 * object literal types get the implicit index signature the SDK's loose
 * result object requires.
 */
export type McpCallToolResult = {
  readonly _meta?: JsonObject;
  readonly content: McpContentBlock[];
  readonly isError?: boolean;
  readonly structuredContent?: JsonObject;
};
/** Incremental depth / node / byte checks while cloning JSON (Agent Document bounds). */
export interface JsonSnapshotBudget {
  readonly addBytes: (n: number) => void;
  readonly addNode: () => void;
  readonly checkDepth: (depth: number) => void;
}

const jsonLeafBytes = (value: null | boolean | number | string): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

const isArrayIndex = (key: string, length: number): boolean => {
  if (key === '0') return length > 0;
  if (!/^[1-9]\d*$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < length;
};

const jsonPathError = (reason: string, path: string): Error =>
  new Error(path === '' ? reason : `${reason} at ${path}`);

const cloneJsonValue = (
  value: unknown,
  ancestors: Set<object>,
  path: string,
  depth = 0,
  budget?: JsonSnapshotBudget,
): JsonValue => {
  budget?.checkDepth(depth);
  budget?.addNode();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    budget?.addBytes(jsonLeafBytes(value));
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw jsonPathError('non-finite number', path);
    budget?.addBytes(jsonLeafBytes(value));
    return value;
  }
  if (typeof value !== 'object') throw jsonPathError('non-JSON value', path);
  if (ancestors.has(value)) throw jsonPathError('cyclic value', path);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        keys.some((key) => key !== 'length' && (typeof key !== 'string' || !isArrayIndex(key, value.length)))
      ) {
        throw jsonPathError('sparse or decorated array', path);
      }

      budget?.addBytes(2);
      const clone: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) budget?.addBytes(1);
        const elementPath = `${path}[${index}]`;
        if (!Object.hasOwn(value, index)) throw jsonPathError('sparse array', elementPath);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor)) throw jsonPathError('array accessor', elementPath);
        // JSON.stringify serializes undefined array elements as null; match the SDK wire shape.
        clone.push(
          descriptor.value === undefined
            ? cloneJsonValue(null, ancestors, elementPath, depth + 1, budget)
            : cloneJsonValue(descriptor.value, ancestors, elementPath, depth + 1, budget),
        );
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw jsonPathError('non-plain object', path);
    budget?.addBytes(2);
    const clone: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
    let properties = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw jsonPathError('symbol key', path);
      const propertyPath = path === '' ? key : `${path}.${key}`;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw jsonPathError('non-enumerable or accessor property', propertyPath);
      }
      // JSON.stringify drops undefined-valued properties; match the SDK wire shape.
      if (descriptor.value === undefined) continue;
      if (properties > 0) budget?.addBytes(1);
      budget?.addBytes(jsonLeafBytes(key) + 1);
      properties += 1;
      clone[key] = cloneJsonValue(descriptor.value, ancestors, propertyPath, depth + 1, budget);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
};

const deepFreezeJson = (value: JsonValue): JsonValue => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
};

export const snapshotJsonValue = (
  value: unknown,
  message: string,
  budget?: { readonly depth: number; readonly limits: JsonSnapshotBudget },
): JsonValue => {
  try {
    return deepFreezeJson(cloneJsonValue(
      value,
      new Set(),
      '',
      budget?.depth ?? 0,
      budget?.limits,
    ));
  } catch (error) {
    if (error instanceof Error && error.name === 'AgentContractError') throw error;
    throw new Error(`${message} (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
};
