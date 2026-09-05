import { createTargetDiagnostics } from './diagnostics.ts';
import { stableJson } from '../core/digest.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readMcpTransport, unsupportedMcpTransportDiagnostic } from '../core/mcp-transport.ts';
import {
  pathTokens,
  type AgentBundlePortableConfig,
  type NormalizedMcpServer,
  type NormalizedPlugin,
} from '../core/types.ts';
import {
  allMcpPathTokenFields,
  createMcpPathTokenResolver,
  standardMcpPathTokens,
} from '../services/mcp-path-tokens.ts';
import { createTargetMcpRuntime } from '../services/mcp-runtime.ts';
import {
  capabilityEvidence,
  capabilityFromTableRow,
  capabilityStateFromSupport,
  cliBinCapability,
  webSurfaceCapability,
  eventRouteCapabilitiesFrom,
  noticeDeliveryAdvertisementFrom,
  supportedCapability,
  featureCapabilitiesFrom,
  unavailableCapability,
} from './capability-state.ts';
import capabilityTable from './capabilities/portable-1.0.0.json' with { type: 'json' };
import {
  portableCommandIssues,
  portableCwdIssues,
  portableEnvKeyIssues,
  portableHeaderIssues,
  portableRemoteUrlIssues,
  type PortableMcpRuleIssue,
} from './portable-mcp-rules.ts';
import schemaProvenance from './schemas/portable/PROVENANCE.json' with { type: 'json' };
import mcpSchema from './schemas/portable/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/portable/plugin.schema.json' with { type: 'json' };
import {
  createAdapterValidator,
  payloadCopyEntries,
  routedCliBinLayout,
  schemaDescriptorsFrom,
  sortedEntries,
  sourceInputs,
  validateJsonSchemaDocument,
  validateModernMcpDocument,
  withPluginRootEnvAnchor,
  type TargetAdapter,
  type TargetArtifactEntry,
  type TargetArtifactPlan,
} from './types.ts';
import { deepFreeze } from '../core/freeze.ts';

/** Agent Plugins 1.0.0 §5.4 `author` object: optional `name`, `email`, and `url` strings. */
export interface PortableAuthorConfig {
  readonly email?: string;
  readonly name?: string;
  readonly url?: string;
}

/**
 * Portable-only manifest metadata layered onto the emitted root `plugin.json`
 * (Agent Plugins 1.0.0 §5.4 metadata fields and §5.6/§8.1 `extensions`).
 * Every field is optional; omitted fields are omitted from the manifest.
 */
export interface PortableManifestConfig {
  readonly author?: PortableAuthorConfig;
  /** Client extension namespaces (reverse-domain, §8) mapped to their opaque object payloads. */
  readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly homepage?: string;
  readonly keywords?: readonly string[];
  readonly license?: string;
  readonly repository?: string;
}

export interface PortableConfigExtension {
  portable?: AgentBundlePortableConfig & PortableManifestConfig;
}

declare module '../core/types.ts' {
  interface AgentBundleConfigExtensions {
    portable?: AgentBundlePortableConfig & PortableManifestConfig;
  }
}

const portablePluginSchema =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const portableMcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const portableName = 'portable';
const schemaValidator = createAdapterValidator();
const validatePlugin = schemaValidator.compile(pluginSchema);
const validateMcp = schemaValidator.compile(mcpSchema);
const metadata = Object.freeze({
  adapterRevision: '1.10.0',
  observedVersion: capabilityTable.observedSpecificationVersion,
  schemas: schemaDescriptorsFrom(schemaProvenance, schemaProvenance.version),
});
const evidence = capabilityEvidence(portableName, metadata);

const artifactValidation = deepFreeze({
  documents: [
    Object.freeze({ path: 'mcp.json', required: false, schema: 'mcp' }),
    Object.freeze({ path: 'plugin.json', required: true, schema: 'plugin' }),
  ],
  schemas: [
    Object.freeze({ name: 'mcp', validate: validateModernMcpDocument(validateJsonSchemaDocument(validateMcp)) }),
    Object.freeze({ name: 'plugin', validate: validateJsonSchemaDocument(validatePlugin) }),
  ],
});

