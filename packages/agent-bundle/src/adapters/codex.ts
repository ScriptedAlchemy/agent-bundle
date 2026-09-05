import { posix } from 'node:path';

import { createTargetDiagnostics } from './diagnostics.ts';
import type { CapabilityState } from '../core/capabilities.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readMcpTransport, unsupportedMcpTransportDiagnostic } from '../core/mcp-transport.ts';
import { dataArrayValues } from '../core/strict-json.ts';
import {
  pathTokens,
  type AgentBundleConfig,
  type AgentBundleHostConfig,
  type NormalizedHook,
  type NormalizedMcpServer,
  type NormalizedPlugin,
} from '../core/types.ts';
import { createMcpPathTokenResolver, standardMcpPathTokens } from '../services/mcp-path-tokens.ts';
import { createTargetMcpRuntime, resolveTargetRelativeStdioArgument } from '../services/mcp-runtime.ts';
import {
  capabilityEvidence,
  capabilityStateFromSupport,
  eventRouteCapabilitiesFrom,
  featureCapabilitiesFrom,
  noticeDeliveryAdvertisementFrom,
  supportedEventRouteNamesFrom,
  cliBinCapability,
  supportedCapability,
  unavailableCapability,
} from './capability-state.ts';
import capabilityTable from './capabilities/codex-0.147.0.json' with { type: 'json' };
import {
  createNativeEventStarter,
  emptyHookDocument,
  mergeHookDocuments,
  encodeNativeHookPlaygroundInput,
  encodeNativeHookPlaygroundOutput,
  nativeHookWrapperSource,
  nativeHooksFor,
  planHooks,
  readStandardNativeHookCommands,
  validatedNativeHookDocument,
  type TargetHookContract,
} from './hook-contract.ts';
import appSchema from './schemas/codex/app.schema.json' with { type: 'json' };
import schemaProvenance from './schemas/codex/PROVENANCE.json' with { type: 'json' };
import hooksSchema from './schemas/codex/hooks.schema.json' with { type: 'json' };
import marketplaceSchema from './schemas/codex/marketplace.schema.json' with { type: 'json' };
import mcpSchema from './schemas/codex/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/codex/plugin.schema.json' with { type: 'json' };
import {
  createAdapterValidator,
  hasPathToken,
  schemaDescriptorsFrom,
  sourceInputs,
  standardArtifactLayout,
  standardPluginArtifactPlan,
  validateJsonSchemaDocument,
  withPluginRootEnvAnchor,
  type TargetAdapter,
  type TargetArtifactDocumentValidator,
  type TargetArtifactPlan,
} from './types.ts';
import { pluginLogoManifestRef, withPluginLogoEntry } from './plugin-logo.ts';
import { folderDiscoveryShadowed, hookWrapperPath } from './composite-layout.ts';
import { deepFreeze } from '../core/freeze.ts';

export interface CodexInterfaceConfig {
  readonly brandColor?: string;
  readonly capabilities?: readonly string[];
  readonly category?: string;
  readonly composerIcon?: string;
  readonly defaultPrompt?: readonly string[];
  readonly developerName?: string;
  readonly displayName?: string;
  readonly logo?: string;
  readonly logoDark?: string;
  readonly longDescription?: string;
  readonly privacyPolicyURL?: string;
  readonly screenshots?: readonly string[];
  readonly shortDescription?: string;
  readonly termsOfServiceURL?: string;
  readonly websiteURL?: string;
}

export interface CodexRegisteredAppConfig {
  /** Exact technical identifier returned by the registered MCP connection workflow. */
  readonly id: string;
}

/** Documented publisher identity in `.codex-plugin/plugin.json`. */
export interface CodexAuthorConfig {
  readonly email?: string;
  readonly name: string;
  readonly url?: string;
}

/** Documented install and authentication policy for the emitted local marketplace entry. */
export interface CodexMarketplacePolicyConfig {
  readonly authentication?: 'ON_INSTALL' | 'ON_USE';
  readonly installation?: 'AVAILABLE' | 'INSTALLED_BY_DEFAULT' | 'NOT_AVAILABLE';
}

/** Authored fields of the emitted `.agents/plugins/marketplace.json`; the source stays the local plugin root. */
export interface CodexMarketplaceConfig {
  /** Marketplace-entry category; defaults to the plugin's interface category. */
  readonly category?: string;
  /** Marketplace picker title; defaults to the plugin name. */
  readonly displayName?: string;
  readonly policy?: CodexMarketplacePolicyConfig;
}

/** Codex-only authored package metadata and install-surface config layered onto the generated manifest. */
export interface CodexHostConfig extends AgentBundleHostConfig {
  /** Registered MCP connection mappings emitted to the root `.app.json` compatibility document. */
  readonly apps?: Readonly<Record<string, CodexRegisteredAppConfig>>;
  readonly author?: CodexAuthorConfig;
  readonly homepage?: string;
  /** Install-surface metadata merged over the compiler's generated defaults. */
  readonly interface?: CodexInterfaceConfig;
  readonly keywords?: readonly string[];
  readonly license?: string;
  readonly marketplace?: CodexMarketplaceConfig;
  readonly repository?: string;
}

export interface CodexConfigExtension {
  codex?: CodexHostConfig;
}

declare module '../core/types.ts' {
  interface AgentBundleConfigExtensions {
    codex?: CodexHostConfig;
  }
}

const codexName = 'codex';

/** Codex's conventional artifact document paths. */
/**
 * Codex's artifact documents. The hook and MCP documents live beside the
 * manifest rather than at Claude Code's conventional `hooks/hooks.json` and
 * `.mcp.json`: the manifest's `hooks` and `mcpServers` pointers name them, so
 * a composite root that also holds a Claude projection never collides (#555).
 */
export const codexArtifactPaths = Object.freeze({
  apps: '.app.json',
  hooksManifest: '.codex-plugin/hooks.json',
  marketplace: '.agents/plugins/marketplace.json',
  mcp: '.codex-plugin/mcp.json',
  plugin: '.codex-plugin/plugin.json',
});
const validator = createAdapterValidator();
const validateApps = validator.compile(appSchema);
const validatePlugin = validator.compile(pluginSchema);
const validateMcp = validator.compile(mcpSchema);
const validateMarketplace = validator.compile(marketplaceSchema);

/** The pinned manifest validator, shared with the host-install test harness. */
export const codexPluginDocumentValidator: TargetArtifactDocumentValidator = validateJsonSchemaDocument(validatePlugin);
const validateHooks = validator.compile(hooksSchema);
const eventRouteNames = supportedEventRouteNamesFrom(capabilityTable.hooks.eventRoutes);
const hookContract = Object.freeze({
  hostContractRevision: capabilityTable.observedCliVersion,
  commandRoot: '${PLUGIN_ROOT}',
  encodePlaygroundInput: encodeNativeHookPlaygroundInput,
  encodePlaygroundOutput: (result, event, nativeEvent) =>
    encodeNativeHookPlaygroundOutput(result, event, nativeEvent, 'codex'),
  eventNames: capabilityTable.hooks.events,
  eventRouteNames,
  manifestPath: codexArtifactPaths.hooksManifest,
  matchers: capabilityTable.hooks.matchers,
  nativeEventStarter: (event) => {
    const nativeEvent = eventRouteNames[event];
    return nativeEvent === undefined ? undefined : createNativeEventStarter('codex', event, nativeEvent);
  },
  readNativeCommands: readStandardNativeHookCommands,
  wrapperPath: (hook: NormalizedPlugin['hooks'][number]) => `hooks/${hook.name}.mjs`,
  wrapperSource: (entry) => nativeHookWrapperSource(entry, 'Codex'),
} satisfies TargetHookContract);
const metadata = Object.freeze({
  adapterRevision: '1.13.0',
  observedVersion: capabilityTable.observedCliVersion,
  schemas: schemaDescriptorsFrom(schemaProvenance, schemaProvenance.observedCliVersion),
});
const evidence = capabilityEvidence(codexName, metadata);

