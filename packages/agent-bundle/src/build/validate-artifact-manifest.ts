import { resolve } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import type { TargetArtifactLayout, TargetArtifactOutputLayout } from '../adapters/types.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { isPlainRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { readFileString, runWithPlatform } from '../effect/platform.ts';
import { artifactDiagnostic as diagnostic } from './artifact-diagnostics.ts';
import type { ValidatedArtifactMcpServerEvidence } from './artifact-validation-types.ts';
import { isDirectOutputLayoutPath } from './artifact-layout.ts';
import {
  artifactManifestName,
  type ArtifactManifest,
  type ArtifactManifestMcpServer,
  type ArtifactManifestProjection,
  type ArtifactManifestProjectionDocuments,
} from './manifest.ts';

/**
 * The manifest coherence lane of the artifact validator (#592 step 3): what
 * the manifest parser cannot know because it needs the adapter registry or
 * the tree. `AB6039` proves the manifest's own sections agree with each
 * other and with the layouts and documents the selected hosts read; `AB6040`
 * proves each host document repeats the manifest's application identity.
 * Both codes are `error` severity because a consumer acting on the manifest
 * would install or launch something the tree does not contain.
 *
 * The lane runs only after the manifest parsed (`AB6001`) and the file table
 * verified (`AB6004`), so every document it reads holds exactly the bytes the
 * manifest hashed and no finding here restates that drift.
 */

interface CoherenceOptions {
  readonly artifactRoot: string;
  readonly manifest: ArtifactManifest;
  /** The servers the MCP lane read from each host document — one read per document, shared with this lane. */
  readonly mcpEvidence: readonly ValidatedArtifactMcpServerEvidence[];
  /** Hosts whose MCP document the MCP lane already faulted (`AB6006`/`AB6017`); their rows are not re-judged here. */
  readonly mcpUnprovenHosts: ReadonlySet<string>;
  readonly registry: TargetRegistry;
}

type OutputLayoutName = keyof Pick<TargetArtifactLayout, 'cliBin' | 'mcpApps' | 'mcpEntries' | 'scripts'>;

const layoutLabels: Readonly<Record<OutputLayoutName, string>> = Object.freeze({
  cliBin: 'routed CLI bin',
  mcpApps: 'MCP App',
  mcpEntries: 'MCP entry',
  scripts: 'script',
});

const describeLayout = (layout: TargetArtifactOutputLayout): string =>
  layout.allowedSuffixes.length === 1
    ? `${layout.directory}/*${layout.allowedSuffixes[0]}`
    : `${layout.directory}/*{${layout.allowedSuffixes.join(',')}}`;

/**
 * Every executable pointer must be a direct file of the namespace the row's
 * host declares for that kind of output: `bins[]` in `cliBin`, `scripts[]` in
 * `scripts`, `mcpServers[].entry` in `mcpEntries`, and `mcpServers[].apps[]`
 * in `mcpApps`. Hook wrappers are proven by `AB6018`, which already holds
 * every `executables.hooks[]` row to its host's `hookWrappers` layout.
 */
const executableLayoutDiagnostics = (
  manifest: ArtifactManifest,
  registry: TargetRegistry,
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const check = (
    hosts: readonly string[],
    layoutName: OutputLayoutName,
    location: string,
    path: string | undefined,
  ): void => {
    if (path === undefined) return;
    for (const host of hosts) {
      // Unknown hosts are AB6009; without their contract there is no layout to judge against.
      if (!registry.has(host)) continue;
      const layout = registry.artifactLayout(host)[layoutName];
      if (layout !== undefined && isDirectOutputLayoutPath(path, layout)) continue;
      const detail = layout === undefined
        ? `host ${JSON.stringify(host)} declares no ${layoutLabels[layoutName]} layout`
        : `${JSON.stringify(path)} is not ${describeLayout(layout)}`;
      diagnostics.push(diagnostic(
        'AB6039',
        `Manifest ${location} lies outside the ${layoutLabels[layoutName]} layout of host ${JSON.stringify(host)} (${detail}).`,
        path,
        host,
      ));
    }
  };

  const { bins, mcpServers, scripts } = manifest.executables;
  for (const bin of bins) {
    check(bin.hosts, 'cliBin', `executables.bins[${bin.name}].path`, bin.path);
    check(bin.hosts, 'cliBin', `executables.bins[${bin.name}].worker`, bin.worker);
  }
  for (const server of mcpServers) {
    check(server.hosts, 'mcpEntries', `executables.mcpServers[${server.id}].entry.path`, server.entry?.path);
    check(server.hosts, 'mcpEntries', `executables.mcpServers[${server.id}].entry.worker`, server.entry?.worker);
    for (const app of server.apps) {
      check(server.hosts, 'mcpApps', `executables.mcpServers[${server.id}].apps[${app.id}].path`, app.path);
    }
  }
  for (const script of scripts) {
    check(script.hosts, 'scripts', `executables.scripts[${script.id}].path`, script.path);
    check(script.hosts, 'scripts', `executables.scripts[${script.id}].worker`, script.worker);
  }
  return diagnostics;
};

