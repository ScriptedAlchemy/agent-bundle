/**
 * Browser-consumable contract surface for artifact inspection and epoch
 * diffs shown in the workbench. Type-only: inspection runs on the server.
 */
export type {
  ApplicationExplorer,
  ApplicationExplorerApp,
  ApplicationExplorerBin,
  ApplicationExplorerCli,
  ApplicationExplorerCliCommand,
  ApplicationExplorerConfigHook,
  ApplicationExplorerDistribution,
  ApplicationExplorerDocument,
  ApplicationExplorerEvent,
  ApplicationExplorerEventHook,
  ApplicationExplorerHookGroup,
  ApplicationExplorerHost,
  ApplicationExplorerIdentity,
  ApplicationExplorerInstall,
  ApplicationExplorerRoute,
  ApplicationExplorerScript,
  ApplicationExplorerServer,
} from '../dev/artifacts/application-explorer.ts';
export type {
  ArtifactEpochDiff,
  ArtifactInspectionBin,
  ArtifactInspection,
  ArtifactInspectionDirectoryNode,
  ArtifactInspectionFile,
  ArtifactInspectionFileNode,
  ArtifactInspectionHook,
  ArtifactInspectionMcpApp,
  ArtifactInspectionMcpServer,
  ArtifactInspectionProjection,
  ArtifactInspectionProvenance,
  ArtifactInspectionRuntime,
  ArtifactInspectionScript,
  ArtifactInspectionSourceInput,
  ArtifactInspectionTreeNode,
} from '../dev/types.ts';
