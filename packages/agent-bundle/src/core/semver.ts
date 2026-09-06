export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

/** Finds the first semver-shaped token inside surrounding CLI banner text. */
export const parseSemanticVersion = (value: string): SemanticVersion | undefined => {
  const match = /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?=$|[^0-9A-Za-z.-])/u.exec(value);
  if (match === null) return undefined;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  });
};

/** True when observed is newer than minimum, or equal and not a prerelease. */
export const meetsMinimumVersion = (observed: SemanticVersion, minimum: SemanticVersion): boolean => {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (observed[key] !== minimum[key]) return observed[key] > minimum[key];
  }
  return !observed.prerelease;
};
