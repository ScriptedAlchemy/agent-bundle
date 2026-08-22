import { randomUUID } from 'node:crypto';

import { digest } from '../core/digest.ts';
import { snapshotStrictJsonValue } from '../core/strict-json.ts';
import type { HookPlaygroundRouteService } from './hook-playground-routes.ts';
import type { McpSession } from './mcp-session-service.ts';
import type {
  NativePlaygroundCatalog,
  NativePlaygroundEpochReference,
  NativePlaygroundPrepared,
  NativePlaygroundService,
} from './native-playground-service.ts';
import type { PlaygroundOperationRequest, PlaygroundRun } from './playground-contract.ts';
import {
  ScriptPlaygroundFailure,
  scriptPlaygroundCleanupFailures,
  type ScriptPlaygroundService,
} from './script-playground-service.ts';
import type { ArtifactEpoch, ProjectStatus } from './types.ts';
import type {
  DraftEvalCase,
  PlaygroundDurableOutcome,
  PlaygroundEventInput,
  PlaygroundExport,
  PlaygroundJsonObject,
  PlaygroundJsonValue,
  PlaygroundReplay,
  PlaygroundReplayCursor,
  PlaygroundSelectedAssertion,
  PlaygroundSession,
  PlaygroundSessionInput,
  PlaygroundSubscribeOptions,
  PlaygroundSubscription,
  PlaygroundTraceEvent,
} from '../services/playground-service.ts';

export interface PlaygroundEpochReference {
  close(): Promise<void>;
  /** Native catalog admission uses the exact immutable metadata held by this lease. */
  readonly epoch?: ArtifactEpoch;
  readonly root: string;
}

/** Small structural authority so orchestration can pin an epoch without knowing a store path. */
export interface PlaygroundEpochAuthority {
  acquireActiveEpochReference?(): Promise<PlaygroundEpochReference>;
  acquireEpochReference(epochId: string): Promise<PlaygroundEpochReference>;
}

/** PlaygroundService remains private durable storage behind this internal surface. */
export interface PlaygroundDurableTraceStore {
  append(sessionId: string, input: PlaygroundEventInput): Promise<PlaygroundTraceEvent>;
  close(): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  export(sessionId: string): Promise<PlaygroundExport>;
  finalize(sessionId: string, outcome: PlaygroundDurableOutcome): Promise<PlaygroundSession>;
  openSession(input: PlaygroundSessionInput): Promise<PlaygroundSession>;
  promoteToDraftEval(sessionId: string, selectedAssertions: readonly PlaygroundSelectedAssertion[]): Promise<DraftEvalCase>;
  replay(sessionId: string, cursor?: PlaygroundReplayCursor): Promise<PlaygroundReplay>;
  session(sessionId: string): PlaygroundSession | undefined;
  subscribe(sessionId: string, options: PlaygroundSubscribeOptions): Promise<PlaygroundSubscription>;
}

export interface PlaygroundMcpSessionService {
  closeSession(id: string): Promise<boolean>;
  open(options: {
    readonly epochId: string;
    readonly serverName: string;
    readonly signal?: AbortSignal;
    readonly target: string;
  }): Promise<Pick<McpSession, 'callTool' | 'id'>>;
}

export interface PlaygroundOrchestrationServiceOptions {
  readonly coordinator: Pick<{ status(): ProjectStatus }, 'status'>;
  readonly createRunId?: () => string;
  readonly createSessionId?: () => string;
  readonly epochStore: PlaygroundEpochAuthority;
  readonly hookPlayground?: Pick<HookPlaygroundRouteService, 'simulate'>;
  readonly mcpSessions?: PlaygroundMcpSessionService;
  readonly native?: Pick<NativePlaygroundService, 'catalog' | 'close' | 'prepare' | 'run'>;
  readonly scripts?: Pick<ScriptPlaygroundService, 'run'>;
  readonly skillDocuments?: Readonly<{
    generated(epochId: string, target: string, skillId: string): Promise<unknown>;
  }>;
  readonly trace: PlaygroundDurableTraceStore;
}

interface RunningPlaygroundOperation {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

interface PlaygroundOperationResult {
  readonly event?: PlaygroundEventInput;
  readonly events?: readonly PlaygroundEventInput[];
  readonly outcome?: Omit<PlaygroundDurableOutcome, 'status'>;
  readonly status: 'failed' | 'passed';
}

/** Snapshots executor output as data; inherited values, getters, functions, and cycles never enter trace storage. */
const evidenceValue = (value: unknown): PlaygroundJsonValue => {
  try {
    return snapshotStrictJsonValue(value) as PlaygroundJsonValue;
  } catch { return '[unavailable evidence]'; }
};

const resultHasError = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'isError');
    return descriptor !== undefined && 'value' in descriptor && descriptor.value === true;
  } catch { return true; } // Hostile isError accessors are treated as an error result.
};

