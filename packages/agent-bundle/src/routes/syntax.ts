// Aliased for the same reason as config-extract.ts: this is a parser-only use
// of the TypeScript 5.x compiler API, bundled into the package (#381).
import ts from 'typescript-5';

/**
 * The structural slice of a TypeScript AST node the helpers below need. They
 * are declared here, not as `ts.*`, because `typescript-5` is a devDependency
 * this package bundles and consumers never install: naming its types in an
 * exported signature would put `import 'typescript-5'` into the shipped
 * declaration of this module, which `pnpm lint:release`
 * (scripts/check-declaration-imports.mjs) rejects. Every `ts.Node` satisfies
 * them, so the extractors keep passing compiler nodes and narrowing the
 * results with the compiler's own guards.
 */
export interface SyntaxNode {
  readonly kind: number;
  getStart(sourceFile?: SyntaxSourceFile): number;
}

/** The slice of `ts.SourceFile` that maps a position to its line and column. */
export interface SyntaxSourceFile {
  getLineAndCharacterOfPosition(position: number): { readonly character: number; readonly line: number };
}

/** A top-level statement, which may carry modifiers such as `export`. */
export interface SyntaxStatement extends SyntaxNode {
  readonly modifiers?: readonly SyntaxNode[];
}

/** A node that wraps another expression without changing its runtime value. */
interface TransparentWrapper extends SyntaxNode {
  readonly expression: SyntaxNode;
}

const transparentWrapperKinds: ReadonlySet<number> = new Set<number>([
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.TypeAssertionExpression,
]);

const isTransparentWrapper = (node: SyntaxNode): node is TransparentWrapper => transparentWrapperKinds.has(node.kind);

/**
 * Casts, assertions, and parentheses carry no runtime value; unwrap them.
 * The result is typed as the argument: exact for `ts.Expression` (every
 * wrapper is one, so the innermost node is one too) and safe for the
 * brand-only families below it (`ts.UnaryExpression`,
 * `ts.LeftHandSideExpression`), which add no members. Never pass a wrapper
 * type itself, such as `ts.ParenthesizedExpression`, whose `expression`
 * member the result lacks.
 */
export const unwrapExpression = <Expression extends SyntaxNode>(expression: Expression): Expression => {
  let current: SyntaxNode = expression;
  while (isTransparentWrapper(current)) current = current.expression;
  return current as Expression;
};

/** The 1-based `line:column` of `node` in `sourceFile`, the form every extractor diagnostic quotes. */
export const positionOf = (sourceFile: SyntaxSourceFile, node: SyntaxNode): string => {
  const { character, line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${line + 1}:${character + 1}`;
};

/** Whether a top-level statement carries the `export` modifier. */
export const hasExportModifier = (statement: SyntaxStatement): boolean =>
  (statement.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/** The module fields used by declaration readers, without exposing bundled TypeScript types. */
export interface ModuleSourceFile extends SyntaxNode, SyntaxSourceFile {
  readonly fileName: string;
  readonly statements: readonly SyntaxStatement[];
  readonly text: string;
}

export const parseModule = (path: string, text: string): ModuleSourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

/** Names one rejected construct for a diagnostic (AB4806). */
export const describeExpression = (node: SyntaxNode): string => {
  const expression = node as ts.Node;
  if (ts.isIdentifier(expression)) {
    return expression.text === 'undefined'
      ? 'the non-JSON value `undefined`'
      : `a reference to the identifier ${JSON.stringify(expression.text)}`;
  }
  if (ts.isCallExpression(expression)) return 'a call expression';
  if (ts.isTemplateExpression(expression)) return 'a template literal with substitutions';
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return 'a function expression';
  if (ts.isSpreadAssignment(expression) || ts.isSpreadElement(expression)) return 'a spread';
  if (ts.isShorthandPropertyAssignment(expression)) return 'a shorthand property reference';
  if (
    ts.isMethodDeclaration(expression) ||
    ts.isGetAccessorDeclaration(expression) ||
    ts.isSetAccessorDeclaration(expression)
  ) {
    return 'a method or accessor';
  }
  if (ts.isComputedPropertyName(expression)) return 'a computed property name';
  if (ts.isOmittedExpression(expression)) return 'an array hole';
  if (expression.kind === ts.SyntaxKind.BigIntLiteral) return 'a bigint literal';
  if (expression.kind === ts.SyntaxKind.RegularExpressionLiteral) return 'a regular expression literal';
  return `a ${ts.SyntaxKind[expression.kind] ?? 'dynamic'} expression`;
};
