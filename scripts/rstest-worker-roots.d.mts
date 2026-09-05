interface RemoveRstestWorkerRootsOptions {
  /** Liveness probe for the owning process id; defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Directory scanned for worker roots; defaults to `rstestWorkerRootsParent`. */
  parent?: string;
}

interface RemoveOwnedRstestWorkerRootsOptions extends RemoveRstestWorkerRootsOptions {
  /** The host `TMPDIR` whose derived worker roots may be removed. */
  temporaryRoot: string;
}

interface RemoveRunRstestWorkerRootsOptions extends RemoveRstestWorkerRootsOptions {
  /** Also remove finished roots with no run id whose marker names this `cwd`. */
  reclaimUntaggedFrom?: string;
  /** The Rstest invocation whose worker roots may be removed; empty matches nothing. */
  runId: string;
}

interface RemoveRstestWorkerRootsResult {
  removed: string[];
  retained: string[];
}

export declare const rstestWorkerRootsParent: string;

export declare const rstestWorkerRootPrefix: string;

export declare const rstestWorkerRootOwnerFile: string;

export declare const rstestRunIdVariable: 'AGENT_BUNDLE_RSTEST_RUN_ID';

export declare const removeOwnedRstestWorkerRoots: (
  options: RemoveOwnedRstestWorkerRootsOptions,
) => Promise<RemoveRstestWorkerRootsResult>;

export declare const removeRunRstestWorkerRoots: (
  options: RemoveRunRstestWorkerRootsOptions,
) => Promise<RemoveRstestWorkerRootsResult>;
