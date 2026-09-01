// Aliased: the workspace toolchain is typescript@7 (native compiler, no
// single-file parse API), and a plain `typescript` dependency here would
// shadow it for rslib's declaration generation. The alias ships the 5.x
// compiler API for parsing only.
import ts from 'typescript-5';

import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import { emptyRouteConfig } from './types.ts';

/**
 * The statically extracted `config` export of one route module, plus the
 * named diagnostics extraction raised. `config` is {@link emptyRouteConfig}
 * whenever the module exports no config, the declaration is not the accepted
 * `export const config = <expression>` form (AB4805), or the expression
 * leaves the accepted grammar (AB4806).
 */
export interface ExtractedRouteConfig {
  readonly config: Readonly<Record<string, unknown>>;
  readonly diagnostics: readonly Diagnostic[];
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
 * - numeric literals, optionally wrapped in unary `+`/`-`;
 * - `true`, `false`, and `null`;
 * - `as`/`satisfies` casts, non-null assertions, and parentheses around any
 *   accepted form (they unwrap to their inner expression).
 *
 * Everything else — identifier references, calls, functions, templates with
 * substitutions, `undefined`, bigints, regular expressions — is dynamic and
 * raises AB4806 naming the offending construct.
 */
export const routeConfigGrammar = 'object/array/string/number/boolean/null literals, with as-const, satisfies, non-null, and parenthesis wrappers';

const emptyExtraction: ExtractedRouteConfig = deepFreeze({
  config: emptyRouteConfig,
  diagnostics: [],
});

const declarationRecovery = 'Export the route config as a single top-level `export const config = { ... }` object literal, then inspect again.';
const grammarRecovery = `Restrict the config initializer to the static grammar (${routeConfigGrammar}), then inspect again.`;

const routeConfigError = (
  code: 'AB4805' | 'AB4806',
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

/** Casts, assertions, and parentheses carry no runtime value; unwrap them. */
const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const literalPropertyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
};

const extractExpression = (expression: ts.Expression): Extraction => {
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
  if (ts.isNumericLiteral(node)) return { kind: 'value', value: Number(node.text) };
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = unwrapExpression(node.operand);
    if (
      ts.isNumericLiteral(operand) &&
      (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
    ) {
      const magnitude = Number(operand.text);
      return { kind: 'value', value: node.operator === ts.SyntaxKind.MinusToken ? -magnitude : magnitude };
    }
    return dynamic(describeExpression(node), node);
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        return dynamic(describeExpression(element), element);
      }
      const extracted = extractExpression(element);
      if (extracted.kind === 'dynamic') return extracted;
      values.push(extracted.value);
    }
    return { kind: 'value', value: values };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return dynamic(describeExpression(property), property);
      const name = literalPropertyName(property.name);
      if (name === undefined) return dynamic(describeExpression(property.name), property.name);
      const extracted = extractExpression(property.initializer);
      if (extracted.kind === 'dynamic') return extracted;
      value[name] = extracted.value;
    }
    return { kind: 'value', value };
  }
  return dynamic(describeExpression(node), node);
};

const hasExportModifier = (statement: ts.Statement): boolean =>
  ts.canHaveModifiers(statement) &&
  (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

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

const scriptKindOf = (relativePath: string): ts.ScriptKind =>
  relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

const positionOf = (sourceFile: ts.SourceFile, node: ts.Node): string => {
  const { character, line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${line + 1}:${character + 1}`;
};

/**
 * Statically extracts the `export const config = <expression>` declaration of
 * one route module. The module is parsed with the TypeScript compiler and
 * never executed, so only the accepted grammar (see
 * {@link routeConfigGrammar}) produces a value; a module without a config
 * export extracts silently to {@link emptyRouteConfig}.
 */
export const extractRouteConfig = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
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
      config: emptyRouteConfig,
      diagnostics: [routeConfigError(
        'AB4805',
        `Route module ${relativePath} exports config through ${site.rejection!}; only a single top-level \`export const config = <expression>\` declaration is extracted.`,
        declarationRecovery,
        sourcePath,
      )],
    });
  }
  const extracted = extractExpression(site.initializer);
  if (extracted.kind === 'dynamic') {
    return deepFreeze({
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
    config: extracted.value as Record<string, unknown>,
    diagnostics: [],
  });
};
