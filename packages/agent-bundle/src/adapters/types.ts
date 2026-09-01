import { Ajv } from 'ajv/dist/ajv.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import type { Diagnostic } from '../core/diagnostics.ts';
import { stableJson } from '../core/digest.ts';
import { snapshotStrictJsonValue } from '../core/strict-json.ts';
import {
  pathTokens,
  pluginRootEnvAnchor,
  type AgentBundleConfig,
  type NormalizedPlugin,
} from '../core/types.ts';
import type { TargetHookContract, TargetHookEntry } from './hook-contract.ts';
import type { TargetMcpRuntimeContract } from '../services/mcp-runtime.ts';

export type { TargetHookEntry, TargetHookWrapper } from './hook-contract.ts';

export interface TargetArtifactWrite {
  readonly content: string;
  readonly kind: 'write';
  readonly relativePath: string;
  /** Absolute authored inputs that selected this generated artifact. */
  readonly sourceInputs: readonly string[];
}

export interface TargetArtifactCopy {
  readonly bytes: number;
  readonly kind: 'copy';
  /**
   * True for a file of a declared prebuilt payload: copied byte-for-byte
   * like any other copy entry, but recorded with the `prebuilt` manifest
   * kind and exempt from generated-module content validation.
   */
  readonly prebuilt?: true;
  readonly relativePath: string;
  readonly source: string;
  /** Absolute authored inputs for this copied artifact. */
  readonly sourceInputs: readonly string[];
}

export type TargetArtifactEntry = TargetArtifactWrite | TargetArtifactCopy;

/** Deduplicated, defined authored inputs for a generated artifact entry. */
export const sourceInputs = (...sources: readonly (string | undefined)[]): readonly string[] =>
  Object.freeze([...new Set(sources.filter((source): source is string => source !== undefined))]);

/** Deterministic artifact ordering shared by every target plan. */
export const sortedEntries = (entries: TargetArtifactEntry[]): readonly TargetArtifactEntry[] => Object.freeze(
  entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0),
);

export interface TargetArtifactPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly entries: readonly TargetArtifactEntry[];
  readonly hookEntries?: readonly TargetHookEntry[];
}

export interface TargetConfigExtension {
  readonly key: string;
}

export interface TargetSchemaDescriptor {
  readonly name: string;
  readonly revision: string;
  readonly sha256: string;
}

/** ajv-formats ships CJS-flavored typings; this single cast localizes the mismatch. */
const installFormats = addFormats as unknown as (target: Ajv | Ajv2020) => void;

/** The one AJV configuration every adapter's pinned schema validators share. */
export const createAdapterValidator = (): Ajv2020 => {
  const validator = new Ajv2020({ allErrors: true, strict: false });
  installFormats(validator);
  return validator;
};

/** Draft-07 validator for official host schemas that declare that dialect. */
export const createDraft7AdapterValidator = (): Ajv => {
  const validator = new Ajv({ allErrors: true, strict: false });
  installFormats(validator);
  return validator;
};

/** Sorted metadata schema descriptors derived from a target's pinned provenance document. */
export const schemaDescriptorsFrom = (
  provenance: Readonly<{ readonly schemas: Readonly<Record<string, { readonly sha256: string }>> }>,
  revision: string,
): readonly TargetSchemaDescriptor[] => Object.freeze(
  Object.entries(provenance.schemas)
    .map(([fileName, schema]) => Object.freeze({
      name: fileName.replace(/\.schema\.json$/, ''),
      revision,
      sha256: schema.sha256,
    }))
    .sort((left, right) => left.name.localeCompare(right.name)),
);

/** True when a value embeds any canonical Agent Bundle path token. */
export const hasPathToken = (value: string): boolean =>
  value.includes(pathTokens.pluginRoot) || value.includes(pathTokens.pluginData) || value.includes(pathTokens.workspaceRoot);

/**
 * Injects the well-known plugin-root env anchor beneath a stdio server's
 * declared environment. The declared entries spread after the anchor, so a
 * user-declared `AGENT_BUNDLE_PLUGIN_ROOT` key always wins.
 */
