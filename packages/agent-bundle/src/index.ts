import type { ClaudeConfigExtension } from './adapters/claude.ts';
import type { CodexConfigExtension } from './adapters/codex.ts';
import type { PortableConfigExtension } from './adapters/portable.ts';
import type { AgentBundleConfig as CoreAgentBundleConfig } from './core/types.ts';

export { defineConfig, pathTokens } from './core/types.ts';
export { startDevServer } from './api.ts';
export type {
  ArtifactOutputKind,
  ArtifactOutputProvenance,
  BuildResult,
  DevServerSession,
  StartDevServerOptions,
} from './api.ts';

export type AgentBundleConfig = CoreAgentBundleConfig
  & ClaudeConfigExtension
  & CodexConfigExtension
  & PortableConfigExtension;

export type {
  AgentBundleConfigExtensions,
  AgentBundleHostConfig,
  AgentBundleMcpApp,
  AgentBundleMcpConfig,
  AgentBundleMcpServer,
  ConfigFactory,
  ConfigFactoryContext,
  McpTransport,
  NormalizationConfigExtension,
  NormalizationTargetRegistry,
  NormalizedConfigExtension,
  NormalizedPlugin,
} from './core/types.ts';
export type {
  ActiveArtifactStatus,
  ArtifactEpoch,
  ArtifactState,
  ArtifactStatus,
  BuildAttempt,
  BuildAttemptOutcome,
  BuildState,
  BuildStatus,
  CompletedBuildAttempt,
  DiagnosticSummary,
  Invalidation,
  InvalidationReason,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ProjectEvent,
  ProjectEventOf,
  ProjectEventMessage,
  ProjectEventPayloadMap,
  ProjectEventType,
  ProjectReplayGap,
  ProjectStatus,
  RuntimeEvent,
  RunningBuildAttempt,
  SucceededBuildAttempt,
  FailedBuildAttempt,
  StaleArtifactStatus,
  SourceState,
  SourceStatus,
} from './dev/types.ts';
