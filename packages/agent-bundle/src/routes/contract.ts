import ts from 'typescript-5';

import type { Diagnostic } from '../core/diagnostics.ts';

const modifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((item) => item.kind === kind) ?? false);

const exported = (node: ts.Node): boolean => modifier(node, ts.SyntaxKind.ExportKeyword);
const asynchronous = (node: ts.Node): boolean => modifier(node, ts.SyntaxKind.AsyncKeyword);

const unwrappedExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const diagnostic = (
  code: 'AB4810' | 'AB4811',
  message: string,
  sourcePath: string,
  recovery: string,
): Diagnostic => ({ code, message, recovery, severity: 'error', sourcePath });

/** Validates G8's one executable route contract without evaluating the module. */
export const validateRouteModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const sourceFile = ts.createSourceFile(relativePath, moduleText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const named = new Set<string>();
  let asyncDefault = false;
  let splitExport = false;

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        named.add(declaration.name.text);
        if (declaration.name.text === 'execute' || declaration.name.text === 'render') splitExport = true;
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && exported(statement)) {
      if (modifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        asyncDefault = asynchronous(statement);
      } else if (statement.name !== undefined) {
        named.add(statement.name.text);
        if (statement.name.text === 'execute' || statement.name.text === 'render') splitExport = true;
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unwrappedExpression(statement.expression);
      asyncDefault = (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) && asynchronous(expression);
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const name = element.name.text;
        named.add(name);
        if (name === 'execute' || name === 'render') splitExport = true;
      }
    }
  }

  const missing = ['inputSchema', 'resultSchema'].filter((name) => !named.has(name));
  const diagnostics: Diagnostic[] = [];
  if (missing.length > 0 || !asyncDefault) {
    const details = [
      ...(missing.length === 0 ? [] : [`missing named ${missing.join(' and ')}`]),
      ...(asyncDefault ? [] : ['default export is not an async function component']),
    ];
    diagnostics.push(diagnostic(
      'AB4810',
      `Route module ${relativePath} does not satisfy the public route contract: ${details.join('; ')}.`,
      sourcePath,
      'Export const inputSchema and resultSchema, plus one async default Server Component receiving { input, signal }.',
    ));
  }
  if (splitExport) {
    diagnostics.push(diagnostic(
      'AB4811',
      `Route module ${relativePath} exports execute or render; routed modules use one async default Server Component instead of an execute/render split.`,
      sourcePath,
      'Move execution into the async default component and render Agent.* elements from that component.',
    ));
  }
  return Object.freeze(diagnostics);
};
