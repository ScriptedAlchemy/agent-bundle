import type { ArtifactInspection } from '../../../agent-bundle/src/contracts/artifacts.ts';
import {
  applicationLeafForRouteId,
  applicationLeaves,
  applicationTreeForManifest,
  filterApplicationTree,
  findApplicationLeaf,
  firstApplicationLeaf,
  type ApplicationTree,
  type ApplicationTreeState,
} from '../../../agent-bundle/src/contracts/application.ts';
import type { RouteManifest } from '../../../agent-bundle/src/contracts/routes.ts';
import type { SkillDocumentTree } from '../../../agent-bundle/src/contracts/skills.ts';
import type { RouteCatalogState } from '../routes/routes-model.ts';

export interface ApplicationTreeSources {
  readonly inspection?: ArtifactInspection;
  readonly manifest?: RouteManifest;
  readonly message?: string;
  readonly skillTree?: SkillDocumentTree;
  readonly state: RouteCatalogState;
}

const applicationState = (state: RouteCatalogState): ApplicationTreeState => {
  switch (state) {
    case 'current':
      return 'fresh';
    case 'stale':
    case 'unavailable':
      return state;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

export const applicationTreeFor = (sources: ApplicationTreeSources): ApplicationTree =>
  applicationTreeForManifest({
    ...(sources.inspection === undefined ? {} : {
      inspection: {
        hooks: sources.inspection.runtime.hooks.map((hook) => ({
          event: hook.event,
          id: hook.id,
          name: hook.name,
          path: hook.path,
          target: hook.target,
        })),
        mcpServers: sources.inspection.runtime.mcpServers.map((server) => ({
          kind: server.kind,
          name: server.name,
          target: server.target,
        })),
        scripts: sources.inspection.runtime.scripts.map((script) => ({
          file: { path: script.file.path },
          id: script.id,
          name: script.name,
          target: script.target,
        })),
      },
    }),
    ...(sources.manifest === undefined ? {} : { manifest: sources.manifest }),
    ...(sources.message === undefined ? {} : { message: sources.message }),
    ...(sources.skillTree === undefined ? {} : {
      skills: sources.skillTree.skills.map((skill) => ({
        id: skill.id,
        label: skill.name,
        ...(skill.provenance === undefined ? {} : { source: skill.provenance.sourcePath }),
      })),
    }),
    state: applicationState(sources.state),
  });

export {
  applicationLeafForRouteId,
  applicationLeaves,
  filterApplicationTree,
  findApplicationLeaf,
  firstApplicationLeaf,
};
export type {
  ApplicationGroup,
  ApplicationGroupKind,
  ApplicationLeaf,
  ApplicationLeafExecution,
  ApplicationServerGroup,
  ApplicationSubgroup,
  ApplicationTree,
} from '../../../agent-bundle/src/contracts/application.ts';
