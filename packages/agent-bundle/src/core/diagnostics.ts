export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  sourcePath?: string;
  generatedPath?: string;
  target?: string;
  recovery?: string;
}

const diagnosticOptionalKeys = ['generatedPath', 'recovery', 'sourcePath', 'target'] as const;

const isSeverity = (value: unknown): value is DiagnosticSeverity =>
  value === 'error' || value === 'info' || value === 'warning';

/** Structural guard for wire values claiming to be diagnostics; extra keys are tolerated. */
export const isDiagnostic = (value: unknown): value is Diagnostic =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  typeof (value as Diagnostic).code === 'string' &&
  typeof (value as Diagnostic).message === 'string' &&
  isSeverity((value as Diagnostic).severity) &&
  diagnosticOptionalKeys.every((key) => {
    const optional = (value as Readonly<Record<string, unknown>>)[key];
    return optional === undefined || typeof optional === 'string';
  });

const diagnosticIdentity = (diagnostic: Diagnostic): string => JSON.stringify([
  diagnostic.code,
  diagnostic.message,
  diagnostic.severity,
  diagnostic.sourcePath,
  diagnostic.generatedPath,
  diagnostic.target,
  diagnostic.recovery,
]);

/** Keeps the first occurrence of each user-visible diagnostic identity. */
export const deduplicateDiagnostics = (diagnostics: Iterable<Diagnostic>): Diagnostic[] => {
  const identities = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const identity = diagnosticIdentity(diagnostic);
    if (identities.has(identity)) continue;
    identities.add(identity);
    unique.push(diagnostic);
  }
  return unique;
};

const sourceRecovery = (code: string): string => {
  if (code.startsWith('AB30')) {
    return 'Restore valid Skill Markdown frontmatter and referenced resources, then inspect again.';
  }
  if (code.startsWith('AB42')) {
    return 'Correct the hook configuration named by this diagnostic, then inspect again.';
  }
  if (code.startsWith('AB43')) {
    return 'Correct the MCP server configuration and referenced source files, then inspect again.';
  }
  if (code.startsWith('AB44')) {
    return 'Correct the script configuration and its entry path, then inspect again.';
  }
  if (code.startsWith('AB4')) {
    return 'Correct the project configuration field named by this diagnostic, then inspect again.';
  }
  if (code.includes('.native-hooks.')) {
    return 'Repair the native hook source and target configuration, then inspect again.';
  }
  if (code.includes('.mcp.')) {
    return 'Correct the target MCP configuration named by this diagnostic, then inspect again.';
  }
  if (code.includes('.schema.')) {
    return 'Correct the target configuration so its generated document satisfies the target schema, then inspect again.';
  }
  return 'Correct the reported project source configuration, then inspect again.';
};

export const withDiagnosticRecovery = (diagnostic: Diagnostic): Diagnostic =>
  diagnostic.recovery === undefined || diagnostic.recovery.trim().length === 0
    ? { ...diagnostic, recovery: sourceRecovery(diagnostic.code) }
    : diagnostic;

const formatSummary = (diagnostics: readonly Diagnostic[]): string => {
  const count = diagnostics.length;
  const noun = count === 1 ? 'error' : 'errors';
  const details = diagnostics
    .map((diagnostic) => `[${diagnostic.code}] ${diagnostic.message}`)
    .join('\n');

  return `Agent Bundle compilation failed with ${count} ${noun}:\n${details}`;
};

export class DiagnosticError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(formatSummary(diagnostics));
    this.name = 'DiagnosticError';
    this.diagnostics = diagnostics;
  }
}

export class DiagnosticBag {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Iterable<Diagnostic> = []) {
    this.diagnostics = [...diagnostics];
  }

  add(diagnostic: Diagnostic): this {
    this.diagnostics.push(diagnostic);
    return this;
  }

  get hasErrors(): boolean {
    return this.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  }

  throwIfErrors(): void {
    const errors = this.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error',
    );

    if (errors.length > 0) {
      throw new DiagnosticError(errors);
    }
  }
}

export const freezeDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));

export const hasErrors = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'error');
