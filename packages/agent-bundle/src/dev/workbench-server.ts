import { spawn } from 'node:child_process';

import { DevCoordinator } from './coordinator.ts';
import { EpochStore } from './epoch-store.ts';
import { ProjectEventHub } from './events.ts';
import {
  startForegroundServer,
  type ForegroundCoordinator,
  type WorkbenchAssetSource,
} from './foreground-server.ts';
import { McpSessionService } from './mcp-session-service.ts';
import { ProjectService } from './project-service.ts';
import { SkillDocumentService } from './skill-document-service.ts';
import { createWorkbenchAssetSource } from './workbench-assets.ts';
import type { Invalidation, ProjectStatus } from './types.ts';

export interface DevServerSession {
  close(): Promise<void>;
  status(): ProjectStatus;
  readonly url: string;
}

export type OpenBrowser = (url: string) => Promise<void> | void;

interface Closeable {
  close(): Promise<void>;
}

export interface DevServerLifecycleCloseFailure {
  readonly error: unknown;
  readonly resource: 'coordinator' | 'mcp-sessions';
}

/** Reports session and coordinator cleanup failures without hiding either resource. */
export class DevServerLifecycleCloseError extends Error {
  readonly failures: readonly DevServerLifecycleCloseFailure[];

  constructor(failures: readonly DevServerLifecycleCloseFailure[]) {
    super('Development workbench could not close every lifecycle resource.');
    this.name = 'DevServerLifecycleCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

export interface StartDevServerOptions {
  /** Supplied by integration tests; published callers use the packaged assets. */
  readonly assets?: WorkbenchAssetSource;
  /** Launch the foreground URL after it has started. Defaults to false. */
  readonly open?: boolean;
  /** Injectable browser launcher for embedding and deterministic tests. */
  readonly openBrowser?: OpenBrowser;
  readonly port?: number;
  readonly root: string;
}

/** Closes persistent MCP state alongside the coordinator, preserving all cleanup failures. */
export const closeDevServerLifecycle = async (
  mcpSessions: Closeable,
  coordinator: Closeable,
): Promise<void> => {
  const results = await Promise.allSettled([mcpSessions.close(), coordinator.close()]);
  const failures = results.flatMap((result, index): readonly DevServerLifecycleCloseFailure[] =>
    result.status === 'rejected'
      ? [Object.freeze({
        error: result.reason,
        resource: index === 0 ? 'mcp-sessions' : 'coordinator',
      })]
      : [],
  );
  if (failures.length > 0) throw new DevServerLifecycleCloseError(failures);
};

const withMcpSessionLifecycle = (
  coordinator: DevCoordinator,
  mcpSessions: McpSessionService,
): ForegroundCoordinator => Object.freeze({
  close: () => closeDevServerLifecycle(mcpSessions, coordinator),
  rebuild: (invalidation: Invalidation) => coordinator.rebuild(invalidation),
  start: () => coordinator.start(),
  status: () => coordinator.status(),
});

const openInBrowser: OpenBrowser = (url) => new Promise((resolvePromise, rejectPromise) => {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', rejectPromise);
  child.once('spawn', () => {
    child.unref();
    resolvePromise();
  });
});

/** Starts one loopback foreground session over the current project services. */
export const startDevServer = async (options: StartDevServerOptions): Promise<DevServerSession> => {
  const eventHub = new ProjectEventHub();
  const epochStore = new EpochStore({ projectRoot: options.root });
  const projectService = new ProjectService({ root: options.root });
  const coordinator = new DevCoordinator({ epochStore, eventHub, projectService, root: options.root });
  const mcpSessions = new McpSessionService({ epochStore, projectRoot: options.root });
  const foreground = await startForegroundServer({
    assets: options.assets ?? createWorkbenchAssetSource(),
    coordinator: withMcpSessionLifecycle(coordinator, mcpSessions),
    eventHub,
    mcpSessions,
    port: options.port,
    skillDocuments: new SkillDocumentService({ epochStore, projectService, root: options.root }),
  });
  try {
    if (options.open === true) await (options.openBrowser ?? openInBrowser)(foreground.url);
  } catch (error) {
    await foreground.close();
    throw error;
  }
  return Object.freeze({
    close: () => foreground.close(),
    status: () => coordinator.status(),
    url: foreground.url,
  });
};
