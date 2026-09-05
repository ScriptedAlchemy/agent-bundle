/**
 * The props boundary between the shell (which owns clients, location, and the
 * selected leaf) and the route workspace (which owns input, Run, result tabs,
 * and the inspector). The shell mounts exactly one workspace for the selected
 * leaf; the workspace never navigates the shell except through `onNavigate`.
 */
import type { ArtifactEpoch, ProjectStatus } from '../../../agent-bundle/src/contracts/project.ts';
import type {
  RouteInvocation,
  RouteInvocationEventHost,
  RouteInvocationRequest,
  RouteInvocationSummary,
} from '../../../agent-bundle/src/contracts/invocations.ts';
import type { JsonValue } from '../../../agent-bundle/src/contracts/strict-json.ts';
import type { EvalClient } from '../evals/eval-client.ts';
import type { HookClient } from '../hooks/hook-client.ts';
import type { LifecycleClient } from '../lifecycles/lifecycle-client.ts';
import type { McpAppClient } from '../mcp/mcp-app-client.ts';
import type { ForegroundRouteClient, McpRouteClient } from '../mcp/mcp-route-client.ts';
import type { SkillClient } from '../skill-client.ts';
import type { WorkbenchLocation } from '../shell/workbench-location.ts';
import type { TraceClient } from '../trace/trace-client.ts';
import type { ApplicationLeaf, ApplicationTree } from './application-tree-model.ts';
import type { InvocationBackend, InvocationBackendKind } from './invocation-backend.ts';
import type { InvocationState } from './invocation-model.ts';

/**
 * The result tabs an executable workspace offers; `rendered` is the default.
 * `canonical`, `mapping`, `native`, and `replay` are the event route's
 * secondary codec tabs and appear only on event leaves.
 */
export type WorkspaceResultTab =
  | 'canonical'
  | 'cli'
  | 'mapping'
  | 'mcp'
  | 'native'
  | 'raw'
  | 'rendered'
  | 'replay'
  | 'structured'
  | 'trace';

/** The inspector drawer tabs. */
export type WorkspaceInspectorTab = 'context' | 'projection' | 'providers' | 'raw-protocol' | 'schema' | 'source' | 'timings';

export interface WorkspaceClients {
  readonly appClient: McpAppClient;
  readonly evalClient: EvalClient;
  readonly foreground: ForegroundRouteClient;
  readonly hookClient: HookClient;
  readonly lifecycleClient: LifecycleClient;
  readonly mcpRoutes: McpRouteClient;
  readonly skillClient: SkillClient;
}

export interface RouteWorkspaceProps {
  readonly backends: readonly InvocationBackend[];
  readonly clients: WorkspaceClients;
  /** Deep-linked invocation snapshot to load instead of the last input (`?invocation=<id>`). */
  readonly invocationId?: string;
  readonly leaf: ApplicationLeaf;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly status: ProjectStatus;
  /** Deep-linked result tab (`?tab=<tab>`); the workspace falls back to `rendered`. */
  readonly tab?: string;
  /** Unified trace transport; supplied by the Workbench root once connected. */
  readonly trace?: TraceClient;
  readonly tree: ApplicationTree;
}

/**
 * One ready-made input for a leaf. Event leaves get one per host from the
 * served lifecycle catalog (the host's native payload); a `host` fixture is
 * submitted as `event: { host, fixtureId }` so the service canonicalizes it.
 */
export interface RouteInputFixture {
  readonly host?: RouteInvocationEventHost;
  readonly id: string;
  readonly input: JsonValue;
  readonly label: string;
}

/**
 * What the workspace sends the backend, minus the identity fields the
 * controller adds (`routeId`, `correlationId`).
 */
export type RouteInvocationDraft = Omit<RouteInvocationRequest, 'correlationId' | 'routeId'>;

/**
 * The one invocation the shared workspace panels observe. `RouteWorkspace`
 * owns it (one per mounted leaf) and hands it to whichever workspace body the
 * leaf's execution kind selects, so the input editor, result tabs, inspector,
 * and event codec panes never talk to a backend directly.
 */
export interface RouteInvocationController {
  /** Names the backend that runs this leaf; undefined when none accepts it. */
  readonly backendKind?: InvocationBackendKind;
  /** Recent invocations of this leaf, newest first (the Trace tab). */
  readonly history: readonly RouteInvocationSummary[];
  /** Loads one snapshot by id into `state` (trace entries, deep links). */
  readonly load: (invocationId: string) => void;
  /** The last request sent, for the inspector's Raw protocol tab. */
  readonly request?: RouteInvocationRequest;
  readonly run: (draft: RouteInvocationDraft) => void;
  readonly state: InvocationState;
}

/** The invocation currently on screen, whether it ran here or was loaded by id. */
export const invocationOf = (state: InvocationState): RouteInvocation | undefined =>
  state.phase === 'succeeded' || state.phase === 'failed' ? state.invocation : undefined;

/** The published build every generated surface (Skills, MCP sessions) is scoped to. */
export const publishedEpochFor = (status: ProjectStatus): ArtifactEpoch | undefined =>
  status.artifact.state === 'missing' ? undefined : status.artifact.activeEpoch;
