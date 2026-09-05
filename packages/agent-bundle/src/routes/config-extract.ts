import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';

// Aliased: the workspace toolchain is typescript@7 (native compiler, no
// single-file parse API), and a plain `typescript` dependency here would
// shadow it for rslib's declaration generation. The alias ships the 5.x
// compiler API for parsing only.
import ts from 'typescript-5';

import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import { isRelativeSpecifier, moduleCandidates, readModuleFromDisk } from './module-candidates.ts';
import { hasExportModifier, positionOf, unwrapExpression } from './syntax.ts';
import { emptyRouteConfig } from './types.ts';

/** The package subpath route modules import compile-time authoring helpers from. */
export const routeHelpersSpecifier = 'agent-bundle/routes';

/** The compile-time helper that references an MCP App route's `resourceUri`. */
export const appResourceUriHelperName = 'appResourceUri';

/**
 * One `appResourceUri('<app>')` call the extractor found inside `config`. The
 * config carries the reference text at {@link path} until the route-graph
 * compiler, which knows every App route, substitutes the target's
 * `resourceUri` through {@link resolveRouteConfigAppReferences}.
 */
export interface RouteConfigAppReference {
  /** Property path from the config root to the referencing value. */
  readonly path: readonly (number | string)[];
  /** `line:column` of the call inside the route module. */
  readonly position: string;
  /** The App reference exactly as authored. */
  readonly reference: string;
}

/**
 * The statically extracted `config` export of one route module, plus the
 * named diagnostics extraction raised. `config` is {@link emptyRouteConfig}
 * whenever the module exports no config, the declaration is not the accepted
 * `export const config = <expression>` form (AB4805), or the expression
 * leaves the accepted grammar (AB4806).
 */
export interface ExtractedRouteConfig {
  /** Unresolved `appResourceUri()` references, in source order; empty once resolved. */
  readonly appReferences: readonly RouteConfigAppReference[];
  readonly config: Readonly<Record<string, unknown>>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface RouteConfigExtractionOptions {
  /**
   * Absolute project root. A relative import that resolves outside it is not
   * project source and stays dynamic. Unset means unconstrained (tests).
   */
  readonly projectRoot?: string;
  /**
   * Reads one sibling module's text; `undefined` when the path is not a
   * readable file. Defaults to a synchronous filesystem read.
   */
  readonly readModule?: (path: string) => string | undefined;
}

/**
 * The accepted route-config expression grammar. Extraction is fully static —
 * the module is parsed, never executed — so the initializer must be built
 * from these forms only:
 *
 * - object literals whose property names are identifiers, string literals,
 *   or numeric literals (no computed names, spreads, shorthand references,
 *   methods, or accessors);
 * - array literals without spreads or holes;
 * - string literals and substitution-free template literals;
 * - finite numeric literals, optionally wrapped in unary `+`/`-`;
 * - `true`, `false`, and `null`;
 * - `as`/`satisfies` casts, non-null assertions, and parentheses around any
 *   accepted form (they unwrap to their inner expression);
 * - two constrained reference forms for string values: an identifier bound
 *   to a top-level `const` whose initializer is a string literal, declared
 *   in the same module or `export const`-ed by a module reached through a
 *   relative import inside the project; and `appResourceUri('<app>')`
 *   imported from `agent-bundle/routes`, which the route-graph compiler
 *   replaces with the referenced App route's `resourceUri`.
 *
 * Everything else — other identifier references, calls, functions,
 * templates with substitutions, `undefined`, bigints, regular expressions,
 * non-finite numbers such as `1e999` — is dynamic and raises AB4806 naming
 * the offending construct.
 */
export const routeConfigGrammar = 'object/array/string/number/boolean/null literals, with as-const, satisfies, non-null, and parenthesis wrappers, plus const string-literal identifiers and appResourceUri() App references';

const emptyExtraction: ExtractedRouteConfig = deepFreeze({
  appReferences: [],
  config: emptyRouteConfig,
  diagnostics: [],
});

const declarationRecovery = 'Export the route config as a single top-level `export const config = { ... }` object literal, then inspect again.';
const grammarRecovery = `Restrict the config initializer to the static grammar (${routeConfigGrammar}). A string value may reference a top-level const string literal declared in this module or exported by a relative sibling module (\`import { X } from './constants'\`), or reference an MCP App route through \`${appResourceUriHelperName}('<app>')\` imported from ${routeHelpersSpecifier}; then inspect again.`;
const appReferenceRecovery = `Reference an App route of the same generated server as '<app>', '<server>/<app>', 'app:<server>/<app>', or a relative module path from the referencing module, and make sure that App route declares a static config.resourceUri; then inspect again.`;

const routeConfigError = (
  code: 'AB4805' | 'AB4806' | 'AB4826',
  message: string,
  recovery: string,
  sourcePath: string,
): Diagnostic => ({ code, message, recovery, severity: 'error', sourcePath });

interface DynamicNode {
  readonly description: string;
  readonly node: ts.Node;
}

type Extraction =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'dynamic'; readonly dynamic: DynamicNode };

