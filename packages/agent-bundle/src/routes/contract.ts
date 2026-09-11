import ts from 'typescript-5';

import type { Diagnostic } from '../core/diagnostics.ts';
import { readRouteDefinition, type RouteDefinition } from './definition-syntax.ts';

const modifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((item) => item.kind === kind) ?? false);

/** Declared runtime exports. Linking and execution validate their values. */
export interface RouteModuleExports {
  readonly definition?: RouteDefinition;
  readonly named: ReadonlySet<string>;
  readonly splitExport: boolean;
}

/** Reads declarations only; it never resolves imports or classifies function bodies. */
export const scanRouteModuleExports = (moduleText: string, relativePath: string): RouteModuleExports => {
  const sourceFile = ts.createSourceFile(relativePath, moduleText, ts.ScriptTarget.Latest, true);
  const definition = readRouteDefinition(sourceFile);
  const named = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (modifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) named.add('default');
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || statement.exportClause === undefined) continue;
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) named.add(element.name.text);
        }
      } else {
        named.add(statement.exportClause.name.text);
      }
    } else if (modifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (modifier(statement, ts.SyntaxKind.DefaultKeyword)) named.add('default');
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) named.add(declaration.name.text);
        }
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name !== undefined) {
        named.add(statement.name.text);
      }
    }
  }
  if (definition?.inputSchema !== undefined) named.add('inputSchema');
  if (definition?.resultSchema !== undefined) named.add('resultSchema');
  return Object.freeze({ ...(definition === undefined ? {} : { definition }), named, splitExport: named.has('execute') || named.has('render') });
};

const diagnostic = (
  code: 'AB4810' | 'AB4811' | 'AB4830' | 'AB4840' | 'AB4940',
  message: string,
  sourcePath: string,
  recovery: string,
): Diagnostic => ({ code, message, recovery, severity: 'error', sourcePath });

/** Validates G8's one executable MCP route contract without evaluating the module. */
export const validateRouteModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const exports = scanRouteModuleExports(moduleText, relativePath);
  const { named, splitExport } = exports;
  const hasDefault = exports.named.has('default');
  const missing = ['inputSchema', 'resultSchema'].filter((name) => !named.has(name));
  const diagnostics: Diagnostic[] = [];
  if (missing.length > 0 || !hasDefault) {
    const details = [
      ...(missing.length === 0 ? [] : [`missing named ${missing.join(' and ')}`]),
      ...(hasDefault ? [] : ['missing default export']),
    ];
    diagnostics.push(diagnostic(
      'AB4810',
      `Route module ${relativePath} does not satisfy the public route contract: ${details.join('; ')}.`,
      sourcePath,
      'Export const inputSchema and resultSchema, plus one default Server Component receiving { input, signal }.',
    ));
  }
  if (splitExport) {
    diagnostics.push(diagnostic(
      'AB4811',
      `Route module ${relativePath} exports execute or render; routed modules use one default Server Component instead of an execute/render split.`,
      sourcePath,
      'Move execution into the default component and render Agent.* elements from that component.',
    ));
  }
  return Object.freeze(diagnostics);
};

/** Validates an event route's single component contract without requiring MCP schemas. */
export const validateEventRouteModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const exports = scanRouteModuleExports(moduleText, relativePath);
  const { splitExport } = exports;
  const diagnostics: Diagnostic[] = [];
  if (!exports.named.has('default')) {
    diagnostics.push(diagnostic(
      'AB4810',
      `Event route module ${relativePath} does not satisfy the public route contract: ${'missing default export'}.`,
      sourcePath,
      'Export one default Server Component receiving { canonical, native, signal }.',
    ));
  }
  if (splitExport) {
    diagnostics.push(diagnostic(
      'AB4811',
      `Event route module ${relativePath} exports execute or render; routed modules use one default Server Component instead of an execute/render split.`,
      sourcePath,
      'Move execution into the default component and render Agent.* elements from that component.',
    ));
  }
  return Object.freeze(diagnostics);
};

/**
 * Validates one conventional layout module without evaluating it: the default
 * export must be a function component (sync or async) and the module must
 * not carry the route contract's `inputSchema`/`resultSchema`/`config`
 * exports — a layout wraps routes, it is not one, and a stray schema export
 * usually means a route module was saved under the reserved layout name.
 */
export const validateLayoutModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const exports = scanRouteModuleExports(moduleText, relativePath);
  const { named, splitExport } = exports;
  const routeExports = ['config', 'inputSchema', 'resultSchema'].filter((name) => named.has(name));
  const details = [
    ...(exports.named.has('default') ? [] : ['missing default export']),
    ...(routeExports.length === 0 ? [] : [`exports route-only ${routeExports.join(', ')}`]),
    ...(splitExport ? ['exports execute or render'] : []),
  ];
  if (details.length === 0) return Object.freeze([]);
  return Object.freeze([diagnostic(
    'AB4830',
    `Layout module ${relativePath} does not satisfy the layout contract: ${details.join('; ')}.`,
    sourcePath,
    'Default-export one function component receiving { children, route, signal } that renders Agent.Result around children, and keep route schemas in route modules.',
  )]);
};

/** Validates one context provider's default factory export without evaluating the module. */
export const validateProviderModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const exports = scanRouteModuleExports(moduleText, relativePath);
  if (exports.named.has('default')) return Object.freeze([]);
  return Object.freeze([diagnostic(
    'AB4940',
    `Provider module ${relativePath} does not satisfy the public provider contract: ${'missing default export'}.`,
    sourcePath,
    'Default-export a provider factory receiving { invocation, plugin, signal }.',
  )]);
};
