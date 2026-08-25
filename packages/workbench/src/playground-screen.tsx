import { errorMessage as messageFrom } from './client-helpers.ts';
import { useEffect, useState } from 'react';

import type { PlaygroundRun } from '../../agent-bundle/src/contracts/playground.ts';
import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';
import type { NativePlaygroundCatalog } from '../../agent-bundle/src/contracts/playground.ts';

import type { ArtifactInspection } from '../../agent-bundle/src/contracts/artifacts.ts';
import type { SkillDocumentTree } from '../../agent-bundle/src/contracts/skills.ts';
import { activeEpochFor } from './overview-model.ts';
import type { PlaygroundClient } from './playground/playground-client.ts';
import {
  PlaygroundPage,
  playgroundScriptsForEpoch,
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

export const PlaygroundScreen = ({ connectionError, inspection, onNavigate, onRunChange, pages, playgroundClient, run, skillTree, status }: {
  readonly connectionError?: string;
  readonly inspection: ArtifactInspection;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onRunChange: (run: PlaygroundRun | undefined) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
  readonly playgroundClient: PlaygroundClient;
  readonly run: PlaygroundRun | undefined;
  readonly skillTree: SkillDocumentTree;
  readonly status: ProjectStatus;
}) => {
  const epoch = activeEpochFor(status);
  const [nativeCatalog, setNativeCatalog] = useState<NativePlaygroundCatalog>();
  const [nativeCatalogError, setNativeCatalogError] = useState<string>();
  const [nativeCatalogLoading, setNativeCatalogLoading] = useState(false);
  const visibleNativeCatalog = nativeCatalog?.epochId === epoch?.id ? nativeCatalog : undefined;
  const scripts = playgroundScriptsForEpoch({ epochId: inspection.epochId, scripts: inspection.runtime.scripts }, epoch?.id);

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

  return <WorkbenchScreen connectionError={connectionError} onNavigate={onNavigate} page="playground" pages={pages}>
    <PlaygroundPage
      catalog={visibleNativeCatalog}
      catalogError={nativeCatalogError}
      catalogLoading={nativeCatalogLoading || (epoch !== undefined && visibleNativeCatalog === undefined && nativeCatalogError === undefined)}
      client={playgroundClient}
      epoch={playgroundEpochFor(status)}
      hooks={inspection.runtime.hooks}
      onRunChange={onRunChange}
      run={run}
      scripts={scripts}
      skills={skillTree.skills}
      targets={playgroundTargetsFor(status)}
    />
  </WorkbenchScreen>;
};
