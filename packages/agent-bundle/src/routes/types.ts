import type { Diagnostic } from '../core/diagnostics.ts';
import type { CanonicalAgentEvent } from './public.ts';

/**
 * Every route kind the conventional source tree can declare. Context
 * providers are deliberately not a route kind: a provider wraps route
 * execution rather than being addressable itself, so providers live in their
 * own {@link CompiledProvider} collection.
 */
export type CompiledRouteKind =
  | 'tool'
  | 'resource'
  | 'prompt'
  | 'app'
  | 'event-route'
  | 'cli'
  | 'script';

/**
 * Where a compiled route came from. This release only compiles conventional
 * filesystem routes; the relative path is the route's portable identity, so
 * graphs digest identically regardless of where the project is checked out.
 */
export interface RouteProvenance {
  readonly kind: 'conventional';
  /** Project-relative POSIX path of the route module. */
  readonly relativePath: string;
}

export type { CapabilityEvidence, CapabilityState } from '../core/capabilities.ts';

/**
 * The config of a route module without an extractable `config` export: the
 * module exports none, the declaration is not the accepted form (AB4805), or
 * the initializer leaves the static grammar (AB4806).
 */
export const emptyRouteConfig: Readonly<Record<string, unknown>> = Object.freeze({});

export type RouteInputSchemaLiteral =
  | boolean
  | number
  | string
  | readonly (boolean | number | string)[];

interface RouteInputScalarSchemaBase {
  readonly default?: RouteInputSchemaLiteral;
  readonly description?: string;
}

export interface RouteInputStringSchema extends RouteInputScalarSchemaBase {
  readonly enum?: readonly string[];
  readonly type: 'string';
}

export interface RouteInputNumberSchema extends RouteInputScalarSchemaBase {
  readonly type: 'number';
}

export interface RouteInputBooleanSchema extends RouteInputScalarSchemaBase {
  readonly type: 'boolean';
}

export type RouteInputScalarSchema =
  | RouteInputBooleanSchema
  | RouteInputNumberSchema
  | RouteInputStringSchema;

export type RouteInputArrayItemSchema =
  | Readonly<{ readonly type: 'boolean' }>
  | Readonly<{ readonly type: 'number' }>
  | Readonly<{ readonly enum?: readonly string[]; readonly type: 'string' }>;

export interface RouteInputArraySchema {
  readonly default?: RouteInputSchemaLiteral;
  readonly description?: string;
  readonly items: RouteInputArrayItemSchema;
  readonly type: 'array';
}

export type RouteInputPropertySchema = RouteInputArraySchema | RouteInputScalarSchema;

/** Deep-frozen JSON Schema draft-2020-12 subset projected from a route module without executing it. */
export interface RouteInputSchema {
  readonly additionalProperties: false;
  readonly properties: Readonly<Record<string, RouteInputPropertySchema>>;
  readonly required?: readonly string[];
  readonly type: 'object';
}

/**
 * Where a contract's schema is declared: the module and the binding whose
 * initializer is the schema expression, at the end of any alias chain.
 */
export interface RouteContractOrigin {
  /** The declaring binding: `statusInputSchema`; `inputSchema` for a route-local literal. */
  readonly binding: string;
  /** Project-relative POSIX path of the declaring module, e.g. `src/lib/protocol-schemas.ts`. */
  readonly module: string;
}

/**
 * One canonical input contract of the Application IR (#592 §1): a route's
 * `inputSchema` declaration, normalized once into the bounded JSON Schema
 * subset and shared by every route that binds the same declared schema.
 * Identity is the declaration site, so two routes importing one binding
 * share one contract while a route-local literal is
 * `contract:<route relativePath>#inputSchema`. Routes reference a contract
 * by {@link CompiledAgentRoute.contract}; projections consume it — the
 * routed CLI derives its argv grammar from `input`, generated route types
 * and the Workbench read it — instead of re-reading the route module.
 */
export interface RouteContract {
  /** `contract:<origin.module>#<origin.binding>`. */
  readonly id: string;
  /** Deep-frozen; the same object as each bound route's {@link CompiledAgentRoute.inputSchema}. */
  readonly input: RouteInputSchema;
  readonly origin: RouteContractOrigin;
  /** Sorted ids of the graph routes bound to this contract. */
  readonly routes: readonly string[];
}

/** One conventional route module compiled into the immutable route graph. */
export interface CompiledAgentRoute {
  /** Statically extracted from the module's `export const config` declaration; {@link emptyRouteConfig} when absent or rejected. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Id of the {@link RouteContract} this route binds; absent when no static contract was extracted. */
  readonly contract?: string;
  /** Canonical event identity; present only when {@link kind} is `event-route`. */
  readonly event?: CanonicalAgentEvent;
  readonly id: string;
  /** Statically projected bounded JSON Schema subset — the bound contract's `input` object; absent for missing or richer input schemas. */
  readonly inputSchema?: RouteInputSchema;
  readonly kind: CompiledRouteKind;
  readonly provenance: RouteProvenance;
  /** The owning MCP server id (`mcp:<name>`); MCP route kinds only. */
  readonly serverId?: string;
  /** Absolute route module path. */
  readonly source: string;
}

/** One conventional `src/providers/<name>.ts` context provider module. */
export interface CompiledProvider {
  readonly id: string;
  readonly name: string;
  readonly provenance: RouteProvenance;
  /** Absolute provider module path. */
  readonly source: string;
}

/**
 * The scope one conventional layout module wraps: `src/layout.{ts,tsx}` wraps
 * every rendered route of the project (generated MCP routes, rendered CLI
 * commands, projected MCP commands, and rendered scripts);
 * `src/mcp/<server>/layout.{ts,tsx}` wraps that server's routes inside the
 * root layout. Event routes are host protocol responses, not documents for a
 * reader, so no layout applies to them.
 */