/** Lifts a pinned four-state capability-table row into the shared capability namespace. */
const tableCapability = (row: { readonly reason?: string; readonly state: string }): CapabilityState => {
  switch (row.state) {
    case 'supported':
      return supportedCapability(evidence);
    case 'degraded':
      return Object.freeze({ evidence, reason: row.reason ?? '', state: 'degraded' });
    case 'unavailable':
      return unavailableCapability(row.reason ?? '');
    default:
      throw new TypeError(`Unsupported Codex capability-table state ${JSON.stringify(row.state)}.`);
  }
};

const hookContractTable = capabilityTable.hooks.contract;
const distributionTable = capabilityTable.distribution;
const overviewSurfacesTable = capabilityTable.plugin.overviewSurfaces;
const componentsTable = capabilityTable.plugin.components;
const codexReleaseHookEvents: readonly string[] = capabilityTable.hooks.releaseEvents;
const codexHookRules = Object.freeze({
  additionalContextEvents: hookContractTable.additionalContextLimit.additionalContextEvents as readonly string[],
  hostedToolExclusions: hookContractTable.matcherSemantics.hostedToolExclusions as readonly string[],
  ignoredMatcherEvents: hookContractTable.matcherSemantics.ignoredMatcherEvents as readonly string[],
  mcpToolUnsupportedEvents: hookContractTable.mcpToolExecution.unsupportedEvents as readonly string[],
  shortTimeoutEvents: hookContractTable.timeoutRules.shortTimeoutEvents as Readonly<
    Record<string, { readonly defaultSeconds: number; readonly maximumSeconds: number } | undefined>
  >,
  synchronousEvents: hookContractTable.asyncCommandHooks.synchronousEvents as readonly string[],
});

const artifactValidation = deepFreeze({
  documents: [
    Object.freeze({ path: codexArtifactPaths.apps, required: false, schema: 'app' }),
    Object.freeze({ path: codexArtifactPaths.hooksManifest, required: false, schema: 'hooks' }),
    Object.freeze({ path: codexArtifactPaths.marketplace, required: false, schema: 'marketplace' }),
    Object.freeze({ path: codexArtifactPaths.mcp, required: false, schema: 'mcp' }),
    Object.freeze({ path: codexArtifactPaths.plugin, required: true, schema: 'plugin' }),
  ],
  schemas: [
    Object.freeze({ name: 'app', validate: validateJsonSchemaDocument(validateApps) }),
    Object.freeze({ name: 'hooks', validate: validateJsonSchemaDocument(validateHooks) }),
    Object.freeze({ name: 'marketplace', validate: validateJsonSchemaDocument(validateMarketplace) }),
    Object.freeze({ name: 'mcp', validate: validateJsonSchemaDocument(validateMcp) }),
    Object.freeze({ name: 'plugin', validate: validateJsonSchemaDocument(validatePlugin) }),
  ],
});

const mcpRuntime = createTargetMcpRuntime({
  manifestPath: codexArtifactPaths.mcp,
  remoteTypes: ['streamable-http'],
  resolveStdioArgument: resolveTargetRelativeStdioArgument,
  resolveValue: createMcpPathTokenResolver({
    knownTokens: standardMcpPathTokens,
    target: codexName,
    tokens: {},
  }),
});

const { errorDiagnostic, schemaDiagnostics } = createTargetDiagnostics(codexName, 'Codex');

const isPlainDataRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));

const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isAbsoluteUrl = (value: unknown): value is string => {
  if (!isNonemptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Every `interface` field the adapter can emit — generated or authored through
 * the `codex.interface` extension. The host-install proofs check installed
 * manifests against this declared set so an undeclared emission cannot land.
 */
export const codexInterfaceFields = Object.freeze([
  'brandColor',
  'capabilities',
  'category',
  'composerIcon',
  'defaultPrompt',
  'developerName',
  'displayName',
  'logo',
  'logoDark',
  'longDescription',
  'privacyPolicyURL',
  'screenshots',
  'shortDescription',
  'termsOfServiceURL',
  'websiteURL',
]);


const isEmail = (value: unknown): value is string =>
  isNonemptyString(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);

const hookHandlersOf = (
  hooks: Readonly<Record<string, unknown>>,
): readonly {
  readonly event: string;
  readonly group: Readonly<Record<string, unknown>>;
  readonly groupIndex: number;
  readonly handler: Readonly<Record<string, unknown>>;
  readonly handlerIndex: number;
}[] => {
  const handlers = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const [groupIndex, group] of (dataArrayValues(groups) ?? []).entries()) {
      if (!isPlainDataRecord(group)) continue;
      for (const [handlerIndex, handler] of (dataArrayValues(group['hooks']) ?? []).entries()) {
        if (!isPlainDataRecord(handler)) continue;
        handlers.push({ event, group, groupIndex, handler, handlerIndex });
      }
    }
  }
  return handlers;
};

/**
 * Names the documented-but-unsupported surfaces in an authored native hook
 * document before schema validation, so the closed schema's generic rejection
 * does not hide why Codex would skip the entry.
 */
const scanCodexNativeHookDocument = (document: unknown, source: string): readonly Diagnostic[] => {
  if (!isPlainDataRecord(document) || !isPlainDataRecord(document['hooks'])) return [];
  const diagnostics: Diagnostic[] = [];
  for (const event of Object.keys(document['hooks'])) {
    if (codexReleaseHookEvents.includes(event)) continue;
    diagnostics.push(event === 'Interrupt'
      ? {
          ...errorDiagnostic(
            'codex.native-hooks.event.deferred',
            `Codex native hooks file ${JSON.stringify(source)} declares the Interrupt event, which is deferred: the pinned rust-v0.147.0 generated hook schemas publish no Interrupt contract.`,
          ),
          recovery: 'Remove the Interrupt group until the Codex pin moves to a release that ships the generated Interrupt schemas.',
        }
      : {
          ...errorDiagnostic(
            'codex.native-hooks.event.unknown',
            `Codex native hooks file ${JSON.stringify(source)} declares ${JSON.stringify(event)}, which is not one of the eleven release-documented Codex hook events.`,
          ),
          recovery: `Use one of ${codexReleaseHookEvents.join(', ')}.`,
        });
  }
  for (const { event, groupIndex, handler, handlerIndex } of hookHandlersOf(document['hooks'])) {
    const type = handler['type'];
    if (type !== 'prompt' && type !== 'agent') continue;
    diagnostics.push({
      ...errorDiagnostic(
        'codex.native-hooks.handler.skipped',
        `Codex native hooks file ${JSON.stringify(source)} ${event}[${groupIndex}].hooks[${handlerIndex}] uses handler type ${JSON.stringify(type)}, which Codex 0.147.0 parses but skips.`,
      ),
      recovery: 'Use a command or mcp_tool handler; Codex runs no prompt or agent handlers.',
    });
  }
  return diagnostics;
};

/**
 * Applies the per-event rules from https://learn.chatgpt.com/docs/hooks that
 * the closed hooks schema cannot express, to generated and native handlers
 * alike, so no handler field the host would ignore or reject is published.
 */
