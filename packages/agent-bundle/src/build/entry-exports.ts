import { readFile } from 'node:fs/promises';

import ts from 'typescript-5';

/**
 * Static entry-export detection for TypeScript/JavaScript entry modules. The
 * generated entry conventions only need two facts — "does this module export
 * `main`" and "does this module have a default export" — read from the
 * top-level statements of a TypeScript parse at build time; the generated
 * wrappers re-verify the export shape at runtime with a clear error.
 */
export interface EntryExportScan {
  readonly hasDefaultExport: boolean;
  readonly hasMainExport: boolean;
}

const hasModifier = (statement: ts.Statement, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === kind);

/**
 * A CommonJS entry's `module.exports = <expr>` is a default export: the
 * bundler exposes the assigned value as the namespace's `default`, which is
 * what the generated shells read. Only the top-level whole-object assignment
 * qualifies; `exports.foo = …` and `module.exports.foo = …` are named.
 */
const assignsModuleExports = (statement: ts.Statement): boolean => {
  if (!ts.isExpressionStatement(statement)) return false;
  const assignment = statement.expression;
  return ts.isBinaryExpression(assignment)
    && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(assignment.left)
    && ts.isIdentifier(assignment.left.expression)
    && assignment.left.expression.text === 'module'
    && assignment.left.name.text === 'exports';
};

const declaresMain = (statement: ts.Statement): boolean => {
  if (ts.isFunctionDeclaration(statement)) return statement.name?.text === 'main';
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === 'main');
  }
  return false;
};

/** `fileName` selects the grammar (`.tsx`/`.jsx` parse JSX; `.ts` keeps angle-bracket assertions). */
export const scanEntryExportsSource = (source: string, fileName = 'entry.ts'): EntryExportScan => {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  let hasDefaultExport = false;
  let hasMainExport = false;
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement)) {
      hasDefaultExport ||= !statement.isExportEquals;
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      // Type-only clauses (`export type { … }`) never produce runtime exports.
      if (statement.isTypeOnly || statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        hasDefaultExport ||= element.name.text === 'default';
        hasMainExport ||= element.name.text === 'main';
      }
      continue;
    }
    if (assignsModuleExports(statement)) {
      hasDefaultExport = true;
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword) || hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) hasDefaultExport = true;
    else if (declaresMain(statement)) hasMainExport = true;
  }
  return Object.freeze({ hasDefaultExport, hasMainExport });
};

export const scanEntryExports = async (source: string): Promise<EntryExportScan> =>
  scanEntryExportsSource(await readFile(source, 'utf8'), source);