export type CompiledLayoutScope = 'root' | 'server';

/** One conventional layout module compiled into the immutable route graph. */
export interface CompiledLayout {
  /** `layout:root` or `layout:mcp:<server>`. */
  readonly id: string;
  readonly provenance: RouteProvenance;
  readonly scope: CompiledLayoutScope;
  /** The owning MCP server id (`mcp:<name>`); `server` scope only. */
  readonly serverId?: string;
  /** Absolute layout module path. */
  readonly source: string;
}

/**
 * The packaging mode of one MCP server that owns discovered route modules.
 * `generated`, `custom`, `command`, and `remote` are explicit or inferred
 * decisions; `conflict` records that discovery found routes but an existing
 * entry claims the same server and no explicit mode resolved it — discovery
 * is not a packaging choice, so the routes stay visible beside the error.
 */
export type CompiledServerMode = 'generated' | 'custom' | 'command' | 'remote' | 'conflict';

/** One MCP server surface assembled from `src/mcp/<name>/` route modules. */
export interface CompiledServerSurface {
  readonly id: string;
  readonly mode: CompiledServerMode;
  readonly name: string;
  /** Discovered routes; empty when an explicit non-generated mode omits them. */
  readonly routes: readonly CompiledAgentRoute[];
}

/**
 * The CLI surface mode: `generated` compiles `src/cli/**` command routes,
 * `conventional` keeps the existing `src/cli.ts` entry and omits the routed
 * commands, and `conflict` records both present without an explicit choice.
 */
export type CompiledCliMode = 'generated' | 'conventional' | 'conflict';

/**
 * One argv projection of a CLI route's `inputSchema` property, derived
 * statically from the bounded zod grammar (#102 stage 2). `key` is the
 * schema property; `option` is its kebab-case `--option` spelling; a
 * positional entry consumes bare arguments in `positional` order instead.
 */
export interface CompiledCliOption {
  /** Accepted values of a `z.enum([...])` base. */
  readonly choices?: readonly string[];
  /** The static `.default(<literal>)` value, surfaced in generated help. */
  readonly defaultValue?: unknown;
  /** The static `.describe('<text>')` string, surfaced in generated help. */
  readonly description?: string;
  readonly key: string;
  readonly kind: 'boolean' | 'enum' | 'number' | 'string';
  readonly option: string;
  /** Zero-based positional order when `config.positionals` names the key. */
  readonly positional?: number;
  /** True for a `z.array(...)` schema: a repeatable option or the trailing variadic positional. */
  readonly repeated: boolean;
  /** True when the schema has neither `.optional()` nor `.default(...)`. */
  readonly required: boolean;
}

/**
 * One executable command compiled from a `src/cli/**` route: nesting is the
 * path-derived identity (`cli:library/audit` -> `library audit`), metadata
 * comes from the statically extracted route config, and the argv surface
 * comes from the bounded `inputSchema` grammar.
 */
export interface CompiledCliCommand {
  readonly aliases: readonly string[];
  readonly description?: string;
  /** Exit-code policy: `zero` on success, or `result` reading the validated result's `exitCode`. */
  readonly exitCode: 'result' | 'zero';
  /**
   * Provenance and safety policy for a command projected from an MCP tool.
   * `confirm` is false only when the tool explicitly declares
   * `annotations.readOnlyHint: true`; the MCP defaults are mutation-capable,
   * so missing or malformed annotations fail closed.
   */
  readonly mcp?: {
    readonly confirm: boolean;
    readonly server: string;
    readonly tool: string;
  };
  readonly options: readonly CompiledCliOption[];
  /** Command path segments below the CLI root (`['library', 'audit']`). */
  readonly path: readonly string[];
  /**
   * The render budget the route declared in `config.render` (#454); a
   * projected MCP command inherits its tool's. Absent means the runtime
   * default, so pre-#454 graphs digest unchanged.
   */
  readonly render?: { readonly maxElapsedMs: number };
  /** True for a `.tsx` route whose async default Server Component renders through the dispatcher (#102 stage 3). */
  readonly rendered: boolean;
  readonly routeId: string;
}

/** The CLI command surface assembled from custom CLI routes and selected projected MCP tools. */
export interface CompiledCliSurface {
  /**
   * The collision-checked command graph compiled from the route surface;
   * present only in `generated` mode. Plain (`.ts`) routes execute directly;
   * rendered (`.tsx`) routes render through the dispatcher.
   */
  readonly commands?: readonly CompiledCliCommand[];
  readonly mode: CompiledCliMode;
  /** Backing routes for every compiled command; empty when `conventional` mode omits them. */
  readonly routes: readonly CompiledAgentRoute[];
}

/**
 * The immutable route graph: one compiler IR for everything the conventional
 * source tree declares. Deep-frozen at compile time; `digest` covers only
 * project-relative identity so equal trees hash equally on every machine.
 */
export interface CompiledRouteGraph {
  readonly cli?: CompiledCliSurface;
  /** Sorted by id; absent when no route has a static contract, so pre-#593 graphs digest unchanged. */
  readonly contracts?: readonly RouteContract[];
  readonly diagnostics: readonly Diagnostic[];
  /** sha256 over the graph's project-relative identity. */
  readonly digest: string;
  readonly events: readonly CompiledAgentRoute[];
  /** Conventional layout modules; absent when the project declares none so pre-layout graphs digest unchanged. */
  readonly layouts?: readonly CompiledLayout[];
  readonly providers: readonly CompiledProvider[];
  readonly scripts: readonly CompiledAgentRoute[];
  readonly servers: readonly CompiledServerSurface[];
}
