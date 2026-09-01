import type { ClaudeConfigExtension } from '../adapters/claude.ts';
import type { CodexConfigExtension } from '../adapters/codex.ts';
import type { PortableConfigExtension } from '../adapters/portable.ts';
import type { AgentBundleConfig as CoreAgentBundleConfig } from '../core/types.ts';

export { discoverProject } from './discover.ts';
export { defineConfig } from '../core/types.ts';
export type { AppRouteConfig, PromptConfig, ResourceConfig, RouteSchema, RouteSchemaOutput, ToolConfig, ToolRouteProps } from '../routes/public.ts';
export type { AgentBundleRuntimeConfig, ConfigFactory, ConfigFactoryContext } from '../core/types.ts';
export type { DiscoveredProject } from './discover.ts';
export { loadConfig } from './load.ts';
export type { LoadedConfig, LoadConfigOptions } from './load.ts';
export { normalizeProject } from './normalize.ts';
export { parseSkill } from './skill.ts';
export type { SkillDocument, SkillResource } from './skill.ts';
export { validateModel, validateSource } from './validate.ts';
export type AgentBundleConfig = CoreAgentBundleConfig
  & ClaudeConfigExtension
  & CodexConfigExtension
  & PortableConfigExtension;
export type {
  AgentBundleConfigExtensions,
  AgentBundleDevConfig,
  AgentBundleDevRuntimeConfig,
  AgentBundleHostConfig,
  AgentBundlePayloadConfig,
  AgentBundlePayloadEntry,
  AgentBundlePayloadInput,
  AgentBundlePortableConfig,
  AgentBundlePrebuiltEntry,
  NormalizationConfigExtension,
  NormalizationTargetRegistry,
  AgentBundleMcpApp,
  AgentBundleMcpConfig,
  AgentBundleMcpServer,
  McpTransport,
  NormalizedConfigExtension,
  NormalizedMetadata,
  NormalizedMcpApp,
  NormalizedMcpServer,
  NormalizedPayload,
  NormalizedPayloadFile,
  NormalizedPlugin,
  NormalizedRuntime,
  NormalizedScript,
  NormalizedSkill,
  NormalizedSkillResource,
  NormalizedTarget,
  ProvenanceKind,
  SourceProvenance,
} from '../core/types.ts';
