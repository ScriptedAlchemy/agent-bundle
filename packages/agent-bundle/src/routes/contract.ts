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
  code: 'AB4810' | 'AB4811' | 'AB4940',
  message: string,
  sourcePath: string,
  recovery: string,
): Diagnostic => ({ code, message, recovery, severity: 'error', sourcePath });

/** The statically scanned export surface of one route module. */
export interface RouteModuleExports {
  /** True when the default export is an async function or arrow function. */
  readonly asyncDefault: boolean;
  /** True when the default export is a function or arrow function. */
  readonly defaultFunction: boolean;
  readonly named: ReadonlySet<string>;
  /** True when the module exports `execute` or `render` (the retired split contract). */
  readonly splitExport: boolean;
}

/** Scans one route module's top-level export surface without evaluating it. */
export const scanRouteModuleExports = (
  moduleText: string,
  relativePath: string,
): RouteModuleExports => {
  const sourceFile = ts.createSourceFile(relativePath, moduleText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const asyncFunctionBindings = new Set<string>();
  const functionBindings = new Set<string>();
  const named = new Set<string>();
  let asyncDefault = false;
  let defaultFunction = false;
  let defaultIdentifier: string | undefined;
  let splitExport = false;

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const initializer = declaration.initializer === undefined ? undefined : unwrappedExpression(declaration.initializer);
        if (initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          functionBindings.add(declaration.name.text);
          if (asynchronous(initializer)) asyncFunctionBindings.add(declaration.name.text);
        }
        if (exported(statement)) {
          named.add(declaration.name.text);
          if (declaration.name.text === 'execute' || declaration.name.text === 'render') splitExport = true;
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name !== undefined) {
        functionBindings.add(statement.name.text);
        if (asynchronous(statement)) asyncFunctionBindings.add(statement.name.text);
      }
      if (exported(statement) && modifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        defaultFunction = true;
        asyncDefault = asynchronous(statement);
      } else if (exported(statement) && statement.name !== undefined) {
        named.add(statement.name.text);
        if (statement.name.text === 'execute' || statement.name.text === 'render') splitExport = true;
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unwrappedExpression(statement.expression);
      defaultFunction = ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
      asyncDefault = defaultFunction && asynchronous(expression);
      if (ts.isIdentifier(expression)) defaultIdentifier = expression.text;
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const name = element.name.text;
        if (name === 'default' && statement.moduleSpecifier === undefined) {
          defaultIdentifier = element.propertyName?.text ?? name;
          continue;
        }
        named.add(name);
        if (name === 'execute' || name === 'render') splitExport = true;
      }
    }
  }

  if (defaultIdentifier !== undefined) {
    defaultFunction = functionBindings.has(defaultIdentifier);
    asyncDefault = asyncFunctionBindings.has(defaultIdentifier);
  }

  return Object.freeze({ asyncDefault, defaultFunction, named, splitExport });
};

/** Validates G8's one executable MCP route contract without evaluating the module. */
export const validateRouteModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const { asyncDefault, named, splitExport } = scanRouteModuleExports(moduleText, relativePath);
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

/** Validates an event route's single async component contract without requiring MCP schemas. */
export const validateEventRouteModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const { asyncDefault, splitExport } = scanRouteModuleExports(moduleText, relativePath);
  const diagnostics: Diagnostic[] = [];
  if (!asyncDefault) {
    diagnostics.push(diagnostic(
      'AB4810',
      `Event route module ${relativePath} does not satisfy the public route contract: default export is not an async function component.`,
      sourcePath,
      'Export one async default Server Component receiving { canonical, native, signal }.',
    ));
  }
  if (splitExport) {
    diagnostics.push(diagnostic(
      'AB4811',
      `Event route module ${relativePath} exports execute or render; routed modules use one async default Server Component instead of an execute/render split.`,
      sourcePath,
      'Move execution into the async default component and render Agent.* elements from that component.',
    ));
  }
  return Object.freeze(diagnostics);
};

/** Validates one context provider's default factory export without evaluating the module. */
export const validateProviderModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const { defaultFunction } = scanRouteModuleExports(moduleText, relativePath);
  if (defaultFunction) return Object.freeze([]);
  return Object.freeze([diagnostic(
    'AB4940',
    `Provider module ${relativePath} does not satisfy the public provider contract: default export is not a function.`,
    sourcePath,
    'Default-export a provider factory receiving { invocation, signal }.',
  )]);
};