const dynamic = (description: string, node: ts.Node): Extraction =>
  ({ dynamic: { description, node }, kind: 'dynamic' });

/** One `import { name as local } from '<specifier>'` binding of the route module. */
interface ImportedBinding {
  readonly importedName: string;
  readonly node: ts.Node;
  readonly specifier: string;
}

/** The top-level bindings of one parsed module the reference forms may consult. */
interface ModuleScope {
  /** Top-level `const` declarations by local name; the flag records `export`. */
  readonly consts: ReadonlyMap<string, { readonly exported: boolean; readonly initializer: ts.Expression | undefined }>;
  readonly imports: ReadonlyMap<string, ImportedBinding>;
  /** Local names bound by `let`/`var`, functions, classes, or non-named imports: known, but never static. */
  readonly nonConst: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

const collectBindingNames = (name: ts.BindingName, into: Set<string>): void => {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, into);
  }
};

const scopeOf = (sourceFile: ts.SourceFile): ModuleScope => {
  const consts = new Map<string, { readonly exported: boolean; readonly initializer: ts.Expression | undefined }>();
  const imports = new Map<string, ImportedBinding>();
  const nonConst = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      const exported = hasExportModifier(statement);
      for (const declaration of statement.declarationList.declarations) {
        if (isConst && ts.isIdentifier(declaration.name)) {
          consts.set(declaration.name.text, { exported, initializer: declaration.initializer });
        } else {
          collectBindingNames(declaration.name, nonConst);
        }
      }
      continue;
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (clause.name !== undefined) nonConst.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings)) {
        nonConst.add(bindings.name.text);
        continue;
      }
      for (const element of bindings.elements) {
        if (clause.isTypeOnly || element.isTypeOnly) continue;
        const importedName = element.propertyName?.text ?? element.name.text;
        imports.set(element.name.text, { importedName, node: element, specifier });
      }
      continue;
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) {
      nonConst.add(statement.name.text);
    }
  }
  return { consts, imports, nonConst, sourceFile };
};

/** Names one rejected construct for the AB4806 message. */
const describeExpression = (node: ts.Node): string => {
  if (ts.isIdentifier(node)) {
    return node.text === 'undefined'
      ? 'the non-JSON value `undefined`'
      : `a reference to the identifier ${JSON.stringify(node.text)}`;
  }
  if (ts.isCallExpression(node)) return 'a call expression';
  if (ts.isTemplateExpression(node)) return 'a template literal with substitutions';
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return 'a function expression';
  if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) return 'a spread';
  if (ts.isShorthandPropertyAssignment(node)) return 'a shorthand property reference';
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return 'a method or accessor';
  }
  if (ts.isComputedPropertyName(node)) return 'a computed property name';
  if (ts.isOmittedExpression(node)) return 'an array hole';
  if (node.kind === ts.SyntaxKind.BigIntLiteral) return 'a bigint literal';
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) return 'a regular expression literal';
  return `a ${ts.SyntaxKind[node.kind] ?? 'dynamic'} expression`;
};

const literalPropertyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
};

const stringLiteralText = (expression: ts.Expression | undefined): string | undefined => {
  if (expression === undefined) return undefined;
  const node = unwrapExpression(expression);
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
};

/**
 * Numeric literals must extract to finite numbers: an overflowing literal
 * such as `1e999` evaluates to `Infinity`, which `JSON.stringify` collapses
 * to `null` — the digest and inspection output could no longer distinguish
 * the config from one that declared `null`.
 */
const finiteNumber = (value: number, node: ts.Node): Extraction =>
  Number.isFinite(value)
    ? { kind: 'value', value }
    : dynamic(`the non-finite number \`${String(value)}\``, node);

