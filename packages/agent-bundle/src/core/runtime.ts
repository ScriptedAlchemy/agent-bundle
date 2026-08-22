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
