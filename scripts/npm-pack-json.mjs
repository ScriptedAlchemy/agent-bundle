/**
 * Parses `npm pack --json` output into one pack entry. npm emits either an
 * array or a package-keyed object depending on version; both are accepted,
 * anything else throws.
 *
 * When `packageName` is given, the entry is selected by package name rather
 * than by position, so a pack that also lists sibling workspace packages
 * still resolves the intended tarball deterministically. Without it, the
 * output must contain exactly one entry. Mirrors
 * packages/agent-bundle/src/build/pack-inventory.ts.
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const packEntryName = (entry, key) => (isRecord(entry) && typeof entry.name === 'string' ? entry.name : key);

export const packOutputFromJson = (stdout, packageName) => {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed)
    ? parsed.map((entry) => [undefined, entry])
    : isRecord(parsed)
      ? Object.entries(parsed)
      : undefined;
  if (entries === undefined) {
    throw new TypeError('npm pack --json returned neither an array nor a package-keyed object.');
  }
  let entry;
  if (packageName === undefined) {
    if (entries.length !== 1) {
      throw new TypeError(`npm pack --json returned ${String(entries.length)} entries; expected exactly one.`);
    }
    entry = entries[0][1];
  } else {
    const named = entries.filter(([key, candidate]) => packEntryName(candidate, key) === packageName);
    if (named.length !== 1) {
      const seen = entries.map(([key, candidate]) => packEntryName(candidate, key) ?? '<unnamed>');
      throw new TypeError(
        `npm pack --json returned ${String(named.length)} entries named ${JSON.stringify(packageName)}; `
        + `expected exactly one (saw: ${seen.map((name) => JSON.stringify(name)).join(', ')}).`,
      );
    }
    entry = named[0][1];
  }
  if (!isRecord(entry)) {
    throw new TypeError('npm pack --json returned an invalid pack entry; expected one object.');
  }
  return entry;
};
