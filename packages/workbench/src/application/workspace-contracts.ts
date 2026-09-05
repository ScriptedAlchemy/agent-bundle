/**
 * The props boundary between the shell (which owns clients, location, and the
 * selected leaf) and the route workspace (which owns input, Run, result tabs,
 * and the inspector). The shell mounts exactly one workspace for the selected
 * leaf; the workspace never navigates the shell except through `onNavigate`.
 */
import type { ProjectStatus } from '../../../agent-bundle/src/contracts/project.ts';
import type { EvalClient } from '../evals/eval-client.ts';
import type { HookClient } from '../hooks/hook-client.ts';
import type { LifecycleClient } from '../lifecycles/lifecycle-client.ts';
import type { McpAppClient } from '../mcp/mcp-app-client.ts';
import type { ForegroundRouteClient, McpRouteClient } from '../mcp/mcp-route-client.ts';
import type { SkillClient } from '../skill-client.ts';
import type { WorkbenchLocation } from '../shell/workbench-location.ts';
import type { ApplicationLeaf, ApplicationTree } from './application-tree-model.ts';
import type { InvocationBackend } from './invocation-backend.ts';

/** The result tabs every executable workspace offers; `rendered` is the default. */
export type WorkspaceResultTab = 'cli' | 'mcp' | 'raw' | 'rendered' | 'structured' | 'trace';

/** The inspector drawer tabs. */
export type WorkspaceInspectorTab = 'context' | 'projection' | 'providers' | 'raw-protocol' | 'schema' | 'source';

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
  readonly tree: ApplicationTree;
}