export const withPluginRootEnvAnchor = <Value extends string | undefined>(
  env: Readonly<Record<string, Value>> | undefined,
  pluginRoot: string,
): Record<string, Value | string> => ({ [pluginRootEnvAnchor]: pluginRoot, ...env });

/**
 * Copy entries for every selected prebuilt payload file, at its exact
 * relative path under the payload's declared destination (see
 * AgentBundlePayloadConfig for why the names stay stable). Shared by every
 * target plan that emits payloads.
 */
export const payloadCopyEntries = (
  model: NormalizedPlugin,
  isSelected: (targets: readonly string[]) => boolean,
): TargetArtifactCopy[] => (model.payloads ?? [])
  .filter((payload) => isSelected(payload.targets))
  .flatMap((payload) => payload.files.map((file): TargetArtifactCopy => ({
    bytes: file.bytes,
    kind: 'copy',
    prebuilt: true,
    relativePath: `${payload.name}/${file.relativePath}`,
    source: file.source,
    sourceInputs: sourceInputs(payload.provenance.sourcePath, file.source),
  })));

export interface StandardPluginArtifactsInput {
  readonly diagnostics: readonly Diagnostic[];
  readonly hookDocument?: Record<string, unknown>;
  readonly hookDocumentValid: boolean;
  readonly hookEntries: readonly TargetHookEntry[];
  readonly hookManifestPath: string;
  readonly isSelected: (targets: readonly string[]) => boolean;
  readonly marketplace?: Record<string, unknown>;
  readonly marketplaceRelativePath: string;
  readonly marketplaceValid: boolean;
  readonly mcp?: Record<string, unknown>;
  /** Artifact-relative path for the MCP document; defaults to the plugin-root `.mcp.json` convention. */
  readonly mcpRelativePath?: string;
  /**
   * Emit the target-agnostic skill and asset copy entries; a composing target
   * that lays two host plans into one root emits them from one side only.
   */
  readonly sharedCopyEntries?: boolean;
  readonly mcpValid: boolean;
  readonly model: NormalizedPlugin;
  readonly plugin: Record<string, unknown>;
  readonly pluginRelativePath: string;
  readonly targetName: string;
}

/**
 * Common plugin.json / .mcp.json / hooks / marketplace / skills / assets emission tail
 * shared by every plugin-shaped target adapter (Claude, Codex). Entry order, the
 * `sourceInputs` spread order, and freeze semantics are load-bearing for artifact
 * provenance, so callers must not reorder fields when adopting this helper.
 */
