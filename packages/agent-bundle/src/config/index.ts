import type { ClaudeConfigExtension } from '../adapters/claude.ts';
import type { CodexConfigExtension } from '../adapters/codex.ts';
import type { PortableConfigExtension } from '../adapters/portable.ts';
import type { AgentBundleConfig as CoreAgentBundleConfig } from '../core/types.ts';

export { discoverProject } from './discover.ts';
export { defineConfig } from '../core/types.ts';
export type {
  AgentProviderContext,
  AgentProviderFactory,
  AppRouteConfig,
  PromptConfig,
  ResourceConfig,
  RouteSchema,
  RouteSchemaOutput,
  ToolConfig,
  ToolRouteProps,
} from '../routes/public.ts';
export type { AgentBundleRuntimeConfig, ConfigFactory, ConfigFactoryContext } from '../core/types.ts';
export type { DiscoveredProject } from './discover.ts';
export { loadConfig } from './load.ts';
export type { LoadedConfig, LoadConfigOptions } from './load.ts';
export { normalizeProject } from './normalize.ts';
export { parseCommand } from './command.ts';
export type { CommandDocument } from './command.ts';
export { parseRule } from './rule.ts';
export type { RuleDocument } from './rule.ts';
export { parseSkill } from './skill.ts';
export type { SkillDocument, SkillResource } from './skill.ts';
export { defineSkill, Skill } from '../skills/define.ts';
export { inspectSkillProjection } from '../skills/inspect.ts';
export { parseSkillIr } from '../skills/parse-ir.ts';
export { lowerSkillIr } from '../skills/lower.ts';
export type { SkillIr, SkillHostDocument, SkillTreeLayoutDecision } from '../skills/ir.ts';
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
  NormalizedCommand,
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
  NormalizedRule,
  NormalizedScript,
  NormalizedSkill,
  NormalizedSkillResource,
  NormalizedTarget,
  ProvenanceKind,
  SourceProvenance,
} from '../core/types.ts';