const scriptKindOf = (relativePath: string): ts.ScriptKind => {
  if (relativePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (relativePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
};

const parseModule = (path: string, text: string): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));

const insideProject = (projectRoot: string | undefined, path: string): boolean => {
  if (projectRoot === undefined) return true;
  const relativePath = relative(projectRoot, path);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
};

/** Per-extraction state: the route module's scope, the reference sink, and a sibling-module cache. */
interface ExtractionContext {
  readonly appReferences: RouteConfigAppReference[];
  readonly options: RouteConfigExtractionOptions;
  readonly readModule: (path: string) => string | undefined;
  readonly scope: ModuleScope;
  readonly siblingScopes: Map<string, ModuleScope | undefined>;
  readonly sourceDirectory: string;
}

type ImportedConstResolution =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'rejected'; readonly reason: string };

const resolveImportedConst = (
  binding: ImportedBinding,
  context: ExtractionContext,
): ImportedConstResolution => {
  const from = JSON.stringify(binding.specifier);
  if (!isRelativeSpecifier(binding.specifier)) {
    return { kind: 'rejected', reason: `imported from ${from}, which is not a relative module path` };
  }
  const candidates = moduleCandidates(context.sourceDirectory, binding.specifier);
  let scope: ModuleScope | undefined;
  for (const candidate of candidates) {
    if (!insideProject(context.options.projectRoot, candidate)) {
      return { kind: 'rejected', reason: `imported from ${from}, which resolves outside the project` };
    }
    if (context.siblingScopes.has(candidate)) {
      scope = context.siblingScopes.get(candidate);
    } else {
      const text = context.readModule(candidate);
      scope = text === undefined ? undefined : scopeOf(parseModule(candidate, text));
      context.siblingScopes.set(candidate, scope);
    }
    if (scope !== undefined) break;
  }
  if (scope === undefined) {
    return { kind: 'rejected', reason: `imported from ${from}, which does not resolve to a module inside the project` };
  }
  const declaration = scope.consts.get(binding.importedName);
  if (declaration === undefined || !declaration.exported) {
    return {
      kind: 'rejected',
      reason: `imported from ${from}, which does not declare a top-level \`export const ${binding.importedName}\``,
    };
  }
  const value = stringLiteralText(declaration.initializer);
  if (value === undefined) {
    return {
      kind: 'rejected',
      reason: `imported from ${from}, whose \`export const ${binding.importedName}\` initializer is not a string literal`,
    };
  }
  return { kind: 'value', value };
};

/** Resolves one identifier through the two constrained reference forms. */
const extractIdentifier = (node: ts.Identifier, context: ExtractionContext): Extraction => {
  if (node.text === 'undefined') return dynamic(describeExpression(node), node);
  const reference = `a reference to the identifier ${JSON.stringify(node.text)}`;
  const local = context.scope.consts.get(node.text);
  if (local !== undefined) {
    const value = stringLiteralText(local.initializer);
    return value === undefined
      ? dynamic(`${reference}, whose top-level const initializer is not a string literal`, node)
      : { kind: 'value', value };
  }
  const imported = context.scope.imports.get(node.text);
  if (imported !== undefined) {
    const resolved = resolveImportedConst(imported, context);
    return resolved.kind === 'value'
      ? { kind: 'value', value: resolved.value }
      : dynamic(`${reference}, ${resolved.reason}`, node);
  }
  if (context.scope.nonConst.has(node.text)) {
    return dynamic(`${reference}, which is not a top-level \`const\` string literal`, node);
  }
  return dynamic(`${reference}, which is neither a top-level const string literal in this module nor a named import from a relative module`, node);
};

