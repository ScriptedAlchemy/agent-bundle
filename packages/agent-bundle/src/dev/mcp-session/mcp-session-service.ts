import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Cause, Effect, Exit, FileSystem, Scope } from 'effect';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { createDefaultRegistry, TargetRegistry } from '../../adapters/registry.ts';
import { validateArtifact } from '../../build/validate-artifact.ts';
import { DiagnosticError } from '../../core/diagnostics.ts';
import { joinArtifact } from '../../core/paths.ts';
import { isRecord, parseJsonWithoutDuplicateKeys } from '../../core/strict-json.ts';
import { runPromise } from '../../effect/boundary.ts';
import { liftPromise, liftTry } from '../../effect/lift.ts';
import { readFileString, unwrapPlatformError, type PlatformRun } from '../../effect/platform.ts';
import { platformRunOf } from '../platform-run.ts';
import {
  readTargetMcpServer,
  type ModernMcpServer,
  type TargetMcpRuntimeContract,
} from '../../services/mcp-runtime.ts';
import type { EpochStore } from '../epoch-store.ts';
import type {
  McpAppBridgeResource,
  McpAppBridgeSession,
  McpAppBridgeTool,
  McpAppJsonValue,
  McpAppSessionLease,
} from '../mcp-apps/mcp-app-binding-service.ts';
import type {
  McpSessionBinding,
  McpSessionId,
} from './mcp-session-protocol.ts';
import { McpSession, requestOptions } from './mcp-session.ts';
import type { McpSessionTraceSink } from './mcp-session-trace.ts';
import {
  canonicalMcpAppJson,
  canonicalMcpAppResource,
  canonicalMcpAppTool,
  mcpAppClientCapabilities,
} from './mcp-session-apps.ts';

import {
  McpSessionError,
  McpSessionServiceCloseError,
  McpSessionStaleEpochError,
  type McpClient,
  type McpSessionServiceCloseFailure,
  type McpSessionServiceOptions,
  type OpenMcpSessionOptions,
  type RemoteTransportOptions,
  type StdioOptions,
  type StdioTransport,
} from './mcp-session-types.ts';

export { McpSessionError, McpSessionServiceCloseError, McpSessionStaleEpochError };
export type { McpSessionErrorCode } from './mcp-session-types.ts';
export { mcpAppClientCapabilities };
export { McpSession } from './mcp-session.ts';
export type {
  McpSessionConnectionState,
  McpSessionEvent,
  McpSessionFrame,
  McpSessionPromptOptions,
  McpSessionReplay,
  McpSessionRequestOptions,
  McpSessionResourceOptions,
  McpSessionServiceCloseFailure,
  McpSessionServiceOptions,
  McpSessionToolCallOptions,
  OpenMcpSessionOptions,
} from './mcp-session-types.ts';
export type { McpSessionTraceSink } from './mcp-session-trace.ts';

export type {
  McpSessionBinding,
  McpSessionId,
  McpSessionInspectorConfig,
  McpSessionOperation,
  McpSessionReplayOverflow,
  McpSessionTraceEntry,
  McpSessionTraceListener,
  McpSessionTraceMessage,
  McpSessionTraceReplay,
  McpSessionTraceReplayGap,
  McpSessionTraceSubscription,
  McpSessionTraceSubscriptionOptions,
} from './mcp-session-protocol.ts';

interface OpeningSession {
  readonly abort: AbortController;
  readonly done: Promise<void>;
  readonly finish: (result: PromiseSettledResult<void>) => void;
}

type McpAppSessionCloseListener = Parameters<McpAppSessionLease['watchSessionClosed']>[0];

interface ActiveSession {
  readonly closeWatchers: Set<McpAppSessionCloseListener>;
  readonly session: McpSession;
  appLeaseCount: number;
  closed: boolean;
}

type McpAppLeaseIdentity = McpAppBridgeSession['identity'] & Readonly<{
  readonly binding: McpSessionBinding;
  readonly sessionId: McpSessionId;
}>;

/**
 * The three flattened McpAppSessionIdentity properties are deliberately
 * non-enumerable (the Object.defineProperties descriptor default), so
 * enumeration-based views of a lease identity — structural equality,
 * JSON serialization, spreads — see exactly `{ binding, sessionId }`.
 * A plain five-property literal would make them enumerable and change
 * that observable shape.
 */
