/** Escapes a literal string for interpolation into a RegExp source. */
export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * A byte count for people: 1024-based with one decimal and a trailing `.0`
 * dropped (`427.1 KiB`, `1.3 MiB`, `2 MiB`); plain bytes below 1 KiB.
 */
export const formatByteSize = (bytes: number): string => {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) return `${kibibytes.toFixed(1).replace(/\.0$/u, '')} KiB`;
  return `${(kibibytes / 1024).toFixed(1).replace(/\.0$/u, '')} MiB`;
};
