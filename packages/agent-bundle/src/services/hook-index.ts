import { posix } from 'node:path';

import type { ArtifactHook, ArtifactHookIndex } from '../build/emit.ts';
import { stableJson } from '../core/digest.ts';

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
};

const isSafeArtifactPath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  path === posix.normalize(path) &&
  path !== '..' &&
  !path.startsWith('../');

const parseHook = (value: unknown): ArtifactHook | undefined => {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['event', 'id', 'name', 'path', 'target'], ['timeout'])) {
    return undefined;
  }
  const timeout = value.timeout;
  if (
    typeof value.event !== 'string' || value.event.length === 0 ||
    typeof value.id !== 'string' || value.id.length === 0 ||
    typeof value.name !== 'string' || value.name.length === 0 ||
    typeof value.path !== 'string' || !isSafeArtifactPath(value.path) ||
    typeof value.target !== 'string' || value.target.length === 0 ||
    (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0))
  ) {
    return undefined;
  }
  return Object.freeze({
    event: value.event,
    id: value.id,
    name: value.name,
    path: value.path,
    target: value.target,
    ...(timeout === undefined ? {} : { timeout }),
  });
};

/** Parses canonical compiler-owned hook metadata without retaining mutable JSON input. */
export const parseArtifactHookIndex = (bytes: string): ArtifactHookIndex | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(value) || !hasExactKeys(value, ['hooks', 'version']) || value.version !== 1 || !Array.isArray(value.hooks)) {
    return undefined;
  }

  const hooks: ArtifactHook[] = [];
  let previous: string | undefined;
  for (const candidate of value.hooks) {
    const hook = parseHook(candidate);
    if (hook === undefined) return undefined;
    const key = `${hook.target}\u0000${hook.id}`;
    if (previous !== undefined && previous.localeCompare(key) >= 0) return undefined;
    previous = key;
    hooks.push(hook);
  }
  const index: ArtifactHookIndex = Object.freeze({ hooks: Object.freeze(hooks), version: 1 });
  return bytes === `${stableJson(index)}\n` ? index : undefined;
};
