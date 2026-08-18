import { randomUUID } from 'node:crypto';

import { digest } from '../core/digest.ts';
import type { HookPlaygroundRouteService } from './hook-playground-routes.ts';
import type { McpSession } from './mcp-session-service.ts';
import type { PlaygroundOperationRequest, PlaygroundRun } from './playground-contract.ts';
import type { ScriptPlaygroundService } from './script-playground-service.ts';
import type { ProjectStatus } from './types.ts';
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

const maxEvidenceDepth = 32;

export interface PlaygroundEpochReference {
  close(): Promise<void>;
  readonly root: string;
}

/** Small structural authority so orchestration can pin an epoch without knowing a store path. */
export interface PlaygroundEpochAuthority {
  acquireEpochReference(epochId: string): Promise<PlaygroundEpochReference>;
}

/** PlaygroundService remains private durable storage behind this internal surface. */
export interface PlaygroundDurableTraceStore {
  append(sessionId: string, input: PlaygroundEventInput): Promise<PlaygroundTraceEvent>;
  close(): Promise<void>;
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

const plainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Snapshots executor output as data; inherited values, getters, functions, and cycles never enter trace storage. */
const evidenceValue = (value: unknown, depth = 0, seen = new WeakSet<object>()): PlaygroundJsonValue => {
  if (depth > maxEvidenceDepth) return '[evidence depth exceeded]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return typeof value === 'number' && !Number.isFinite(value) ? '[invalid number]' : value;
  }
  if (typeof value !== 'object') return '[unavailable evidence]';
  if (seen.has(value)) return '[cyclic evidence]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => evidenceValue(item, depth + 1, seen)));
    if (!plainRecord(value)) return '[unavailable evidence]';
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evidenceValue(item, depth + 1, seen)]))) as PlaygroundJsonObject;
  } finally {
    seen.delete(value);
  }
};

const operationIntent = (operation: PlaygroundOperationRequest): PlaygroundSessionInput['invocation'] => {
  if (operation.operation === 'skill.inspect') {
    return Object.freeze({ intent: Object.freeze({ skillId: operation.skillId }), kind: operation.operation });
  }
  if (operation.operation === 'hook.simulate') {
    return Object.freeze({ intent: Object.freeze({ hook: operation.hook }), kind: operation.operation });
  }
  if (operation.operation === 'mcp.call-tool') {
    return Object.freeze({ intent: Object.freeze({ serverName: operation.serverName, tool: operation.tool }), kind: operation.operation });
  }
  return Object.freeze({ intent: Object.freeze({ script: operation.script }), kind: operation.operation });
};

const taskText = (operation: PlaygroundOperationRequest): string => {
  if (operation.operation === 'skill.inspect') return 'Inspect an emitted Skill.';
  if (operation.operation === 'hook.simulate') return 'Simulate an emitted Hook.';
  if (operation.operation === 'mcp.call-tool') return 'Call an emitted MCP tool.';
  return 'Run an emitted script.';
};