const scriptFailureEvidence = (operation: PlaygroundOperationRequest, error: unknown): Readonly<{
  readonly code: string;
  readonly stderr: string;
  readonly stdout: string;
}> | undefined => operation.operation === 'script.run' && error instanceof ScriptPlaygroundFailure
  ? Object.freeze({ code: error.code, stderr: error.stderr, stdout: error.stdout })
  : undefined;

const scriptCleanupEvidence = (error: unknown): readonly PlaygroundJsonObject[] => Object.freeze(
  scriptPlaygroundCleanupFailures(error).map(({ code }): PlaygroundJsonObject => Object.freeze({ code })),
);

const unavailable = (name: string): never => {
  throw new Error(`Playground ${name} service is not available.`);
};

/** Narrows an acquired lease to the native boundary shape without an assertion cast. */
const hasEpochMetadata = (
  reference: PlaygroundEpochReference,
): reference is NativePlaygroundEpochReference & PlaygroundEpochReference => reference.epoch !== undefined;

type PlaygroundOperationKind = PlaygroundOperationRequest['operation'];

/** Keyed operation shapes keep handler dispatch correlated with each kind. */
type PlaygroundOperationByKind = {
  readonly [K in PlaygroundOperationKind]: Extract<PlaygroundOperationRequest, { readonly operation: K }>;
};

/** Everything admission must pin before a durable session may open. */
interface PlaygroundOperationAdmission {
  readonly epoch: ArtifactEpoch;
  readonly fixtureId?: string;
  readonly preparedNative?: NativePlaygroundPrepared;
  readonly reference: PlaygroundEpochReference;
}

interface PlaygroundAdmissionContext {
  readonly acquireNativeEpochReference: (epochId: string | undefined) => Promise<NativePlaygroundEpochReference>;
  readonly native: PlaygroundOrchestrationServiceOptions['native'];
}

interface PlaygroundOperationContext {
  /** Appends to the run's durable session so hosts can stream progress evidence. */
  readonly appendEvent: (event: PlaygroundEventInput) => Promise<void>;
  readonly epochId: string;
  readonly hookPlayground: PlaygroundOrchestrationServiceOptions['hookPlayground'];
  readonly mcpSessions: PlaygroundOrchestrationServiceOptions['mcpSessions'];
  readonly native: PlaygroundOrchestrationServiceOptions['native'];
  readonly preparedNative: NativePlaygroundPrepared | undefined;
  readonly runId: string;
  readonly scripts: PlaygroundOrchestrationServiceOptions['scripts'];
  readonly signal: AbortSignal;
  readonly skillDocuments: PlaygroundOrchestrationServiceOptions['skillDocuments'];
  readonly targetDigest: string;
}

interface PlaygroundOperationHandler<K extends PlaygroundOperationKind> {
  readonly execute: (operation: PlaygroundOperationByKind[K], context: PlaygroundOperationContext) => Promise<PlaygroundOperationResult>;
  readonly intent: (operation: PlaygroundOperationByKind[K]) => PlaygroundSessionInput['invocation'];
  /** Admission capability for kinds that must pin their own epoch and host preparation. */
  readonly prepare?: (operation: PlaygroundOperationByKind[K], context: PlaygroundAdmissionContext) => Promise<PlaygroundOperationAdmission>;
  readonly taskText: (operation: PlaygroundOperationByKind[K]) => string;
}

/** Adding an operation kind fails compilation here until its handler exists. */
type PlaygroundOperationHandlers = { readonly [K in PlaygroundOperationKind]: PlaygroundOperationHandler<K> };