/**
 * A route-generated MCP server (`routes.servers[]` in `generated` mode with
 * at least one route) always compiles to an entry the artifact starts, so
 * the `executables.mcpServers[]` row sharing its id must be `compiled` and
 * carry the same name. Absence is not compared: a generated server whose
 * declared `targets` miss every selected host legitimately has no row. The
 * `custom`, `command`, and `remote` modes are author overrides whose row kind
 * follows the config declaration, and `conflict` never survives a build
 * (`AB4800`), so none of them is compared.
 */
const routeServerDiagnostics = (manifest: ArtifactManifest): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const rows = new Map(manifest.executables.mcpServers.map((server) => [server.id, server]));
  for (const server of manifest.routes.servers) {
    if (server.mode !== 'generated' || server.routes.length === 0) continue;
    const row = rows.get(server.id);
    if (row === undefined) continue;
    if (row.kind !== 'compiled') {
      diagnostics.push(diagnostic(
        'AB6039',
        `Manifest executables.mcpServers[${row.id}] is a ${row.kind} server, but routes.servers[${server.id}] is a generated server (generated servers compile to an entry the artifact starts).`,
        artifactManifestName,
      ));
    }
    if (row.name !== server.name) {
      diagnostics.push(diagnostic(
        'AB6039',
        `Manifest executables.mcpServers[${row.id}] is named ${JSON.stringify(row.name)}, but routes.servers[${server.id}] is named ${JSON.stringify(server.name)} (one server, two names).`,
        artifactManifestName,
      ));
    }
  }
  return diagnostics;
};

/** The document's strict JSON value, or undefined when it is not strict JSON. */
const readStrictJson = async (artifactRoot: string, path: string): Promise<unknown> => {
  try {
    return parseJsonWithoutDuplicateKeys(await runWithPlatform(readFileString(resolve(artifactRoot, path))));
  } catch {
    return undefined;
  }
};

/**
 * AB6039 for one selected host's MCP surface: the manifest's `documents.mcp`
 * pointer must name the document the host actually reads, and that document
 * must declare exactly the servers whose rows list the host, each with the
 * transport its row records. The declared servers come from the MCP lane's
 * evidence, so a host document is read once per validation; documents that
 * lane already faulted (`AB6006`/`AB6017`) are not re-reported here.
 */
