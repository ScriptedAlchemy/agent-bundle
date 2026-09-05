import type { TargetRegistry } from '../adapters/registry.ts';
import type { CompiledCliMode } from '../routes/types.ts';
import type {
  ArtifactManifest,
  ArtifactManifestApplication,
  ArtifactManifestBuiltInHost,
  ArtifactManifestMcpServer,
  ArtifactManifestProjectionDocuments,
} from './manifest.ts';
import { type ArtifactManifestReadResult, readArtifactManifest } from './manifest-file.ts';

/**
 * Resolves which host projection of a composite artifact should run an MCP
 * server. `--target` is optional: a single MCP-capable projection that hosts
 * the named server is enough; several require an explicit choice (#592 / #555).
 */

export interface ResolveManifestHostOptions {
  readonly capability: 'mcp';
  readonly requested?: string;
  readonly server?: string;
}

export type InspectManifestSummary = Readonly<{
  readonly application: ArtifactManifestApplication;
  readonly executables: {
    readonly bins: readonly string[];
    readonly hooks: number;
    readonly mcpServers: readonly {
      readonly hosts: readonly string[];
      readonly kind: ArtifactManifestMcpServer['kind'];
      readonly name: string;
    }[];
    readonly scripts: readonly string[];
  };
  readonly manifestVersion: number;
  readonly path: string;
  readonly projections: readonly {
    readonly builtInHost?: ArtifactManifestBuiltInHost;
    readonly documents: ArtifactManifestProjectionDocuments;
    readonly host: string;
  }[];
  readonly routes: {
    readonly cli: CompiledCliMode | undefined;
    readonly digest: string;
    readonly events: number;
    readonly scripts: number;
    readonly servers: number;
  };
}>;

export type InspectManifestInvalid = Readonly<{
  readonly detail: string;
  readonly path: string;
  readonly status: 'invalid';
}>;

export type InspectManifestOutput = InspectManifestInvalid | InspectManifestSummary;

const formatHosts = (hosts: readonly string[]): string => `[${hosts.join(', ')}]`;

const projectionHosts = (manifest: ArtifactManifest): readonly string[] =>
  manifest.projections.map((projection) => projection.host);

const mcpHostsForServer = (manifest: ArtifactManifest, server: string): ReadonlySet<string> => {
  const hosts = new Set<string>();
  for (const row of manifest.executables.mcpServers) {
    if (row.name === server) {
      for (const host of row.hosts) hosts.add(host);
    }
  }
  return hosts;
};

export const resolveManifestHost = (
  manifest: ArtifactManifest,
  options: ResolveManifestHostOptions,
  registry: TargetRegistry,
): string => {
  if (options.requested !== undefined) {
    const declared = projectionHosts(manifest);
    if (!declared.includes(options.requested)) {
      throw new Error(
        `The artifact declares projections ${formatHosts(declared)}; ${options.requested} is not among them.`,
      );
    }
    if (!registry.supports(options.requested, options.capability)) {
      throw new Error(`Unsupported MCP target ${JSON.stringify(options.requested)}.`);
    }
    return options.requested;
  }

  const serverHosts = options.server === undefined ? undefined : mcpHostsForServer(manifest, options.server);
  const candidates = projectionHosts(manifest).filter((host) => {
    if (!registry.supports(host, options.capability)) return false;
    return serverHosts === undefined || serverHosts.has(host);
  });
  if (candidates.length === 1) return candidates[0]!;
  const name = options.server ?? 'MCP';
  if (candidates.length === 0) {
    throw new Error(`No projection of this artifact runs MCP server ${name}.`);
  }
  throw new Error(
    `Choose --target: the artifact projects MCP server ${name} for ${formatHosts(candidates)}.`,
  );
};

export const resolveManifestMcpDocument = (
  manifest: ArtifactManifest,
  target: string,
  server: string,
  registry: TargetRegistry,
): string => {
  resolveManifestHost(manifest, { capability: 'mcp', requested: target }, registry);
  const projection = manifest.projections.find((candidate) => candidate.host === target)!;
  const document = projection.documents.mcp;
  if (document === undefined) {
    throw new Error(`The ${target} projection has no MCP document.`);
  }
  const matching = manifest.executables.mcpServers.filter((candidate) =>
    candidate.name === server && candidate.hosts.includes(target));
  // A shipped host's document is derived from the model, so every server it names
  // has a row; an advanced-registry adapter writes its own document and may name
  // servers the manifest never rowed — the document is then the only authority.
  if (matching.length > 1 || (matching.length === 0 && projection.builtInHost !== undefined)) {
    throw new Error(`Expected exactly one ${target} MCP server matching ${JSON.stringify(server)}.`);
  }
  return document;
};

export const requireArtifactManifest = (read: ArtifactManifestReadResult): ArtifactManifest => {
  switch (read.status) {
    case 'ok':
      return read.manifest;
    case 'missing':
      throw new Error(`No artifact manifest at ${read.path}.`);
    case 'invalid':
      throw new Error(read.detail);
    default: {
      const exhaustive: never = read;
      throw new TypeError(`Unhandled artifact manifest status ${String(exhaustive)}.`);
    }
  }
};

export const resolveManifestHostFromRoot = async (
  root: string,
  options: ResolveManifestHostOptions,
  registry: TargetRegistry,
): Promise<Readonly<{
  readonly host: string;
  readonly manifest: ArtifactManifest;
  readonly path: string;
}>> => {
  const read = await readArtifactManifest(root);
  const manifest = requireArtifactManifest(read);
  return Object.freeze({
    host: resolveManifestHost(manifest, options, registry),
    manifest,
    path: read.path,
  });
};

export const inspectManifestSummary = (
  manifest: ArtifactManifest,
  path: string,
): InspectManifestSummary => Object.freeze({
  application: manifest.application,
  executables: Object.freeze({
    bins: Object.freeze(manifest.executables.bins.map((bin) => bin.name)),
    hooks: manifest.executables.hooks.length,
    mcpServers: Object.freeze(manifest.executables.mcpServers.map((server) => Object.freeze({
      hosts: server.hosts,
      kind: server.kind,
      name: server.name,
    }))),
    scripts: Object.freeze(manifest.executables.scripts.map((script) => script.name)),
  }),
  manifestVersion: manifest.manifestVersion,
  path,
  projections: Object.freeze(manifest.projections.map((projection) => Object.freeze({
    ...(projection.builtInHost === undefined ? {} : { builtInHost: projection.builtInHost }),
    documents: projection.documents,
    host: projection.host,
  }))),
  routes: Object.freeze({
    cli: manifest.routes.cli?.mode,
    digest: manifest.routes.digest,
    events: manifest.routes.events.length,
    scripts: manifest.routes.scripts.length,
    servers: manifest.routes.servers.length,
  }),
});

export const inspectManifestOutput = (read: ArtifactManifestReadResult): InspectManifestOutput | undefined => {
  switch (read.status) {
    case 'missing':
      return undefined;
    case 'invalid':
      return Object.freeze({ detail: read.detail, path: read.path, status: 'invalid' });
    case 'ok':
      return inspectManifestSummary(read.manifest, read.path);
    default: {
      const exhaustive: never = read;
      throw new TypeError(`Unhandled artifact manifest status ${String(exhaustive)}.`);
    }
  }
};
