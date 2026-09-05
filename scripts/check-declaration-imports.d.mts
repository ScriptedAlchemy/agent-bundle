export type DeclarationSpecifierKind = 'import' | 'path-reference' | 'types-reference';

export interface DeclarationSpecifier {
  readonly kind: DeclarationSpecifierKind;
  readonly line: number;
  readonly specifier: string;
}

export type DeclarationViolationReason =
  | 'dev-dependency'
  | 'export-target-missing'
  | 'missing-target'
  | 'subpath-import'
  | 'undeclared'
  | 'unexported'
  | 'unresolvable';

export interface DeclarationViolation {
  readonly line?: number;
  readonly message: string;
  readonly path: string;
  /** The `exports` entry (or `types`/`typings`) a consumer reaches the declaration through; absent for internal declarations. */
  readonly reachableFrom?: string;
  readonly reason: DeclarationViolationReason;
  readonly specifier: string;
}

export interface DeclarationManifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly exports?: unknown;
  readonly imports?: unknown;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly types?: string;
  readonly typings?: string;
}

export interface PackedDeclaration {
  readonly path: string;
  readonly text: string;
}

export interface DeclarationRoot {
  readonly entry: string;
  readonly path: string;
}

export interface DeclarationImportReport {
  readonly declarationCount: number;
  readonly errors: readonly DeclarationViolation[];
  readonly reachable: ReadonlySet<string>;
  readonly roots: readonly DeclarationRoot[];
  readonly warnings: readonly DeclarationViolation[];
}

export interface DeclarationImportInput {
  readonly declarations: readonly PackedDeclaration[];
  readonly manifest: DeclarationManifest;
  readonly packedPaths: readonly string[];
}

export interface CheckPackedDeclarationsInput {
  readonly manifest: DeclarationManifest;
  readonly packageDirectory: string;
  readonly packedPaths: readonly string[];
  readonly readFile?: (path: string, encoding: 'utf8') => Promise<string>;
}

export interface RunCheckDeclarationImportsOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly inventory?: (packageDirectory: string, manifest: DeclarationManifest) => Promise<readonly string[]>;
  readonly log?: (line: string) => void;
}

export declare const isDeclarationPath: (path: string) => boolean;

export declare const packageNameOf: (specifier: string) => string;

export declare const declarationSpecifiers: (text: string) => readonly DeclarationSpecifier[];

export declare const declarationImportViolations: (input: DeclarationImportInput) => DeclarationImportReport;

export declare const checkPackedDeclarations: (input: CheckPackedDeclarationsInput) => Promise<DeclarationImportReport>;

export declare const packedPaths: (packageDirectory: string, manifest: DeclarationManifest) => Promise<readonly string[]>;

export declare const formatDeclarationImportReport: (
  name: string,
  report: DeclarationImportReport,
  options?: { readonly strict?: boolean },
) => readonly string[];

export declare const runCheckDeclarationImports: (options?: RunCheckDeclarationImportsOptions) => Promise<number>;
