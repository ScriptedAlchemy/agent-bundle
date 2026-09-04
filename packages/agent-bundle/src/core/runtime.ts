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
 * The flags that make `node` load a TypeScript source, strongest first:
 *
 * - `--experimental-transform-types` (Node 22 and 24) lowers TypeScript-only
 *   syntax — enums, namespaces, parameter properties — on top of stripping
 *   type annotations. Node 26 removed it (nodejs/node#61803) with no stable
 *   successor and rejects it as a bad option (exit code 9).
 * - `--strip-types` (Node 24 and 26) strips type annotations only; it is on
 *   by default there (`process.features.typescript === 'strip'`), but naming
 *   it on the command line outranks a `--no-strip-types` the child would
 *   otherwise inherit through `NODE_OPTIONS`.
 */
const TYPESCRIPT_FLAGS: readonly string[] = Object.freeze(['--experimental-transform-types', '--strip-types']);

/**
 * The `node` flags a child of this process needs to run a TypeScript source
 * with the fullest TypeScript support its binary has: the first of
 * {@link TYPESCRIPT_FLAGS} the binary accepts, decided by the flags it
 * accepts rather than by its version. On Node 26 that is `--strip-types`, so
 * TypeScript-only syntax fails there exactly as it does under `node file.ts`
 * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
 *
 * `allowedFlags` defaults to the parent's `process.allowedNodeEnvironmentFlags`;
 * a child launched over `process.execPath` runs the same binary, so what the
 * parent accepts the child accepts. Every supported Node (`engines`) accepts
 * one of the two; a binary accepting neither gets no flag at all.
 */
export const typeScriptTransformFlags = (
  allowedFlags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
): readonly string[] => {
  const flag = TYPESCRIPT_FLAGS.find((candidate) => allowedFlags.has(candidate));
  return Object.freeze(flag === undefined ? [] : [flag]);
};
