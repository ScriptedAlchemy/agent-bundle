import { parse as parseJavaScript } from 'acorn';
import { init, parse } from 'es-module-lexer';

import { DigestCache } from '../core/digest.ts';
import type { AgentBundleToolsConfig } from '../core/types.ts';

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

/**
 * How a build checks the syntax of the modules its own bundler emitted. The
 * bundler's output is trusted to the ESM lexer; once a consumer `tools` hatch
 * can rewrite emitted assets (a banner, a `processAssets` pass), the final
 * bytes are no longer the bundler's proof and are parsed in full. The
 * artifact build and the package build decide this the same way.
 */
export const bundleSyntaxCheckFor = (tools: AgentBundleToolsConfig | undefined): ModuleSyntaxCheck =>
  tools?.rspack === undefined && tools?.rsbuild === undefined ? 'lexed' : 'parsed';

const importKind = (dynamic: number): ModuleImport['kind'] =>
  dynamic === -2 ? 'meta' : dynamic === -1 ? 'static' : 'dynamic';

/**
 * Imports already read from bytes with a known SHA-256, keyed by check level
 * and digest (a full parse is a stronger claim than a lex, so each level is
 * remembered on its own); see `DigestCache` for why the same bundle is read
 * several times per process. The records are a few dozen specifiers per
 * module; the cache stays bounded.
 */
const importsByDigest = new DigestCache<readonly ModuleImport[]>(512);

/**
 * Reads the imports of one ES module source, throwing on invalid syntax
 * (the lexer's or, for `parsed`, acorn's). When the source's SHA-256 is
 * known, a result remembered for those bytes at this check level is
 * returned as is, and a fresh read is remembered for the next pass over the
 * same bytes.
 */
export const readModuleImports = async (
  source: string,
  options: { readonly check: ModuleSyntaxCheck; readonly sha256?: string },
): Promise<readonly ModuleImport[]> => {
  if (options.sha256 !== undefined) {
    const known = importsByDigest.get(`${options.check}:${options.sha256}`);
    if (known !== undefined) return known;
  }
  await init;
  if (options.check === 'parsed') parseJavaScript(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const [records] = parse(source);
  const imports = Object.freeze(records.map((record) => Object.freeze({
    kind: importKind(record.d),
    specifier: record.n,
  })));
  if (options.sha256 !== undefined) importsByDigest.set(`${options.check}:${options.sha256}`, imports);
  return imports;
};