const codexHookDocumentDiagnostics = (document: Readonly<Record<string, unknown>>): readonly Diagnostic[] => {
  const hooks = document['hooks'];
  if (!isPlainDataRecord(hooks)) return [];
  const diagnostics: Diagnostic[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!codexHookRules.ignoredMatcherEvents.includes(event)) continue;
    for (const [groupIndex, group] of (dataArrayValues(groups) ?? []).entries()) {
      if (!isPlainDataRecord(group) || typeof group['matcher'] !== 'string') continue;
      diagnostics.push({
        ...errorDiagnostic(
          'codex.hooks.matcher.ignored',
          `Codex ignores any matcher on ${event}; ${event}[${groupIndex}] declares matcher ${JSON.stringify(group['matcher'])}.`,
        ),
        recovery: `Remove the matcher from the ${event} group; the hook already runs on every ${event} event.`,
      });
    }
  }
  for (const { event, groupIndex, handler, handlerIndex } of hookHandlersOf(hooks)) {
    const location = `${event}[${groupIndex}].hooks[${handlerIndex}]`;
    if (handler['type'] === 'mcp_tool' && codexHookRules.mcpToolUnsupportedEvents.includes(event)) {
      diagnostics.push({
        ...errorDiagnostic(
          'codex.hooks.session-end.mcp-tool',
          `Codex ${event} does not support mcp_tool handlers; ${location} declares one.`,
        ),
        recovery: `Use a command handler for ${event}, or move the mcp_tool handler to a supported event.`,
      });
    }
    if (handler['async'] === true && codexHookRules.synchronousEvents.includes(event)) {
      diagnostics.push({
        ...errorDiagnostic(
          'codex.hooks.session-end.async',
          `Codex always runs ${event} hooks synchronously; ${location} sets async to true, which the host would ignore.`,
        ),
        recovery: `Remove async from the ${event} handler.`,
      });
    }
    const shortTimeout = codexHookRules.shortTimeoutEvents[event];
    if (shortTimeout !== undefined && typeof handler['timeout'] === 'number' && handler['timeout'] > shortTimeout.maximumSeconds) {
      diagnostics.push({
        ...errorDiagnostic(
          'codex.hooks.session-end.timeout',
          `Codex ${event} hooks support at most ${shortTimeout.maximumSeconds} seconds (default ${shortTimeout.defaultSeconds}); ${location} declares ${handler['timeout']}.`,
        ),
        recovery: `Set the ${event} handler timeout to ${shortTimeout.maximumSeconds} seconds or less.`,
      });
    }
    if (handler['additionalContextLimit'] !== undefined && !codexHookRules.additionalContextEvents.includes(event)) {
      diagnostics.push({
        ...errorDiagnostic(
          'codex.hooks.additional-context-limit.event',
          `Codex ${event} hooks cannot return additionalContext, so ${location} additionalContextLimit would be ignored with a host configuration warning.`,
        ),
        recovery: `Remove additionalContextLimit from the ${event} handler; it applies only to ${codexHookRules.additionalContextEvents.join(', ')}.`,
      });
    }
  }
  return diagnostics;
};

/** Rejects codex-scoped native selectors that name hosted tools outside the local function-tool hook path. */
const codexHostedToolDiagnostics = (
  model: NormalizedPlugin,
  isSelected: (targets: readonly string[]) => boolean,
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  for (const hook of model.hooks) {
    if (!isSelected(hook.targets)) continue;
    for (const nativeTool of hook.nativeTools ?? []) {
      if (nativeTool.target !== codexName || !codexHookRules.hostedToolExclusions.includes(nativeTool.name)) continue;
      diagnostics.push({
        ...errorDiagnostic(
          'codex.hook.tool.hosted',
          `Codex hosted tool ${JSON.stringify(nativeTool.name)} never reaches the local function-tool hook path, so hook ${JSON.stringify(hook.name)} cannot select it.`,
        ),
        recovery: 'Select a shell, apply_patch, MCP, or local function tool instead; hosted tools such as WebSearch are not hookable in Codex.',
      });
    }
  }
  return diagnostics;
};

interface CodexManifestMetadataPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: Readonly<Record<string, unknown>>;
  readonly sourceInputs: readonly string[];
}

const noManifestMetadataPlan: CodexManifestMetadataPlan = deepFreeze({
  diagnostics: [],
  sourceInputs: [],
});

const manifestMetadataDiagnostic = (
  code: string,
  message: string,
  recovery: string,
): Diagnostic => ({
  ...errorDiagnostic(code, message),
  recovery,
});

const planCodexManifestMetadata = (model: NormalizedPlugin): CodexManifestMetadataPlan => {
  const extension = model.extensions[codexName];
  if (extension === undefined || !isPlainDataRecord(extension.value)) return noManifestMetadataPlan;
  const author = extension.value['author'];
  const homepage = extension.value['homepage'];
  const keywords = extension.value['keywords'];
  const license = extension.value['license'];
  const repository = extension.value['repository'];
  if (
    author === undefined &&
    homepage === undefined &&
    keywords === undefined &&
    license === undefined &&
    repository === undefined
  ) {
    return noManifestMetadataPlan;
  }

  const diagnostics: Diagnostic[] = [];
  let plannedAuthor: Readonly<Record<string, string>> | undefined;
  if (author !== undefined) {
    if (!isPlainDataRecord(author)) {
      diagnostics.push(manifestMetadataDiagnostic(
        'codex.manifest.author.invalid',
        'Codex author must be a plain object.',
        'Set codex.author to an object containing name and optional email and url strings, or remove it.',
      ));
    } else {
      const unknownFields = Object.keys(author).filter((field) => !['email', 'name', 'url'].includes(field));
      if (unknownFields.length > 0) {
        diagnostics.push(manifestMetadataDiagnostic(
          'codex.manifest.author.invalid',
          `Codex author contains unsupported field${unknownFields.length === 1 ? '' : 's'} ${unknownFields.map((field) => JSON.stringify(field)).join(', ')}.`,
          'Keep only codex.author.name, codex.author.email, and codex.author.url.',
        ));
      }
      const name = author['name'];
      const email = author['email'];
      const url = author['url'];
      if (!isNonemptyString(name)) {
        diagnostics.push(manifestMetadataDiagnostic(
          'codex.manifest.author.name.invalid',
          'Codex author.name must be a nonempty string after trimming whitespace.',
          'Set codex.author.name to the author or team name.',
        ));
      }
      if (email !== undefined && !isEmail(email)) {
        diagnostics.push(manifestMetadataDiagnostic(
          'codex.manifest.author.email.invalid',
          'Codex author.email must be a valid nonempty email address.',
          'Set codex.author.email to a contact email address, or remove it.',
        ));
      }
      if (url !== undefined && !isAbsoluteUrl(url)) {
        diagnostics.push(manifestMetadataDiagnostic(
          'codex.manifest.author.url.invalid',
          'Codex author.url must be an absolute HTTP or HTTPS URL.',
          'Set codex.author.url to the author or team homepage, or remove it.',
        ));
      }
      if (
        unknownFields.length === 0 &&
        isNonemptyString(name) &&
        (email === undefined || isEmail(email)) &&
        (url === undefined || isAbsoluteUrl(url))
      ) {
        plannedAuthor = Object.freeze({
          ...(email === undefined ? {} : { email }),
          name,
          ...(url === undefined ? {} : { url }),
        });
      }
    }
  }
  for (const [field, value] of [['homepage', homepage], ['repository', repository]] as const) {
    if (value !== undefined && !isAbsoluteUrl(value)) {
      diagnostics.push(manifestMetadataDiagnostic(
        `codex.manifest.${field}.invalid`,
        `Codex ${field} must be an absolute HTTP or HTTPS URL.`,
        `Set codex.${field} to an absolute URL, or remove it.`,
      ));
    }
  }
  if (license !== undefined && !isNonemptyString(license)) {
    diagnostics.push(manifestMetadataDiagnostic(
      'codex.manifest.license.invalid',
      'Codex license must be a nonempty string after trimming whitespace.',
      'Set codex.license to a license identifier such as MIT or Apache-2.0, or remove it.',
    ));
  }
  if (
    keywords !== undefined &&
    (
      !Array.isArray(keywords) ||
      keywords.some((keyword) => !isNonemptyString(keyword))
    )
  ) {
    const invalidIndex = Array.isArray(keywords)
      ? keywords.findIndex((keyword) => !isNonemptyString(keyword))
      : undefined;
    diagnostics.push(manifestMetadataDiagnostic(
      'codex.manifest.keywords.invalid',
      invalidIndex === undefined
        ? 'Codex keywords must be an array of nonempty strings.'
        : `Codex keywords[${invalidIndex}] must be a nonempty string after trimming whitespace.`,
      'Set codex.keywords to discovery tags such as ["research", "crm"], or remove it.',
    ));
  }

  const inputs = [extension.provenance.sourcePath];
  if (diagnostics.length > 0) return { diagnostics, sourceInputs: inputs };
  return {
    diagnostics,
    document: Object.freeze({
      ...(plannedAuthor === undefined ? {} : { author: plannedAuthor }),
      ...(homepage === undefined ? {} : { homepage }),
      ...(keywords === undefined ? {} : { keywords }),
      ...(license === undefined ? {} : { license }),
      ...(repository === undefined ? {} : { repository }),
    }),
    sourceInputs: inputs,
  };
};

