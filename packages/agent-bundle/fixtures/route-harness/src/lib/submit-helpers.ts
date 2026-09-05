/** Preserves first occurrence order while dropping duplicate fixture values. */
export const dedupe = <Value>(values: readonly Value[]): readonly Value[] => [...new Set(values)];
