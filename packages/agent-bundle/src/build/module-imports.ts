import { parse as parseJavaScript } from 'acorn';
import { init, parse } from 'es-module-lexer';

/**
 * One import of an ES module as the lexer reports it: `specifier` is the
 * literal module specifier (absent for a non-literal dynamic import), and
 * `kind` tells a static import from a dynamic `import()` and from the
 * `import.meta` pseudo-import that carries no module at all.
 */
export interface ModuleImport {
  readonly kind: 'dynamic' | 'meta' | 'static';
  readonly specifier: string | undefined;
}

/**
 * How thoroughly a module's syntax is checked before its imports are read.
 *
 * - `lexed`: the ESM lexer is the only pass. It rejects unterminated strings,
 *   templates, comments, and regexps and unbalanced braces — enough for a
 *   module the framework's own bundler emitted, whose syntax is the
 *   bundler's to guarantee. Re-parsing megabytes of bundler output to prove
 *   it is JavaScript was the dominant cost of every build.
 * - `parsed`: a full `acorn` parse runs first, so a module the framework did
 *   not compile — a copied consumer script, a generated installer — keeps
 *   the complete syntax check.
 */
export type ModuleSyntaxCheck = 'lexed' | 'parsed';

const importKind = (dynamic: number): ModuleImport['kind'] =>
  dynamic === -2 ? 'meta' : dynamic === -1 ? 'static' : 'dynamic';

/**
 * Imports already read from bytes with a known SHA-256, keyed by check level
 * and digest. Within one process the same emitted bundle is scanned by the
 * post-compile self-containment check, by artifact validation (twice: before
 * and after the manifest is written), and by the npm prepack dependency gate;
 * the bytes never change between those passes, so the imports of a
 * multi-megabyte bundle are lexed once. The records are a few dozen
 * specifiers per module; the map stays bounded.
 */
const importsByDigest = new Map<string, readonly ModuleImport[]>();
const importsByDigestLimit = 512;

const remember = (key: string, imports: readonly ModuleImport[]): void => {
  if (importsByDigest.size >= importsByDigestLimit) {
    const oldest = importsByDigest.keys().next();
    if (!oldest.done) importsByDigest.delete(oldest.value);
  }
  importsByDigest.set(key, imports);
};

/**
 * Both check levels read the same import records; `parsed` only adds acorn's
 * veto first. A remembered `parsed` result therefore answers a `lexed`
 * request, never the reverse.
 */
const remembered = (check: ModuleSyntaxCheck, sha256: string): readonly ModuleImport[] | undefined =>
  importsByDigest.get(`${check}:${sha256}`)
  ?? (check === 'lexed' ? importsByDigest.get(`parsed:${sha256}`) : undefined);

/**
 * Reads the imports of one ES module source, throwing on invalid syntax
 * (the lexer's or, for `parsed`, acorn's). When the source's SHA-256 is
 * known, a result remembered for those bytes at this check level (or a
 * stronger one) is returned as is, and a fresh read is remembered for the
 * next pass over the same bytes.
 */
export const readModuleImports = async (
  source: string,
  options: { readonly check: ModuleSyntaxCheck; readonly sha256?: string },
): Promise<readonly ModuleImport[]> => {
  if (options.sha256 !== undefined) {
    const known = remembered(options.check, options.sha256);
    if (known !== undefined) return known;
  }
  await init;
  if (options.check === 'parsed') parseJavaScript(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const [records] = parse(source);
  const imports = Object.freeze(records.map((record) => Object.freeze({
    kind: importKind(record.d),
    specifier: record.n,
  })));
  if (options.sha256 !== undefined) remember(`${options.check}:${options.sha256}`, imports);
  return imports;
};
