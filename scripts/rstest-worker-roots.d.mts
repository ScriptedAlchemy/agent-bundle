interface RemoveOwnedRstestWorkerRootsOptions {
  /** Liveness probe for the owning process id; defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Directory scanned for worker roots; defaults to `rstestWorkerRootsParent`. */
  parent?: string;
  /** The host `TMPDIR` whose derived worker roots may be removed. */
  temporaryRoot: string;
}

interface RemoveOwnedRstestWorkerRootsResult {
  removed: string[];
  retained: string[];
}

export declare const rstestWorkerRootsParent: string;

export declare const rstestWorkerRootPrefix: string;

export declare const rstestWorkerRootOwnerFile: string;

export declare const removeOwnedRstestWorkerRoots: (
  options: RemoveOwnedRstestWorkerRootsOptions,
) => Promise<RemoveOwnedRstestWorkerRootsResult>;
