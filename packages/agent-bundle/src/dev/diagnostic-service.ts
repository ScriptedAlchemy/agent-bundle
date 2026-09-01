import { resolve } from 'node:path';

import { Rslint } from '@rslint/core';

import type { Diagnostic, DiagnosticSeverity } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';


export interface RslintMessage {
  readonly column?: number;
  readonly line?: number;
  readonly message: string;
  readonly ruleId: string | null;
  readonly severity: number;
}

export interface RslintLintResult {
  readonly filePath: string;
  readonly messages: readonly RslintMessage[];
}

export interface RslintEngine {
  close(): Promise<void>;
  lintFiles(paths: readonly string[]): Promise<readonly RslintLintResult[]>;
}

export interface DiagnosticServiceOptions {
  readonly createRslint?: (options: Readonly<{ readonly cwd: string }>) => RslintEngine;
  readonly root: string;
}

export interface DiagnosticReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly paths: readonly string[];
}

const defaultRslint = ({ cwd }: Readonly<{ readonly cwd: string }>): RslintEngine => {
  const engine = new Rslint({ cwd });
  return {
    close: () => engine.close(),
    lintFiles: (paths) => engine.lintFiles([...paths]),
  };
};

const freezeReport = (
  diagnostics: readonly Diagnostic[],
  paths: readonly string[],
): DiagnosticReport => deepFreeze({
  diagnostics: diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
  paths: [...paths],
});

const diagnosticSeverity = (severity: number): DiagnosticSeverity =>
  severity === 2 ? 'error' : 'warning';

const diagnosticCode = (ruleId: string | null): string =>
  ruleId === null ? 'RSLINT' : `RSLINT/${ruleId}`;

const positionSuffix = (message: RslintMessage): string =>
  Number.isInteger(message.line) && Number.isInteger(message.column)
    ? ` (${message.line}:${message.column})`
    : '';

const toDiagnostic = (filePath: string, message: RslintMessage): Diagnostic => ({
  code: diagnosticCode(message.ruleId),
  message: `${message.message}${positionSuffix(message)}`,
  severity: diagnosticSeverity(message.severity),
  sourcePath: filePath,
});

/** Owns one resident Rslint engine for affected-file diagnostics. */
export class DiagnosticService {
  readonly #createRslint: (options: Readonly<{ readonly cwd: string }>) => RslintEngine;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #engine: RslintEngine | undefined;
  readonly #root: string;

  constructor(options: DiagnosticServiceOptions) {
    this.#createRslint = options.createRslint ?? defaultRslint;
    this.#root = resolve(options.root);
  }

  async lint(paths: readonly string[]): Promise<DiagnosticReport> {
    if (this.#closed) {
      throw new Error('DiagnosticService is closed.');
    }

    const affectedPaths = Object.freeze([...new Set(paths.map((path) => resolve(this.#root, path)))]);
    if (affectedPaths.length === 0) {
      return freezeReport([], affectedPaths);
    }

    const engine = this.#engine ??= this.#createRslint({ cwd: this.#root });
    const results = await engine.lintFiles(affectedPaths);
    return freezeReport(
      results.flatMap((result) => result.messages.map((message) => toDiagnostic(result.filePath, message))),
      affectedPaths,
    );
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    try {
      this.#closePromise = Promise.resolve(this.#engine?.close());
    } catch (error) {
      this.#closePromise = Promise.reject(error);
    }
    return this.#closePromise;
  }
}
