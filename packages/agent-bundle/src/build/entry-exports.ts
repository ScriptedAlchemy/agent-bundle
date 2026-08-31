import { readFile } from 'node:fs/promises';

/**
 * Static entry-export detection for TypeScript/JavaScript entry modules. The
 * generated entry conventions only need two facts — "does this module export
 * `main`" and "does this module have a default export" — and the sources are
 * TypeScript, which the JS-only lexers in this package cannot parse. A
 * comment- and string-stripped scan decides both facts deterministically at
 * build time; the generated wrappers re-verify the export shape at runtime
 * with a clear error.
 */
export interface EntryExportScan {
  readonly hasDefaultExport: boolean;
  readonly hasMainExport: boolean;
}

/**
 * Removes comments, string literals, and template literals so export
 * detection never matches inside them. Template `${}` holes are scanned
 * recursively enough for detection purposes (nested braces tracked by depth).
 */
export const stripCommentsAndStrings = (source: string): string => {
  let output = '';
  let index = 0;
  const length = source.length;
  // Template-literal nesting: each entry is the brace depth inside a `${}` hole.
  const templateHoleDepth: number[] = [];
  let inTemplate = false;
  // Last significant character, for the division-versus-regex-literal heuristic.
  let lastCode = '';

  const regexCanFollow = (): boolean =>
    lastCode === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastCode) || /\breturn$|\btypeof$|\bcase$/u.test(output.trimEnd());

  while (index < length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (inTemplate) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '`') {
        inTemplate = false;
        index += 1;
        continue;
      }
      if (char === '$' && next === '{') {
        templateHoleDepth.push(0);
        inTemplate = false;
        output += ' ';
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      output += ' ';
      continue;
    }
    if (char === '/' && next !== '/' && next !== '*' && regexCanFollow()) {
      // Regex literal: skip to its unescaped closing slash (character classes
      // may contain unescaped slashes).
      index += 1;
      let inClass = false;
      while (index < length && (inClass || source[index] !== '/')) {
        if (source[index] === '\\') index += 1;
        else if (source[index] === '[') inClass = true;
        else if (source[index] === ']') inClass = false;
        index += 1;
      }
      index += 1;
      while (index < length && /[a-z]/iu.test(source[index]!)) index += 1;
      output += ' ';
      lastCode = ' ';
      continue;
    }
    if (char === "'" || char === '"') {
      index += 1;
      while (index < length && source[index] !== char) {
        index += source[index] === '\\' ? 2 : 1;
      }
      index += 1;
      output += ' ';
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      index += 1;
      continue;
    }
    if (templateHoleDepth.length > 0) {
      if (char === '{') {
        templateHoleDepth[templateHoleDepth.length - 1] = templateHoleDepth[templateHoleDepth.length - 1]! + 1;
      } else if (char === '}') {
        const depth = templateHoleDepth[templateHoleDepth.length - 1]!;
        if (depth === 0) {
          templateHoleDepth.pop();
          inTemplate = true;
          index += 1;
          continue;
        }
        templateHoleDepth[templateHoleDepth.length - 1] = depth - 1;
      }
    }
    output += char;
    if (!/\s/u.test(char)) lastCode = char;
    index += 1;
  }

  return output;
};

const exportBraceClausePattern = /export\s+(?:type\s+)?\{([^}]*)\}/gu;

/** Names exported by one `export { … }` clause, honoring `as` renames. */
const braceExportNames = (clause: string): readonly string[] => clause
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)
  .map((entry) => {
    const rename = /^(?:\S+)\s+as\s+(\S+)$/u.exec(entry);
    return rename === null ? entry : rename[1]!;
  });

export const scanEntryExportsSource = (source: string): EntryExportScan => {
  const stripped = stripCommentsAndStrings(source);
  const braceExports = new Set<string>();
  for (const match of stripped.matchAll(exportBraceClausePattern)) {
    // Type-only clauses (`export type { … }`) never produce runtime exports.
    if (/export\s+type\s*\{/u.test(match[0])) continue;
    for (const name of braceExportNames(match[1]!)) {
      braceExports.add(name);
    }
  }

  const hasDefaultExport =
    /(?:^|[\s;}])export\s+default\b/u.test(stripped) || braceExports.has('default');
  const hasMainExport =
    /(?:^|[\s;}])export\s+(?:async\s+)?(?:const|let|var|function)\s+main\b/u.test(stripped) ||
    braceExports.has('main');
  return Object.freeze({ hasDefaultExport, hasMainExport });
};

export const scanEntryExports = async (source: string): Promise<EntryExportScan> =>
  scanEntryExportsSource(await readFile(source, 'utf8'));
