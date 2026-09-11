import { dirname, resolve } from 'node:path';

import ts from 'typescript-5';

import type { CompiledEventPreflight } from './types.ts';
import { routeDefinitionSource } from './definition-syntax.ts';

/** Isolate a gate's declared imports, never the rendered module's initialization. */
export const eventHandlerEntry = (
  text: string,
  relativePath: string,
  sourcePath: string,
): CompiledEventPreflight | undefined => {
  const provenance = { kind: 'conventional' as const, relativePath };
  routeDefinitionSource(text, relativePath, (event) => {
    const expected = relativePath.match(/(?:^|\/)src\/events\/(.+)\.tsx?$/u)?.[1];
    if (expected !== event) throw new TypeError(`Event definition ${event} disagrees with conventional path ${relativePath}.`);
  });
  if (relativePath.endsWith('.ts')) return { mode: 'handler', provenance, source: sourcePath };
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const gate = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'before'
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    && !statement.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  if (gate === undefined) {
    const hasBefore = source.statements.some((statement) =>
      ts.isVariableStatement(statement)
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'before')
      || ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.some((element) => !element.isTypeOnly && element.name.text === 'before'));
    if (hasBefore) throw new TypeError(`Export before() as a function declaration in ${relativePath}.`);
    return undefined;
  }
  if (gate.body === undefined || gate.asteriskToken !== undefined) throw new TypeError(`before() in ${relativePath} must be a non-generator function with a body.`);
  const host: ts.CompilerHost = {
    fileExists: (path) => path === sourcePath,
    getCanonicalFileName: (path) => path,
    getCurrentDirectory: () => dirname(sourcePath),
    getDefaultLibFileName: () => '',
    getNewLine: () => '\n',
    getSourceFile: (path) => path === sourcePath ? source : undefined,
    readFile: (path) => path === sourcePath ? text : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  };
  const checker = ts.createProgram([sourcePath], { noLib: true, noResolve: true }, host).getTypeChecker();
  const imports = new Set<ts.ImportDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      for (const declaration of symbol?.declarations ?? []) {
        if (declaration.getSourceFile() !== source || (declaration.pos >= gate.pos && declaration.end <= gate.end)) continue;
        let owner: ts.Node = declaration;
        while (owner.parent !== source && owner.parent !== undefined) owner = owner.parent;
        if (ts.isImportDeclaration(owner)) imports.add(owner);
        else if (!ts.isTypeAliasDeclaration(owner) && !ts.isInterfaceDeclaration(owner)) {
          throw new TypeError(`before() in ${relativePath} captures ${node.text}. Move gate-local values into before(), or import its dependency from a separate module.`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(gate);
  const importText = [...imports].map((statement) => {
    const specifier = statement.moduleSpecifier;
    const original = statement.getText(source);
    if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) return original;
    return original.replace(specifier.getText(source), JSON.stringify(resolve(dirname(sourcePath), specifier.text)));
  });
  return {
    mode: 'gate',
    provenance,
    source: sourcePath,
    virtualSource: [...importText, gate.getText(source), 'export default before;'].join('\n'),
  };
};
