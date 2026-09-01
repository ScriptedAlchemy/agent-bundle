/** The structural schema surface route props infer without coupling to one schema library. */
export interface RouteSchema<Output = unknown> {
  readonly _output: Output;
}

export type RouteSchemaOutput<Schema> = Schema extends RouteSchema<infer Output> ? Output : never;

/** Props received by every executable MCP route's async default Server Component. */
export interface ToolRouteProps<InputSchema extends RouteSchema> {
  readonly input: RouteSchemaOutput<InputSchema>;
  readonly signal: AbortSignal;
}

export interface ToolConfig {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, boolean>>;
  readonly description?: string;
  readonly title?: string;
}

export interface ResourceConfig {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly mimeType?: string;
  readonly title?: string;
  readonly uri: string;
}

export interface PromptConfig {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly title?: string;
}

export interface AppRouteConfig {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly resourceUri: string;
  readonly targets?: readonly string[];
  readonly template?: string;
}

/**
 * Static metadata of one `src/cli/**` command route (#102 stage 2). Every
 * field must stay inside the static route-config grammar; the command path
 * itself comes from the file path, never from config.
 */
export interface CliRouteConfig {
  /** Alternative command names at the same nesting level. */
  readonly aliases?: readonly string[];
  readonly description?: string;
  /**
   * Exit-code policy: omit for 0-on-success, or `'result'` to read the
   * validated result's integer `exitCode` property (0-255).
   */
  readonly exitCode?: 'result';
  /**
   * The `inputSchema` keys consumed as bare arguments, in order. All but the
   * last must be scalar; a trailing `z.array(...)` key is variadic. Keys not
   * named here become `--options`.
   */
  readonly positionals?: readonly string[];
}

/** Props received by every routed CLI command's async default function. */
export interface CliRouteProps<InputSchema extends RouteSchema> {
  readonly input: RouteSchemaOutput<InputSchema>;
  readonly signal: AbortSignal;
}
