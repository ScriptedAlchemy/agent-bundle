import { dirname } from 'node:path';

import ts from 'typescript-5';

import type { Diagnostic } from '../core/diagnostics.ts';
import { isInside, toPosixPath, toPosixRelative } from '../core/paths.ts';
import { isRelativeSpecifier, moduleCandidates, readModuleFromDisk } from './module-candidates.ts';

/**
 * Framework entries whose module graph carries the compiler. Every generated
 * executable — the routed CLI bin, script executables, generated MCP servers,
 * event-route hook wrappers — is a self-contained bundle (#387), so a value
 * import of one of these inlines the whole compiler into it and the build
 * fails deep inside the generated file rather than at the import: the
 * bundler on the compiler's runtime-relative module probes
 * (`new URL('../events/<module>.ts', import.meta.url)` in `build/entries.ts`:
 * `Module not found: Can't resolve '../events'`), or the artifact validator
 * on the inlined compiler's non-literal dynamic imports (`AB6005`, naming the
 * generated bin). Matched exactly: the subpaths below, never
 * `agent-bundle/api/<deeper>`.
 *
 * - `agent-bundle`: the root entry re-exports `api.ts`.
 * - `agent-bundle/api`: the compiler itself (`build`, `serveApp`, ...).
 * - `agent-bundle/config`: `defineConfig` pulls `validate.ts` and TypeScript.
 * - `agent-bundle/eval`: the eval harnesses pull `artifact.ts`, hence the build.
 * - `agent-bundle/rstest`, `agent-bundle/test`, `agent-bundle/test/browser`:
 *   the test harness and preset load the compiler to build fixtures.
 *
 * The leaf entries a route may value-import (`agent-bundle/routes`,
 * `agent-bundle/launch-env`, `agent-bundle/meta`, `agent-bundle/mcp-apps`,
 * `agent-bundle/mcp-entry`, `agent-bundle/cli-entry`,
 * `agent-bundle/terminal-capability`, `agent-bundle/serve-app-command`) are
 * deliberately absent.
 */
export const compilerCarryingSpecifiers: readonly string[] = Object.freeze([
  'agent-bundle',
  'agent-bundle/api',
  'agent-bundle/config',
  'agent-bundle/eval',
  'agent-bundle/rstest',
  'agent-bundle/test',
  'agent-bundle/test/browser',
]);

const compilerCarrying = new Set(compilerCarryingSpecifiers);

/** How a module imports a framework entry at run time. */
export type FrameworkValueImportForm = 'static' | 'dynamic' | 'reexport' | 'side-effect';

/** One value import of a compiler-carrying framework entry found by the scan. */
export interface FrameworkValueImport {
  /** Absolute path of the module containing the import (the route or a relatively imported helper). */
  readonly importer: string;
  readonly specifier: string;
  readonly form: FrameworkValueImportForm;
}

/** Where the scanned module lives, so relative imports can be followed. */
export interface ScanFrameworkValueImportsOptions {
  /**
   * Reads one relatively imported module's source text by absolute path;
   * undefined when the file is unreadable. Defaults to a synchronous file read.
   */
  readonly readModule?: (absolutePath: string) => string | undefined;
  /** The scanned module's absolute path; relative imports resolve against its directory. */
  readonly source: string;
}

const scriptKindOf = (path: string): ts.ScriptKind => {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Whether one identifier occurrence reads the binding of that name at run
 * time. The bundler's SWC transform elides an import whose bindings are only
 * ever used as types — with or without the `type` keyword — so an import
 * counts as a value import only when some binding survives that elision.
 * Every position that is a *name* rather than a reference (`foo.serveApp`,
 * `{ serveApp: 1 }`, a declaration's own name, an import/export clause) is
 * ruled out first; then any ancestor that makes the occurrence a type-level
 * one (a type node, which covers `typeof x` type queries and `import('x')`
 * type nodes, an `implements` clause, a `type`/`interface`/type-parameter
 * declaration) or an ambient `declare` declaration rules it out too. Shadowing
 * declarations in nested scopes are not modelled: a same-named local
 * reference still counts, which errs toward reporting only in the
 * import-then-shadow-then-type-only case.
 */
const isValueReference = (identifier: ts.Identifier): boolean => {
  const { parent } = identifier;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isExportSpecifier(parent)) return isLocalExportReference(identifier, parent);
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if (ts.isMetaProperty(parent)) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return !isInTypeContext(parent);
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isEnumMember(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isJsxAttribute(parent)) &&
    parent.name === identifier
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && (parent.propertyName === identifier || parent.name === identifier)) return false;
  if (isDeclaredName(identifier, parent)) return false;
  // A lowercase JSX tag is an intrinsic element, not a binding.
  if (
    (ts.isJsxOpeningLikeElement(parent) || ts.isJsxClosingElement(parent)) &&
    parent.tagName === identifier &&
    /^[a-z]/u.test(identifier.text)
  ) {
    return false;
  }
  return !isInTypeContext(parent);
};