const playgroundOperationHandlers = Object.freeze<PlaygroundOperationHandlers>({
  'hook.simulate': {
    execute: async (operation, context) => {
      const service = context.hookPlayground ?? unavailable('Hook playground');
      const result = await service.simulate({ epochId: context.epochId, hook: operation.hook, input: { inline: operation.input }, signal: context.signal, target: operation.target });
      context.signal.throwIfAborted();
      return Object.freeze({ event: Object.freeze({ kind: 'hook.simulated', raw: Object.freeze({ hook: operation.hook, result: evidenceValue(result) }), source: 'hook', summary: 'Simulated emitted Hook.' }), status: 'diagnostics' in result ? 'failed' : 'passed' });
    },
    intent: (operation) => Object.freeze({ intent: Object.freeze({ hook: operation.hook }), kind: operation.operation }),
    taskText: () => 'Simulate an emitted Hook.',
  },
  'mcp.call-tool': {
    execute: async (operation, context) => {
      const service = context.mcpSessions ?? unavailable('MCP session');
      const session = await service.open({ epochId: context.epochId, serverName: operation.serverName, signal: context.signal, target: operation.target });
      try {
        context.signal.throwIfAborted();
        const result = await session.callTool({ arguments: operation.arguments, name: operation.tool, requestId: context.runId, signal: context.signal });
        context.signal.throwIfAborted();
        return Object.freeze({ event: Object.freeze({ kind: 'mcp.tool.called', raw: Object.freeze({ result: evidenceValue(result), serverName: operation.serverName, tool: operation.tool }), source: 'mcp', summary: 'Called emitted MCP tool.' }), status: resultHasError(result) ? 'failed' : 'passed' });
      } finally {
        await service.closeSession(session.id);
        context.signal.throwIfAborted();
      }
    },
    intent: (operation) => Object.freeze({ intent: Object.freeze({ serverName: operation.serverName, tool: operation.tool }), kind: operation.operation }),
    taskText: () => 'Call an emitted MCP tool.',
  },
  'native.prompt': {
    execute: async (_operation, context) => {
      const service = context.native ?? unavailable('Native Playground');
      const prepared = context.preparedNative ?? unavailable('prepared Native Playground');
      const result = await service.run(prepared, { emit: context.appendEvent, signal: context.signal });
      return Object.freeze({
        events: result.events,
        ...(result.response === undefined && result.workspace === undefined
          ? {}
          : { outcome: Object.freeze({
            ...(result.response === undefined ? {} : { response: result.response }),
            ...(result.workspace === undefined ? {} : { workspace: result.workspace }),
          }) }),
        status: result.status,
      });
    },
    intent: (operation) => Object.freeze({
      intent: Object.freeze({ caseId: operation.caseId, fixtureId: operation.fixtureId, host: operation.host, modelPinId: operation.modelPinId }),
      kind: operation.operation,
    }),
    prepare: async (operation, context) => {
      const service = context.native ?? unavailable('Native Playground');
      const reference = await context.acquireNativeEpochReference(operation.epochId);
      try {
        const preparedNative = await service.prepare(reference, operation);
        return Object.freeze({ epoch: reference.epoch, fixtureId: operation.fixtureId, preparedNative, reference });
      } catch (error) {
        try { await reference.close(); }
        catch (releaseError) {
          throw new AggregateError([error, releaseError], 'Native Playground admission and epoch release both failed.', { cause: releaseError });
        }
        throw error;
      }
    },
    taskText: (operation) => operation.prompt,
  },
  'script.run': {
    execute: async (operation, context) => {
      const service = context.scripts ?? unavailable('Script');
      const result = await service.run({ epochId: context.epochId, scriptId: operation.scriptId, signal: context.signal, target: operation.target });
      context.signal.throwIfAborted();
      return Object.freeze({
        event: Object.freeze({ kind: 'script.completed', raw: Object.freeze({ result: evidenceValue(result), targetDigest: context.targetDigest }), source: 'script', summary: 'Ran emitted script.' }),
        status: result.exitCode === 0 && (result.cleanupFailures?.length ?? 0) === 0 ? 'passed' : 'failed',
      });
    },
    intent: (operation) => Object.freeze({ intent: Object.freeze({ scriptId: operation.scriptId }), kind: operation.operation }),
    taskText: () => 'Run an emitted script.',
  },
  'skill.inspect': {
    execute: async (operation, context) => {
      const service = context.skillDocuments ?? unavailable('Skill document');
      await service.generated(context.epochId, operation.target, operation.skillId);
      context.signal.throwIfAborted();
      return Object.freeze({ event: Object.freeze({ kind: 'skill.inspected', raw: Object.freeze({ skillId: operation.skillId }), source: 'skill-evidence', summary: 'Inspected emitted Skill.' }), status: 'passed' });
    },
    intent: (operation) => Object.freeze({ intent: Object.freeze({ skillId: operation.skillId }), kind: operation.operation }),
    taskText: () => 'Inspect an emitted Skill.',
  },
});

