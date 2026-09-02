// The workspace compiler is TypeScript 7, while this parse-only alias keeps
// the stable single-file compiler API used by the other static extractors.
import ts from 'typescript-5';

import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import type { NormalizedStateDefinition } from '../core/types.ts';

/** Reserved by the generated runtime for the internal notice ledger store. */
const AGENT_NOTICE_LEDGER_STATE_ID = '@agent-bundle/runtime/agent-notice-ledger/v1';

export interface ExtractedStateDefinition {
  readonly definition?: Pick<NormalizedStateDefinition, 'id' | 'lifetime'>;
  readonly diagnostics: readonly Diagnostic[];
}

const diagnostic = (
  code: 'AB4818' | 'AB4819' | 'AB4820' | 'AB4821',
  message: string,
  recovery: string,
  sourcePath: string,
): Diagnostic => ({ code, message, recovery, severity: 'error', sourcePath });

const unwrap = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const property = (
  object: ts.ObjectLiteralExpression,
  name: 'id' | 'lifetime',
): ts.Expression | undefined => {
  const matches = object.properties.filter((candidate): candidate is ts.PropertyAssignment =>
    ts.isPropertyAssignment(candidate)
    && ((ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) && candidate.name.text === name));
  return matches.length === 1 ? unwrap(matches[0]!.initializer) : undefined;
};

/**
 * Extracts the storage identity and lifetime from the conventional
 * `export default defineState({ ... })` declaration without evaluating it.
 */
export const extractStateDefinition = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): ExtractedStateDefinition => {
  const sourceFile = ts.createSourceFile(
    relativePath,
    moduleText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const defaults = sourceFile.statements.filter((statement): statement is ts.ExportAssignment =>
    ts.isExportAssignment(statement) && !statement.isExportEquals);
  const expression = defaults.length === 1 ? unwrap(defaults[0]!.expression) : undefined;
  if (
    expression === undefined
    || !ts.isCallExpression(expression)
    || !ts.isIdentifier(expression.expression)
    || expression.expression.text !== 'defineState'
    || expression.arguments.length !== 1
    || !ts.isObjectLiteralExpression(unwrap(expression.arguments[0]!))
  ) {
    return deepFreeze({
      diagnostics: [diagnostic(
        'AB4818',
        `State module ${relativePath} must default-export one direct \`defineState({ ... })\` call.`,
        'Export default defineState({ id, lifetime, ... }) from the state module.',
        sourcePath,
      )],
    });
  }

  const input = unwrap(expression.arguments[0]!) as ts.ObjectLiteralExpression;
  const idNode = property(input, 'id');
  const lifetimeNode = property(input, 'lifetime');
  const id = idNode !== undefined && ts.isStringLiteral(idNode) ? idNode.text : undefined;
  const lifetime = lifetimeNode !== undefined && ts.isStringLiteral(lifetimeNode) ? lifetimeNode.text : undefined;
  const accepted = lifetime === 'request'
    || lifetime === 'process'
    || lifetime === 'workspace-durable'
    || lifetime === 'external';
  if (id === undefined || id.trim() === '' || !accepted) {
    return deepFreeze({
      diagnostics: [diagnostic(
        'AB4819',
        `State module ${relativePath} requires non-empty string-literal id and lifetime properties; lifetime must be request, process, workspace-durable, or external.`,
        'Replace computed or referenced id/lifetime values with string literals in defineState({ ... }).',
        sourcePath,
      )],
    });
  }
  if (lifetime === 'external') {
    return deepFreeze({
      diagnostics: [diagnostic(
        'AB4820',
        `State module ${relativePath} selects external lifetime, but generated mounting v1 supports request, process, and workspace-durable lifetimes only.`,
        'Use a supported generated lifetime, or wire the external driver from an embedder.',
        sourcePath,
      )],
    });
  }
  if (id === AGENT_NOTICE_LEDGER_STATE_ID) {
    return deepFreeze({
      diagnostics: [diagnostic(
        'AB4821',
        `State module ${relativePath} uses the reserved notice-ledger id ${AGENT_NOTICE_LEDGER_STATE_ID}.`,
        'Choose a project-scoped state id; the generated runtime owns the notice ledger store under that id.',
        sourcePath,
      )],
    });
  }
  return deepFreeze({
    definition: { id, lifetime },
    diagnostics: [],
  });
};