/** `export { x }` / `export { x as y }` without a module specifier reads the local binding `x`. */
const isLocalExportReference = (identifier: ts.Identifier, specifier: ts.ExportSpecifier): boolean => {
  const declaration = specifier.parent.parent;
  if (specifier.isTypeOnly || declaration.isTypeOnly || declaration.moduleSpecifier !== undefined) return false;
  return (specifier.propertyName ?? specifier.name) === identifier;
};

/** True when the identifier is the declared name of its parent, not a reference. */
const isDeclaredName = (identifier: ts.Identifier, parent: ts.Node): boolean => {
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isClassExpression(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isEnumDeclaration(parent) ||
    ts.isModuleDeclaration(parent) ||
    ts.isTypeParameterDeclaration(parent)
  ) {
    return parent.name === identifier;
  }
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return parent.label === identifier;
  return false;
};

/** `class C extends X<T>`: the `X` expression is a value even though TypeScript types the node. */
const isClassExtendsExpression = (node: ts.ExpressionWithTypeArguments): boolean =>
  ts.isHeritageClause(node.parent) &&
  node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
  ts.isClassLike(node.parent.parent);

/** True for a declaration carrying the `declare` modifier: an ambient context the emit erases entirely. */
const isAmbientDeclaration = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false);

/** True when some ancestor makes the position type-level or ambient, so no JavaScript reads it. */
const isInTypeContext = (start: ts.Node): boolean => {
  for (let ancestor: ts.Node | undefined = start; ancestor !== undefined; ancestor = ancestor.parent) {
    if (ts.isExpressionWithTypeArguments(ancestor)) {
      if (isClassExtendsExpression(ancestor)) continue;
      return true;
    }
    if (ts.isTypeNode(ancestor)) return true;
    if (ts.isHeritageClause(ancestor) && ancestor.token === ts.SyntaxKind.ImplementsKeyword) return true;
    if (
      ts.isTypeAliasDeclaration(ancestor) ||
      ts.isInterfaceDeclaration(ancestor) ||
      ts.isTypeParameterDeclaration(ancestor) ||
      isAmbientDeclaration(ancestor)
    ) {
      return true;
    }
  }
  return false;
};

/** The local binding names an import declaration introduces as values (`type`-qualified specifiers excluded). */
const valueBindingsOf = (clause: ts.ImportClause): readonly string[] => {
  if (clause.isTypeOnly) return [];
  const names: string[] = [];
  if (clause.name !== undefined) names.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) {
      names.push(bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) names.push(element.name.text);
      }
    }
  }
  return names;
};

/** Whether a re-export declaration emits JavaScript (SWC keeps every specifier not marked `type`). */
const isValueReExport = (declaration: ts.ExportDeclaration): boolean => {
  if (declaration.isTypeOnly) return false;
  const clause = declaration.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
};

const moduleSpecifierText = (expression: ts.Expression | undefined): string | undefined =>
  expression !== undefined && ts.isStringLiteralLike(expression) ? expression.text : undefined;

/** Every identifier text in `names` that some value position of the module reads. */
const referencedValueBindings = (sourceFile: ts.SourceFile, names: ReadonlySet<string>): Set<string> => {
  const referenced = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text) && !referenced.has(node.text) && isValueReference(node)) {
      referenced.add(node.text);
    }
    if (referenced.size < names.size) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return referenced;
};

/** Every `import('<literal>')` specifier in the module, wherever it appears. */
const dynamicImportSpecifiers = (sourceFile: ts.SourceFile): readonly string[] => {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = moduleSpecifierText(node.arguments[0]);
      if (specifier !== undefined) specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

interface ValueImport {
  readonly form: FrameworkValueImportForm;
  readonly specifier: string;
}

/**
 * The module's value imports — the specifiers the bundler resolves and
 * inlines once SWC has elided the type-only ones — in source order.
 */
const valueImportsOf = (sourceFile: ts.SourceFile): readonly ValueImport[] => {
  const imports: ValueImport[] = [];
  const staticBindings = new Map<string, Set<string>>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = moduleSpecifierText(statement.moduleSpecifier);
      if (specifier === undefined) continue;
      if (statement.importClause === undefined) {
        imports.push({ form: 'side-effect', specifier });
        continue;
      }
      const bindings = valueBindingsOf(statement.importClause);
      if (bindings.length === 0) continue;
      const known = staticBindings.get(specifier) ?? new Set<string>();
      for (const binding of bindings) known.add(binding);
      staticBindings.set(specifier, known);
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const specifier = moduleSpecifierText(statement.moduleSpecifier);
      if (specifier !== undefined && isValueReExport(statement)) imports.push({ form: 'reexport', specifier });
    }
  }
  if (staticBindings.size > 0) {
    const names = new Set([...staticBindings.values()].flatMap((bindings) => [...bindings]));
    const referenced = referencedValueBindings(sourceFile, names);
    for (const [specifier, bindings] of staticBindings) {
      if ([...bindings].some((binding) => referenced.has(binding))) imports.push({ form: 'static', specifier });
    }
  }
  for (const specifier of dynamicImportSpecifiers(sourceFile)) imports.push({ form: 'dynamic', specifier });
  return imports;
};

