import { execFile as executeFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Diagnostic } from '../core/diagnostics.ts';

const execFile = promisify(executeFile);

/**
 * Declaration generation rides rsbuild-plugin-dts, which aborts a failed pass
 * with one prose line naming only the Rslib environment — the TypeScript
 * diagnostics that actually failed the emit stay inside the forked worker.
 * This module recovers them by replaying declaration emit over the very
 * tsconfig the failed build used, so the CLI reports the file, line, and TS
 * code instead of a catch-all.
 *
 * `AB4716` joins the `AB471x` package-build `lib` family (see
 * `docs/diagnostics.md`); it is never `AB5000`, whose dev-lock meaning
 * misdirected triage of exactly this failure.
 */
export const declarationBuildCode = 'AB4716';

const emitOnlyRecovery = 'Fix the reported TypeScript declaration errors and rebuild. '
  + 'Declaration-emit errors such as TS4023 (an exported value naming a type its module does not export) '
  + 'never appear under `tsc --noEmit`; replay them with `tsc --declaration --emitDeclarationOnly` '
  + 'over the lib entry source directory.';

export interface TypeScriptEmitLocation {
  readonly column: number;
  /** As printed by `tsc`: relative to the project root, or absolute. */
  readonly file: string;
  readonly line: number;
}

export interface TypeScriptEmitDiagnostic {
  /** Absent for whole-program diagnostics such as option errors. */
  readonly location?: TypeScriptEmitLocation;
  readonly message: string;
  /** The TypeScript diagnostic code, e.g. `TS4023`. */
  readonly tsCode: string;
}

const locatedDiagnostic =
  /^(?<file>[^(]+)\((?<line>\d+),(?<column>\d+)\): (?:error|warning) (?<tsCode>TS\d+): (?<message>.+)$/u;
const programWideDiagnostic = /^(?:error|warning) (?<tsCode>TS\d+): (?<message>.+)$/u;

/**
 * Parses the `--pretty false` diagnostic format, which is stable across
 * TypeScript 5 and the TypeScript 7 native compiler. Continuation and
 * related-information lines are indented and carry no code, so they are
 * skipped rather than misparsed.
 */
export const parseTypeScriptDiagnostics = (output: string): readonly TypeScriptEmitDiagnostic[] => {
  const diagnostics: TypeScriptEmitDiagnostic[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const located = locatedDiagnostic.exec(line)?.groups;
    if (located !== undefined) {
      diagnostics.push({
        location: {
          column: Number(located.column),
          file: located.file!,
          line: Number(located.line),
        },
        message: located.message!.trim(),
        tsCode: located.tsCode!,
      });
      continue;
    }
    const programWide = programWideDiagnostic.exec(line)?.groups;
    if (programWide !== undefined) {
      diagnostics.push({ message: programWide.message!.trim(), tsCode: programWide.tsCode! });
    }
  }
  return Object.freeze(diagnostics);
};

/**
 * The consumer project's own compiler, resolved exactly like the dts build
 * resolves it: a project pinning TypeScript 5 must never be replayed through
 * a different copy hoisted somewhere above it.
 */
const typeScriptCli = (projectRoot: string): string | undefined => {
  let manifest: string;
  try {
    manifest = createRequire(join(projectRoot, 'package.json')).resolve('typescript/package.json');
  } catch {
    return undefined;
  }
  const cli = join(dirname(manifest), 'lib', 'tsc.js');
  return existsSync(cli) ? cli : undefined;
};

const processOutput = (error: unknown): string => {
  const streams = error as { readonly stderr?: unknown; readonly stdout?: unknown };
  return [streams.stdout, streams.stderr]
    .filter((stream): stream is string => typeof stream === 'string')
    .join('\n');
};

/**
 * Replays `tsc --declaration --emitDeclarationOnly` over the synthesized dts
 * project. The overrides pin emit on regardless of what the consumer
 * tsconfig this project extends declares (`noEmit`, `declarationDir`, and
 * incremental build info all belong to the consumer's own type check), and
 * the declarations land in a throwaway sibling of the synthesized project so
 * the replay never touches the package output or the project tree.
 *
 * A replay that cannot run (no resolvable compiler) or that passes returns no
 * diagnostics; the caller still reports the failure, just without detail.
 */
export const replayDeclarationEmit = async (options: {
  readonly projectRoot: string;
  readonly tsconfigPath: string;
}): Promise<readonly TypeScriptEmitDiagnostic[]> => {
  const cli = typeScriptCli(options.projectRoot);
  if (cli === undefined) return Object.freeze([]);
  const outDir = join(dirname(options.tsconfigPath), 'declaration-replay');
  try {
    await execFile(process.execPath, [
      cli,
      '--project', options.tsconfigPath,
      '--declaration',
      '--declarationDir', outDir,
      '--emitDeclarationOnly',
      '--incremental', 'false',
      '--noEmit', 'false',
      '--outDir', outDir,
      '--pretty', 'false',
    ], { cwd: options.projectRoot, maxBuffer: 32 * 1024 * 1024 });
    return Object.freeze([]);
  } catch (error) {
    return parseTypeScriptDiagnostics(processOutput(error));
  }
};

/** Project-relative when the file lives inside the project, absolute otherwise. */
const formatLocation = (projectRoot: string, location: TypeScriptEmitLocation): {
  readonly display: string;
  readonly sourcePath: string;
} => {
  const sourcePath = isAbsolute(location.file) ? location.file : resolve(projectRoot, location.file);
  const relativePath = relative(projectRoot, sourcePath).replaceAll('\\', '/');
  const shown = relativePath.length === 0 || relativePath.startsWith('..') ? sourcePath : relativePath;
  return { display: `${shown}(${location.line},${location.column}): `, sourcePath };
};

/**
 * One `AB4716` error per recovered TypeScript diagnostic, each carrying the
 * file, position, and TS code so `--json` consumers and the terminal see the
 * same detail the manual `tsc --emitDeclarationOnly` replay produced. When
 * nothing could be recovered the failure still reports under `AB4716` with
 * the bundler's own message, never the `AB5000` catch-all.
 */
export const declarationBuildDiagnostics = (options: {
  readonly entryName: string;
  readonly failure: string;
  readonly projectRoot: string;
  readonly typeScriptDiagnostics: readonly TypeScriptEmitDiagnostic[];
}): readonly Diagnostic[] => {
  const prefix = `Declaration generation for lib entry ${JSON.stringify(options.entryName)} failed`;
  if (options.typeScriptDiagnostics.length === 0) {
    return Object.freeze([{
      code: declarationBuildCode,
      message: `${prefix}: ${options.failure}`,
      recovery: emitOnlyRecovery,
      severity: 'error' as const,
    }]);
  }
  return Object.freeze(options.typeScriptDiagnostics.map((diagnostic): Diagnostic => {
    const location = diagnostic.location === undefined
      ? undefined
      : formatLocation(options.projectRoot, diagnostic.location);
    return {
      code: declarationBuildCode,
      message: `${prefix}: ${location?.display ?? ''}${diagnostic.tsCode}: ${diagnostic.message}`,
      recovery: emitOnlyRecovery,
      severity: 'error' as const,
      ...(location === undefined ? {} : { sourcePath: location.sourcePath }),
    };
  }));
};
