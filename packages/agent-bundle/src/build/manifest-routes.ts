import type {
  CompiledAgentRoute,
  CompiledCliCommand,
  CompiledCliOption,
  CompiledCliSurface,
  CompiledLayout,
  CompiledProvider,
  CompiledRouteGraph,
  CompiledServerSurface,
  RouteContract,
} from '../routes/types.ts';
import type {
  ArtifactManifestCli,
  ArtifactManifestCliCommand,
  ArtifactManifestCliOption,
  ArtifactManifestLayout,
  ArtifactManifestProvider,
  ArtifactManifestRoute,
  ArtifactManifestRouteContract,
  ArtifactManifestRoutes,
  ArtifactManifestServer,
} from './manifest.ts';

/**
 * Projects the compiled route graph into the manifest's `routes` section
 * (#592 step 3, gap 1). The same rows feed the Workbench route catalog
 * (`dev/routes/route-manifest.ts`), which adds its display-only fields on
 * top; the build and the browser therefore read one projection of one
 * compiler pass, never two discoveries.
 */

const byId = <Row extends { readonly id: string }>(rows: readonly Row[]): readonly Row[] =>
  [...rows].sort((left, right) => left.id.localeCompare(right.id));

/** `config.description` when it is a non-blank string. */
export const routeDescription = (config: Readonly<Record<string, unknown>>): string | undefined => {
  const value = config['description'];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
};

export const artifactRouteFor = (route: CompiledAgentRoute): ArtifactManifestRoute => {
  const summary = routeDescription(route.config);
  return {
    ...(route.contract === undefined ? {} : { contract: route.contract }),
    ...(summary === undefined ? {} : { description: summary }),
    ...(route.event === undefined ? {} : { event: route.event }),
    id: route.id,
    ...(route.inputSchema === undefined ? {} : { inputSchema: route.inputSchema }),
    kind: route.kind,
    provenance: { kind: route.provenance.kind },
    ...(route.serverId === undefined ? {} : { serverId: route.serverId }),
    source: route.provenance.relativePath,
  };
};

export const artifactCliOptionFor = (option: CompiledCliOption): ArtifactManifestCliOption => ({
  ...(option.choices === undefined ? {} : { choices: [...option.choices] }),
  ...(option.description === undefined ? {} : { description: option.description }),
  key: option.key,
  kind: option.kind,
  option: option.option,
  ...(option.positional === undefined ? {} : { positional: option.positional }),
  repeated: option.repeated,
  required: option.required,
});

/** One command in compiler order; {@link artifactRoutesFor} sorts the manifest copy by its sort keys. */
export const artifactCliCommandFor = (command: CompiledCliCommand): ArtifactManifestCliCommand => ({
  aliases: [...command.aliases],
  ...(command.description === undefined ? {} : { description: command.description }),
  exitCode: command.exitCode,
  ...(command.mcp === undefined ? {} : { mcp: { ...command.mcp } }),
  options: command.options.map(artifactCliOptionFor),
  path: [...command.path],
  routeId: command.routeId,
});

const sortedCliCommand = (command: ArtifactManifestCliCommand): ArtifactManifestCliCommand => ({
  ...command,
  aliases: [...command.aliases].sort((left, right) => left.localeCompare(right)),
  options: [...command.options].sort((left, right) => left.key.localeCompare(right.key)),
});

export const artifactProviderFor = (provider: CompiledProvider): ArtifactManifestProvider => ({
  id: provider.id,
  name: provider.name,
  source: provider.provenance.relativePath,
});

export const artifactLayoutFor = (layout: CompiledLayout): ArtifactManifestLayout => ({
  id: layout.id,
  scope: layout.scope,
  ...(layout.serverId === undefined ? {} : { serverId: layout.serverId }),
  source: layout.provenance.relativePath,
});

const artifactServerFor = (server: CompiledServerSurface): ArtifactManifestServer => ({
  id: server.id,
  mode: server.mode,
  name: server.name,
  routes: byId(server.routes.map(artifactRouteFor)),
});

const artifactCliFor = (cli: CompiledCliSurface): ArtifactManifestCli => ({
  ...(cli.commands === undefined
    ? {}
    : {
      commands: cli.commands.map((command) => sortedCliCommand(artifactCliCommandFor(command)))
        .sort((left, right) => left.path.join(' ').localeCompare(right.path.join(' '))),
    }),
  mode: cli.mode,
  routes: byId(cli.routes.map(artifactRouteFor)),
});

/** One route contract row (#593): the compiler's contract with its sorted bound route ids. */
export const artifactRouteContractFor = (contract: RouteContract): ArtifactManifestRouteContract => ({
  id: contract.id,
  input: contract.input,
  origin: { binding: contract.origin.binding, module: contract.origin.module },
  routes: [...contract.routes].sort((left, right) => left.localeCompare(right)),
});

/** The manifest `routes` section for one compiled graph; arrays are sorted by their manifest sort keys. */
export const artifactRoutesFor = (graph: CompiledRouteGraph): ArtifactManifestRoutes => ({
  ...(graph.cli === undefined ? {} : { cli: artifactCliFor(graph.cli) }),
  ...(graph.contracts === undefined ? {} : { contracts: byId(graph.contracts.map(artifactRouteContractFor)) }),
  digest: graph.digest,
  events: byId(graph.events.map(artifactRouteFor)),
  layouts: byId((graph.layouts ?? []).map(artifactLayoutFor)),
  providers: byId(graph.providers.map(artifactProviderFor)),
  scripts: byId(graph.scripts.map(artifactRouteFor)),
  servers: byId(graph.servers.map(artifactServerFor)),
});
