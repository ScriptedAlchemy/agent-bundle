/** Declarations for the docs-only classifier so test imports typecheck. */

export interface GhFilesListingEntry {
  readonly filename: string;
  readonly previousFilename: string;
}

export type DocsOnlyReason =
  | 'docs-only'
  | 'empty-listing'
  | 'invalid-count'
  | 'listing-error'
  | 'non-docs-path'
  | 'truncated-listing';

export interface DocsOnlyClassification {
  readonly docsOnly: boolean;
  readonly path?: string;
  readonly reason: DocsOnlyReason;
}

export declare const isDocsOnlyPath: (filePath: string) => boolean;

export declare const parseGhFilesListing: (text: string) => GhFilesListingEntry[];

export declare const classifyDocsOnlyListing: (options: {
  readonly changedFilesCount: string | undefined;
  readonly entries: readonly GhFilesListingEntry[];
  readonly listingOk: boolean;
}) => DocsOnlyClassification;

export declare const runClassify: (options?: {
  readonly argv?: readonly string[];
  readonly env?: Record<string, string | undefined>;
}) => Promise<DocsOnlyClassification>;
