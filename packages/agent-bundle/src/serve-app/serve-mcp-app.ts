import { Context, Effect, Layer, type Scope } from 'effect';

import type { TargetRegistry } from '../adapters/registry.ts';
import type { ServedMcpApp, ServeMcpAppPublicOptions } from './types.ts';
import { makeScopedEffectRuntime } from '../effect/boundary.ts';
import { liftPromise, liftTry } from '../effect/lift.ts';
import { resolveMcpLaunchEnvironment, type McpLaunchEnvironmentOptions } from '../services/mcp-run.ts';
import { startWebHost, validPort, validProfile, type WebHost } from '../web-host/host-server.ts';
import { readWebHostPageScript } from '../web-host/page-script.ts';
import { appNameOf, openApp, parseAppSelector } from '../web-host/select-app.ts';
import { openStdioAppSession } from '../web-host/session.ts';

/**
 * `agent-bundle serve-app`: one built MCP App, served standalone in a browser
 * over a bound session to the plugin's own packed MCP server.
 *
 * The host itself is the framework's shared web host (`web-host/*`): the same
 * stdio session, App selection, loopback HTTP host, and page a generated
 * plugin's `<plugin> web` command runs from its bin. What is specific to this
 * module is the framework side — validating the operator's options,
 * resolving (or building) the artifact and its launch environment exactly as
 * `mcp run` does, and reading the built page script from the package — and
 * the Effect scope that owns every acquired resource: `close()` finalizes it
 * once, newest resource first (the web host, then the MCP session, then a
 * throwaway artifact).
 */

export type { McpAppConsentCapability, ServedMcpApp, ServeMcpAppPublicOptions } from './types.ts';

export interface ServeMcpAppOptions extends ServeMcpAppPublicOptions, Omit<McpLaunchEnvironmentOptions, 'artifact' | 'registry' | 'server'> {
  /** The MCP App to serve: `<server>/<app>`, or `<server>/ui://...` for an exact resource URI. */
  readonly app: string;
  /**
   * A built artifact root, or an Effect that acquires one into the served
   * App's scope (a throwaway build removed on `close()`).
   */
  readonly artifact: string | Effect.Effect<string, unknown, Scope.Scope>;
  readonly registry?: TargetRegistry;
}

const defaultTimeoutMs = 30_000;

class ServedMcpAppService extends Context.Service<ServedMcpAppService, WebHost>()(
  'agent-bundle/serve-app/ServedMcpAppService',
) {}

const serveProgram = (options: ServeMcpAppOptions): Effect.Effect<WebHost, unknown, Scope.Scope> => Effect.gen(function* () {
  const port = yield* liftTry(() => validPort(options.port));
  const profile = yield* liftTry(() => validProfile(options.profile));
  const requestedApp = yield* liftTry(() => parseAppSelector(options.app));
  const autoApprove = Object.freeze([...(options.autoApprove ?? [])]);
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  // Before any build or launch: a package without its page cannot host anything.
  const pageScript = yield* liftPromise(() => readWebHostPageScript());
  const artifact = typeof options.artifact === 'string' ? options.artifact : yield* options.artifact;
  const launch = yield* liftPromise(() => resolveMcpLaunchEnvironment({
    artifact,
    ...(options.envFiles === undefined ? {} : { envFiles: options.envFiles }),
    ...(options.envPluginRoot === undefined ? {} : { envPluginRoot: options.envPluginRoot }),
    ...(options.loadEnvFiles === undefined ? {} : { loadEnvFiles: options.loadEnvFiles }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    pluginDataRoot: options.pluginDataRoot,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    server: requestedApp.server,
    target: options.target,
    workspaceRoot: options.workspaceRoot,
  }));
  const session = yield* Effect.acquireRelease(
    liftPromise(() => openStdioAppSession(launch, { serverName: requestedApp.server, target: options.target }, timeoutMs)),
    (opened) => Effect.promise(() => opened.close()),
  );
  const selection = yield* liftPromise(() => openApp(session.selection, {
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(requestedApp.name === undefined ? {} : { name: requestedApp.name }),
    ...(requestedApp.resourceUri === undefined ? {} : { resourceUri: requestedApp.resourceUri }),
    server: requestedApp.server,
    ...(options.tool === undefined ? {} : { tool: options.tool }),
  }));
  return yield* Effect.acquireRelease(
    liftPromise(() => startWebHost({
      autoApprove,
      open: options.open === true,
      ...(options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser }),
      pageScript,
      port,
      profile,
      selection,
      session,
      title: `${selection.server}/${appNameOf(selection.resourceUri) ?? selection.resourceUri}`,
    })),
    (host) => Effect.promise(() => host.close()),
  );
});

/**
 * Serves one built MCP App standalone: launches the plugin's packed MCP
 * server exactly as `agent-bundle mcp run` would, binds the App to it
 * through the Workbench's MCP App host stack, and returns the loopback URL of
 * a page that renders the App. `close()` tears everything down, the server
 * process included.
 */
export const serveMcpApp = async (options: ServeMcpAppOptions): Promise<ServedMcpApp> => {
  const runtime = makeScopedEffectRuntime(Layer.effect(ServedMcpAppService, serveProgram(options)));
  let host: WebHost;
  try {
    host = await runtime.run(ServedMcpAppService);
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return Object.freeze({
    close: () => {
      closing ??= runtime.close();
      return closing;
    },
    closed: host.closed,
    resourceUri: host.resourceUri,
    sandboxOrigin: host.sandboxOrigin,
    server: host.server,
    tool: host.tool,
    url: host.url,
  });
};
