export type TreeSnapshot = ReadonlyMap<string, string>;

export interface TreeSnapshotDifference {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

export declare const snapshotTree: (root: string) => Promise<TreeSnapshot>;

export declare const diffTreeSnapshots: (
  before: TreeSnapshot,
  after: TreeSnapshot,
) => TreeSnapshotDifference;

export declare const treesIdentical: (before: TreeSnapshot, after: TreeSnapshot) => boolean;

export declare const digestTree: (root: string) => Promise<string>;