/** Recognizes `appResourceUri('<app>')` imported from the route helpers subpath. */
const extractAppReferenceCall = (
  node: ts.CallExpression,
  path: readonly (number | string)[],
  context: ExtractionContext,
): Extraction => {
  const callee = unwrapExpression(node.expression);
  if (!ts.isIdentifier(callee)) return dynamic(describeExpression(node), node);
  const binding = context.scope.imports.get(callee.text);
  if (binding === undefined || binding.importedName !== appResourceUriHelperName) {
    if (callee.text === appResourceUriHelperName) {
      return dynamic(`a call to ${JSON.stringify(callee.text)} that is not imported from ${routeHelpersSpecifier}`, node);
    }
    return dynamic(describeExpression(node), node);
  }
  if (binding.specifier !== routeHelpersSpecifier) {
    return dynamic(
      `a call to ${appResourceUriHelperName} imported from ${JSON.stringify(binding.specifier)} instead of ${routeHelpersSpecifier}`,
      node,
    );
  }
  const [argument] = node.arguments;
  if (argument === undefined || node.arguments.length !== 1) {
    return dynamic(`a call to ${appResourceUriHelperName} without exactly one string argument`, node);
  }
  const extracted = extractExpression(argument, path, context);
  if (extracted.kind === 'dynamic') return extracted;
  if (typeof extracted.value !== 'string' || extracted.value.trim() === '') {
    return dynamic(`a call to ${appResourceUriHelperName} whose argument is not a non-empty string`, argument);
  }
  context.appReferences.push({
    path,
    position: positionOf(context.scope.sourceFile, node),
    reference: extracted.value,
  });
  // The reference text stands in until the graph compiler substitutes the
  // App's resourceUri; it is also what the helper returns at run time.
  return { kind: 'value', value: extracted.value };
};

const extractExpression = (
  expression: ts.Expression,
  path: readonly (number | string)[],
  context: ExtractionContext,
): Extraction => {
  const node = unwrapExpression(expression);
  switch (node.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return { kind: 'value', value: true };
    case ts.SyntaxKind.FalseKeyword:
      return { kind: 'value', value: false };
    case ts.SyntaxKind.NullKeyword:
      return { kind: 'value', value: null };
    default:
      break;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: 'value', value: node.text };
  }
  if (ts.isNumericLiteral(node)) return finiteNumber(Number(node.text), node);
  if (ts.isIdentifier(node)) return extractIdentifier(node, context);
  if (ts.isCallExpression(node)) return extractAppReferenceCall(node, path, context);
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = unwrapExpression(node.operand);
    if (
      ts.isNumericLiteral(operand) &&
      (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
    ) {
      const magnitude = Number(operand.text);
      return finiteNumber(node.operator === ts.SyntaxKind.MinusToken ? -magnitude : magnitude, node);
    }
    return dynamic(describeExpression(node), node);
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const [index, element] of node.elements.entries()) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        return dynamic(describeExpression(element), element);
      }
      const extracted = extractExpression(element, [...path, index], context);
      if (extracted.kind === 'dynamic') return extracted;
      values.push(extracted.value);
    }
    return { kind: 'value', value: values };
  }
  if (ts.isObjectLiteralExpression(node)) {
    // A null-prototype carrier keeps a literal `__proto__` key an ordinary
    // own property; assigning through a plain `{}` would invoke the legacy
    // prototype setter and silently drop the declared property.
    const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return dynamic(describeExpression(property), property);
      const name = literalPropertyName(property.name);
      if (name === undefined) return dynamic(describeExpression(property.name), property.name);
      const extracted = extractExpression(property.initializer, [...path, name], context);
      if (extracted.kind === 'dynamic') return extracted;
      value[name] = extracted.value;
    }
    return { kind: 'value', value };
  }
  return dynamic(describeExpression(node), node);
};

/** The named binding this pattern would introduce for `config`, if any. */
const bindsConfigName = (name: ts.BindingName): boolean => {
  if (ts.isIdentifier(name)) return name.text === 'config';
  return name.elements.some((element) =>
    !ts.isOmittedExpression(element) && bindsConfigName(element.name));
};

interface ConfigExportSite {
  /** The accepted-form initializer; absent for every rejected declaration shape. */
  readonly initializer?: ts.Expression;
  readonly rejection?: string;
}

/** Finds the first top-level statement that exports a `config` binding. */
const findConfigExport = (sourceFile: ts.SourceFile): ConfigExportSite | undefined => {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      const declaration = statement.declarationList.declarations
        .find((candidate) => bindsConfigName(candidate.name));
      if (declaration === undefined) continue;
      if (!ts.isIdentifier(declaration.name)) {
        return { rejection: 'a destructuring declaration' };
      }
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
        return { rejection: 'a mutable `let`/`var` declaration' };
      }
      if (declaration.initializer === undefined) {
        return { rejection: 'a declaration without an initializer' };
      }
      return { initializer: declaration.initializer };
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)) {
      const named = statement.exportClause.elements
        .find((element) => element.name.text === 'config');
      if (named !== undefined) return { rejection: 'an indirect `export { config }` clause' };
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      hasExportModifier(statement) && statement.name?.text === 'config') {
      return { rejection: 'a function or class declaration' };
    }
  }
  return undefined;
};