const pluginInternalPath = (value: unknown): value is string => {
  if (!isNonemptyString(value) || !value.startsWith('./') || value === './' || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  const pluginRoot = '/agent-bundle-plugin-root';
  const resolved = posix.resolve(pluginRoot, value.slice(2));
  return resolved.startsWith(`${pluginRoot}/`);
};

interface CodexInterfacePlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly sourceInputs: readonly string[];
  readonly value: Readonly<Record<string, unknown>>;
}

const planCodexInterface = (
  model: NormalizedPlugin,
  generated: Readonly<Record<string, unknown>>,
): CodexInterfacePlan => {
  const extension = model.extensions[codexName];
  const declared = extension !== undefined && isPlainDataRecord(extension.value)
    ? extension.value['interface']
    : undefined;
  if (declared === undefined || extension === undefined) {
    return { diagnostics: [], sourceInputs: [], value: generated };
  }
  if (!isPlainDataRecord(declared)) {
    return {
      diagnostics: [errorDiagnostic(
        'codex.interface.invalid',
        'Codex interface must be a plain object containing only documented interface fields.',
      )],
      sourceInputs: sourceInputs(extension.provenance.sourcePath),
      value: generated,
    };
  }

  const diagnostics: Diagnostic[] = [];
  for (const key of Object.keys(declared)) {
    if (!codexInterfaceFields.includes(key)) {
      diagnostics.push(errorDiagnostic(
        'codex.interface.field.unknown',
        `Codex interface field ${JSON.stringify(key)} is not documented.`,
      ));
    }
  }
  const value: Record<string, unknown> = { ...generated };
  const stringFields = [
    ['displayName', 'display-name'],
    ['shortDescription', 'short-description'],
    ['longDescription', 'long-description'],
    ['developerName', 'developer-name'],
    ['category', 'category'],
  ] as const;
  for (const [field, codeField] of stringFields) {
    const authored = declared[field];
    if (authored === undefined) continue;
    if (!isNonemptyString(authored)) {
      diagnostics.push(errorDiagnostic(
        `codex.interface.${codeField}.invalid`,
        `Codex interface ${field} must be a nonempty string.`,
      ));
    } else {
      value[field] = authored;
    }
  }

  const capabilities = declared['capabilities'];
  if (capabilities !== undefined) {
    const items = dataArrayValues(capabilities);
    if (items === undefined) {
      diagnostics.push(errorDiagnostic(
        'codex.interface.capabilities.invalid',
        'Codex interface capabilities must be an array of nonempty strings.',
      ));
    } else {
      let valid = true;
      for (const [index, item] of items.entries()) {
        if (isNonemptyString(item)) continue;
        valid = false;
        diagnostics.push(errorDiagnostic(
          'codex.interface.capabilities.item.invalid',
          `Codex interface capabilities[${index}] must be a nonempty string.`,
        ));
      }
      if (valid) value['capabilities'] = items;
    }
  }

  const urlFields = [
    ['websiteURL', 'website-url'],
    ['privacyPolicyURL', 'privacy-policy-url'],
    ['termsOfServiceURL', 'terms-of-service-url'],
  ] as const;
  for (const [field, codeField] of urlFields) {
    const authored = declared[field];
    if (authored === undefined) continue;
    if (!isAbsoluteUrl(authored)) {
      diagnostics.push(errorDiagnostic(
        `codex.interface.${codeField}.invalid`,
        `Codex interface ${field} must be an absolute HTTP(S) URL.`,
      ));
    } else {
      value[field] = authored;
    }
  }

  const defaultPrompt = declared['defaultPrompt'];
  if (defaultPrompt !== undefined) {
    const items = dataArrayValues(defaultPrompt);
    if (items === undefined || items.length < 1 || items.length > 3) {
      diagnostics.push(errorDiagnostic(
        'codex.interface.default-prompt.invalid',
        'Codex interface defaultPrompt must contain between one and three strings.',
      ));
    } else {
      let valid = true;
      for (const [index, item] of items.entries()) {
        // Code points, not UTF-16 units, to match JSON Schema maxLength.
        if (isNonemptyString(item) && [...item].length <= 128) continue;
        valid = false;
        diagnostics.push(errorDiagnostic(
          'codex.interface.default-prompt.item.invalid',
          `Codex interface defaultPrompt[${index}] must be a nonempty string of at most 128 characters.`,
        ));
      }
      if (valid) value['defaultPrompt'] = items;
    }
  }

  const brandColor = declared['brandColor'];
  if (brandColor !== undefined) {
    if (typeof brandColor !== 'string' || !/^#[0-9A-Fa-f]{6}$/u.test(brandColor)) {
      diagnostics.push(errorDiagnostic(
        'codex.interface.brand-color.invalid',
        'Codex interface brandColor must be a six-digit hexadecimal color such as "#10A37F".',
      ));
    } else {
      value['brandColor'] = brandColor;
    }
  }

  const assetFields = [
    ['composerIcon', 'composer-icon'],
    ['logo', 'logo'],
    ['logoDark', 'logo-dark'],
  ] as const;
  for (const [field, codeField] of assetFields) {
    const authored = declared[field];
    if (authored === undefined) continue;
    if (!pluginInternalPath(authored)) {
      diagnostics.push(errorDiagnostic(
        `codex.interface.${codeField}.invalid`,
        `Codex interface ${field} must be a ./-prefixed path that stays inside the plugin root.`,
      ));
    } else {
      value[field] = authored;
    }
  }

  const screenshots = declared['screenshots'];
  if (screenshots !== undefined) {
    const items = dataArrayValues(screenshots);
    if (items === undefined) {
      diagnostics.push(errorDiagnostic(
        'codex.interface.screenshots.invalid',
        'Codex interface screenshots must be an array of plugin-internal PNG paths.',
      ));
    } else {
      let valid = true;
      for (const [index, item] of items.entries()) {
        if (
          pluginInternalPath(item) &&
          item.startsWith('./assets/') &&
          item.endsWith('.png')
        ) {
          continue;
        }
        valid = false;
        diagnostics.push(errorDiagnostic(
          'codex.interface.screenshots.item.invalid',
          `Codex interface screenshots[${index}] must be a ./assets/-relative PNG path inside the plugin root.`,
        ));
      }
      if (valid) value['screenshots'] = items;
    }
  }

  return {
    diagnostics,
    sourceInputs: sourceInputs(extension.provenance.sourcePath),
    value: diagnostics.length === 0 ? value : generated,
  };
};

