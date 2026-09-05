import type { Diagnostic } from '../core/diagnostics.ts';

/**
 * What one Rspack compilation reported about itself, recorded by the
 * framework's dependency audit plugin (`dependency-audit-plugin.ts`) before
 * any asset is emitted. Keyed by the compiler name, which Rslib sets to the
 * lib id (`entryLibId`), so the compiler service can hand each record back
 * to the entry that produced it.
 */
export interface CompilationEvidence {
  readonly compiler: string;
  readonly externals: readonly CompilationExternal[];
  readonly modules: readonly CompilationModule[];
}

/** One `ExternalModule` of a compilation: a request the bundle loads at run time instead of inlining. */
export interface CompilationExternal {
  /** The external type Rspack spelled into the module identifier: `module`, `node-commonjs`, `import`, … */
  readonly externalType: string;
  /** Absolute resource paths of the modules whose imports reach the request; sorted, unique. */
  readonly issuers: readonly string[];
  readonly request: string;
}

export interface CompilationModule {
  readonly identifier: string;
  /** The resolved on-disk (or virtual) path, when the module has one. */
  readonly resource?: string;
}

/**
 * How a kept-external request stands against the artifact contract. An
 * expression request (`import(expr)`, `require(expr)`) never appears here:
 * Rslib's profile leaves it verbatim in the bundle without parsing it, so it
 * is neither a module nor an external — the compiler has no view of it.
 */
export type ExternalKind = 'artifact-relative' | 'builtin' | 'package';

/** One run-time dependency of an emitted asset, classified against the artifact contract. */
export interface ExternalIR {
  /** The emitted asset, relative to the output root (POSIX). */
  readonly asset: string;
  readonly externalType: string;
  /** Issuer modules relative to the project root (POSIX); a generated module keeps its reserved path. */
  readonly issuers: readonly string[];
  readonly kind: ExternalKind;
  readonly request: string;
}

export type ModuleKind = 'authored' | 'dependency' | 'generated';

export interface ModuleIR {
  readonly asset: string;
  readonly identifier: string;
  readonly kind: ModuleKind;
  /** The package a dependency module belongs to (`name` or `@scope/name`), when it resolved under `node_modules`. */
  readonly package?: string;
  readonly resource?: string;
}

export interface AssetIR {
  readonly path: string;
  /** Absolute authored inputs. Build-boundary canonicalization happens separately. */
  readonly sourceInputs: readonly string[];
}

/**
 * The compiler service's account of one compiled surface: what it emitted,
 * what it inlined, what it left for run time, and what it found wrong.
 * Self-containment is judged on `externals` — a request the compiler kept
 * external is either a Node built-in, an emitted sibling of the same
 * artifact, or a violation — never on the emitted bytes.
 */
export interface CompileResult {
  readonly assets: readonly AssetIR[];
  readonly diagnostics: readonly Diagnostic[];
  readonly externals: readonly ExternalIR[];
  readonly modules: readonly ModuleIR[];
}
