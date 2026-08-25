import { errorMessage as messageFrom } from './client-helpers.ts';
import { useEffect, useState } from 'react';

import type { PlaygroundRun } from '../../agent-bundle/src/contracts/playground.ts';
import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';
import type { NativePlaygroundCatalog } from '../../agent-bundle/src/contracts/playground.ts';

import type { ArtifactClient } from './artifacts/artifact-client.ts';
import { activeEpochFor } from './overview-model.ts';
import type { PlaygroundClient } from './playground/playground-client.ts';
import {
  PlaygroundPage,
  playgroundScriptsForEpoch,
  type PlaygroundScriptCatalog,
} from './playground/playground-page.tsx';
import { WorkbenchScreen, type WorkbenchPage } from './workbench-screen.tsx';

const errorMessage = (reason: unknown): string => messageFrom(reason, 'Foreground project state could not be refreshed.');

/** The normalized model digest identifies the epoch's content for durable playground identity. */
const playgroundEpochFor = (status: ProjectStatus) => {
  const epoch = activeEpochFor(status);
  return epoch === undefined ? undefined : { digest: epoch.modelDigest, id: epoch.id };
};

const playgroundTargetsFor = (status: ProjectStatus) => {
  const epoch = activeEpochFor(status);
  return epoch === undefined
    ? []
    : Object.entries(epoch.targetDigests).map(([name, digest]) => ({ digest, name }));
};

export const PlaygroundScreen = ({ artifactClient, connectionError, onNavigate, onRunChange, pages, playgroundClient, run, status }: {
  readonly artifactClient: ArtifactClient;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onRunChange: (run: PlaygroundRun | undefined) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly playgroundClient: PlaygroundClient;
  readonly run: PlaygroundRun | undefined;
  readonly status: ProjectStatus;
}) => {
  const epoch = activeEpochFor(status);
  const [nativeCatalog, setNativeCatalog] = useState<NativePlaygroundCatalog>();
  const [nativeCatalogError, setNativeCatalogError] = useState<string>();
  const [nativeCatalogLoading, setNativeCatalogLoading] = useState(false);
  const [scriptCatalog, setScriptCatalog] = useState<PlaygroundScriptCatalog>();
  const visibleNativeCatalog = nativeCatalog?.epochId === epoch?.id ? nativeCatalog : undefined;
  const scripts = playgroundScriptsForEpoch(scriptCatalog, epoch?.id);

  useEffect(() => {
    const requestedEpochId = epoch?.id;
    const controller = new AbortController();
    const live = (): boolean => !controller.signal.aborted;
    setNativeCatalog(undefined);
    setNativeCatalogError(undefined);
    setNativeCatalogLoading(requestedEpochId !== undefined);
    if (requestedEpochId === undefined) return () => controller.abort();
    void playgroundClient.catalog(requestedEpochId, controller.signal).then((catalog) => {
      if (live() && catalog.epochId === requestedEpochId) setNativeCatalog(catalog);
    }).catch((reason: unknown) => {
      if (live() && !(reason instanceof Error && reason.name === 'AbortError')) setNativeCatalogError(errorMessage(reason));
    }).finally(() => {
      if (live()) setNativeCatalogLoading(false);
    });
    return () => controller.abort();
  }, [epoch?.id, playgroundClient]);

  useEffect(() => {
    let current = true;
    if (epoch === undefined) {
      setScriptCatalog(undefined);
      return () => { current = false; };
    }
    setScriptCatalog({ epochId: epoch.id, scripts: [] });
    void artifactClient.inspect(epoch.id).then((inspection) => {
      if (current) setScriptCatalog({ epochId: epoch.id, scripts: inspection.runtime.scripts });
    }).catch(() => {
      if (current) setScriptCatalog({ epochId: epoch.id, scripts: [] });
    });
    return () => { current = false; };
  }, [artifactClient, epoch?.id]);

  return <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="playground" pages={pages}>
    <PlaygroundPage
      catalog={visibleNativeCatalog}
      catalogError={nativeCatalogError}
      catalogLoading={nativeCatalogLoading || (epoch !== undefined && visibleNativeCatalog === undefined && nativeCatalogError === undefined)}
      client={playgroundClient}
      epoch={playgroundEpochFor(status)}
      onRunChange={onRunChange}
      run={run}
      scripts={scripts}
      targets={playgroundTargetsFor(status)}
    />
  </WorkbenchScreen>;
};
