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