const scanModule = (
  moduleText: string,
  source: string,
  read: (absolutePath: string) => string | undefined,
  visited: Set<string>,
  findings: FrameworkValueImport[],
): void => {
  const sourceFile = ts.createSourceFile(source, moduleText, ts.ScriptTarget.Latest, true, scriptKindOf(source));
  for (const { form, specifier } of valueImportsOf(sourceFile)) {
    if (compilerCarrying.has(specifier)) {
      findings.push({ form, importer: source, specifier });
      continue;
    }
    if (!isRelativeSpecifier(specifier)) continue;
    // The same candidate order the other static scans use, so every scan
    // names one file for one specifier; the first readable candidate wins.
    for (const candidate of moduleCandidates(dirname(source), specifier)) {
      if (visited.has(candidate)) break;
      const text = read(candidate);
      if (text === undefined) continue;
      visited.add(candidate);
      scanModule(text, candidate, read, visited, findings);
      break;
    }
  }
};

/**
 * Statically finds every value import of a compiler-carrying framework entry
 * in one module and the modules it reaches through relative value imports
 * (`./` and `../` specifiers, followed with the shared candidate order, each
 * file once). The module is parsed, never evaluated. Findings list the
 * scanned module's own first, then by importer path, specifier, and form.
 */
export const scanFrameworkValueImports = (
  moduleText: string,
  options: ScanFrameworkValueImportsOptions,
): readonly FrameworkValueImport[] => {
  const findings: FrameworkValueImport[] = [];
  scanModule(moduleText, options.source, options.readModule ?? readModuleFromDisk, new Set([options.source]), findings);
  findings.sort((left, right) =>
    Number(left.importer !== options.source) - Number(right.importer !== options.source) ||
    compareStrings(left.importer, right.importer) ||
    compareStrings(left.specifier, right.specifier) ||
    compareStrings(left.form, right.form));
  return Object.freeze(findings.map((finding) => Object.freeze(finding)));
};

/**
 * Names a helper module the way the project's own diagnostics name files:
 * project-relative when the route's project root can be recovered from its
 * paths and the helper lies inside it, otherwise relative to the route's
 * directory.
 */
const describeImporter = (importer: string, relativePath: string, sourcePath: string): string => {
  const posixSource = toPosixPath(sourcePath);
  const suffix = `/${relativePath}`;
  if (posixSource.endsWith(suffix)) {
    const projectRoot = sourcePath.slice(0, sourcePath.length - suffix.length);
    if (isInside(projectRoot, importer)) return toPosixRelative(projectRoot, importer);
  }
  const fromRoute = toPosixRelative(dirname(sourcePath), importer);
  return fromRoute.startsWith('.') ? fromRoute : `./${fromRoute}`;
};

const recovery =
  'Keep framework calls in a host process: serve an MCP App from a routed command with spawnServeApp from agent-bundle/serve-app-command, which spawns agent-bundle serve-app; use import type for framework types; otherwise move the call into a package.json script or a hand-written .mjs run from the checkout.';

/**
 * AB4837: the module a generated executable bundles value-imports a
 * compiler-carrying framework entry (#558), directly or through a relatively
 * imported helper. At most one diagnostic per module — the first finding in
 * the scan's deterministic order — so a route that imports the compiler
 * three ways reads one actionable sentence. `executable` is the noun for the
 * self-contained bundle the module ends up in ('routed CLI executable',
 * 'generated MCP server', ...); `subject` is how the module is addressed.
 */
export const validateRouteFrameworkImports = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
  executable: string,
  subject = 'Route module',
): readonly Diagnostic[] => {
  const [finding] = scanFrameworkValueImports(moduleText, { source: sourcePath });
  if (finding === undefined) return Object.freeze([]);
  const via = finding.importer === sourcePath
    ? ''
    : ` (via ${describeImporter(finding.importer, relativePath, sourcePath)})`;
  return Object.freeze([{
    code: 'AB4837',
    message: `${subject} ${relativePath} imports ${JSON.stringify(finding.specifier)} as a value${via}; the ${executable} is self-contained and cannot bundle the compiler, so the build would fail deep inside the generated executable (an unresolvable compiler module or AB6005) instead of at this import.`,
    recovery,
    severity: 'error',
    sourcePath,
  }]);
};