const mcpAppLeaseIdentity = (session: McpSession): McpAppLeaseIdentity => {
  const identity: { readonly binding: McpSessionBinding; readonly sessionId: McpSessionId } = {
    binding: session.binding,
    sessionId: session.id,
  };
  Object.defineProperties(identity, {
    epochId: { value: session.binding.epochId },
    serverName: { value: session.binding.serverName },
    target: { value: session.binding.target },
  });
  return Object.freeze(identity) as McpAppLeaseIdentity;
};

const openingSession = (): OpeningSession => {
  const done = Promise.withResolvers<void>();
  void done.promise.catch(() => undefined);
  return Object.freeze({
    abort: new AbortController(),
    done: done.promise,
    finish: (result: PromiseSettledResult<void>) => {
      if (result.status === 'rejected') {
        done.reject(result.reason);
      } else {
        done.resolve();
      }
    },
  });
};

/**
 * The bridge-facing lease over one active control session: the seam toward
 * mcp-app-binding-service. Every operation canonicalizes JSON at the
 * boundary and re-checks the entry's closed flag around each await.
 */
const createMcpAppSessionLease = (entry: ActiveSession): McpAppSessionLease => {
  entry.appLeaseCount += 1;
  const identity = mcpAppLeaseIdentity(entry.session);
  let bridgeResources: Promise<readonly McpAppBridgeResource[]> | undefined;
  let bridgeTools: Promise<readonly McpAppBridgeTool[]> | undefined;
  let released = false;
  const assertActive = (): void => {
    if (entry.closed) throw new Error('MCP App session is closed.');
  };
  const bridgeSession: McpAppBridgeSession = Object.freeze({
    callTool: async ({ arguments: toolArguments, name, signal }: {
      readonly arguments: McpAppJsonValue | undefined;
      readonly name: string;
      readonly signal?: AbortSignal;
    }) => {
      assertActive();
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('MCP App tool call was aborted.');
      }
      const argumentsSnapshot = canonicalMcpAppJson(toolArguments ?? {}, 'MCP App tool arguments');
      if (!isRecord(argumentsSnapshot)) throw new TypeError('MCP App tool arguments must be a JSON object.');
      const result = await entry.session.callTool({
        arguments: argumentsSnapshot,
        name,
        ...(signal === undefined ? {} : { signal }),
      });
      assertActive();
      return canonicalMcpAppJson(
        result,
        'MCP App tool result',
      );
    },
    identity,
    listBridgeResources: async () => {
      assertActive();
      bridgeResources ??= entry.session.listResources().then((resources) =>
        Object.freeze(resources.map(canonicalMcpAppResource)));
      const resources = await bridgeResources;
      assertActive();
      return resources;
    },
    listBridgeTools: async () => {
      assertActive();
      bridgeTools ??= entry.session.listTools().then((tools) => Object.freeze(tools.map(canonicalMcpAppTool)));
      const tools = await bridgeTools;
      assertActive();
      return tools;
    },
    readResource: async ({ uri, signal }: { readonly signal?: AbortSignal; readonly uri: string }) => {
      assertActive();
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('MCP App resource read was aborted.');
      }
      const result = await entry.session.readResource({
        uri,
        ...(signal === undefined ? {} : { signal }),
      });
      assertActive();
      return canonicalMcpAppJson(result, 'MCP App resource result');
    },
  });
  return Object.freeze({
    release: async () => {
      if (released) return;
      released = true;
      entry.appLeaseCount = Math.max(0, entry.appLeaseCount - 1);
    },
    session: bridgeSession,
    watchSessionClosed: (listener: McpAppSessionCloseListener) => {
      if (typeof listener !== 'function') throw new TypeError('MCP App session close listener must be a function.');
      if (entry.closed) return Object.freeze({ closed: true, unsubscribe: () => undefined });
      entry.closeWatchers.add(listener);
      let subscribed = true;
      return Object.freeze({
        closed: false,
        unsubscribe: () => {
          if (!subscribed) return;
          subscribed = false;
          entry.closeWatchers.delete(listener);
        },
      });
    },
  });
};