const mcpRuntime = createTargetMcpRuntime({
  manifestPath: 'mcp.json',
  remoteTypes: ['streamable-http'],
  validatedButNonModernRemoteTypes: ['sse'],
  resolveValue: createMcpPathTokenResolver({
    knownTokens: standardMcpPathTokens,
    target: portableName,
    tokens: allMcpPathTokenFields(Object.freeze({
      '${PLUGIN_DATA}': 'pluginData',
      '${PLUGIN_ROOT}': 'pluginRoot',
    })),
  }),
});

const containsToken = (value: string): boolean =>
  Object.values(pathTokens).some((token) => value.includes(token));

const expandPortableToken = (value: string): string =>
  value
    .replaceAll(pathTokens.pluginRoot, '${PLUGIN_ROOT}')
    .replaceAll(pathTokens.pluginData, '${PLUGIN_DATA}');

const unsupportedTokenDiagnostic = (
  value: string,
  location: string,
): Diagnostic | undefined => {
  if (value.includes(pathTokens.workspaceRoot)) {
    return errorDiagnostic(
      'portable.mcp.token.workspace-root',
      `Portable MCP ${location} cannot use the workspace-root path token.`,
    );
  }

  if (!containsToken(value)) {
    return undefined;
  }

  return errorDiagnostic(
    `portable.mcp.token.${location}`,
    `Portable MCP ${location} cannot use a path token.`,
  );
};

const { errorDiagnostic, schemaDiagnostics } = createTargetDiagnostics(portableName, 'Portable');

/**
 * Agent Plugins 1.0.0 normative MCP rules the schema cannot express, applied
 * to the values as they will be written so ordinary `build` and `validate`
 * fail closed instead of deferring to `--host-validation`.
 */
const normativeRuleDiagnostics = (
  server: NormalizedMcpServer,
  issues: readonly PortableMcpRuleIssue[],
): readonly Diagnostic[] => issues.map((issue) => errorDiagnostic(
  `portable.mcp.${issue.field.split('/')[0] ?? issue.field}.standard`,
  `Portable MCP server "${server.name}" ${issue.field} ${issue.message}.`,
));

const hasPortableTarget = (targets: readonly string[]): boolean =>
  targets.includes(portableName);

const isPlainDataRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));

const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isAbsoluteHttpUrl = (value: unknown): value is string => {
  if (!isNonemptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const isEmail = (value: unknown): value is string =>
  isNonemptyString(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);

/** §8: client extension namespaces are reverse-domain identifiers such as `com.example.client`. */
const isExtensionNamespace = (value: string): boolean =>
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u.test(value);

const manifestMetadataFields = Object.freeze([
  'author',
  'extensions',
  'homepage',
  'keywords',
  'license',
  'repository',
] as const);

type ManifestMetadataField = (typeof manifestMetadataFields)[number];

interface PortableManifestMetadataPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document: Readonly<Record<string, unknown>>;
  readonly sourceInputs: readonly string[];
}

const noManifestMetadataPlan: PortableManifestMetadataPlan = deepFreeze({
  diagnostics: [],
  document: {},
  sourceInputs: [],
});

const manifestMetadataDiagnostic = (
  field: ManifestMetadataField | 'author.email' | 'author.name' | 'author.url',
  message: string,
  recovery: string,
): Diagnostic => ({
  ...errorDiagnostic(`portable.manifest.${field}.invalid`, message),
  recovery,
});

const planAuthor = (
  author: unknown,
  diagnostics: Diagnostic[],
): Readonly<Record<string, string>> | undefined => {
  if (!isPlainDataRecord(author)) {
    diagnostics.push(manifestMetadataDiagnostic(
      'author',
      'Portable author must be a plain object (Agent Plugins 1.0.0 §5.4).',
      'Set portable.author to an object with optional name, email, and url strings, or remove it.',
    ));
    return undefined;
  }
  const unknownFields = Object.keys(author).filter((field) => !['email', 'name', 'url'].includes(field));
  if (unknownFields.length > 0) {
    diagnostics.push(manifestMetadataDiagnostic(
      'author',
      `Portable author contains unsupported field${unknownFields.length === 1 ? '' : 's'} ` +
        `${unknownFields.map((field) => JSON.stringify(field)).join(', ')}; Agent Plugins 1.0.0 §5.4 permits only name, email, and url.`,
      'Keep only portable.author.name, portable.author.email, and portable.author.url.',
    ));
  }
  const { email, name, url } = author;
  if (name !== undefined && !isNonemptyString(name)) {
    diagnostics.push(manifestMetadataDiagnostic(
      'author.name',
      'Portable author.name must be a nonempty string after trimming whitespace.',
      'Set portable.author.name to the author or team name, or remove it.',
    ));
  }
  if (email !== undefined && !isEmail(email)) {
    diagnostics.push(manifestMetadataDiagnostic(
      'author.email',
      'Portable author.email must be a nonempty email address.',
      'Set portable.author.email to a contact email address, or remove it.',
    ));
  }
  if (url !== undefined && !isAbsoluteHttpUrl(url)) {
    diagnostics.push(manifestMetadataDiagnostic(
      'author.url',
      'Portable author.url must be an absolute HTTP or HTTPS URL.',
      'Set portable.author.url to the author or team homepage, or remove it.',
    ));
  }
  if (
    unknownFields.length > 0 ||
    (name !== undefined && !isNonemptyString(name)) ||
    (email !== undefined && !isEmail(email)) ||
    (url !== undefined && !isAbsoluteHttpUrl(url))
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
    ...(url === undefined ? {} : { url }),
  });
};

