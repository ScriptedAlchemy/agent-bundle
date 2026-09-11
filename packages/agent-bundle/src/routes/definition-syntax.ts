import ts from 'typescript-5';

import { unwrapExpression, type SyntaxNode } from './syntax.ts';

const readDefinition = (text: string, path: string) => {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
  for (const statement of source.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    const call = unwrapExpression(statement.expression);
    if (!ts.isCallExpression(call)) continue;
    const parts: string[] = [];
    let callee = call.expression;
    while (ts.isPropertyAccessExpression(callee)) {
      parts.unshift(callee.name.text);
      callee = callee.expression;
    }
    if (!ts.isIdentifier(callee)) continue;
    const helper = helpers.get(callee.text);
    if (helper !== 'defineTool' && helper !== 'events') continue;
    if (helper === 'defineTool' && parts.length !== 0) continue;
    const event = helper === 'events' ? parts.map((part) => part.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)).join('/') : undefined;
    const config = call.arguments[0];
    if (config === undefined || call.arguments.length !== 2) return undefined;
    const object = unwrapExpression(config);
    if (!ts.isObjectLiteralExpression(object)) return undefined;
    return { event, helper, object, source, statement };
  }
  return undefined;
};

const propertyKey = (property: ts.ObjectLiteralElementLike): string | undefined => {
  const name = property.name;
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
};

/** Read the schema in its original module scope, preserving local and imported bindings. */
export const routeDefinitionSchema = (text: string, path: string): SyntaxNode | undefined => {
  const definition = readDefinition(text, path);
  if (definition?.helper !== 'defineTool') return undefined;
  const property = definition.object.properties.find((property) => propertyKey(property) === 'inputSchema');
  if (property === undefined) return undefined;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  return undefined;
};

/** Normalize declarations for static metadata and export checks, never handler behavior. */
export const routeDefinitionSource = (text: string, path: string, onEvent?: (event: string) => void): string => {
  const definition = readDefinition(text, path);
  if (definition === undefined) return text;
  const { event, helper, object, source, statement } = definition;
  if (event !== undefined) onEvent?.(event);
  const metadata: string[] = [];
  const schemas: string[] = [];
  for (const property of object.properties) {
    const key = propertyKey(property);
    if (helper === 'defineTool' && (key === 'inputSchema' || key === 'resultSchema')
      && (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) {
      schemas.push(`export const ${key} = null;`);
    } else metadata.push(property.getText(source));
  }
  return `${text.slice(0, statement.getStart(source))}\nexport const config = {${metadata.join(',')}};\n${schemas.join('\n')}\nexport default async function() {}\n${text.slice(statement.end)}`;
};
