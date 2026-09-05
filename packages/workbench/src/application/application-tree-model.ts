/**
 * The one application tree (#600 §1): every plugin-authored surface as a leaf
 * of one tree derived from the compiled route graph (the route manifest), the
 * served Skill tree, and the artifact inventory for configuration-declared
 * surfaces that have no route module. Navigation derives from this tree, not
 * from a list of Workbench pages.
 *
 * Group order is fixed: MCP (per server: Tools · Resources · Prompts · Apps),
 * Events / Hooks, CLI, Scripts, Skills, Rules / Commands. Empty groups are
 * omitted. Leaves sort by label within a group.
 */
import type { ArtifactInspection } from '../../../agent-bundle/src/contracts/artifacts.ts';
import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import type { RouteInputSchema, RouteManifest, RouteManifestCliCommand, RouteManifestConfigEntry } from '../../../agent-bundle/src/contracts/routes.ts';
import type { SkillDocumentTree } from '../../../agent-bundle/src/contracts/skills.ts';
import type { ApplicationNodeRef } from '../../../agent-bundle/src/dev/routes/application-node.ts';
import type { RouteCatalogState } from '../routes/routes-model.ts';

export type ApplicationGroupKind = 'cli' | 'events' | 'mcp' | 'rules' | 'scripts' | 'skills';

/** How a leaf is executed from its workspace. */
export type ApplicationLeafExecution =
  /** Rendered through `POST /api/routes/invocations` (tools, resources, prompts, CLI, scripts, event routes). */
  | 'invoke'
  /** Previewed through the MCP App preview (apps). */
  | 'preview'
  /** Read-only document (skills, rules, commands). */
  | 'document';

export interface ApplicationLeaf {
  /** Compiled CLI command grammar; `cli` leaves only. */
  readonly command?: RouteManifestCliCommand;
  readonly config: readonly RouteManifestConfigEntry[];
  readonly description?: string;
  /** Canonical event id; `event` leaves only. */
  readonly event?: string;
  readonly execution: ApplicationLeafExecution;
  readonly inputSchema?: RouteInputSchema;
  /** Stable key: the leaf's URL path (see `applicationNodeKey`). */
  readonly key: string;
  readonly label: string;
  readonly ref: ApplicationNodeRef;
  /** Compiled route id when the leaf is a compiled route; absent for skills, rules, commands. */
  readonly routeId?: string;
  /** Project-relative source path when known. */
  readonly source?: string;
}

export interface ApplicationSubgroup {
  readonly key: string;
  readonly label: string;
  readonly leaves: readonly ApplicationLeaf[];
}

export interface ApplicationServerGroup {
  readonly key: string;
  readonly label: string;
  /** `command | conflict | custom | generated | remote` — the server's manifest mode. */
  readonly mode: string;
  readonly server: string;
  /** Tools · Resources · Prompts · Apps, non-empty only. */
  readonly subgroups: readonly ApplicationSubgroup[];
}

export type ApplicationGroup =
  | Readonly<{ readonly key: string; readonly kind: 'mcp'; readonly label: 'MCP'; readonly servers: readonly ApplicationServerGroup[] }>
  | Readonly<{ readonly key: string; readonly kind: Exclude<ApplicationGroupKind, 'mcp'>; readonly label: string; readonly leaves: readonly ApplicationLeaf[] }>;

export interface ApplicationTree {
  readonly diagnostics: readonly Diagnostic[];
  readonly groups: readonly ApplicationGroup[];
  readonly leafCount: number;
  /** Present when the compiled route catalog could not be read. */
  readonly message?: string;
  /** Freshness of the compiled route catalog against the published build. */
  readonly state: RouteCatalogState;
}

export interface ApplicationTreeSources {
  /** Artifact inventory of the published epoch: configuration-declared hooks, servers, scripts without route modules. */
  readonly inspection?: ArtifactInspection;
  /** The compiled route manifest; absent when it could not be read (`state` is `unavailable`, `message` says why). */
  readonly manifest?: RouteManifest;
  readonly message?: string;
  readonly skillTree?: SkillDocumentTree;
  readonly state: RouteCatalogState;
}

// Implemented by the tree lane, as thin adapters over the pure derivation in
// packages/agent-bundle/src/dev/routes/application-tree.ts (shared with the
// `agent-bundle/test` Workbench-surface proof): applicationTreeFor(sources),
// findApplicationLeaf(tree, ref), applicationLeafForRouteId(tree, routeId),
// applicationLeaves(tree), filterApplicationTree(tree, query), firstApplicationLeaf(tree).