interface CodexAppsPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: Record<string, unknown>;
  readonly sourceInputs: readonly string[];
}

const planCodexApps = (model: NormalizedPlugin): CodexAppsPlan => {
  const extension = model.extensions[codexName];
  const declared = extension !== undefined && isPlainDataRecord(extension.value)
    ? extension.value['apps']
    : undefined;
  if (declared === undefined || extension === undefined) return { diagnostics: [], sourceInputs: [] };
  const inputs = sourceInputs(extension.provenance.sourcePath);
  if (!isPlainDataRecord(declared) || Object.keys(declared).length === 0) {
    return {
      diagnostics: [errorDiagnostic(
        'codex.apps.invalid',
        'Codex apps must be a nonempty object mapping declaration names to registered MCP IDs.',
      )],
      sourceInputs: inputs,
    };
  }

  const diagnostics: Diagnostic[] = [];
  const apps: Record<string, { readonly id: string }> = Object.create(null) as Record<string, { readonly id: string }>;
  for (const [name, entry] of Object.entries(declared)) {
    if (name.trim().length === 0) {
      diagnostics.push(errorDiagnostic(
        'codex.apps.name.invalid',
        'Codex app declaration names must be nonempty strings.',
      ));
      continue;
    }
    if (!isPlainDataRecord(entry) || Object.keys(entry).length !== 1 || !Object.hasOwn(entry, 'id')) {
      diagnostics.push(errorDiagnostic(
        'codex.apps.entry.invalid',
        `Codex app ${JSON.stringify(name)} must contain exactly one id field.`,
      ));
      continue;
    }
    const id = entry['id'];
    if (!isNonemptyString(id)) {
      diagnostics.push(errorDiagnostic(
        'codex.apps.id.invalid',
        `Codex app ${JSON.stringify(name)} id must be the nonempty technical ID returned by registration.`,
      ));
      continue;
    }
    apps[name] = { id };
  }
  return {
    diagnostics,
    ...(diagnostics.length === 0 ? { document: { apps } } : {}),
    sourceInputs: inputs,
  };
};

const marketplaceTable = capabilityTable.marketplace;
const marketplaceAuthenticationPolicies: readonly string[] = marketplaceTable.policy.authentication;
const marketplaceInstallationPolicies: readonly string[] = marketplaceTable.policy.installation;
const marketplaceNotInstallablePolicy: string = marketplaceTable.policy.notInstallable;
const marketplaceConfigFields = Object.freeze(['category', 'displayName', 'policy']);
const marketplacePolicyFields = Object.freeze(['authentication', 'installation']);

interface CodexMarketplacePlan {
  readonly category: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly displayName: string;
  readonly policy: { readonly authentication: string; readonly installation: string };
  readonly sourceInputs: readonly string[];
}

const planCodexMarketplace = (model: NormalizedPlugin, interfaceCategory: string): CodexMarketplacePlan => {
  const defaults = {
    category: interfaceCategory,
    diagnostics: [] as readonly Diagnostic[],
    displayName: model.metadata.name,
    policy: { authentication: 'ON_INSTALL', installation: 'AVAILABLE' },
    sourceInputs: [] as readonly string[],
  };
  const extension = model.extensions[codexName];
  const declared = extension !== undefined && isPlainDataRecord(extension.value)
    ? extension.value['marketplace']
    : undefined;
  if (declared === undefined || extension === undefined) return defaults;
  const inputs = sourceInputs(extension.provenance.sourcePath);
  if (!isPlainDataRecord(declared)) {
    return {
      ...defaults,
      diagnostics: [errorDiagnostic(
        'codex.marketplace.invalid',
        'Codex marketplace must be a plain object containing only category, displayName, and policy.',
      )],
      sourceInputs: inputs,
    };
  }
  const diagnostics: Diagnostic[] = [];
  for (const key of Object.keys(declared)) {
    if (!marketplaceConfigFields.includes(key)) {
      diagnostics.push(errorDiagnostic(
        'codex.marketplace.field.unknown',
        `Codex marketplace field ${JSON.stringify(key)} is not documented; the emitted local marketplace supports category, displayName, and policy.`,
      ));
    }
  }
  let category = defaults.category;
  let displayName = defaults.displayName;
  for (const [field, code] of [['category', 'category'], ['displayName', 'display-name']] as const) {
    const authored = declared[field];
    if (authored === undefined) continue;
    if (!isNonemptyString(authored)) {
      diagnostics.push(errorDiagnostic(
        `codex.marketplace.${code}.invalid`,
        `Codex marketplace ${field} must be a nonempty string.`,
      ));
    } else if (field === 'category') {
      category = authored;
    } else {
      displayName = authored;
    }
  }
  const policy = { ...defaults.policy };
  const declaredPolicy = declared['policy'];
  if (declaredPolicy !== undefined) {
    if (!isPlainDataRecord(declaredPolicy)) {
      diagnostics.push(errorDiagnostic(
        'codex.marketplace.policy.invalid',
        'Codex marketplace policy must be a plain object containing installation and authentication.',
      ));
    } else {
      for (const key of Object.keys(declaredPolicy)) {
        if (!marketplacePolicyFields.includes(key)) {
          diagnostics.push(errorDiagnostic(
            'codex.marketplace.policy.field.unknown',
            `Codex marketplace policy field ${JSON.stringify(key)} is not documented.`,
          ));
        }
      }
      const authentication = declaredPolicy['authentication'];
      if (authentication !== undefined) {
        if (typeof authentication !== 'string' || !marketplaceAuthenticationPolicies.includes(authentication)) {
          diagnostics.push(errorDiagnostic(
            'codex.marketplace.policy.authentication.invalid',
            `Codex marketplace policy.authentication must be one of ${marketplaceAuthenticationPolicies.join(', ')}.`,
          ));
        } else {
          policy.authentication = authentication;
        }
      }
      const installation = declaredPolicy['installation'];
      if (installation !== undefined) {
        if (typeof installation !== 'string' || !marketplaceInstallationPolicies.includes(installation)) {
          diagnostics.push(errorDiagnostic(
            'codex.marketplace.policy.installation.invalid',
            `Codex marketplace policy.installation must be one of ${marketplaceInstallationPolicies.join(', ')}.`,
          ));
        } else if (installation === marketplaceNotInstallablePolicy) {
          // The emitted marketplace exists to install this artifact: INSTALL.md and
          // installBundle() both run `codex plugin add`, which the host refuses for
          // NOT_AVAILABLE entries, so a self-installing bundle cannot honestly carry it.
          diagnostics.push(errorDiagnostic(
            'codex.marketplace.policy.installation.not-installable',
            `Codex marketplace policy.installation ${marketplaceNotInstallablePolicy} makes the emitted bundle refuse its own codex plugin add install path; use ${
              marketplaceInstallationPolicies.filter((value) => value !== marketplaceNotInstallablePolicy).join(' or ')
            }.`,
          ));
        } else {
          policy.installation = installation;
        }
      }
    }
  }
  if (diagnostics.length > 0) return { ...defaults, diagnostics, sourceInputs: inputs };
  return { category, diagnostics, displayName, policy, sourceInputs: inputs };
};

