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
