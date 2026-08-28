import { z } from 'zod';

import type { Diagnostic } from '../../agent-bundle/src/contracts/diagnostics.ts';
import { parseJsonWithoutDuplicateKeys, type JsonValue } from '../../agent-bundle/src/contracts/strict-json.ts';
import { snapshotStrictJsonValue } from './strict-json.ts';

/** Shared coded client error so each workbench client keeps its name and `instanceof` class. */
export class CodedClientError<TCode extends string = string> extends Error {
  readonly code: TCode;

  constructor(name: string, code: TCode, message: string) {
    super(message);
    this.name = name;
    this.code = code;
  }
}

/**
 * Structural equality for decoded JSON, used to detect replay-vs-stream conflicts.
 * Key order is not significant, so records are compared as sorted entries.
 */
export const jsonEquivalent = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => jsonEquivalent(entry, right[index]));
  }
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, entry], index) =>
    key === rightEntries[index]?.[0] && jsonEquivalent(entry, rightEntries[index]?.[1]));
};

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Hands the viewer a browser download. The object URL is revoked on a queued
 * task: a synchronous revoke can abort the scheduled download of larger blobs.
 */
export const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = globalThis.document.createElement('a');
  link.download = filename;
  link.href = url;
  link.rel = 'noopener';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

/** Tolerates hostile error objects whose message accessor throws. */
export const errorMessage = (reason: unknown, fallback: string): string => {
  try { return reason instanceof Error && typeof reason.message === 'string' ? reason.message : fallback; }
  catch { return fallback; }
};

export const isAbortError = (reason: unknown): boolean =>
  reason instanceof Error && reason.name === 'AbortError';

/** Detaches a strict JSON snapshot, converting any hostile-value failure into the caller's error. */
export const strictJsonSnapshot = (value: unknown, invalid: () => Error): JsonValue => {
  try { return snapshotStrictJsonValue(value); }
  catch { throw invalid(); }
};

/** Fatal UTF-8 decode, duplicate-key-rejecting parse, and detached snapshot for a response body. */
export const parseStrictResponseJson = (bytes: Uint8Array, invalid: () => Error): JsonValue => {
  try { return strictJsonSnapshot(parseJsonWithoutDuplicateKeys(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), invalid); }
  catch { throw invalid(); }
};

/** Required keys present, every own key allowed, extras rejected. */
export const hasAllowedKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Readonly<Record<string, unknown>> =>
  isRecord(value) && required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

/** Exact own-key set; order-independent. */
export const exactKeys = (
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> =>
  isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export const requiredString = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  invalid: () => Error,
): string => {
  const candidate = value[key];
  if (typeof candidate !== 'string') throw invalid();
  return candidate;
};

export const optionalString = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  invalid: () => Error,
): string | undefined => {
  if (!Object.hasOwn(value, key)) return undefined;
  return requiredString(value, key, invalid);
};

export const diagnosticSeveritySchema = z.enum(['error', 'info', 'warning']);

const diagnosticFields = {
  code: z.string(),
  generatedPath: z.string().optional(),
  message: z.string(),
  recovery: z.string().optional(),
  severity: diagnosticSeveritySchema,
  sourcePath: z.string().optional(),
  target: z.string().optional(),
} as const;

/** Exact Diagnostic wire object (no extra keys). */
export const diagnosticSchema: z.ZodType<Diagnostic> = z.strictObject(diagnosticFields);

/** Same fields, extra keys allowed — artifact failure payloads are not exact. */
export const looseDiagnosticSchema = z.object(diagnosticFields);

export const diagnosticErrorEnvelopeSchema = z.strictObject({
  diagnostic: z.strictObject({
    code: z.string(),
    message: z.string(),
  }),
});

export const decodeExactDiagnostic = (value: unknown): Diagnostic | undefined => {
  const parsed = diagnosticSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : undefined;
};

/** Loose diagnostic used when extra keys must survive (artifact AB8064 payloads). */
export const isDiagnostic = (value: unknown): value is Diagnostic =>
  looseDiagnosticSchema.safeParse(value).success;

export const decodeDiagnosticError = (value: unknown): { readonly code: string; readonly message: string } | undefined => {
  const parsed = diagnosticErrorEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data.diagnostic : undefined;
};
