import {
  isJsonRecord,
  snapshotStrictJsonValue,
  type JsonValue,
} from '../../core/strict-json.ts';

export type McpAppJsonValue = JsonValue;
export type McpAppJsonRecord = Readonly<Record<string, McpAppJsonValue>>;

/** Detaches a value already narrowed to the MCP App JSON domain. */
export const cloneMcpAppJson = (value: McpAppJsonValue): McpAppJsonValue => snapshotStrictJsonValue(value);

/** Returns a detached immutable MCP App JSON value or `undefined` for invalid input. */
export const snapshotMcpAppJson = (value: unknown): McpAppJsonValue | undefined => {
  try {
    return snapshotStrictJsonValue(value);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
};

/** Returns a detached immutable MCP App JSON object or `undefined` for invalid input. */
export const snapshotMcpAppJsonRecord = (value: unknown): McpAppJsonRecord | undefined => {
  const snapshot = snapshotMcpAppJson(value);
  return snapshot !== undefined && isJsonRecord(snapshot) ? snapshot : undefined;
};

export const requireMcpAppJson = (value: unknown, message: string): McpAppJsonValue => {
  try {
    return snapshotStrictJsonValue(value);
  } catch (error) {
    if (error instanceof TypeError) throw new TypeError(message, { cause: error });
    throw error;
  }
};

export const requireMcpAppJsonRecord = (value: unknown, message: string): McpAppJsonRecord => {
  const snapshot = requireMcpAppJson(value, message);
  if (!isJsonRecord(snapshot)) throw new TypeError(message);
  return snapshot;
};