const planExtensions = (
  extensions: unknown,
  diagnostics: Diagnostic[],
): Readonly<Record<string, unknown>> | undefined => {
  if (!isPlainDataRecord(extensions)) {
    diagnostics.push(manifestMetadataDiagnostic(
      'extensions',
      'Portable extensions must be a plain object keyed by client extension namespace (Agent Plugins 1.0.0 §8.1).',
      'Set portable.extensions to { "<reverse.domain.namespace>": { ... } }, or remove it.',
    ));
    return undefined;
  }
  let valid = true;
  const planned: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [namespace, value] of Object.entries(extensions)) {
    if (!isExtensionNamespace(namespace)) {
      valid = false;
      diagnostics.push(manifestMetadataDiagnostic(
        'extensions',
        `Portable extension namespace ${JSON.stringify(namespace)} is not a reverse-domain identifier (Agent Plugins 1.0.0 §8).`,
        'Key portable.extensions by a reverse-domain namespace such as "com.example.client".',
      ));
      continue;
    }
    if (!isPlainDataRecord(value)) {
      valid = false;
      diagnostics.push(manifestMetadataDiagnostic(
        'extensions',
        `Portable extension namespace ${JSON.stringify(namespace)} must map to a plain object (Agent Plugins 1.0.0 §8.1).`,
        `Set portable.extensions[${JSON.stringify(namespace)}] to an object, or remove it.`,
      ));
      continue;
    }
    planned[namespace] = value;
  }
  return valid ? Object.freeze({ ...planned }) : undefined;
};

/**
 * Agent Plugins 1.0.0 §5.4 metadata and §5.6 `extensions` authored under the
 * `portable` config extension. Metadata beyond the JSON-type floor is checked
 * (§5.4 recommends SPDX and URL forms; a client MUST NOT reject them, but this
 * compiler refuses to ship values it knows to be malformed).
 */
