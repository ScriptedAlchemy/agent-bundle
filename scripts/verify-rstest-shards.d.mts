export interface ShardPartitionInput {
  /** Every file the unsharded pool lists. */
  readonly all: readonly string[];
  /** The files each shard lists, in `--shard` order (index 0 is shard 1). */
  readonly shards: readonly (readonly string[])[];
}

export interface ShardSummary {
  readonly count: number;
  readonly first: string | undefined;
  /** 1-based, like `--shard <index>/<count>`. */
  readonly index: number;
  readonly last: string | undefined;
}

export interface ShardPartitionReport {
  /** Files listed by more than one shard (or twice by one), sorted. */
  readonly duplicated: readonly string[];
  /** 1-based indices of shards that list no files. */
  readonly empty: readonly number[];
  /** Files a shard lists that the pool does not, sorted. */
  readonly extra: readonly string[];
  /** Pool files that no shard lists, sorted. */
  readonly missing: readonly string[];
  readonly ok: boolean;
  readonly shards: readonly ShardSummary[];
  /** Distinct files in the pool. */
  readonly total: number;
}

export interface ListRstestFilesOptions {
  readonly config: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly shard?: { readonly count: number; readonly index: number };
}

export interface RunVerifyShardsOptions {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export declare const parseRstestFileList: (text: string) => string[];

export declare const partitionReport: (input: ShardPartitionInput) => ShardPartitionReport;

export declare const listRstestFiles: (options: ListRstestFilesOptions) => Promise<string[]>;

export declare const runVerifyShards: (options?: RunVerifyShardsOptions) => Promise<ShardPartitionReport>;