export const standardPluginArtifactPlan = (input: StandardPluginArtifactsInput): TargetArtifactPlan => {
  const {
    diagnostics,
    hookDocument,
    hookDocumentValid,
    hookEntries,
    hookManifestPath,
    isSelected,
    marketplace,
    marketplaceRelativePath,
    marketplaceValid,
    mcp,
    mcpValid,
    model,
    plugin,
    pluginRelativePath,
    targetName,
  } = input;

  const targetSourceInputs = model.targets
    .filter((target) => target.name === targetName)
    .map((target) => target.provenance.sourcePath);
  const mcpSourceInputs = model.mcpServers
    .filter((server) => isSelected(server.targets))
    .map((server) => server.provenance.sourcePath);
  const hookSourceInputs = model.hooks
    .filter((hook) => isSelected(hook.targets))
    .map((hook) => hook.provenance.sourcePath);
  const nativeHookSourceInputs = model.nativeHooks
    ?.filter((hook) => hook.target === targetName)
    .flatMap((hook) => [hook.provenance.sourcePath, hook.source]) ?? [];
  const skillSourceInputs = model.skills
    .filter((skill) => isSelected(skill.targets))
    .map((skill) => skill.source);

  const entries: TargetArtifactEntry[] = [{
    content: `${stableJson(plugin)}\n`,
    kind: 'write',
    relativePath: pluginRelativePath,
    sourceInputs: sourceInputs(
      model.metadata.provenance.sourcePath,
      ...targetSourceInputs,
      ...mcpSourceInputs,
      ...hookSourceInputs,
      ...nativeHookSourceInputs,
      ...skillSourceInputs,
    ),
  }];
  if (mcp !== undefined && mcpValid) {
    entries.push({
      content: `${stableJson(mcp)}\n`,
      kind: 'write',
      relativePath: input.mcpRelativePath ?? '.mcp.json',
      sourceInputs: sourceInputs(...targetSourceInputs, ...mcpSourceInputs),
    });
  }
  if (hookDocument !== undefined && hookDocumentValid) {
    entries.push({
      content: `${stableJson(hookDocument)}\n`,
      kind: 'write',
      relativePath: hookManifestPath,
      sourceInputs: sourceInputs(
        ...targetSourceInputs,
        ...hookSourceInputs,
        ...nativeHookSourceInputs,
      ),
    });
  }
  if (marketplace !== undefined && marketplaceValid) {
    entries.push({
      content: `${stableJson(marketplace)}\n`,
      kind: 'write',
      relativePath: marketplaceRelativePath,
      sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...targetSourceInputs),
    });
  }
  for (const skill of input.sharedCopyEntries === false ? [] : model.skills) {
    if (!isSelected(skill.targets)) continue;
    if (skill.markdown !== undefined) {
      // A rendered skill's SKILL.md is compiled from its component module.
      entries.push({
        content: skill.markdown,
        kind: 'write',
        relativePath: `skills/${skill.name}/SKILL.md`,
        sourceInputs: sourceInputs(skill.source),
      });
    }
    for (const resource of skill.resources) {
      entries.push({
        bytes: resource.bytes,
        kind: 'copy',
        relativePath: `skills/${skill.name}/${resource.relativePath}`,
        source: resource.source,
        sourceInputs: sourceInputs(skill.source, resource.source),
      });
    }
  }

  for (const asset of input.sharedCopyEntries === false ? [] : model.assets ?? []) {
    if (!isSelected(asset.targets)) continue;
    entries.push({
      bytes: asset.bytes,
      kind: 'copy',
      relativePath: `assets/${asset.relativePath}`,
      source: asset.source,
      sourceInputs: sourceInputs(asset.source),
    });
  }

  entries.push(...(input.sharedCopyEntries === false ? [] : payloadCopyEntries(model, isSelected)));

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    entries: sortedEntries(entries),
    hookEntries: hookDocumentValid ? hookEntries : Object.freeze([]),
  });
};

export interface TargetAdapterMetadata {
  readonly adapterRevision: string;
  readonly capabilityRevision: string;
  readonly capabilitySha256: string;
  readonly observedVersion: string;
  readonly schemas: readonly TargetSchemaDescriptor[];
}

export interface TargetArtifactDocumentIssue {
  readonly instancePath: string;
  readonly message: string;
}

export type TargetArtifactDocumentValidator = (
  document: unknown,
) => readonly TargetArtifactDocumentIssue[];

export interface TargetArtifactSchemaContract {
  readonly name: string;
  readonly validate: TargetArtifactDocumentValidator;
}

export interface TargetArtifactDocumentContract {
  readonly path: string;
  readonly required: boolean;
  readonly schema: string;
}

export interface TargetArtifactValidationContract {
  readonly documents: readonly TargetArtifactDocumentContract[];
  readonly schemas: readonly TargetArtifactSchemaContract[];
}

/** A direct-file namespace emitted by a target's compiler plan. */
export interface TargetArtifactOutputLayout {
  readonly allowedSuffixes: readonly string[];
  readonly directory: string;
}

const noArtifactDocumentIssues: readonly TargetArtifactDocumentIssue[] = Object.freeze([]);
const invalidMcpDocumentIssues: readonly TargetArtifactDocumentIssue[] = Object.freeze([Object.freeze({
  instancePath: '',
  message: 'MCP document must be a detached finite JSON value.',
})]);

/**
 * Target-owned compiler namespaces, separate from target-native schema documents.
 * Every field is an emitted-layout fact rather than a target-name convention.
 */
