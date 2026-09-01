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
