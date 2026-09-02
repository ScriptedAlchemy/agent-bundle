interface GhFileListingEntry {
  filename: string;
  previousFilename: string;
}

type DocsOnlyClassification =
  | { docsOnly: false; reason: 'listing-error' | 'invalid-count' | 'empty-listing' | 'truncated-listing' }
  | { docsOnly: false; path: string; reason: 'non-docs-path' }
  | { docsOnly: true; reason: 'docs-only' };

interface ClassifyDocsOnlyOptions {
  changedFilesCount: unknown;
  entries: readonly GhFileListingEntry[];
  listingOk: boolean;
}

interface RunClassifyOptions {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}

export declare const isDocsOnlyPath: (filePath: string) => boolean;

export declare const parseGhFilesListing: (text: string) => GhFileListingEntry[];

export declare const classifyDocsOnlyListing: (
  options: ClassifyDocsOnlyOptions,
) => DocsOnlyClassification;

export declare const runClassify: (
  options?: RunClassifyOptions,
) => Promise<DocsOnlyClassification>;
