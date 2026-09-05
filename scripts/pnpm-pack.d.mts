export interface PnpmPackOutputFile {
  readonly path: string;
}

/** One `pnpm pack --json` entry, its `filename` reduced to the bare tarball name. */
export interface PnpmPackOutput {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly files: readonly PnpmPackOutputFile[];
}

export interface PnpmPackOptions {
  /** The package directory to pack. */
  readonly cwd: string;
  /** Absolute directory the tarball is written to (`--pack-destination`). */
  readonly destination: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PnpmPackResult {
  readonly packOutput: PnpmPackOutput;
  /** Absolute path of the tarball inside `destination`. */
  readonly tarball: string;
}

export declare const pnpmPackOutputFromJson: (stdout: string) => PnpmPackOutput;

export declare const pnpmPack: (options: PnpmPackOptions) => Promise<PnpmPackResult>;
