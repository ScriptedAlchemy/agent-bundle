import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';

import { Mcp } from './elements.js';

type McpElement = {
  type: string;
  props: Record<string, unknown>;
};

const mcpComponents = new Set<unknown>(Object.values(Mcp));

const isMcpComponent = (value: unknown): value is ((props: Record<string, unknown>) => ReactElement) =>
  mcpComponents.has(value);

const isServerComponent = (value: unknown): value is ((props: Record<string, unknown>) => ReactNode) =>
  typeof value === 'function';

const asMcpElement = (node: ReactNode): McpElement => {
  let element = node;
  while (isValidElement(element) && (isMcpComponent(element.type) || isServerComponent(element.type))) {
    element = element.type(element.props as Record<string, unknown>);
  }

  if (!isValidElement(element) || typeof element.type !== 'string' || !element.type.startsWith('mcp-')) {
    throw new Error('Expected an MCP result element');
  }

  return { props: element.props as Record<string, unknown>, type: element.type };
};

const requiredString = (value: unknown, message: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(message);
  }
  return value;
};

const textChild = (children: unknown, message: string): string => {
  const values = Children.toArray(children as ReactNode);
  if (values.length !== 1 || typeof values[0] !== 'string') {
    throw new Error(message);
  }
  return values[0];
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const isArrayIndex = (key: string, length: number): boolean => {
  if (key === '0') return length > 0;
  if (!/^[1-9]\d*$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < length;
};

const jsonPathError = (reason: string, path: string): Error =>
  new Error(path === '' ? reason : `${reason} at ${path}`);

const cloneJsonValue = (value: unknown, ancestors: Set<object>, path: string): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw jsonPathError('non-finite number', path);
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

      const clone: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const elementPath = `${path}[${index}]`;
        if (!Object.hasOwn(value, index)) throw jsonPathError('sparse array', elementPath);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor)) throw jsonPathError('array accessor', elementPath);
        // JSON.stringify serializes undefined array elements as null; match the SDK wire shape.
        clone.push(descriptor.value === undefined ? null : cloneJsonValue(descriptor.value, ancestors, elementPath));
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw jsonPathError('non-plain object', path);
    const clone: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw jsonPathError('symbol key', path);
      const propertyPath = path === '' ? key : `${path}.${key}`;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw jsonPathError('non-enumerable or accessor property', propertyPath);
      }
      // JSON.stringify drops undefined-valued properties; match the SDK wire shape.
      if (descriptor.value === undefined) continue;
      clone[key] = cloneJsonValue(descriptor.value, ancestors, propertyPath);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
};

const jsonRecord = (value: unknown, message: string): Record<string, JsonValue> => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not a plain object');
    }
    const clone = cloneJsonValue(value, new Set(), '');
    if (Array.isArray(clone) || clone === null || typeof clone !== 'object') {
      throw new Error('not a plain object');
    }
    return clone;
  } catch (error) {
    throw new Error(`${message} (${error instanceof Error ? error.message : String(error)})`);
  }
};

const deepFreezeJson = (value: JsonValue): JsonValue => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * Copies declaration-level metadata through the same JSON wire boundary as
 * MCP results and deep-freezes the copy, so frozen definitions cannot be
 * mutated through their metadata after the fact.
 */
export const frozenJsonRecord = (value: unknown, message: string): Readonly<Record<string, JsonValue>> => {
  const clone = jsonRecord(value, message);
  deepFreezeJson(clone);
  return clone;
};

const lowerContent = (node: ReactNode): CallToolResult['content'][number] => {
  const element = asMcpElement(node);
  const { props } = element;
  switch (element.type) {
    case 'mcp-text':
      return { text: textChild(props.children, 'mcp-text requires one text child'), type: 'text' };
    case 'mcp-image':
      return {
        data: requiredString(props.data, 'mcp-image requires non-empty data and mimeType'),
        mimeType: requiredString(props.mimeType, 'mcp-image requires non-empty data and mimeType'),
        type: 'image',
      };
    case 'mcp-audio':
      return {
        data: requiredString(props.data, 'mcp-audio requires non-empty data and mimeType'),
        mimeType: requiredString(props.mimeType, 'mcp-audio requires non-empty data and mimeType'),
        type: 'audio',
      };
    case 'mcp-resource-link': {
      const mimeType = props.mimeType;
      if (mimeType !== undefined && typeof mimeType !== 'string') {
        throw new Error('mcp-resource-link mimeType must be a string');
      }
      return {
        ...(mimeType === undefined ? {} : { mimeType }),
        name: requiredString(props.name, 'mcp-resource-link requires non-empty uri and name'),
        type: 'resource_link',
        uri: requiredString(props.uri, 'mcp-resource-link requires non-empty uri and name'),
      };
    }
    case 'mcp-embedded-resource': {
      const hasText = props.text !== undefined;
      const hasTextChild = props.children !== undefined;
      const hasBlob = props.blob !== undefined;
      if (Number(hasText) + Number(hasTextChild) + Number(hasBlob) !== 1) {
        throw new Error('mcp-embedded-resource accepts exactly one text or blob value');
      }
      const mimeType = props.mimeType;
      if (mimeType !== undefined && typeof mimeType !== 'string') {
        throw new Error('mcp-embedded-resource mimeType must be a string');
      }
      const resource = {
        ...(mimeType === undefined ? {} : { mimeType }),
        uri: requiredString(props.uri, 'mcp-embedded-resource requires a non-empty uri'),
        ...(hasBlob
          ? { blob: requiredString(props.blob, 'mcp-embedded-resource blob must be non-empty') }
          : {
              text: hasTextChild
                ? textChild(props.children, 'mcp-embedded-resource requires one text child')
                : requiredString(props.text, 'mcp-embedded-resource text must be non-empty'),
            }),
      };
      return { resource, type: 'resource' };
    }
    case 'mcp-result':
      throw new Error('mcp-result may not be nested');
    default:
      throw new Error(`Unsupported MCP result element: ${element.type}`);
  }
};

export const lowerMcpResult = (node: ReactNode): CallToolResult => {
  const root = asMcpElement(node);
  if (root.type !== 'mcp-result') throw new Error('Expected mcp-result as the root element');
  if (root.props.isError !== undefined && typeof root.props.isError !== 'boolean') {
    throw new Error('mcp-result isError must be a boolean');
  }
  const structuredContent = root.props.structuredContent;
  const metadata = root.props._meta;
  return {
    content: Children.toArray(root.props.children as ReactNode).map(lowerContent),
    ...(metadata === undefined ? {} : { _meta: jsonRecord(metadata, 'mcp-result _meta must be JSON-serializable') }),
    ...(structuredContent === undefined
      ? {}
      : { structuredContent: jsonRecord(structuredContent, 'mcp-result structuredContent must be JSON-serializable') }),
    ...(root.props.isError === undefined ? {} : { isError: root.props.isError }),
  };
};