const mcpDocumentDiagnostics = (
  options: CoherenceOptions,
  projection: ArtifactManifestProjection,
  rows: readonly ArtifactManifestMcpServer[],
): readonly Diagnostic[] => {
  const host = projection.host;
  const diagnostics: Diagnostic[] = [];
  const runtime = options.registry.mcpRuntime(host);
  if (runtime === undefined) {
    for (const row of rows) {
      diagnostics.push(diagnostic(
        'AB6039',
        `Manifest executables.mcpServers[${row.id}] lists host ${JSON.stringify(host)}, which does not support MCP (the adapter declares no MCP runtime contract).`,
        artifactManifestName,
        host,
      ));
    }
    return diagnostics;
  }
  const documentPath = projection.documents.mcp;
  if (documentPath === undefined) {
    for (const row of rows) {
      diagnostics.push(diagnostic(
        'AB6039',
        `Manifest executables.mcpServers[${row.id}] lists host ${JSON.stringify(host)}, whose projection has no MCP document (projections[${host}].documents.mcp is absent).`,
        artifactManifestName,
        host,
      ));
    }
    return diagnostics;
  }
  if (documentPath !== runtime.manifestPath) {
    diagnostics.push(diagnostic(
      'AB6039',
      `Manifest projections[${host}].documents.mcp names ${JSON.stringify(documentPath)}, which host ${JSON.stringify(host)} never reads (its MCP document is ${JSON.stringify(runtime.manifestPath)}).`,
      documentPath,
      host,
    ));
    return diagnostics;
  }
  if (options.mcpUnprovenHosts.has(host)) return diagnostics;
  const declared = new Map(options.mcpEvidence
    .filter((server) => server.target === host)
    .map((server) => [server.name, server]));
  const listed = new Set(rows.map((row) => row.name));
  // Every row must be in the host document. The converse — every declared
  // server has a row — holds for the shipped hosts, whose documents the
  // framework derives from the model; an advanced-registry adapter writes its
  // own document and may declare servers the model never named (#578: judged
  // by adapter identity, not by name).
  const derivedDocument = projection.builtInHost !== undefined;
  for (const [name] of declared) {
    if (!derivedDocument || listed.has(name)) continue;
    diagnostics.push(diagnostic(
      'AB6039',
      `Manifest executables.mcpServers has no row listing host ${JSON.stringify(host)} for MCP server ${JSON.stringify(name)} (${JSON.stringify(documentPath)} declares it).`,
      documentPath,
      host,
    ));
  }
  for (const row of rows) {
    const server = declared.get(row.name);
    if (server === undefined) {
      diagnostics.push(diagnostic(
        'AB6039',
        `Manifest executables.mcpServers[${row.id}] lists host ${JSON.stringify(host)}, whose MCP document lacks server ${JSON.stringify(row.name)} (${JSON.stringify(documentPath)}).`,
        documentPath,
        host,
      ));
      continue;
    }
    if (server.kind !== row.transport) {
      diagnostics.push(diagnostic(
        'AB6039',
        `Manifest executables.mcpServers[${row.id}] records transport ${JSON.stringify(row.transport)}, but host ${JSON.stringify(host)} runs ${JSON.stringify(row.name)} as ${JSON.stringify(server.kind)} (${JSON.stringify(documentPath)}).`,
        documentPath,
        host,
      ));
    }
  }
  return diagnostics;
};

/**
 * AB6039 for the projections: each derived-document pointer names the
 * document its host's contract reads, and the MCP document and the
 * `executables.mcpServers[]` rows describe the same servers.
 */
const projectionDiagnostics = async (options: CoherenceOptions): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  for (const projection of options.manifest.projections) {
    const host = projection.host;
    // Unknown hosts are AB6009; without their contract there is nothing to compare against.
    if (!options.registry.has(host)) continue;
    // The recorded adapter identity is what a consumer holding only the manifest
    // keys on (`install`, `doctor`, the installed harness); it must be the
    // identity the registry assigns the adapter under this name.
    const builtInHost = options.registry.builtInHost(host);
    if (projection.builtInHost !== builtInHost) {
      diagnostics.push(diagnostic(
        'AB6039',
        `Manifest projections[${host}].builtInHost records ${JSON.stringify(projection.builtInHost)}, but the adapter registered under ${JSON.stringify(host)} is ${
          builtInHost === undefined ? 'not a shipped adapter' : `the shipped ${JSON.stringify(builtInHost)} adapter`
        }.`,
        artifactManifestName,
        host,
      ));
      continue;
    }
    const contractDocuments = options.registry.artifactValidation(host).documents;
    const contractPath = (schema: string): string | undefined =>
      contractDocuments.find((document) => document.schema === schema)?.path;
    // `documents.mcp` is judged by `mcpDocumentDiagnostics` against the MCP runtime contract.
    const pointers: readonly (readonly [Exclude<keyof ArtifactManifestProjectionDocuments, 'mcp'>, string | undefined, string])[] = [
      ['hooks', options.registry.hookContract(host)?.manifestPath, 'hooks'],
      ['marketplace', contractPath('marketplace'), 'marketplace'],
      ['plugin', contractPath('plugin'), 'plugin'],
    ];
    for (const [key, expected, label] of pointers) {
      const declared = projection.documents[key];
      if (declared === undefined || declared === expected) continue;
      diagnostics.push(diagnostic(
        'AB6039',
        `Manifest projections[${host}].documents.${key} names ${JSON.stringify(declared)}, which host ${JSON.stringify(host)} never reads (${
          expected === undefined ? `the host has no ${label} document` : `its ${label} document is ${JSON.stringify(expected)}`
        }).`,
        declared,
        host,
      ));
    }
    const rows = options.manifest.executables.mcpServers.filter((server) => server.hosts.includes(host));
    diagnostics.push(...mcpDocumentDiagnostics(options, projection, rows));
  }
  return diagnostics;
};