const unavailable = (name: string): never => {
  throw new Error(`Playground ${name} service is not available.`);
};

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
  readonly #scripts: PlaygroundOrchestrationServiceOptions['scripts'];
  readonly #skillDocuments: PlaygroundOrchestrationServiceOptions['skillDocuments'];
  readonly #trace: PlaygroundDurableTraceStore;
  readonly #running = new Map<string, RunningPlaygroundOperation>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: PlaygroundOrchestrationServiceOptions) {
    this.#coordinator = options.coordinator;
    this.#createRunId = options.createRunId ?? randomUUID;
    this.#createSessionId = options.createSessionId ?? randomUUID;
    this.#epochStore = options.epochStore;
    this.#hookPlayground = options.hookPlayground;
    this.#mcpSessions = options.mcpSessions;
    this.#scripts = options.scripts;
    this.#skillDocuments = options.skillDocuments;
    this.#trace = options.trace;
  }

  async run(input: PlaygroundOperationRequest, options: { readonly signal?: AbortSignal } = {}): Promise<PlaygroundRun> {
    if (this.#closed) throw new Error('Playground orchestration service is closed.');
    const id = this.#createRunId();
    const controller = new AbortController();
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
    let settle!: () => void;
    const running: RunningPlaygroundOperation = Object.freeze({
      controller,
      done: new Promise<void>((resolvePromise) => { settle = resolvePromise; }),
    });
    this.#running.set(id, running);
    try {
      if (this.#closed) throw new Error('Playground orchestration service is closed.');
      return await this.#run(id, input, signal);
    } finally {
      settle();
      this.#running.delete(id);
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const running = this.#running.get(runId);
    if (running === undefined) return false;
    running.controller.abort(new Error('Playground run was cancelled.'));
    await running.done;
    return true;
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
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    const running = [...this.#running.values()];
    for (const operation of running) operation.controller.abort(new Error('Playground orchestration service is closed.'));
    await Promise.allSettled(running.map((operation) => operation.done));
    await this.#trace.close();
  }

  async #run(id: string, operation: PlaygroundOperationRequest, signal: AbortSignal): Promise<PlaygroundRun> {
    const artifact = this.#coordinator.status().artifact;
    if (artifact.state === 'missing') throw new Error('Playground requires an active artifact epoch.');
    const epoch = artifact.activeEpoch;
    const targetDigest = epoch.targetDigests[operation.target];
    if (typeof targetDigest !== 'string') throw new Error('Playground operation target is not in the active artifact epoch.');
    const reference = await this.#epochStore.acquireEpochReference(epoch.id);
    const sessionId = this.#createSessionId();
    const epochDigest = digest({
      configDigest: epoch.configDigest,
      id: epoch.id,
      modelDigest: epoch.modelDigest,
      projectRevision: epoch.projectRevision,
      targetDigests: epoch.targetDigests,
    });
    const fixtureDigest = digest({ epochDigest, kind: 'server-owned-workspace', target: operation.target });
    try {
      await this.#trace.openSession(Object.freeze({
        epoch: Object.freeze({ digest: epochDigest, id: epoch.id }),
        fixture: Object.freeze({ digest: fixtureDigest, id: 'server-owned-workspace' }),
        invocation: operationIntent(operation),
        sessionId,
        target: Object.freeze({ digest: targetDigest, name: operation.target }),
        task: Object.freeze({ id, text: taskText(operation) }),
      }));
      await this.#trace.append(sessionId, Object.freeze({
        kind: 'epoch.bound',
        raw: Object.freeze({ epochId: epoch.id, target: operation.target, targetDigest }),
        source: 'build',
        summary: 'Bound playground run to the current active artifact epoch.',
      }));
      try {
        const event = await this.#operation(operation, epoch.id, id, signal);
        await this.#trace.append(sessionId, event);
        const session = await this.#trace.finalize(sessionId, Object.freeze({ status: 'passed' }));
        return Object.freeze({ id, session });
      } catch {
        const cancelled = signal.aborted;
        await this.#trace.append(sessionId, Object.freeze({
          kind: cancelled ? 'operation.cancelled' : 'operation.failed',
          raw: Object.freeze({ operation: operation.operation }),
          source: 'diagnostics',
          summary: cancelled ? 'Server-owned playground operation was cancelled.' : 'Server-owned playground operation failed.',
        }));
        const session = await this.#trace.finalize(sessionId, Object.freeze({ status: cancelled ? 'cancelled' : 'failed' }));
        return Object.freeze({ id, session });
      }
    } finally {
      await reference.close();
    }
  }

  async #operation(
    operation: PlaygroundOperationRequest,
    epochId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<PlaygroundEventInput> {
    if (operation.operation === 'skill.inspect') {
      const service = this.#skillDocuments ?? unavailable('Skill document');
      await service.generated(epochId, operation.target, operation.skillId);
      return Object.freeze({
        kind: 'skill.inspected',
        raw: Object.freeze({ skillId: operation.skillId }),
        source: 'skill-evidence',
        summary: 'Inspected emitted Skill.',
      });
    }
    if (operation.operation === 'hook.simulate') {
      const service = this.#hookPlayground ?? unavailable('Hook playground');
      const result = await service.simulate({ epochId, hook: operation.hook, input: { inline: operation.input }, signal, target: operation.target });
      return Object.freeze({
        kind: 'hook.simulated',
        raw: Object.freeze({ hook: operation.hook, result: evidenceValue(result) }),
        source: 'hook',
        summary: 'Simulated emitted Hook.',
      });
    }
    if (operation.operation === 'mcp.call-tool') {
      const service = this.#mcpSessions ?? unavailable('MCP session');
      const session = await service.open({ epochId, serverName: operation.serverName, signal, target: operation.target });
      try {
        const result = await session.callTool({ arguments: operation.arguments, name: operation.tool, requestId: runId, signal });
        return Object.freeze({
          kind: 'mcp.tool.called',
          raw: Object.freeze({ result: evidenceValue(result), serverName: operation.serverName, tool: operation.tool }),
          source: 'mcp',
          summary: 'Called emitted MCP tool.',
        });
      } finally {
        await service.closeSession(session.id);
      }
    }
    const service = this.#scripts ?? unavailable('Script');
    const result = await service.run({ epochId, script: operation.script, signal, target: operation.target });
    return Object.freeze({
      kind: 'script.completed',
      raw: evidenceValue(result),
      source: 'script',
      summary: 'Ran emitted script.',
    });
  }
}