/*
 * The generic kind parameter keeps each lookup correlated with its own
 * operation shape, so callers holding the full request union dispatch
 * through these helpers instead of re-branching per kind.
 */
const admitOperation = <K extends PlaygroundOperationKind>(
  kind: K,
  operation: PlaygroundOperationByKind[K],
  context: PlaygroundAdmissionContext,
): Promise<PlaygroundOperationAdmission> | undefined => playgroundOperationHandlers[kind].prepare?.(operation, context);

const operationIntent = <K extends PlaygroundOperationKind>(
  kind: K,
  operation: PlaygroundOperationByKind[K],
): PlaygroundSessionInput['invocation'] => playgroundOperationHandlers[kind].intent(operation);

const operationTaskText = <K extends PlaygroundOperationKind>(
  kind: K,
  operation: PlaygroundOperationByKind[K],
): string => playgroundOperationHandlers[kind].taskText(operation);

const executeOperation = <K extends PlaygroundOperationKind>(
  kind: K,
  operation: PlaygroundOperationByKind[K],
  context: PlaygroundOperationContext,
): Promise<PlaygroundOperationResult> => playgroundOperationHandlers[kind].execute(operation, context);

/**
 * Owns the public Playground operation lifecycle. It creates durable sessions
 * and evidence itself; browsers see only typed requests plus replayed results.
 */