/** Owns persistent MCP sessions and releases every epoch reference on shutdown. */
export class McpSessionService {
  readonly #createClient: () => McpClient;
  readonly #createStdioTransport: (options: StdioOptions) => StdioTransport;
  readonly #createStreamableHttpTransport: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly #epochStore: EpochStore;
  readonly #projectRoot: string;
  readonly #registry: TargetRegistry;
  readonly #run: PlatformRun;
  readonly #traceSink: McpSessionTraceSink | undefined;
  readonly #openingSessions = new Set<OpeningSession>();
  readonly #sessions = new Map<string, ActiveSession>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: McpSessionServiceOptions) {
    if (!isAbsolute(options.projectRoot)) throw new Error('MCP session service project root must be absolute.');
    this.#createClient = options.createClient ??
      (() => new Client({ name: 'agent-bundle', version: '0.1.0' }, { capabilities: mcpAppClientCapabilities }));
    this.#createStdioTransport = options.createStdioTransport ?? ((stdioOptions) => new StdioClientTransport(stdioOptions));
    this.#createStreamableHttpTransport = options.createStreamableHttpTransport ?? ((url, transportOptions) =>
      new StreamableHTTPClientTransport(url, {
        requestInit: transportOptions.headers === undefined ? undefined : { headers: transportOptions.headers },
      }));
    this.#epochStore = options.epochStore;
    this.#projectRoot = resolve(options.projectRoot);
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#run = platformRunOf(options.platformRuntime);
    this.#traceSink = options.traceSink;
  }

  async open(options: OpenMcpSessionOptions): Promise<McpSession> {
    if (this.#closed) throw McpSessionError.serviceClosed();
    const timeoutMs = requestOptions(options).timeout;
    const opening = openingSession();
    this.#openingSessions.add(opening);
    const signal = options.signal === undefined
      ? opening.abort.signal
      : AbortSignal.any([options.signal, opening.abort.signal]);
    let cleanupFailed = false;
    let cleanupFailure: unknown;
    try {
      return await this.#run(this.#openEffect({ ...options, signal, timeoutMs }, (error) => {
        if (!cleanupFailed) {
          cleanupFailed = true;
          cleanupFailure = error;
        }
      }));
    } finally {
      this.#openingSessions.delete(opening);
      opening.finish(cleanupFailed
        ? { reason: cleanupFailure, status: 'rejected' }
        : { status: 'fulfilled', value: undefined });
    }
  }

  /**
   * The open acquisition chain as scoped resources: the epoch lease and the
   * plugin-data directory are `acquireRelease`d into the open scope, and
   * their releases run — newest first, failures collected, never thrown from
   * a finalizer — only while the session has not been constructed. Once the
   * `McpSession` exists it owns every resource, the scope finalizers disarm,
   * and a later open failure is cleaned up by `session.close()` instead.
   *
   * The plugin-data directory is not a `withTempDirectory` bracket: it
   * outlives this call. It is acquired into its own session-lifetime
   * {@link Scope}, whose only finalizer removes it, and the session closes
   * that scope from `close()` — until the session exists, the open scope's
   * release closes it instead.
   */
  #openEffect(
    options: OpenMcpSessionOptions,
    reportCleanupFailure: (error: unknown) => void,
  ): Effect.Effect<McpSession, unknown, FileSystem.FileSystem> {
    return Effect.suspend(() => {
      const cleanupFailures: unknown[] = [];
      let constructed: McpSession | undefined;
      const releaseUnlessTransferred = (release: () => Promise<void>): Effect.Effect<void> =>
        Effect.promise(async () => {
          if (constructed !== undefined) return;
          try {
            await release();
          } catch (error) {
            cleanupFailures.push(error);
          }
        });
      const program = Effect.gen({ self: this }, function* (this: McpSessionService) {
        const target = options.target;
        const runtime = yield* liftTry(() => this.#runtime(target));
        if (options.serverName.trim().length === 0) {
          return yield* Effect.fail(McpSessionError.invalidServerName());
        }
        const epochReference = yield* Effect.acquireRelease(
          liftPromise(() => this.#epochStore.acquireEpochReference(options.epochId)),
          (reference) => releaseUnlessTransferred(() => reference.close()),
        );
        const epochRoot = epochReference.root;
        const diagnostics = yield* liftPromise(() => validateArtifact({
          allowEpochStagingMarker: true,
          artifactRoot: epochRoot,
          registry: this.#registry,
        }));
        const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
        if (errors.length > 0) return yield* Effect.fail(new DiagnosticError(errors));
        // Every selected host reads the composite epoch root as its plugin root (#555).
        const targetRoot = epochRoot;
        const server = yield* liftPromise(() => this.#server(targetRoot, target, runtime, options.serverName));
        const fs = yield* FileSystem.FileSystem;
        const pluginDataScope = yield* Scope.make();
        const releasePluginData = (): Promise<void> => runPromise(Scope.close(pluginDataScope, Exit.void));
        const pluginData = yield* Effect.acquireRelease(
          Effect.tap(
            fs.makeTempDirectory({ directory: tmpdir(), prefix: 'agent-bundle-mcp-' }),
            (directory) => Scope.addFinalizer(
              pluginDataScope,
              // The session's close step reports this failure (last-failure-wins);
              // `runPromise` rethrows the defect as the unwrapped Node error.
              fs.remove(directory, { force: true, recursive: true }).pipe(
                Effect.mapError(unwrapPlatformError),
                Effect.orDie,
              ),
            ),
          ),
          () => releaseUnlessTransferred(releasePluginData),
        );
        const sessionId = randomUUID();
        const session = yield* liftTry(() => new McpSession({
          assertEpochAvailable: async () => {
            const probe = await this.#epochStore.acquireEpochReference(options.epochId);
            await probe.close();
          },
          binding: { epochId: options.epochId, serverName: options.serverName, target },
          createClient: this.#createClient,
          createStdioTransport: this.#createStdioTransport,
          createStreamableHttpTransport: this.#createStreamableHttpTransport,
          epochReference,
          id: sessionId,
          onClose: () => this.#invalidateSession(sessionId, new Error('MCP session closed.')),
          onClosing: () => this.#invalidateSession(sessionId, new Error('MCP session is closing.')),
          pluginData,
          releasePluginData,
          resolved: { runtime, server, target, targetRoot },
          timeoutMs: options.timeoutMs,
          ...(this.#traceSink === undefined ? {} : { traceSink: this.#traceSink }),
          workspaceRoot: resolve(options.workspaceRoot ?? this.#projectRoot),
        }));
        constructed = session;
        yield* liftPromise(() => session.initialize({ signal: options.signal }));
        if (this.#closed) return yield* Effect.fail(McpSessionError.serviceClosed());
        this.#sessions.set(sessionId, {
          appLeaseCount: 0,
          closeWatchers: new Set(),
          closed: false,
          session,
        });
        return session;
      });
      return Effect.scoped(program).pipe(
        Effect.catch((error) => Effect.suspend(() => {
          const session = constructed;
          if (session !== undefined) {
            return liftPromise(() => session.close()).pipe(
              Effect.catch((cleanupError) => Effect.suspend(() => {
                reportCleanupFailure(cleanupError);
                return Effect.fail(cleanupError);
              })),
              Effect.andThen(Effect.fail(error)),
            );
          }
          for (const failure of cleanupFailures) reportCleanupFailure(failure);
          return Effect.fail(cleanupFailures.length > 0 ? cleanupFailures[cleanupFailures.length - 1] : error);
        })),
      );
    });
  }

  get(id: McpSessionId): McpSession | undefined {
    const entry = this.#sessions.get(id);
    return entry?.closed === false ? entry.session : undefined;
  }

  async acquireAppLease(sessionId: string): Promise<McpAppSessionLease> {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined || entry.closed) throw new Error(`Unknown MCP App session ${JSON.stringify(sessionId)}.`);
    return createMcpAppSessionLease(entry);
  }

  /** Live App leases over one session; 0 for an unknown or closed session. */
  appLeaseCount(sessionId: string): number {
    const entry = this.#sessions.get(sessionId);
    return entry === undefined || entry.closed ? 0 : entry.appLeaseCount;
  }

  async closeSession(id: McpSessionId): Promise<boolean> {
    const entry = this.#invalidateSession(id, new Error('MCP session control closed.'));
    if (entry === undefined) return false;
    await entry.session.close();
    return true;
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const sessions = [...this.#sessions.entries()].flatMap(([id]) => {
      const entry = this.#invalidateSession(id, new Error('MCP session service is closed.'));
      return entry === undefined ? [] : [[id, entry.session] as const];
    });
    const openings = [...this.#openingSessions];
    for (const opening of openings) opening.abort.abort(new Error('MCP session service is closed.'));
    this.#closePromise = runPromise(this.#closeEffect(openings, sessions));
    return this.#closePromise;
  }

  /**
   * Waits for every tracked lifecycle — openings first, then active
   * sessions, each phase settling concurrently via per-element `Exit` — and
   * fails with one `McpSessionServiceCloseError` naming every resource that
   * could not be released.
   */
  #closeEffect(
    openings: readonly OpeningSession[],
    sessions: readonly (readonly [string, McpSession])[],
  ): Effect.Effect<void, McpSessionServiceCloseError> {
    return Effect.gen(function* () {
      const openingResults = yield* Effect.forEach(
        openings,
        (opening) => Effect.exit(liftPromise(() => opening.done)),
        { concurrency: 'unbounded' },
      );
      const sessionResults = yield* Effect.forEach(
        sessions,
        ([, session]) => Effect.exit(liftPromise(() => session.close())),
        { concurrency: 'unbounded' },
      );
      const failures = Object.freeze([
        ...openingResults.flatMap((result): readonly McpSessionServiceCloseFailure[] =>
          Exit.isFailure(result)
            ? [Object.freeze({ error: Cause.squash(result.cause), resource: 'opening' as const })]
            : []),
        ...sessionResults.flatMap((result, index): readonly McpSessionServiceCloseFailure[] => {
          const sessionId = sessions[index]?.[0];
          return Exit.isFailure(result) && sessionId !== undefined
            ? [Object.freeze({ error: Cause.squash(result.cause), resource: 'session' as const, sessionId })]
            : [];
        }),
      ]);
      if (failures.length > 0) {
        return yield* Effect.fail(new McpSessionServiceCloseError(failures));
      }
    });
  }

  #invalidateSession(id: string, reason: unknown): ActiveSession | undefined {
    const entry = this.#sessions.get(id);
    if (entry === undefined || entry.closed) return undefined;
    entry.closed = true;
    this.#sessions.delete(id);
    const watchers = [...entry.closeWatchers];
    entry.closeWatchers.clear();
    for (const watcher of watchers) {
      try {
        void Promise.resolve(watcher(reason)).catch(() => undefined);
      } catch {
        // App cleanup callbacks cannot interfere with the control session's shutdown.
      }
    }
    return entry;
  }

  #runtime(name: string): TargetMcpRuntimeContract {
    if (!this.#registry.has(name) || !this.#registry.supports(name, 'mcp')) {
      throw new Error(`Unsupported MCP target ${JSON.stringify(name)}.`);
    }
    const runtime = this.#registry.mcpRuntime(name);
    if (runtime === undefined) throw new Error(`Unsupported MCP target ${JSON.stringify(name)}.`);
    return runtime;
  }

  async #server(
    targetRoot: string,
    target: string,
    runtime: TargetMcpRuntimeContract,
    name: string,
  ): Promise<ModernMcpServer> {
    const path = joinArtifact(targetRoot, runtime.manifestPath);
    let document: unknown;
    try {
      document = parseJsonWithoutDuplicateKeys(await this.#run(readFileString(path)));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`MCP manifest for target ${JSON.stringify(target)} is not valid JSON.`, { cause: error });
      }
      throw error;
    }
    const result = readTargetMcpServer(runtime, document, name);
    if (result.status === 'missing') {
      throw new Error(`Expected exactly one ${target} MCP server matching ${JSON.stringify(name)}.`);
    }
    if (result.status === 'invalid') {
      throw new Error(`MCP server ${JSON.stringify(name)} in target ${JSON.stringify(target)} is invalid.`);
    }
    return result.server;
  }
}
