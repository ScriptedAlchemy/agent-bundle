import { spawn } from 'node:child_process';

import { DevCoordinator } from './coordinator.ts';
import { EpochStore } from './epoch-store.ts';
import { ProjectEventHub } from './events.ts';
import { startForegroundServer, type WorkbenchAssetSource } from './foreground-server.ts';
import { ProjectService } from './project-service.ts';
import { SkillDocumentService } from './skill-document-service.ts';
import { createWorkbenchAssetSource } from './workbench-assets.ts';
import type { ProjectStatus } from './types.ts';

export interface DevServerSession {
  close(): Promise<void>;
  status(): ProjectStatus;
  readonly url: string;
}

export type OpenBrowser = (url: string) => Promise<void> | void;

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
  const foreground = await startForegroundServer({
    assets: options.assets ?? createWorkbenchAssetSource(),
    coordinator,
    eventHub,
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
