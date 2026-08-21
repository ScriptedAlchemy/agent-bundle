import type { ErrorObject } from 'ajv/dist/2020.js';

import type { Diagnostic } from '../core/diagnostics.ts';

export interface TargetDiagnosticHelpers {
  errorDiagnostic(code: string, message: string): Diagnostic;
  schemaDiagnostics(document: string, valid: boolean, errors: readonly ErrorObject[] | null | undefined): Diagnostic[];
}

/** Host adapters share one diagnostic shape, differing only in target slug and display label. */
export const createTargetDiagnostics = (target: string, label: string): TargetDiagnosticHelpers => {
  const errorDiagnostic = (code: string, message: string): Diagnostic => ({
    code,
    message,
    severity: 'error',
    target,
  });
  return {
    errorDiagnostic,
    schemaDiagnostics: (document, valid, errors) => valid
      ? []
      : [errorDiagnostic(
          `${target}.schema.${document}`,
          `${label} ${document}.json is invalid: ${(errors ?? [])
            .map((error) => `${error.instancePath || '/'}: ${error.message ?? 'schema validation failed'}`)
            .join('; ') || 'schema validation failed'}.`,
        )],
  };
};