const planPortableManifestMetadata = (model: NormalizedPlugin): PortableManifestMetadataPlan => {
  const extension = model.extensions[portableName];
  if (extension === undefined || !isPlainDataRecord(extension.value)) return noManifestMetadataPlan;
  const declared = extension.value;
  if (manifestMetadataFields.every((field) => declared[field] === undefined)) return noManifestMetadataPlan;

  const diagnostics: Diagnostic[] = [];
  const document: Record<string, unknown> = {};
  const { author, extensions, homepage, keywords, license, repository } = declared;
  if (author !== undefined) {
    const planned = planAuthor(author, diagnostics);
    if (planned !== undefined) document['author'] = planned;
  }
  for (const [field, value] of [['homepage', homepage], ['repository', repository]] as const) {
    if (value === undefined) continue;
    if (isAbsoluteHttpUrl(value)) {
      document[field] = value;
      continue;
    }
    diagnostics.push(manifestMetadataDiagnostic(
      field,
      `Portable ${field} must be an absolute HTTP or HTTPS URL.`,
      `Set portable.${field} to an absolute URL, or remove it.`,
    ));
  }
  if (license !== undefined) {
    if (isNonemptyString(license)) document['license'] = license;
    else {
      diagnostics.push(manifestMetadataDiagnostic(
        'license',
        'Portable license must be a nonempty string (an SPDX identifier is recommended by Agent Plugins 1.0.0 §5.4).',
        'Set portable.license to a license identifier such as MIT or Apache-2.0, or remove it.',
      ));
    }
  }
  if (keywords !== undefined) {
    const invalidIndex = Array.isArray(keywords)
      ? keywords.findIndex((keyword) => !isNonemptyString(keyword))
      : undefined;
    if (Array.isArray(keywords) && invalidIndex === -1) document['keywords'] = Object.freeze([...keywords]);
    else {
      diagnostics.push(manifestMetadataDiagnostic(
        'keywords',
        invalidIndex === undefined
          ? 'Portable keywords must be an array of nonempty strings.'
          : `Portable keywords[${invalidIndex}] must be a nonempty string after trimming whitespace.`,
        'Set portable.keywords to discovery tags such as ["research", "crm"], or remove it.',
      ));
    }
  }
  if (extensions !== undefined) {
    const planned = planExtensions(extensions, diagnostics);
    if (planned !== undefined) document['extensions'] = planned;
  }

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    document: Object.freeze(document),
    sourceInputs: Object.freeze([extension.provenance.sourcePath]),
  });
};

const planMcpServer = (
  server: NormalizedMcpServer,
): { readonly diagnostics: readonly Diagnostic[]; readonly value?: Record<string, unknown> } => {
  const transport = readMcpTransport(server);
  const transportDiagnostic = unsupportedMcpTransportDiagnostic(server, transport);
  if (transportDiagnostic !== undefined) return { diagnostics: [transportDiagnostic] };
  const diagnostics: Diagnostic[] = [];

  if (transport === 'stdio') {
    const args = server.args?.map((argument, index) => {
      if (argument.includes(pathTokens.workspaceRoot)) {
        diagnostics.push(
          errorDiagnostic(
            'portable.mcp.token.workspace-root',
            `Portable MCP args[${index}] cannot use the workspace-root path token.`,
          ),
        );
      }
      return expandPortableToken(argument);
    });
    if (server.command === undefined) {
      diagnostics.push(
        errorDiagnostic('portable.mcp.command.required', `Portable MCP server "${server.name}" requires a command.`),
      );
    } else {
      const diagnostic = unsupportedTokenDiagnostic(server.command, 'command');
      if (diagnostic !== undefined) diagnostics.push(diagnostic);
    }
    const declaredEnv = server.env === undefined ? undefined : Object.fromEntries(
      Object.entries(server.env).map(([key, value]) => {
        const keyDiagnostic = unsupportedTokenDiagnostic(key, 'env-key');
        if (keyDiagnostic !== undefined) diagnostics.push(keyDiagnostic);
        if (value.includes(pathTokens.workspaceRoot)) {
          diagnostics.push(
            errorDiagnostic(
              'portable.mcp.token.workspace-root',
              `Portable MCP env value for "${key}" cannot use the workspace-root path token.`,
            ),
          );
        }
        return [key, expandPortableToken(value)];
      }),
    );
    const cwd = server.cwd === undefined ? undefined : expandPortableToken(server.cwd);
    if (server.cwd?.includes(pathTokens.workspaceRoot)) {
      diagnostics.push(
        errorDiagnostic(
          'portable.mcp.token.workspace-root',
          'Portable MCP cwd cannot use the workspace-root path token.',
        ),
      );
    }

    if (diagnostics.length > 0 || server.command === undefined) {
      return { diagnostics };
    }

    diagnostics.push(
      ...normativeRuleDiagnostics(server, portableCommandIssues(server.command)),
      ...normativeRuleDiagnostics(server, portableCwdIssues(cwd)),
      ...normativeRuleDiagnostics(server, portableEnvKeyIssues(declaredEnv)),
    );
    if (diagnostics.length > 0) {
      return { diagnostics };
    }

    return {
      diagnostics,
      value: {
        ...(args === undefined ? {} : { args }),
        command: server.command,
        ...(cwd === undefined ? {} : { cwd }),
        env: withPluginRootEnvAnchor(declaredEnv, expandPortableToken(pathTokens.pluginRoot)),
        type: transport,
      },
    };
  }

  if (server.url === undefined) {
    diagnostics.push(
      errorDiagnostic('portable.mcp.url.required', `Portable MCP server "${server.name}" requires a URL.`),
    );
  } else {
    const diagnostic = unsupportedTokenDiagnostic(server.url, 'url');
    if (diagnostic !== undefined) diagnostics.push(diagnostic);
  }

  if (server.headers !== undefined) {
    for (const [key, value] of Object.entries(server.headers)) {
      const keyDiagnostic = unsupportedTokenDiagnostic(key, 'headers');
      const valueDiagnostic = unsupportedTokenDiagnostic(value, 'headers');
      if (keyDiagnostic !== undefined) diagnostics.push(keyDiagnostic);
      if (valueDiagnostic !== undefined) diagnostics.push(valueDiagnostic);
    }
  }

  if (diagnostics.length > 0 || server.url === undefined) {
    return { diagnostics };
  }

  diagnostics.push(
    ...normativeRuleDiagnostics(server, portableRemoteUrlIssues(server.url)),
    ...normativeRuleDiagnostics(server, portableHeaderIssues(server.headers)),
  );
  if (diagnostics.length > 0) {
    return { diagnostics };
  }

  return {
    diagnostics,
    value: {
      ...(server.headers === undefined ? {} : { headers: server.headers }),
      type: 'streamable-http',
      url: server.url,
    },
  };
};