export class PlaygroundOrchestrationService {
  readonly #coordinator: PlaygroundOrchestrationServiceOptions['coordinator'];
  readonly #createRunId: () => string;
  readonly #createSessionId: () => string;
  readonly #epochStore: PlaygroundEpochAuthority;
  readonly #hookPlayground: PlaygroundOrchestrationServiceOptions['hookPlayground'];
  readonly #mcpSessions: PlaygroundOrchestrationServiceOptions['mcpSessions'];
  readonly #native: PlaygroundOrchestrationServiceOptions['native'];
  readonly #scripts: PlaygroundOrchestrationServiceOptions['scripts'];
  readonly #skillDocuments: PlaygroundOrchestrationServiceOptions['skillDocuments'];
  readonly #trace: PlaygroundDurableTraceStore;
  readonly #running = new Map<string, RunningPlaygroundOperation>();
  readonly #backgroundFailures: unknown[] = [];
  /**
   * A close invoked synchronously from AbortSignal dispatch cannot await the
   * public close promise: the outer close is waiting for that listener's run
   * to settle. This stable completion breaks that unavoidable cycle while
   * ordinary callers still share the public drain promise.
   */
  readonly #abortReentryCompletion = Promise.resolve();
  #abortDispatchDepth = 0;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: PlaygroundOrchestrationServiceOptions) {
    this.#coordinator = options.coordinator;
    this.#createRunId = options.createRunId ?? randomUUID;
    this.#createSessionId = options.createSessionId ?? randomUUID;
    this.#epochStore = options.epochStore;
    this.#hookPlayground = options.hookPlayground;
    this.#mcpSessions = options.mcpSessions;
    this.#native = options.native;
    this.#scripts = options.scripts;
    this.#skillDocuments = options.skillDocuments;
    this.#trace = options.trace;
  }

  async run(input: PlaygroundOperationRequest, options: { readonly signal?: AbortSignal } = {}): Promise<PlaygroundRun> {
    if (this.#closed) throw new Error('Playground orchestration service is closed.');
    const id = this.#createRunId();
    const controller = new AbortController();
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
    const admission = await (admitOperation(input.operation, input, Object.freeze({
      acquireNativeEpochReference: (epochId: string | undefined) => this.#nativeReference(epochId),
      native: this.#native,
    })) ?? this.#activeEpochAdmission());
    const { epoch, preparedNative, reference } = admission;
    const targetDigest = epoch.targetDigests[input.target];
    if (typeof targetDigest !== 'string') {
      await reference.close();
      throw new Error('Playground operation target is not in the selected artifact epoch.');
    }
    const sessionId = this.#createSessionId();
    const epochDigest = digest({
      configDigest: epoch.configDigest,
      id: epoch.id,
      modelDigest: epoch.modelDigest,
      projectRevision: epoch.projectRevision,
      targetDigests: epoch.targetDigests,
    });
    const fixtureDigest = preparedNative?.fixtureDigest ?? digest({ epochDigest, kind: 'server-owned-workspace', target: input.target });
    let opened = false;
    try {
      if (this.#closed) throw new Error('Playground orchestration service is closed.');
      const session = await this.#trace.openSession(Object.freeze({
        epoch: Object.freeze({ digest: epochDigest, id: epoch.id }),
        fixture: Object.freeze({ digest: fixtureDigest, id: admission.fixtureId ?? 'server-owned-workspace' }),
        invocation: operationIntent(input.operation, input),
        sessionId,
        target: Object.freeze({ digest: targetDigest, name: input.target }),
        task: Object.freeze({ id, text: operationTaskText(input.operation, input) }),
      }));
      opened = true;
      await this.#trace.append(sessionId, Object.freeze({
        kind: 'epoch.bound',
        raw: Object.freeze({ epochId: epoch.id, target: input.target, targetDigest }),
        source: 'build',
        summary: 'Bound playground run to the current active artifact epoch.',
      }));
      const done = (async () => {
        try { await this.#finish(sessionId, input, epoch.id, targetDigest, id, signal, preparedNative); }
        catch (error) { this.#backgroundFailures.push(error); }
        finally {
          try { await reference.close(); }
          catch (error) { this.#backgroundFailures.push(error); }
          finally { this.#running.delete(id); }
        }
      })();
      this.#running.set(id, Object.freeze({ controller, done }));
      return Object.freeze({ id, session });
    } catch (error) {
      const containment: unknown[] = [];
      if (opened) {
        try { await this.#trace.finalize(sessionId, Object.freeze({ status: 'failed' })); }
        catch (finalizeError) {
          containment.push(finalizeError);
          try { await this.#trace.closeSession(sessionId); }
          catch (closeError) { containment.push(closeError); }
        }
      }
      await reference.close();
      if (containment.length > 0) throw new AggregateError([error, ...containment], 'Playground admission and containment both failed.', { cause: error });
      throw error;
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const running = this.#running.get(runId);
    if (running === undefined) return false;
    running.controller.abort(new Error('Playground run was cancelled.'));
    await running.done;
    return true;
  }

  async catalog(options: { readonly epochId?: string } = {}): Promise<NativePlaygroundCatalog> {
    if (this.#closed) throw new Error('Playground orchestration service is closed.');
    const service = this.#native ?? unavailable('Native Playground');
    const reference = await this.#nativeReference(options.epochId);
    try { return await service.catalog(reference); }
    finally { await reference.close(); }
  }

  session(sessionId: string): PlaygroundSession | undefined {
    return this.#trace.session(sessionId);
  }

  replay(sessionId: string, cursor?: PlaygroundReplayCursor): Promise<PlaygroundReplay> {
    return this.#trace.replay(sessionId, cursor);
  }

  subscribe(sessionId: string, options: PlaygroundSubscribeOptions): Promise<PlaygroundSubscription> {
    return this.#trace.subscribe(sessionId, options);
  }

  export(sessionId: string): Promise<PlaygroundExport> {
    return this.#trace.export(sessionId);
  }

  async promoteToDraftEval(sessionId: string, rawEventRefs: readonly string[]): Promise<DraftEvalCase> {
    const exported = await this.#trace.export(sessionId);
    const events = new Map(exported.events.map((event) => [event.rawEventRef, event]));
    const assertions = rawEventRefs.map((rawEventRef): PlaygroundSelectedAssertion => {
      const event = events.get(rawEventRef);
      if (event === undefined) throw new Error('Requested reference is not a persisted playground event.');
      return Object.freeze({
        evidence: Object.freeze({ rawEventRef: event.rawEventRef }),
        expectation: Object.freeze({ kind: event.kind, source: event.source }),
        id: event.rawEventRef,
        kind: 'playground-event',
      });
    });
    return this.#trace.promoteToDraftEval(sessionId, Object.freeze(assertions));
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      if (this.#abortDispatchDepth > 0) return this.#abortReentryCompletion;
      return this.#closePromise;
    }
    const closing = Promise.withResolvers<void>();
    this.#closePromise = closing.promise;
    void this.#close().then(closing.resolve, closing.reject);
    return closing.promise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    const running = [...this.#running.values()];
    for (const operation of running) {
      this.#abortDispatchDepth += 1;
      try { operation.controller.abort(new Error('Playground orchestration service is closed.')); }
      finally { this.#abortDispatchDepth -= 1; }
    }
    await Promise.allSettled(running.map((operation) => operation.done));
    let nativeFailure: unknown;
    try { await this.#native?.close(); }
    catch (error) { nativeFailure = error; }
    let traceFailure: unknown;
    try { await this.#trace.close(); }
    catch (error) { traceFailure = error; }
    const failures = [
      ...this.#backgroundFailures,
      ...(nativeFailure === undefined ? [] : [nativeFailure]),
      ...(traceFailure === undefined ? [] : [traceFailure]),
    ];
    if (failures.length > 0) throw new AggregateError(failures, 'Playground background operations could not be contained.', { cause: failures[0] });
  }

  async #finish(
    sessionId: string,
    operation: PlaygroundOperationRequest,
    epochId: string,
    targetDigest: string,
    runId: string,
    signal: AbortSignal,
    preparedNative: NativePlaygroundPrepared | undefined,
  ): Promise<void> {
    try {
      const result = await this.#operation(operation, epochId, targetDigest, runId, signal, sessionId, preparedNative);
      const events = result.events ?? (result.event === undefined ? [] : [result.event]);
      for (const event of events) await this.#trace.append(sessionId, event);
      const cancelled = signal.aborted;
      if (cancelled) {
        await this.#trace.append(sessionId, Object.freeze({
          kind: 'operation.cancelled',
          raw: Object.freeze({ operation: operation.operation }),
          source: 'diagnostics',
          summary: 'Server-owned playground operation was cancelled.',
        }));
      }
      await this.#trace.finalize(sessionId, Object.freeze({
        ...(result.outcome ?? {}),
        status: cancelled ? 'cancelled' : result.status,
      }));
    } catch (error) {
      const cancelled = signal.aborted;
      const failure = scriptFailureEvidence(operation, error);
      const cleanupFailures = scriptCleanupEvidence(error);
      const terminalFailures: unknown[] = [];
      try {
        await this.#trace.append(sessionId, Object.freeze({
          kind: cancelled ? 'operation.cancelled' : 'operation.failed',
          raw: Object.freeze({
            ...(cleanupFailures.length === 0 ? {} : { cleanupFailures }),
            ...(failure === undefined ? {} : { failure }),
            operation: operation.operation,
          }),
          source: 'diagnostics',
          summary: cancelled ? 'Server-owned playground operation was cancelled.' : 'Server-owned playground operation failed.',
        }));
      } catch (appendError) { terminalFailures.push(appendError); }
      try { await this.#trace.finalize(sessionId, Object.freeze({ status: cancelled ? 'cancelled' : 'failed' })); }
      catch (finalizeError) { terminalFailures.push(finalizeError); }
      if (terminalFailures.length === 0) return;
      try { await this.#trace.closeSession(sessionId); }
      catch (closeError) { terminalFailures.push(closeError); }
      throw new AggregateError([error, ...terminalFailures], 'Playground operation could not reach a durable terminal state.', { cause: error });
    }
  }

  #operation(
    operation: PlaygroundOperationRequest,
    epochId: string,
    targetDigest: string,
    runId: string,
    signal: AbortSignal,
    sessionId: string,
    preparedNative: NativePlaygroundPrepared | undefined,
  ): Promise<PlaygroundOperationResult> {
    return executeOperation(operation.operation, operation, Object.freeze({
      appendEvent: async (event: PlaygroundEventInput) => { await this.#trace.append(sessionId, event); },
      epochId,
      hookPlayground: this.#hookPlayground,
      mcpSessions: this.#mcpSessions,
      native: this.#native,
      preparedNative,
      runId,
      scripts: this.#scripts,
      signal,
      skillDocuments: this.#skillDocuments,
      targetDigest,
    }));
  }

  /** Default admission for operations without their own prepare capability. */
  async #activeEpochAdmission(): Promise<PlaygroundOperationAdmission> {
    const artifact = this.#coordinator.status().artifact;
    if (artifact.state === 'missing') throw new Error('Playground requires an active artifact epoch.');
    const epoch = artifact.activeEpoch;
    return Object.freeze({ epoch, reference: await this.#epochStore.acquireEpochReference(epoch.id) });
  }

  async #nativeReference(epochId: string | undefined): Promise<NativePlaygroundEpochReference> {
    const reference = epochId === undefined
      ? await (this.#epochStore.acquireActiveEpochReference?.() ?? unavailable('active epoch'))
      : await this.#epochStore.acquireEpochReference(epochId);
    if (hasEpochMetadata(reference)) return reference;
    try { await reference.close(); }
    catch { /* The missing metadata refusal remains the primary safe diagnosis. */ }
    throw new Error('Playground native epoch reference lacks immutable metadata.');
  }
}
