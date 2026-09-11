import ts from 'typescript-5';

import { unwrapExpression, type SyntaxNode } from './syntax.ts';
import type { ModuleSourceFile } from './syntax.ts';

export interface RouteDefinition {
  readonly kind: 'defineTool' | 'events';
  readonly event?: string;
  readonly metadata: readonly SyntaxNode[];
  readonly inputSchema?: SyntaxNode;
  readonly resultSchema?: SyntaxNode;
}

/** Recognize a direct declaration; expressions remain nodes in their original source. */
export const readRouteDefinition = (module: ModuleSourceFile): RouteDefinition | undefined => {
  const source = module as ts.SourceFile;
  const path = source.fileName;
  const helpers = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== 'agent-bundle/routes' || statement.importClause?.isTypeOnly) continue;
    const names = statement.importClause?.namedBindings;
    if (names !== undefined && ts.isNamedImports(names)) {
      for (const name of names.elements) {
        if (!name.isTypeOnly) helpers.set(name.name.text, (name.propertyName ?? name.name).text);
      }
    }
  }
  const invalid = (): never => {
    throw new TypeError(`Unsupported route definition in ${path}. Use export default defineTool({ ... }, handler) or export default events.family.event({ ... }, handler), with an inline object literal and no wrappers or aliases.`);
  };
  for (const statement of source.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    const call = unwrapExpression(statement.expression);
    if (!ts.isCallExpression(call)) {
      if (ts.isIdentifier(call) && [...helpers.values()].some((name) => name === 'defineTool' || name === 'events')) invalid();
      continue;
    }
    const parts: string[] = [];
    let callee = call.expression;
    while (ts.isPropertyAccessExpression(callee)) {
      parts.unshift(callee.name.text);
      callee = callee.expression;
    }
    if (!ts.isIdentifier(callee)) return invalid();
    const helper = helpers.get(callee.text);
    if (helper !== 'defineTool' && helper !== 'events') return invalid();
    if (helper === 'defineTool' && parts.length !== 0) return invalid();
    const event = helper === 'events' ? parts.map((part) => part.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)).join('/') : undefined;
    const config = call.arguments[0];
    if (config === undefined || call.arguments.length !== 2) return invalid();
    const object = unwrapExpression(config);
    if (!ts.isObjectLiteralExpression(object)) return invalid();
    const metadata: SyntaxNode[] = [];
    const schemas: { inputSchema?: SyntaxNode; resultSchema?: SyntaxNode } = {};
    for (const property of object.properties) {
      const key = propertyKey(property);
      if (helper === 'defineTool' && (key === 'inputSchema' || key === 'resultSchema')
        && (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) {
        schemas[key] = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      } else metadata.push(property);
    }
    return { kind: helper, ...(event === undefined ? {} : { event }), metadata, ...schemas };
  }
  return undefined;
};

const propertyKey = (property: ts.ObjectLiteralElementLike): string | undefined => {
  const name = property.name;
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
};
