import { createHash } from 'node:crypto';

import type { RuntimeResourceDefinition } from '../runtime/contracts.js';

export type SerializableValue = null | boolean | number | string | SerializableValue[] | { [key: string]: SerializableValue };
export type SerializableMetadata = Record<string, SerializableValue>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const cloneSerializableValue = (value: unknown, seen: Set<object> = new Set()): SerializableValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    throw new Error('Metadata must be JSON-serializable');
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => cloneSerializableValue(item, seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error('Metadata must be JSON-serializable');
    }

    const clone: SerializableMetadata = Object.create(null) as SerializableMetadata;
    for (const [key, item] of Object.entries(value)) {
      clone[key] = cloneSerializableValue(item, seen);
    }
    return clone;
  } finally {
    seen.delete(value);
  }
};

/**
 * Copies extension metadata verbatim while enforcing the portable JSON boundary.
 * Namespaces are deliberately opaque to this runtime.
 */
export const mergeSerializableMetadata = (...values: Array<Record<string, unknown> | undefined>): SerializableMetadata => {
  const result: SerializableMetadata = Object.create(null) as SerializableMetadata;
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    if (!isRecord(value)) {
      throw new Error('Metadata must be a JSON object');
    }
    for (const [key, item] of Object.entries(value)) {
      result[key] = cloneSerializableValue(item);
    }
  }
  return result;
};

export const claudeStableAppDomain = (publicMcpUrl: string): string => {
  const parsed = new URL(publicMcpUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Public MCP URL must use HTTP or HTTPS');
  }

  return `${createHash('sha256').update(publicMcpUrl).digest('hex').slice(0, 32)}.claudemcpcontent.com`;
};

/**
 * Converts the definition's portable resource fields into the MCP Apps shape.
 * The Claude domain is opt-in and belongs only to returned resource content.
 */
export const resourceMetadata = (
  resource: RuntimeResourceDefinition,
  publicMcpUrl?: string,
): SerializableMetadata => {
  const source = mergeSerializableMetadata(resource._meta);
  const csp = source['ui.csp'];
  const prefersBorder = source['ui.prefersBorder'];
  const existingUi = isRecord(source.ui) ? source.ui : undefined;
  delete source['ui.csp'];
  delete source['ui.prefersBorder'];
  delete source.ui;

  return mergeSerializableMetadata(source, {
    ui: mergeSerializableMetadata(existingUi, {
      ...(csp === undefined ? {} : { csp }),
      ...(prefersBorder === undefined ? {} : { prefersBorder }),
      ...(publicMcpUrl === undefined ? {} : { domain: claudeStableAppDomain(publicMcpUrl) }),
    }),
  });
};
