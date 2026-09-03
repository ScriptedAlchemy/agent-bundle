/**
 * Parses `npm pack --json` output into its single pack entry. npm emits
 * either an array or a package-keyed object depending on version; both are
 * accepted, anything else throws.
 */
export const packOutputFromJson = (stdout) => {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object'
      ? Object.values(parsed)
      : undefined;
  if (entries === undefined) {
    throw new TypeError('npm pack --json returned neither an array nor a package-keyed object.');
  }
  if (entries.length !== 1) {
    throw new TypeError(`npm pack --json returned ${String(entries.length)} entries; expected exactly one.`);
  }
  const [entry] = entries;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('npm pack --json returned an invalid pack entry; expected one object.');
  }
  return entry;
};
