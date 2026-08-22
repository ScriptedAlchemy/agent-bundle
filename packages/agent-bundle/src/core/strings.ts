/** Escapes a literal string for interpolation into a RegExp source. */
export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
