import type { NormalizedRuntime } from './types.ts';

/** The default runtime floor for generated executables per the published contract. */
export const defaultGeneratedRuntime: NormalizedRuntime = Object.freeze({ node: '22.12.0' });

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/u;

/** Parses a `major.minor[.patch]` version string; patch defaults to zero. */
export const parseRuntimeVersion = (value: string): readonly [number, number, number] | undefined => {
  const match = versionPattern.exec(value);
  if (match === null) return undefined;
  const version = [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')] as const;
  return version.every(Number.isSafeInteger) ? version : undefined;
};

const compareVersions = (
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

/** True when the candidate version is at or above the default generated runtime floor. */
export const satisfiesGeneratedRuntimeFloor = (candidate: readonly [number, number, number]): boolean => {
  const floor = parseRuntimeVersion(defaultGeneratedRuntime.node);
  return floor !== undefined && compareVersions(candidate, floor) >= 0;
};

/** Canonical `major.minor.patch` form of a parsed runtime version. */
export const formatRuntimeVersion = (version: readonly [number, number, number]): string =>
  `${version[0]}.${version[1]}.${version[2]}`;

/**
 * The flag Node 22 and 24 take to lower TypeScript-only syntax while loading
 * a `.ts` source. Node 26 removed it (nodejs/node#61803) and rejects it as a
 * bad option (exit code 9).
 */
const TRANSFORM_TYPES_FLAG = '--experimental-transform-types';

/**
 * The `node` flags a child of this process needs to run a TypeScript source
 * with the fullest TypeScript support its binary has, decided by the flags
 * the binary accepts rather than by its version:
 *
 * - Node 22 and 24 accept `--experimental-transform-types`, which lowers
 *   TypeScript-only syntax (enums, namespaces, parameter properties) on top
 *   of stripping type annotations;
 * - Node 26 removed the flag with no stable successor and strips types by
 *   default (`process.features.typescript === 'strip'`), so the child gets no
 *   flag and TypeScript-only syntax fails there exactly as it does under
 *   `node file.ts`: `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
 *
 * `allowedFlags` defaults to the parent's `process.allowedNodeEnvironmentFlags`;
 * a child launched over `process.execPath` runs the same binary, so what the
 * parent accepts the child accepts. Every supported Node (`engines`) either
 * has the transform flag or strips types unflagged, so no strip flag is
 * ever needed.
 */
export const typeScriptTransformFlags = (
  allowedFlags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
): readonly string[] => Object.freeze(allowedFlags.has(TRANSFORM_TYPES_FLAG) ? [TRANSFORM_TYPES_FLAG] : []);
