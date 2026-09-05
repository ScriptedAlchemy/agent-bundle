import type {
  ArtifactManifest,
  ArtifactManifestDistributionChannel,
  ArtifactManifestRoute,
} from '../../build/manifest.ts';
import { deepFreeze } from '../../core/freeze.ts';

/**
 * The browser contract for the Workbench application tree.
 *
 * This deliberately projects the manifest into the concepts a person explores.
 * Add a manifest field here only when a Workbench page renders that field.
 */
export interface ApplicationExplorer {
  readonly cli?: ApplicationExplorerCli;
  readonly distribution: ApplicationExplorerDistribution;
  readonly events: readonly ApplicationExplorerEvent[];
  readonly hooks: readonly ApplicationExplorerHookGroup[];
  readonly hosts: readonly ApplicationExplorerHost[];
  readonly identity: ApplicationExplorerIdentity;
  readonly scripts: readonly ApplicationExplorerScript[];
  readonly servers: readonly ApplicationExplorerServer[];
}

export interface ApplicationExplorerIdentity {
  readonly description?: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export interface ApplicationExplorerDocument {
  readonly kind: 'hooks' | 'marketplace' | 'mcp' | 'plugin';
  readonly path: string;
}

export interface ApplicationExplorerHost {
  readonly builtIn: boolean;
  readonly documents: readonly ApplicationExplorerDocument[];
  readonly host: string;
  readonly marketplace?: string;
}

export interface ApplicationExplorerRoute {
  readonly description?: string;
  readonly id: string;
  readonly name: string;
}

export interface ApplicationExplorerApp {
  readonly id: string;
  readonly name: string;
  readonly path?: string;
  readonly resourceUri: string;
}

export interface ApplicationExplorerServer {
  readonly apps: readonly ApplicationExplorerApp[];
  readonly entry?: string;
  readonly hosts: readonly string[];
  readonly id: string;
  readonly kind: 'command' | 'compiled' | 'prebuilt' | 'remote';
  readonly name: string;
  readonly prompts: readonly ApplicationExplorerRoute[];
  readonly resources: readonly ApplicationExplorerRoute[];
  readonly tools: readonly ApplicationExplorerRoute[];
  readonly transport: string;
}

export interface ApplicationExplorerEventHook {
  readonly host: string;
  readonly kind: 'event-route';
  readonly path: string;
  readonly timeout?: number;
}

export interface ApplicationExplorerEvent {
  readonly event: string;
  readonly hooks: readonly ApplicationExplorerEventHook[];
  readonly id: string;
  readonly preflight?: string;
  readonly providers?: readonly string[];
}

export interface ApplicationExplorerConfigHook {
  readonly event: string;
  readonly id: string;
  readonly kind: 'config';
  readonly name: string;
  readonly path: string;
  readonly timeout?: number;
}

export interface ApplicationExplorerHookGroup {
  readonly hooks: readonly ApplicationExplorerConfigHook[];
  readonly host: string;
}

export interface ApplicationExplorerCliCommand {
  readonly path: readonly string[];
  readonly routeId: string;
}

export interface ApplicationExplorerBin {
  readonly hosts: readonly string[];
  readonly name: string;
  readonly path: string;
}

export interface ApplicationExplorerCli {
  readonly bins: readonly ApplicationExplorerBin[];
  readonly commands: readonly ApplicationExplorerCliCommand[];
  readonly mode: 'conflict' | 'conventional' | 'generated';
}

export interface ApplicationExplorerScript {
  readonly hosts: readonly string[];
  readonly id: string;
  readonly mode: 'bundle' | 'copy';
  readonly name: string;
  readonly path: string;
}

export interface ApplicationExplorerInstall {
  readonly instructions?: string;
  readonly script?: string;
}

export interface ApplicationExplorerPayload {
  readonly hosts: readonly string[];
  readonly name: string;
  readonly runtimeDependencies: readonly string[];
}

export interface ApplicationExplorerDistribution {
  readonly channels: readonly ArtifactManifestDistributionChannel[];
  readonly install?: ApplicationExplorerInstall;
  readonly payloads: readonly ApplicationExplorerPayload[];
}

const documentKinds = ['hooks', 'marketplace', 'mcp', 'plugin'] as const;

const byId = <Value extends { readonly id: string }>(left: Value, right: Value): number =>
  left.id.localeCompare(right.id);

const routeForExplorer = (route: ArtifactManifestRoute): ApplicationExplorerRoute => ({
  ...(route.description === undefined ? {} : { description: route.description }),
  id: route.id,
  name: route.id,
});

const hostsFor = (manifest: ArtifactManifest): ApplicationExplorerHost[] =>
  manifest.projections
    .map((projection): ApplicationExplorerHost => ({
      builtIn: projection.builtInHost !== undefined,
      documents: documentKinds
        .flatMap((kind): ApplicationExplorerDocument[] => {
          const path = projection.documents[kind];
          return path === undefined ? [] : [{ kind, path }];
        })
        .sort((left, right) => left.kind.localeCompare(right.kind)),
      host: projection.host,
      ...(projection.marketplace === undefined ? {} : { marketplace: projection.marketplace.name }),
    }))
    .sort((left, right) => left.host.localeCompare(right.host));

const serversFor = (manifest: ArtifactManifest): ApplicationExplorerServer[] => {
  const routesByServer = new Map(manifest.routes.servers.map((server) => [server.id, server]));
  return manifest.executables.mcpServers
    .map((executable): ApplicationExplorerServer => {
      // A server the route graph never compiled routes for (a prebuilt or remote
      // server) is still a process the root runs; it simply has no route rows.
      const server = routesByServer.get(executable.id);
      const tools: ApplicationExplorerRoute[] = [];
      const resources: ApplicationExplorerRoute[] = [];
      const prompts: ApplicationExplorerRoute[] = [];
      for (const route of server?.routes ?? []) {
        switch (route.kind) {
          case 'tool':
            tools.push(routeForExplorer(route));
            break;
          case 'resource':
            resources.push(routeForExplorer(route));
            break;
          case 'prompt':
            prompts.push(routeForExplorer(route));
            break;
          case 'app':
            break;
          case 'cli':
          case 'event-route':
          case 'script':
            throw new TypeError(`Application explorer server route ${JSON.stringify(route.id)} has invalid kind ${JSON.stringify(route.kind)}.`);
          default: {
            const exhaustive: never = route.kind;
            throw new TypeError(`Application explorer route kind ${String(exhaustive)} is unknown.`);
          }
        }
      }
      return {
        apps: executable.apps
          .map((app): ApplicationExplorerApp => ({
            id: app.id,
            name: app.name,
            ...(app.path === undefined ? {} : { path: app.path }),
            resourceUri: app.resourceUri,
          }))
          .sort(byId),
        ...(executable.launch === undefined ? {} : { entry: executable.launch.entry }),
        hosts: [...executable.hosts].sort((left, right) => left.localeCompare(right)),
        id: executable.id,
        kind: executable.kind,
        name: executable.name,
        prompts: prompts.sort(byId),
        resources: resources.sort(byId),
        tools: tools.sort(byId),
        transport: executable.transport,
      };
    })
    .sort(byId);
};

const eventsFor = (manifest: ArtifactManifest): ApplicationExplorerEvent[] =>
  manifest.routes.events
    .map((event): ApplicationExplorerEvent => ({
      event: event.event ?? event.id,
      hooks: manifest.executables.hooks
        .filter((hook) => hook.kind === 'event-route' && hook.routeId === event.id)
        .map((hook): ApplicationExplorerEventHook => ({
          host: hook.host,
          kind: 'event-route',
          path: hook.path,
          ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
        }))
        .sort((left, right) => left.host === right.host
          ? left.path.localeCompare(right.path)
          : left.host.localeCompare(right.host)),
      id: event.id,
      ...(event.execution?.preflight === undefined ? {} : { preflight: event.execution.preflight }),
      ...(event.execution?.providers === undefined ? {} : { providers: [...event.execution.providers] }),
    }))
    .sort(byId);

const configHooksFor = (manifest: ArtifactManifest): ApplicationExplorerHookGroup[] => {
  const hooksByHost = new Map<string, ApplicationExplorerConfigHook[]>();
  for (const hook of manifest.executables.hooks) {
    if (hook.kind !== 'config') continue;
    const hooks = hooksByHost.get(hook.host) ?? [];
    hooks.push({
      event: hook.event,
      id: hook.id,
      kind: 'config',
      name: hook.name,
      path: hook.path,
      ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
    });
    hooksByHost.set(hook.host, hooks);
  }
  return [...hooksByHost.entries()]
    .map(([host, hooks]): ApplicationExplorerHookGroup => ({
      hooks: hooks.sort(byId),
      host,
    }))
    .sort((left, right) => left.host.localeCompare(right.host));
};

const cliFor = (manifest: ArtifactManifest): ApplicationExplorerCli | undefined => {
  const cli = manifest.routes.cli;
  if (cli === undefined) return undefined;
  return {
    bins: manifest.executables.bins
      .map((bin): ApplicationExplorerBin => ({
        hosts: [...bin.hosts].sort((left, right) => left.localeCompare(right)),
        name: bin.name,
        path: bin.path,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    commands: (cli.commands ?? [])
      .map((command): ApplicationExplorerCliCommand => ({
        path: [...command.path],
        routeId: command.routeId,
      }))
      .sort((left, right) => left.path.join(' ').localeCompare(right.path.join(' '))),
    mode: cli.mode,
  };
};

/**
 * Builds the small immutable application tree consumed by the Workbench.
 * Operational compiler, validation, schema, provenance, and file facts stay
 * outside this projection.
 */
export const applicationExplorerFor = (manifest: ArtifactManifest): ApplicationExplorer => {
  const cli = cliFor(manifest);
  return deepFreeze({
    ...(cli === undefined ? {} : { cli }),
    distribution: {
      channels: [...manifest.distribution.channels].sort((left, right) => left.localeCompare(right)),
      ...(manifest.distribution.install === undefined
        ? {}
        : {
          install: {
            ...(manifest.distribution.install.instructions === undefined
              ? {}
              : { instructions: manifest.distribution.install.instructions }),
            ...(manifest.distribution.install.script === undefined
              ? {}
              : { script: manifest.distribution.install.script }),
          },
        }),
      payloads: [...manifest.distribution.payloads]
        .map((payload): ApplicationExplorerPayload => ({
          hosts: [...payload.hosts].sort((left, right) => left.localeCompare(right)),
          name: payload.name,
          runtimeDependencies: [...payload.runtimeDependencies]
            .sort((left, right) => left.localeCompare(right)),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    },
    events: eventsFor(manifest),
    hooks: configHooksFor(manifest),
    hosts: hostsFor(manifest),
    identity: {
      ...(manifest.application.description === undefined
        ? {}
        : { description: manifest.application.description }),
      id: manifest.application.id,
      name: manifest.application.name,
      version: manifest.application.version,
    },
    scripts: manifest.executables.scripts
      .map((script): ApplicationExplorerScript => ({
        hosts: [...script.hosts].sort((left, right) => left.localeCompare(right)),
        id: script.id,
        mode: script.mode,
        name: script.name,
        path: script.path,
      }))
      .sort(byId),
    servers: serversFor(manifest),
  });
};
