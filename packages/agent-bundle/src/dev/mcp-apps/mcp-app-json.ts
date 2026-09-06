import { snapshotStrictJsonValue, type JsonValue } from '../../core/strict-json.ts';

export type McpAppJsonValue = JsonValue;

export const requireMcpAppJson = (value: unknown, message: string): McpAppJsonValue => {
  try {
    return snapshotStrictJsonValue(value);
  } catch (error) {
    if (error instanceof TypeError) throw new TypeError(message, { cause: error });
    throw error;
  }
};
