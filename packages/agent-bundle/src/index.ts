import type { ClaudeConfigExtension } from './adapters/claude.ts';
import type { CodexConfigExtension } from './adapters/codex.ts';
import type { PortableConfigExtension } from './adapters/portable.ts';
import type { AgentBundleConfig as CoreAgentBundleConfig } from './core/types.ts';

export { defineConfig, pathTokens, pluginRootEnvAnchor } from './core/types.ts';
export { defineSkill, Skill } from './skills/define.ts';
export {
  classifySkillToken,
  skillTokenSpellings,
} from './skills/tokens.ts';
export type {
  ClaudeSkillExtension,
  CodexSkillExtension,
  CursorSkillExtension,
  DefinedSkill,
  SkillHost,
  SkillIr,
  SkillTokenId,
  SkillTreeLayoutDecision,
} from './skills/index.ts';
export { canonicalAgentEvents } from './routes/public.ts';
export type {
  AgentEventCanonicalIdentity,
  AgentEventDelivery,
  AgentEventFallbackMode,
  AgentEventNativePayload,
  AgentEventProvenance,
  AgentEventRouteConfig,
  AgentEventRouteProps,
  AgentEventRuntimeMode,
  AgentProviderContext,
  AgentProviderFactory,
  AppRouteConfig,
  CanonicalAgentEvent,
  CliRouteConfig,
  CliRouteProps,
  PromptConfig,
  ResourceConfig,
  RouteSchema,
  RouteSchemaOutput,
  ToolConfig,
  ToolRouteProps,
} from './routes/public.ts';
export { compareEvals, runEvals, startDevServer } from './api.ts';
export {
  createCodexEvalHarness,
  createEvalHarness,
  runClaudeTrial,
  runCodexEvalTrial,
} from './eval/index.ts';
export type {
  CodexCommandInput,
  CodexCommandResult,
  CodexCommandRunner,
  CodexEvalHarness,
  EvalHarness,
  EvalSemanticGrader,
  EvalSemanticGraderContext,
  EvalSemanticGraderSpec,
  RunClaudeTrialOptions,
  RunCodexEvalTrialOptions,
} from './eval/index.ts';
export {
  assembleArtifactManifest,
  parseArtifactManifest,
  serializeArtifactManifest,
} from './api.ts';
export type {
  EvalAssertionSummary,
  EvalCaseSummary,
  EvalComparison,
  EvalRunResult,
  EvalRunSelection,
  EvalServiceNativeOptions,
  EvalSuiteListing,
  EvalSuiteSummary,
  CompareEvalsOptions,
  RunEvalsOptions,
} from './api.ts';
export type {
  ArtifactOutputKind,
  ArtifactOutputProvenance,
  ArtifactManifestAgentSkills,
  ArtifactManifestFile,
  ArtifactManifestFileKind,
  ArtifactManifestProducer,
  ArtifactManifestProject,
  ArtifactManifestRuntime,
  ArtifactManifestSourceInput,
  ArtifactManifestTarget,
  ArtifactManifestTargetSchema,
  ArtifactManifestTargetValidation,
  ArtifactManifest,
  ArtifactManifestValidation,
  ArtifactManifestValidationRecord,
  ArtifactManifestValidationStatus,
  AssembledArtifactManifest,
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
  AgentBundleDevConfig,
  AgentBundleHostConfig,
  AgentBundleMcpApp,
  AgentBundleMcpConfig,
  AgentBundleMcpServer,
  AgentBundlePayloadConfig,
  AgentBundlePayloadEntry,
  AgentBundlePayloadInput,
  AgentBundlePrebuiltEntry,
  AgentBundleRuntimeConfig,
  ConfigFactory,
  ConfigFactoryContext,
  McpTransport,
  NormalizationConfigExtension,
  NormalizationTargetRegistry,
  NormalizedAsset,
  NormalizedConfigExtension,
  NormalizedPayload,
  NormalizedPayloadFile,
  NormalizedPlugin,
  NormalizedRuntime,
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