/**
 * Statically extracts the `export const config = <expression>` declaration of
 * one route module. The module is parsed with the TypeScript compiler and
 * never executed, so only the accepted grammar (see
 * {@link routeConfigGrammar}) produces a value; a module without a config
 * export extracts silently to {@link emptyRouteConfig}. Sibling modules a
 * const reference imports are parsed the same way, never executed.
 */
export const extractRouteConfig = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
  options: RouteConfigExtractionOptions = {},
): ExtractedRouteConfig => {
  const sourceFile = ts.createSourceFile(
    relativePath,
    moduleText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(relativePath),
  );
  const site = findConfigExport(sourceFile);
  if (site === undefined) return emptyExtraction;
  if (site.initializer === undefined) {
    return deepFreeze({
      appReferences: [],
      config: emptyRouteConfig,
      diagnostics: [routeConfigError(
        'AB4805',
        `Route module ${relativePath} exports config through ${site.rejection!}; only a single top-level \`export const config = <expression>\` declaration is extracted.`,
        declarationRecovery,
        sourcePath,
      )],
    });
  }
  const context: ExtractionContext = {
    appReferences: [],
    options,
    readModule: options.readModule ?? readModuleFromDisk,
    scope: scopeOf(sourceFile),
    siblingScopes: new Map(),
    sourceDirectory: dirname(sourcePath),
  };
  const extracted = extractExpression(site.initializer, [], context);
  if (extracted.kind === 'dynamic') {
    return deepFreeze({
      appReferences: [],
      config: emptyRouteConfig,
      diagnostics: [routeConfigError(
        'AB4806',
        `Route module ${relativePath} has a dynamic config: ${extracted.dynamic.description} at ${positionOf(sourceFile, extracted.dynamic.node)} is outside the static route-config grammar.`,
        grammarRecovery,
        sourcePath,
      )],
    });
  }
  if (typeof extracted.value !== 'object' || extracted.value === null || Array.isArray(extracted.value)) {
    return deepFreeze({
      appReferences: [],
      config: emptyRouteConfig,
      diagnostics: [routeConfigError(
        'AB4805',
        `Route module ${relativePath} exports a ${extracted.value === null ? 'null' : Array.isArray(extracted.value) ? 'array' : typeof extracted.value} config; the config export must be an object literal.`,
        declarationRecovery,
        sourcePath,
      )],
    });
  }
  return deepFreeze({
    appReferences: context.appReferences,
    config: extracted.value as Record<string, unknown>,
    diagnostics: [],
  });
};

/** One App route the reference resolver may target. */
export interface AppReferenceTarget {
  /** The route id, `app:<server>/<name>`. */
  readonly id: string;
  /** The App's statically extracted `config.resourceUri`. */
  readonly resourceUri: string;
  /** Absolute App route module path. */
  readonly source: string;
}

/** The referencing route module, as the resolver needs to see it. */
export interface AppReferenceSite {
  readonly relativePath: string;
  /** The owning MCP server name; absent for non-MCP routes, which cannot use the bare `'<app>'` form. */
  readonly serverName?: string;
  /** Absolute route module path. */
  readonly source: string;
}

/**
 * The extensions an App route module can carry (the discovery globs admit
 * `.ts`/`.tsx`) and the TypeScript-style specifier spellings that map onto
 * them. Only these count as an extension of a relative reference, so a
 * dotted App name such as `foo.bar` keeps its dot and a mistyped suffix
 * (`dashboard.tss`) matches nothing.
 */
const appModuleExtensions: Readonly<Record<string, string>> = {
  '.js': '.ts',
  '.jsx': '.tsx',
  '.ts': '.ts',
  '.tsx': '.tsx',
};

/** The App sources one relative reference may name: exact (after `.js`-style mapping) or extensionless. */
const relativeAppCandidates = (site: AppReferenceSite, reference: string): readonly string[] => {
  const candidate = resolve(dirname(site.source), reference);
  const extension = extname(reference).toLowerCase();
  const mapped = appModuleExtensions[extension];
  if (mapped !== undefined) return [`${candidate.slice(0, -extension.length)}${mapped}`];
  return [`${candidate}.ts`, `${candidate}.tsx`];
};