const hasLeadingPluginRoot = (value: string): boolean =>
  value === pathTokens.pluginRoot || value.startsWith(`${pathTokens.pluginRoot}/`);

const relativePluginPath = (value: string): string | undefined => {
  const rest = value.slice(pathTokens.pluginRoot.length).replace(/^\/+/, '');
  const pluginRoot = '/agent-bundle-plugin-root';
  const resolved = posix.resolve(pluginRoot, rest);
  if (resolved !== pluginRoot && !resolved.startsWith(`${pluginRoot}/`)) return undefined;
  const relative = posix.relative(pluginRoot, resolved);
  return relative.length === 0 ? './' : `./${relative}`;
};

const convertCodexValue = (
  value: string,
  location: string,
  hasPluginRootCwd: boolean,
  diagnostics: Diagnostic[],
): string | undefined => {
  if (value.includes(pathTokens.pluginData)) {
    diagnostics.push(errorDiagnostic(
      `codex.mcp.token.plugin-data.${location}`,
      `Codex MCP ${location} cannot use the plugin-data path token.`,
    ));
    return undefined;
  }
  if (value.includes(pathTokens.workspaceRoot)) {
    diagnostics.push(errorDiagnostic(
      `codex.mcp.token.workspace-root.${location}`,
      `Codex MCP ${location} cannot use the workspace-root path token.`,
    ));
    return undefined;
  }
  if (!value.includes(pathTokens.pluginRoot)) return value;
  if (!hasLeadingPluginRoot(value)) {
    diagnostics.push(errorDiagnostic(
      `codex.mcp.token.plugin-root.embedded.${location}`,
      `Codex MCP ${location} embeds the plugin-root path token and cannot represent it natively.`,
    ));
    return undefined;
  }
  if (!hasPluginRootCwd) {
    diagnostics.push(errorDiagnostic(
      `codex.mcp.token.plugin-root.cwd.required.${location}`,
      `Codex MCP ${location} needs an explicit plugin-root cwd before it can be made relative.`,
    ));
    return undefined;
  }
  const relative = relativePluginPath(value);
  if (relative === undefined) {
    diagnostics.push(errorDiagnostic(
      `codex.mcp.token.plugin-root.escape.${location}`,
      `Codex MCP ${location} escapes the plugin-root cwd after canonical path resolution.`,
    ));
  }
  return relative;
};

const planMcpServer = (
  server: NormalizedMcpServer,
): { readonly diagnostics: readonly Diagnostic[]; readonly value?: Record<string, unknown> } => {
  const transport = readMcpTransport(server);
  const transportDiagnostic = unsupportedMcpTransportDiagnostic(server, transport);
  if (transportDiagnostic !== undefined) return { diagnostics: [transportDiagnostic] };
  const diagnostics: Diagnostic[] = [];
  if (transport === 'stdio') {
    if (server.command === undefined) {
      diagnostics.push(errorDiagnostic(
        'codex.mcp.command.required',
        `Codex MCP server "${server.name}" requires a command.`,
      ));
      return { diagnostics };
    }

    const hasPluginRootCwd = server.cwd === pathTokens.pluginRoot || server.cwd === './';
    let cwd: string | undefined;
    if (server.cwd !== undefined) {
      if (server.cwd === pathTokens.pluginRoot) {
        cwd = './';
      } else {
        cwd = convertCodexValue(server.cwd, 'cwd', false, diagnostics);
      }
    }
    const command = convertCodexValue(server.command, 'command', hasPluginRootCwd, diagnostics);
    const args = server.args?.map((argument, index) =>
      convertCodexValue(argument, `args[${index}]`, hasPluginRootCwd, diagnostics));
    const nativeArgs = server.source === undefined
      ? args
      : args?.map((argument, index) =>
          index === 0 && typeof argument === 'string' && argument.startsWith('mcp/')
            ? `./${argument}`
            : argument);
    const env = server.env === undefined
      ? undefined
      : Object.fromEntries(Object.entries(server.env).map(([key, value]) => {
          if (hasPathToken(key)) {
            diagnostics.push(errorDiagnostic(
              'codex.mcp.token.env.key',
              `Codex MCP environment key "${key}" cannot use a path token.`,
            ));
          }
          return [key, convertCodexValue(value, `env.${key}`, hasPluginRootCwd, diagnostics)];
        }));

    if (diagnostics.length > 0 || command === undefined || nativeArgs?.some((value) => value === undefined) || Object.values(env ?? {}).some((value) => value === undefined)) {
      return { diagnostics };
    }
    // Codex has no path-token interpolation, so the plugin-root env anchor is
    // representable only as `./` resolved against a plugin-root cwd; entries
    // without one skip the anchor instead of emitting a misleading value.
    const anchoredEnv = hasPluginRootCwd ? withPluginRootEnvAnchor(env, './') : env;
    return {
      diagnostics,
      value: {
        ...(nativeArgs === undefined ? {} : { args: nativeArgs }),
        command,
        ...(cwd === undefined ? {} : { cwd }),
        ...(anchoredEnv === undefined ? {} : { env: anchoredEnv }),
        type: 'stdio',
      },
    };
  }

  if (server.url === undefined) {
    diagnostics.push(errorDiagnostic('codex.mcp.url.required', `Codex MCP server "${server.name}" requires a URL.`));
    return { diagnostics };
  }
  const url = convertCodexValue(server.url, 'url', false, diagnostics);
  const headers = server.headers === undefined
    ? undefined
    : Object.fromEntries(Object.entries(server.headers).map(([key, value]) => {
        if (hasPathToken(key)) {
          diagnostics.push(errorDiagnostic('codex.mcp.token.headers.key', `Codex MCP header key "${key}" cannot use a path token.`));
        }
        return [key, convertCodexValue(value, `headers.${key}`, false, diagnostics)];
      }));
  if (diagnostics.length > 0 || url === undefined || Object.values(headers ?? {}).some((value) => value === undefined)) {
    return { diagnostics };
  }
  return {
    diagnostics,
    value: {
      ...(headers === undefined ? {} : { headers }),
      type: 'streamable-http',
      url,
    },
  };
};

/**
 * The hook contract of one plan: the registered contract with the wrapper
 * paths the composite root assigns for this selection (#555). The document
 * itself stays at `codexArtifactPaths.hooksManifest`, which the manifest's
 * `hooks` pointer names.
 */
const planHookContract = (selected: readonly string[]): TargetHookContract =>
  Object.freeze({
    ...hookContract,
    wrapperPath: (hook: NormalizedHook) => hookWrapperPath(codexName, hook.name, hook.targets, selected),
  });

