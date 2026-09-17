export interface RecursiveRmCall {
  readonly call: string;
  readonly hasRetries: boolean;
  /** 1-based line of the call's first character. */
  readonly line: number;
}

export interface RemovalBindings {
  /** Local names bound to `rm` from node:fs or node:fs/promises, including aliases. */
  readonly bareNames: ReadonlySet<string>;
  /** Namespace and default import names whose `.rm` is node's. */
  readonly namespaceNames: ReadonlySet<string>;
}

export declare const removalBindings: (text: string, fileName?: string) => RemovalBindings;

export declare const recursiveRmCalls: (text: string, fileName?: string) => RecursiveRmCall[];

export declare const bareRecursiveRmFailures: (file: string, text: string) => string[];