const plan = (model: NormalizedPlugin): TargetArtifactPlan => {
  const diagnostics: Diagnostic[] = [];
  const manifestMetadata = planPortableManifestMetadata(model);
  diagnostics.push(...manifestMetadata.diagnostics);
  const plugin = {
    $schema: portablePluginSchema,
    ...(model.metadata.description === undefined
      ? {}
      : { description: model.metadata.description }),
    name: model.metadata.name,
    version: model.metadata.version,
    ...manifestMetadata.document,
  };
  const entries: TargetArtifactEntry[] = [
    {
      content: `${stableJson(plugin)}\n`,
      kind: 'write',
      relativePath: 'plugin.json',
      sourceInputs: sourceInputs(
        model.metadata.provenance.sourcePath,
        ...model.targets.filter((target) => target.name === portableName).map((target) => target.provenance.sourcePath),
        ...manifestMetadata.sourceInputs,
      ),
    },
  ];
  diagnostics.push(...schemaDiagnostics('plugin', validatePlugin(plugin), validatePlugin.errors));

  for (const skill of model.skills) {
    if (!hasPortableTarget(skill.targets)) continue;
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

  for (const asset of model.assets ?? []) {
    if (!hasPortableTarget(asset.targets)) continue;
    entries.push({
      bytes: asset.bytes,
      kind: 'copy',
      relativePath: `assets/${asset.relativePath}`,
      source: asset.source,
      sourceInputs: sourceInputs(asset.source),
    });
  }

  entries.push(...payloadCopyEntries(model, hasPortableTarget));

  const servers: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  for (const server of model.mcpServers) {
    if (!hasPortableTarget(server.targets)) continue;
    const serverPlan = planMcpServer(server);
    diagnostics.push(...serverPlan.diagnostics);
    if (serverPlan.value !== undefined) {
      servers[server.name] = serverPlan.value;
    }
  }

  if (Object.keys(servers).length > 0) {
    const mcp = { $schema: portableMcpSchema, mcpServers: servers };
    const mcpDiagnostics = schemaDiagnostics('mcp', validateMcp(mcp), validateMcp.errors);
    diagnostics.push(...mcpDiagnostics);
    if (mcpDiagnostics.length === 0) {
      entries.push({
        content: `${stableJson(mcp)}\n`,
        kind: 'write',
        relativePath: mcpRuntime.manifestPath,
        sourceInputs: sourceInputs(...model.mcpServers
          .filter((server) => hasPortableTarget(server.targets))
          .map((server) => server.provenance.sourcePath)),
      });
    }
  }

  return deepFreeze({
    diagnostics: diagnostics,
    documents: { plugin: 'plugin.json' },
    entries: sortedEntries(entries),
    hookEntries: [],
  });
};

export const portableAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout: Object.freeze({
    assets: 'assets',
    cliBin: routedCliBinLayout,
    mcpApps: Object.freeze({ allowedSuffixes: Object.freeze(['.html']), directory: 'mcp-apps' }),
    mcpEntries: Object.freeze({ allowedSuffixes: Object.freeze(['.mjs']), directory: 'mcp' }),
    rootDocuments: Object.freeze(['INSTALL.md', 'install.mjs']),
    scripts: Object.freeze({ allowedSuffixes: Object.freeze(['.bash', '.mjs', '.py', '.sh']), directory: 'scripts' }),
    skills: 'skills',
  }),
  capabilities: Object.freeze({
    ...eventRouteCapabilitiesFrom(capabilityTable.eventRoutes, evidence),
    // The routed CLI bin is not an Agent Plugins component; like `scripts/`
    // it rides the plugin-root directory the standard's stdio MCP servers
    // already execute from (#387).
    [cliBinCapability]: supportedCapability(evidence),
    [webSurfaceCapability]: capabilityFromTableRow(capabilityTable.plugin.web, evidence),
    // Component feature sets (#100): the portable Skill document carries only
    // the Agent Skills fields and no interpolation placeholders.
    ...featureCapabilitiesFrom('skills', capabilityTable.plugin.skillFeatures, evidence),
    commands: unavailableCapability(
      'The portable Agent Plugin contract (1.0.0) defines only skills and MCP components; it has no commands surface.',
    ),
    extensionDirectories: unavailableCapability(capabilityTable.plugin.extensionDirectories.reason),
    hooks: unavailableCapability('Agent Plugins 1.0.0 does not define a hooks component.'),
    install: unavailableCapability(capabilityTable.install.reason),
    // Canonical component kinds outside the Agent Plugins 1.0.0 component set (#100).
    lsp: capabilityFromTableRow(capabilityTable.plugin.lsp, evidence),
    manifestExtensions: capabilityStateFromSupport(
      capabilityTable.plugin.extensions.state === 'supported',
      evidence,
      'Agent Plugins 1.0.0 does not define a manifest extensions field.',
    ),
    manifestMetadata: capabilityStateFromSupport(
      capabilityTable.plugin.manifestMetadata.state === 'supported',
      evidence,
      'Agent Plugins 1.0.0 does not define manifest metadata fields.',
    ),
    marketplace: unavailableCapability('Agent Plugins 1.0.0 does not define a marketplace document.'),
    mcp: capabilityStateFromSupport(
      capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
      evidence,
      'Agent Plugins 1.0.0 does not support both required modern MCP transports.',
    ),
    mcpLegacySse: unavailableCapability(capabilityTable.mcp.legacySse.reason),
    nativeDiagnostics: capabilityFromTableRow(capabilityTable.plugin.nativeDiagnostics, evidence),
    nativeExtension: capabilityFromTableRow(capabilityTable.plugin.nativeExtension, evidence),
    rules: unavailableCapability(
      'The portable Agent Plugin contract (1.0.0) defines only skills and MCP components; it has no rules surface.',
    ),
    skills: capabilityStateFromSupport(
      capabilityTable.plugin.skills,
      evidence,
      'Agent Plugins 1.0.0 does not support skills.',
    ),
  }),
  configExtension: Object.freeze({ key: portableName }),
  metadata,
  mcpRuntime,
  name: portableName,
  noticeDelivery: noticeDeliveryAdvertisementFrom(portableName, capabilityTable.noticeDelivery),
  plan,
});