export const planCodexArtifacts = (model: NormalizedPlugin): TargetArtifactPlan => {
  const targetName = codexName;
  const selected = model.targets.map((target) => target.name);
  const mcpRelativePath = codexArtifactPaths.mcp;
  const planContract = planHookContract(selected);
  const isSelected = (targets: readonly string[]): boolean => targets.includes(targetName);
  const diagnostics: Diagnostic[] = [];
  const servers: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const server of model.mcpServers) {
    if (!isSelected(server.targets)) continue;
    const serverPlan = planMcpServer(server);
    diagnostics.push(...serverPlan.diagnostics);
    if (serverPlan.value !== undefined) servers[server.name] = serverPlan.value;
  }

  // An empty document still carries the manifest pointer when Claude's
  // conventional `.mcp.json` shares the root, so Codex never loads it (#555).
  const mcp = Object.keys(servers).length === 0
    ? (folderDiscoveryShadowed('.mcp.json', selected) ? { mcpServers: {} } : undefined)
    : { mcpServers: servers };
  const mcpValid = mcp !== undefined && validateMcp(mcp);
  if (mcp !== undefined) diagnostics.push(...schemaDiagnostics('mcp', mcpValid, validateMcp.errors));
  diagnostics.push(...codexHostedToolDiagnostics(model, isSelected));
  const generatedHooks = planHooks(model, targetName, planContract);
  diagnostics.push(...generatedHooks.diagnostics);
  if (generatedHooks.document !== undefined) {
    diagnostics.push(...schemaDiagnostics('hooks', validateHooks(generatedHooks.document), validateHooks.errors));
  }
  const declaredNativeHooks = nativeHooksFor(model, codexName);
  const nativeScan = declaredNativeHooks?.document === undefined
    ? []
    : scanCodexNativeHookDocument(declaredNativeHooks.document, declaredNativeHooks.source);
  diagnostics.push(...nativeScan);
  // A scan finding already names the exact unsupported surface; the closed
  // schema would only add a generic rejection of the same entry.
  const nativeHooks = nativeScan.length > 0
    ? { diagnostics: [] }
    : validatedNativeHookDocument(model, codexName, 'Codex', validateHooks, errorDiagnostic);
  diagnostics.push(...nativeHooks.diagnostics);
  // Likewise an empty hooks document keeps Codex off Claude's `hooks/hooks.json`.
  const hookDocument = mergeHookDocuments(generatedHooks.document, nativeHooks.document)
    ?? (folderDiscoveryShadowed('hooks/hooks.json', selected) ? emptyHookDocument(planContract) : undefined);
  const hookSemantics = hookDocument === undefined ? [] : codexHookDocumentDiagnostics(hookDocument);
  diagnostics.push(...hookSemantics);
  const hookDocumentValid = hookDocument !== undefined && hookSemantics.length === 0 && validateHooks(hookDocument);
  const manifestMetadata = planCodexManifestMetadata(model);
  diagnostics.push(...manifestMetadata.diagnostics);
  const appsPlan = planCodexApps(model);
  diagnostics.push(...appsPlan.diagnostics);
  const appsValid = appsPlan.document !== undefined && validateApps(appsPlan.document);
  if (appsPlan.document !== undefined) {
    diagnostics.push(...schemaDiagnostics('app', appsValid, validateApps.errors));
  }

  const description = model.metadata.description ?? model.metadata.name;
  // The generated fallback prompt must stay within the pinned 128-code-point
  // defaultPrompt limit even for maximum-length plugin names.
  const generatedPrompt = [...`Help me use ${model.metadata.name}.`].slice(0, 128).join('');
  const generatedInterface = {
    capabilities: [
      ...(mcp === undefined ? [] : ['mcp']),
      ...(hookDocument === undefined ? [] : ['hooks']),
      ...(model.skills.some((skill) => isSelected(skill.targets)) ? ['skills'] : []),
    ],
    defaultPrompt: [generatedPrompt],
    developerName: model.metadata.name,
    category: 'Productivity',
    displayName: model.metadata.name,
    ...(model.metadata.logo === undefined
      ? {}
      : { logo: pluginLogoManifestRef(model.metadata.logo.path) }),
    longDescription: description,
    shortDescription: description,
  } satisfies Readonly<Record<string, unknown>>;
  const interfacePlan = planCodexInterface(model, generatedInterface);
  diagnostics.push(...interfacePlan.diagnostics);
  const plugin = {
    author: { name: model.metadata.name },
    ...manifestMetadata.document,
    description,
    interface: interfacePlan.value,
    ...(appsValid ? { apps: `./${codexArtifactPaths.apps}` } : {}),
    ...(mcp === undefined ? {} : { mcpServers: `./${mcpRelativePath}` }),
    ...(hookDocument === undefined ? {} : { hooks: `./${planContract.manifestPath}` }),
    name: model.metadata.name,
    skills: './skills/',
    version: model.metadata.version,
  };
  diagnostics.push(...schemaDiagnostics('plugin', validatePlugin(plugin), validatePlugin.errors));

  const interfaceCategory = interfacePlan.value['category'];
  const marketplacePlan = planCodexMarketplace(
    model,
    typeof interfaceCategory === 'string' ? interfaceCategory : generatedInterface.category,
  );
  diagnostics.push(...marketplacePlan.diagnostics);
  const marketplace = {
    interface: { displayName: marketplacePlan.displayName },
    name: `${model.metadata.name}-marketplace`,
    plugins: [{
      category: marketplacePlan.category,
      name: model.metadata.name,
      policy: marketplacePlan.policy,
      source: { path: './', source: 'local' },
    }],
  };
  const marketplaceValid = marketplacePlan.diagnostics.length === 0 && validateMarketplace(marketplace);
  if (marketplacePlan.diagnostics.length === 0) {
    diagnostics.push(...schemaDiagnostics('marketplace', marketplaceValid, validateMarketplace.errors));
  }

  const basePlan = standardPluginArtifactPlan({
    additionalPluginSourceInputs: sourceInputs(
      ...manifestMetadata.sourceInputs,
      ...interfacePlan.sourceInputs,
      ...appsPlan.sourceInputs,
    ),
    diagnostics,
    hostDocuments: appsPlan.document !== undefined && appsValid
      ? [{
          document: appsPlan.document,
          relativePath: codexArtifactPaths.apps,
          sourceInputs: appsPlan.sourceInputs,
        }]
      : [],
    hookDocument,
    hookDocumentValid,
    hookEntries: generatedHooks.hookEntries,
    hookManifestPath: planContract.manifestPath,
    isSelected,
    marketplace,
    marketplaceRelativePath: codexArtifactPaths.marketplace,
    marketplaceSourceInputs: sourceInputs(...marketplacePlan.sourceInputs, ...interfacePlan.sourceInputs),
    marketplaceValid,
    mcp,
    mcpRelativePath,
    mcpValid,
    model,
    plugin,
    pluginRelativePath: codexArtifactPaths.plugin,
    targetName,
  });
  // interface.logo references an artifact path, so the referenced image must ship.
  return Object.freeze({ ...basePlan, entries: withPluginLogoEntry(basePlan.entries, model) });
};