const findAppTarget = (
  reference: string,
  site: AppReferenceSite,
  apps: readonly AppReferenceTarget[],
): AppReferenceTarget | undefined => {
  if (isRelativeSpecifier(reference)) {
    const candidates = relativeAppCandidates(site, reference);
    return apps.find((app) => candidates.includes(app.source));
  }
  if (reference.startsWith('app:')) return apps.find((app) => app.id === reference);
  if (reference.includes('/')) return apps.find((app) => app.id === `app:${reference}`);
  if (site.serverName === undefined) return undefined;
  return apps.find((app) => app.id === `app:${site.serverName}/${reference}`);
};

const cloneWithSubstitutions = (
  value: unknown,
  path: readonly (number | string)[],
  substitutions: ReadonlyMap<string, string>,
): unknown => {
  const substitute = substitutions.get(JSON.stringify(path));
  if (substitute !== undefined) return substitute;
  if (Array.isArray(value)) {
    return value.map((element, index) => cloneWithSubstitutions(element, [...path, index], substitutions));
  }
  if (typeof value === 'object' && value !== null) {
    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      clone[key] = cloneWithSubstitutions((value as Record<string, unknown>)[key], [...path, key], substitutions);
    }
    return clone;
  }
  return value;
};

/** Why one `appResourceUri()` reference did not resolve, for the AB4826 message. */
const describeUnresolvedAppReference = (
  reference: string,
  site: AppReferenceSite,
  local: readonly AppReferenceTarget[],
  apps: readonly AppReferenceTarget[],
): string => {
  if (site.serverName === undefined) {
    return 'App references resolve only from MCP route modules (src/mcp/<server>/{tools,resources,prompts,apps}/*), whose generated server registers the App';
  }
  const foreign = findAppTarget(reference, site, apps);
  if (foreign !== undefined) {
    return `which is ${foreign.id} on another server; a generated server registers only its own Apps, so ${JSON.stringify(site.serverName)} cannot serve it`;
  }
  const known = local.length === 0
    ? `no App route of the generated ${JSON.stringify(site.serverName)} server declares a static config.resourceUri`
    : `known App routes of ${JSON.stringify(site.serverName)}: ${local.map((app) => app.id).sort((left, right) => left.localeCompare(right)).join(', ')}`;
  return `which matches no App route of the same server; ${known}`;
};

/**
 * Substitutes every `appResourceUri()` reference of an extraction with the
 * target App route's `resourceUri`. Only Apps of the referencing route's own
 * server are targets — a generated server registers exactly its own Apps, so
 * a URI from another server could never be read through it. A reference that
 * matches no such App (an unknown name, another server's App, an App whose
 * own `resourceUri` is not a static string, or any reference from a non-MCP
 * route) is AB4826, and — like every dynamic config — the route compiles
 * with the empty config beside the diagnostic rather than a half-resolved one.
 */
export const resolveRouteConfigAppReferences = (
  extracted: ExtractedRouteConfig,
  site: AppReferenceSite,
  apps: readonly AppReferenceTarget[],
): ExtractedRouteConfig => {
  if (extracted.appReferences.length === 0) return extracted;
  const local = site.serverName === undefined
    ? []
    : apps.filter((app) => app.id.startsWith(`app:${site.serverName}/`));
  const substitutions = new Map<string, string>();
  const diagnostics: Diagnostic[] = [...extracted.diagnostics];
  for (const reference of extracted.appReferences) {
    const target = findAppTarget(reference.reference, site, local);
    if (target === undefined) {
      diagnostics.push(routeConfigError(
        'AB4826',
        `Route module ${site.relativePath} references MCP App ${JSON.stringify(reference.reference)} at ${reference.position}, ${describeUnresolvedAppReference(reference.reference, site, local, apps)}.`,
        appReferenceRecovery,
        site.source,
      ));
      continue;
    }
    substitutions.set(JSON.stringify(reference.path), target.resourceUri);
  }
  if (diagnostics.length > extracted.diagnostics.length) {
    return deepFreeze({ appReferences: [], config: emptyRouteConfig, diagnostics });
  }
  return deepFreeze({
    appReferences: [],
    config: cloneWithSubstitutions(extracted.config, [], substitutions) as Record<string, unknown>,
    diagnostics,
  });
};
