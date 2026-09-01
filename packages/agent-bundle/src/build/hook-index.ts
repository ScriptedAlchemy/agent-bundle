import { posix } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { isPlainRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { deepFreeze } from '../core/freeze.ts';


export interface ArtifactHook {
  readonly event: string;
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly target: string;
  /** Native hook timeout in seconds. Omit it to use the host default. */
  readonly timeout?: number;
}

export interface ArtifactHookIndex {
  readonly hooks: readonly ArtifactHook[];
}

export const artifactHookIndexName = 'agent-bundle.hooks.json';

/** Orders hook metadata by its explicit `(target, id)` tuple. */
export const compareArtifactHooks = (
  left: Pick<ArtifactHook, 'id' | 'target'>,
  right: Pick<ArtifactHook, 'id' | 'target'>,
): number => left.target === right.target
  ? left.id.localeCompare(right.id)
  : left.target.localeCompare(right.target);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
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
    value = parseJsonWithoutDuplicateKeys(bytes);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(value) || !hasExactKeys(value, ['hooks']) || !Array.isArray(value.hooks)) {
    return undefined;
  }

  const hooks: ArtifactHook[] = [];
  let previous: ArtifactHook | undefined;
  for (const candidate of value.hooks) {
    const hook = parseHook(candidate);
    if (hook === undefined) return undefined;
    if (previous !== undefined && compareArtifactHooks(previous, hook) >= 0) return undefined;
    previous = hook;
    hooks.push(hook);
  }
  const index: ArtifactHookIndex = deepFreeze({ hooks: hooks });
  return bytes === `${stableJson(index)}\n` ? index : undefined;
};
