export type DistFreshnessStatus = 'fresh' | 'stale' | 'missing';

export interface DistDescriptor {
  /** Package name, as printed in the failure message. */
  readonly name: string;
  /** Absolute package root; `inputs` and `output` resolve against it. */
  readonly root: string;
  /** Files and directories the build reads, relative to `root` (`..` segments allowed). */
  readonly inputs: readonly string[];
  /** The directory the build writes, relative to `root`. */
  readonly output: string;
}

export interface NewestEntry {
  /** Absolute path of the newest file or directory. */
  readonly path: string;
  /** Its modification time, in milliseconds since the epoch. */
  readonly mtimeMs: number;
}

export interface DistFreshness {
  readonly name: string;
  /** Absolute path of the output directory. */
  readonly output: string;
  readonly status: DistFreshnessStatus;
  readonly newestInput: NewestEntry;
  /** Undefined when `status` is `missing`. */
  readonly newestOutput: NewestEntry | undefined;
}

export interface NewestEntryOptions {
  /** Count directory mtimes as well as file mtimes; defaults to false. */
  readonly countDirectories?: boolean;
  /** Directory names not to enter; the walk root is always entered. */
  readonly skip?: (name: string) => boolean;
}

export interface FormatDistFreshnessOptions {
  /** Paths under this directory print relative to it; defaults to `process.cwd()`. */
  readonly relativeTo?: string;
}

export declare const isSkippedInputDirectory: (name: string) => boolean;

export declare const newestEntry: (path: string, options?: NewestEntryOptions) => NewestEntry | undefined;

export declare const distFreshness: (descriptor: DistDescriptor) => DistFreshness;

export declare const checkDistFreshness: (descriptors: readonly DistDescriptor[]) => readonly DistFreshness[];

export declare const formatDistFreshnessFailure: (
  results: readonly DistFreshness[],
  options?: FormatDistFreshnessOptions,
) => string;

export declare const assertFreshDist: (descriptors: readonly DistDescriptor[], options?: FormatDistFreshnessOptions) => void;

export declare const workspaceBuildOutputs: (workspaceRoot?: string) => readonly DistDescriptor[];

export declare const runtimeExampleBuildOutputs: (
  workspaceRoot?: string,
  payloads?: readonly string[],
) => readonly DistDescriptor[];