interface IdentityField {
  /** The manifest location the document field must repeat. */
  readonly location: string;
  readonly expected: string;
  /** The top-level key of the host document. */
  readonly key: string;
}

const unprovableIdentity = (host: string, path: string, subject: string): Diagnostic => diagnostic(
  'AB6040',
  `Host document ${JSON.stringify(path)} is not a strict JSON object, so the ${subject} it declares for projection ${JSON.stringify(host)} cannot be proven against the manifest.`,
  path,
  host,
);

const identityFieldDiagnostics = (
  host: string,
  path: string,
  document: Readonly<Record<string, unknown>>,
  fields: readonly IdentityField[],
): readonly Diagnostic[] => fields.flatMap((field) => {
  const actual = document[field.key];
  if (actual === field.expected) return [];
  const declares = typeof actual === 'string'
    ? `declares ${field.key} ${JSON.stringify(actual)}`
    : `declares no string ${JSON.stringify(field.key)}`;
  return [diagnostic(
    'AB6040',
    `Host document ${JSON.stringify(path)} ${declares}, but the manifest ${field.location} is ${JSON.stringify(field.expected)}.`,
    path,
    host,
  )];
});

/**
 * AB6040: every host plugin manifest repeats `application.name` and
 * `application.version`, and every marketplace document registers exactly
 * the marketplace name its projection records. The parser already refuses a
 * declared marketplace without a document pointer; the reverse — a document
 * the projection does not account for — is proven here.
 */
const identityDiagnostics = async (options: CoherenceOptions): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const { application } = options.manifest;
  for (const projection of options.manifest.projections) {
    const { documents, host } = projection;
    if (documents.plugin !== undefined) {
      const document = await readStrictJson(options.artifactRoot, documents.plugin);
      if (!isPlainRecord(document)) {
        diagnostics.push(unprovableIdentity(host, documents.plugin, 'application identity'));
      } else {
        diagnostics.push(...identityFieldDiagnostics(host, documents.plugin, document, [
          { expected: application.name, key: 'name', location: 'application.name' },
          { expected: application.version, key: 'version', location: 'application.version' },
        ]));
      }
    }
    if (documents.marketplace === undefined) continue;
    if (projection.marketplace === undefined) {
      diagnostics.push(diagnostic(
        'AB6040',
        `Host document ${JSON.stringify(documents.marketplace)} registers a marketplace, but the manifest records none for projection ${JSON.stringify(host)} (projections[${host}].marketplace is absent).`,
        documents.marketplace,
        host,
      ));
      continue;
    }
    const document = await readStrictJson(options.artifactRoot, documents.marketplace);
    if (!isPlainRecord(document)) {
      diagnostics.push(unprovableIdentity(host, documents.marketplace, 'marketplace name'));
      continue;
    }
    diagnostics.push(...identityFieldDiagnostics(host, documents.marketplace, document, [
      { expected: projection.marketplace.name, key: 'name', location: `projections[${host}].marketplace.name` },
    ]));
  }
  return diagnostics;
};

/**
 * Proves the parsed manifest against the adapter registry and the host
 * documents of the verified tree: `AB6039` for section coherence, `AB6040`
 * for host-document identity. Call it only over a manifest whose file table
 * matched the tree.
 */
export const validateManifestCoherence = async (
  options: CoherenceOptions,
): Promise<readonly Diagnostic[]> => Object.freeze([
  ...executableLayoutDiagnostics(options.manifest, options.registry),
  ...routeServerDiagnostics(options.manifest),
  ...await projectionDiagnostics(options),
  ...await identityDiagnostics(options),
]);