export const codexAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout: standardArtifactLayout,
  capabilities: Object.freeze({
    ...eventRouteCapabilitiesFrom(capabilityTable.hooks.eventRoutes, evidence),
    // The routed CLI bin rides the same plugin-root directory the pinned
    // contract already executes `mcp/` and `scripts/` files from (#387).
    [cliBinCapability]: supportedCapability(evidence),
    // Component feature sets (#100): one row per host feature a kind may use.
    ...featureCapabilitiesFrom('hooks', capabilityTable.hooks.features, evidence),
    ...featureCapabilitiesFrom('skills', capabilityTable.plugin.skillFeatures, evidence),
    commands: unavailableCapability(
      'The pinned Codex plugin contract (0.147.0) defines no commands component.',
    ),
    interfaceAssets: capabilityStateFromSupport(
      capabilityTable.plugin.interface.assets.state === 'supported',
      evidence,
      'The pinned Codex plugin contract does not document interface image assets.',
    ),
    interfaceBrandColor: capabilityStateFromSupport(
      capabilityTable.plugin.interface.brandColor.state === 'supported',
      evidence,
      'The pinned Codex plugin contract does not document an interface brand color.',
    ),
    interfaceCategoryCapabilities: capabilityStateFromSupport(
      capabilityTable.plugin.interface.categoryCapabilities.state === 'supported',
      evidence,
      'The pinned Codex plugin contract does not document interface category and capability metadata.',
    ),
    interfaceDescriptions: capabilityStateFromSupport(
      capabilityTable.plugin.interface.descriptions.state === 'supported',
      evidence,
      'The pinned Codex plugin contract does not document interface descriptions.',
    ),
    interfaceIdentity: capabilityStateFromSupport(
      capabilityTable.plugin.interface.identity.state === 'supported',
      evidence,
      'The pinned Codex plugin contract does not document interface identity fields.',
    ),
    interfaceStarterPrompts: capabilityStateFromSupport(
      capabilityTable.plugin.interface.starterPrompts.state === 'supported',
      evidence,
      'The pinned Codex plugin contract does not document interface starter prompts.',
    ),
    interfaceUrls: capabilityStateFromSupport(
      capabilityTable.plugin.interface.urls.state === 'supported',
      evidence,
      'The pinned Codex plugin contract does not document interface external links.',
    ),
    claudePluginDataEnvironment: capabilityStateFromSupport(
      capabilityTable.plugin.hookEnvironment.claudePluginData.state === 'supported',
      evidence,
      'The pinned Codex hook contract does not export CLAUDE_PLUGIN_DATA.',
    ),
    claudePluginRootEnvironment: capabilityStateFromSupport(
      capabilityTable.plugin.hookEnvironment.claudePluginRoot.state === 'supported',
      evidence,
      'The pinned Codex hook contract does not export CLAUDE_PLUGIN_ROOT.',
    ),
    install: supportedCapability(evidence),
    marketplace: supportedCapability(evidence),
    allowManagedHooksOnly: tableCapability(distributionTable.allowManagedHooksOnly),
    featureHooks: tableCapability(distributionTable.featureHooks),
    featurePlugins: tableCapability(distributionTable.featurePlugins),
    inlineHooksToml: tableCapability(distributionTable.inlineHooksToml),
    installCacheLayout: tableCapability(distributionTable.installCacheLayout),
    legacyClaudeMarketplaceCompatibility: tableCapability(distributionTable.legacyClaudeMarketplaceCompatibility),
    managedRequirements: tableCapability(distributionTable.managedRequirements),
    marketplaceCategory: tableCapability(distributionTable.marketplaceCategory),
    marketplaceCliLifecycle: tableCapability(distributionTable.marketplaceCliLifecycle),
    marketplaceInterface: tableCapability(distributionTable.marketplaceInterface),
    marketplacePolicy: tableCapability(distributionTable.marketplacePolicy),
    marketplaceSources: tableCapability(distributionTable.marketplaceSources),
    personalMarketplaceDiscovery: tableCapability(distributionTable.personalMarketplaceDiscovery),
    pluginCliLifecycle: tableCapability(distributionTable.pluginCliLifecycle),
    pluginEnableState: tableCapability(distributionTable.pluginEnableState),
    repoMarketplaceDiscovery: tableCapability(distributionTable.repoMarketplaceDiscovery),
    restrictToAllowedSources: tableCapability(distributionTable.restrictToAllowedSources),
    workspacePublishing: tableCapability(distributionTable.workspacePublishing),
    browserExtensions: tableCapability(overviewSurfacesTable.browserExtensions),
    mcpUi: tableCapability(overviewSurfacesTable.mcpUi),
    scheduledTaskTemplates: tableCapability(overviewSurfacesTable.scheduledTaskTemplates),
    hooks: supportedCapability(evidence),
    hookAdditionalContextLimit: tableCapability(hookContractTable.additionalContextLimit),
    hookAsyncCommands: tableCapability(hookContractTable.asyncCommandHooks),
    hookCommandWindows: tableCapability(hookContractTable.commandWindows),
    hookGeneratedSchemas: tableCapability(hookContractTable.generatedSchemaValidation),
    hookHandlerCommand: tableCapability(hookContractTable.handlerCommand),
    hookHandlerMcpTool: tableCapability(hookContractTable.handlerMcpTool),
    hookHandlerPromptAgent: tableCapability(hookContractTable.handlerPromptAgent),
    hookMatcherSemantics: tableCapability(hookContractTable.matcherSemantics),
    hookMcpToolExecution: tableCapability(hookContractTable.mcpToolExecution),
    hookReleaseEvents: tableCapability(hookContractTable.releaseEvents),
    hookStatusMessage: tableCapability(hookContractTable.statusMessage),
    hookTimeoutRules: tableCapability(hookContractTable.timeoutRules),
    hookTrustReview: tableCapability(hookContractTable.trustReview),
    // The pinned Codex plugin contract documents no LSP surface at all, so
    // this is an absent host capability rather than a degraded one: nothing
    // of Claude's `.lsp.json` is copied to the Codex manifest. The same
    // closed manifest schema rules out the other canonical native kinds (#100).
    lsp: tableCapability(componentsTable.lsp),
    nativeDiagnostics: tableCapability(componentsTable.nativeDiagnostics),
    nativeExtension: tableCapability(componentsTable.nativeExtension),
    mcp: capabilityStateFromSupport(
      capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
      evidence,
      'The pinned Codex contract does not support both required modern MCP transports.',
    ),
    pluginDataEnvironment: capabilityStateFromSupport(
      capabilityTable.plugin.hookEnvironment.pluginData.state === 'supported',
      evidence,
      'The pinned Codex hook contract does not export PLUGIN_DATA.',
    ),
    pluginMcpPolicyApprovalModes: unavailableCapability(
      capabilityTable.plugin.mcpServerPolicy.approvalModes.reason,
    ),
    pluginMcpPolicyEnabled: unavailableCapability(
      capabilityTable.plugin.mcpServerPolicy.enabled.reason,
    ),
    pluginMcpPolicyTools: unavailableCapability(
      capabilityTable.plugin.mcpServerPolicy.tools.reason,
    ),
    pluginRootEnvironment: capabilityStateFromSupport(
      capabilityTable.plugin.hookEnvironment.pluginRoot.state === 'supported',
      evidence,
      'The pinned Codex hook contract does not export PLUGIN_ROOT.',
    ),
    registeredMcpApps: capabilityStateFromSupport(
      capabilityTable.plugin.apps.registeredMcpMappings.state === 'supported',
      evidence,
      'The pinned Codex plugin contract does not document registered MCP app mappings.',
    ),
    rules: unavailableCapability(
      'The pinned Codex plugin contract (0.147.0) defines no rules component; Codex guidance remains outside the plugin component surface.',
    ),
    skills: capabilityStateFromSupport(
      capabilityTable.plugin.skills,
      evidence,
      'The pinned Codex plugin contract does not support skills.',
    ),
    manifestMetadata: supportedCapability(evidence),
    manifestPaths: Object.freeze({
      evidence,
      reason: capabilityTable.plugin.manifestPackage.manifestPaths.reason,
      state: 'degraded',
    }),
    optionalAssets: unavailableCapability(
      capabilityTable.plugin.manifestPackage.optionalAssets.reason,
    ),
    submissionPolicy: unavailableCapability(
      capabilityTable.plugin.manifestPackage.submissionPolicy.reason,
    ),
  }),
  configExtension: Object.freeze({ key: codexName }),
  hookContract,
  metadata,
  mcpRuntime,
  name: codexName,
  noticeDelivery: noticeDeliveryAdvertisementFrom(codexName, capabilityTable.noticeDelivery),
  nativeHookSource: (config: Readonly<AgentBundleConfig>) => config.codex?.nativeHooks,
  plan: planCodexArtifacts,
});