export interface TargetArtifactLayout {
  readonly assets?: string;
  readonly hookWrappers?: TargetArtifactOutputLayout;
  readonly mcpApps?: TargetArtifactOutputLayout;
  readonly mcpEntries?: TargetArtifactOutputLayout;
  /** Adapter-owned plain documents at the artifact root (for example a generated AGENTS.md). */
  readonly rootDocuments?: readonly string[];
  readonly scripts?: TargetArtifactOutputLayout;
  readonly skills?: string;
}

/**
 * Direct-file artifact layout shared by every plugin-shaped target adapter
 * (Claude, Codex): hook wrappers, MCP apps/entries, scripts, and skills all
 * land in the same target-agnostic directories with the same suffix policy.
 */
export const standardArtifactLayout: TargetArtifactLayout = Object.freeze({
  assets: 'assets',
  hookWrappers: Object.freeze({ allowedSuffixes: Object.freeze(['.mjs']), directory: 'hooks' }),
  mcpApps: Object.freeze({ allowedSuffixes: Object.freeze(['.html']), directory: 'mcp-apps' }),
  mcpEntries: Object.freeze({ allowedSuffixes: Object.freeze(['.mjs']), directory: 'mcp' }),
  scripts: Object.freeze({ allowedSuffixes: Object.freeze(['.bash', '.mjs', '.py', '.sh']), directory: 'scripts' }),
  skills: 'skills',
});

interface JsonSchemaValidator {
  (document: unknown): boolean;
  readonly errors?: readonly { readonly instancePath: string; readonly message?: string }[] | null;
}

/** Converts the checked-in AJV validator result into the artifact contract's stable issue shape. */
export const validateJsonSchemaDocument = (
  validator: JsonSchemaValidator,
): TargetArtifactDocumentValidator => (document) => {
  if (validator(document)) return Object.freeze([]);
  return Object.freeze((validator.errors ?? []).map((error) => Object.freeze({
    instancePath: error.instancePath,
    message: error.message ?? 'schema validation failed',
  })));
};

const escapeJsonPointerSegment = (value: string): string => value
  .replaceAll('~', '~0')
  .replaceAll('/', '~1');

const legacySseMcpIssues = (document: unknown): readonly TargetArtifactDocumentIssue[] => {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return noArtifactDocumentIssues;
  const servers = (document as { readonly mcpServers?: unknown }).mcpServers;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return noArtifactDocumentIssues;
  return Object.freeze(Object.entries(servers)
    .filter(([, server]) =>
      server !== null &&
      typeof server === 'object' &&
      !Array.isArray(server) &&
      (server as { readonly type?: unknown }).type === 'sse')
    .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1)
    .map(([name]) => Object.freeze({
      instancePath: `/mcpServers/${escapeJsonPointerSegment(name)}/type`,
      message: 'legacy SSE MCP transport is not supported',
    })));
};

/** Adds Agent Bundle's modern-only MCP transport policy to a pinned schema validator. */
export const validateModernMcpDocument = (
  validateSchema: TargetArtifactDocumentValidator,
): TargetArtifactDocumentValidator => (document) => {
  let snapshot: unknown;
  try {
    snapshot = snapshotStrictJsonValue(document);
  } catch {
    return invalidMcpDocumentIssues;
  }
  const legacyIssues = legacySseMcpIssues(snapshot);
  if (legacyIssues.length > 0) return legacyIssues;
  return validateSchema(snapshot);
};

export interface TargetAdapter {
  /** Validates target-native JSON documents against schemas pinned in metadata. */
  readonly artifactValidation?: TargetArtifactValidationContract;
  /** Declares compiler-owned artifact layouts beyond target-native documents. */
  readonly artifactLayout?: TargetArtifactLayout;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly configExtension?: TargetConfigExtension;
  readonly hookContract?: TargetHookContract;
  readonly metadata: TargetAdapterMetadata;
  readonly mcpRuntime?: TargetMcpRuntimeContract;
  readonly name: string;
  nativeHookSource?(config: Readonly<AgentBundleConfig>): string | undefined;
  plan(model: NormalizedPlugin): TargetArtifactPlan;
}
