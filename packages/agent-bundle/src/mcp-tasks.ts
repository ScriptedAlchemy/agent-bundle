/**
 * Task-augmented tool calls for a generated MCP server (#369): the MCP
 * `2025-11-25` Tasks utility over the SDK's `Server`.
 *
 * A tool route that declares `config.execution.taskSupport` (`optional` or
 * `required`) may be called as a task. The server then answers the
 * `tools/call` with a `CreateTaskResult` at once, keeps rendering the route
 * behind that task, and serves the lifecycle through `tasks/get` (status and
 * progress), `tasks/result` (the final `CallToolResult`, exactly what the
 * ordinary call would have returned), `tasks/cancel` (interrupts the render
 * through the same `AbortSignal` a cancelled request would), and `tasks/list`.
 * A client that does not ask for a task sees no change, and a server whose
 * tools never opted in advertises no `tasks` capability at all.
 *
 * The SDK release the server is built on (`@modelcontextprotocol/server@2.0.0`)
 * carries the task wire vocabulary but no task runtime, and its `tools/call`
 * result validation admits `CallToolResult` only. The lifecycle therefore
 * lives in a {@link Server} subclass: `_wrapHandler` is the SDK's documented
 * seam for role-specific request handling, and the task request handlers use
 * its custom-method form (`setRequestHandler(method, schemas, handler)`), so
 * nothing here reaches past the SDK's public surface. `tasks/*` are routed by
 * the SDK only on a `2025-11-25` session — the one revision whose core
 * protocol defines them; the `2026-07-28` revision moves tasks to an
 * extension (SEP-2663) and its wire codec removes `execution.taskSupport`
 * and `capabilities.tasks` — so a client on any other revision keeps the
 * ordinary contract untouched.
 *
 * Task records live with the server instance: the Tasks utility scopes a task
 * to the session that created it, and a render is bound to the process that
 * runs it, so a durable record no later session could read back would claim
 * more than the runtime can honour. Records are bounded by the task `ttl`
 * (retention after the terminal status) and by {@link MAX_MCP_TASKS_RETAINED}.
 */
import { randomUUID } from 'node:crypto';

import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  RELATED_TASK_META_KEY,
  Server,
  type CallToolResult,
  type Implementation,
  type JSONRPCRequest,
  type RegisteredTool,
  type Result,
  type ServerContext,
  type ServerOptions,
  type StandardSchemaV1,
  type Task,
  type TaskStatus,
} from '@modelcontextprotocol/server';
import type { McpProgressNotificationParams } from '@agent-bundle/runtime';

import { errorMessage } from './core/errors.ts';
import { isRecord } from './core/strict-json.ts';
import type { ToolTaskSupport } from './routes/public.ts';

/** The one protocol revision whose core specification defines the Tasks utility. */
export const MCP_TASKS_PROTOCOL_VERSION = '2025-11-25';

/** Retention of a settled task when the client requested no `ttl`: five minutes. */
export const DEFAULT_MCP_TASK_TTL_MS = 5 * 60 * 1000;

/** The longest retention a client may request: 24 hours, the route render ceiling. */
export const MAX_MCP_TASK_TTL_MS = 24 * 60 * 60 * 1000;

/** The polling interval a `CreateTaskResult` suggests when the client requested none. */
export const DEFAULT_MCP_TASK_POLL_INTERVAL_MS = 1000;

/** The shortest polling interval honoured from a client's `task.pollInterval`. */
export const MIN_MCP_TASK_POLL_INTERVAL_MS = 100;

/** Task records one server keeps at most; the oldest settled records are evicted first. */
export const MAX_MCP_TASKS_RETAINED = 256;

/** `_meta` key the spec reserves for the string a host may hand its model while a task runs. */
export const MODEL_IMMEDIATE_RESPONSE_META_KEY = 'io.modelcontextprotocol/model-immediate-response';

/** `_meta` key under which `tasks/get` carries the last render progress of a working task. */
export const MCP_TASK_PROGRESS_META_KEY = 'agent-bundle/progress';

/** The render progress a working task last reported, as `tasks/get` exposes it. */
export interface McpTaskProgress {
  readonly message?: string;
  readonly progress: number;
  readonly total?: number;
}

type TaskOutcome =
  | { readonly kind: 'result'; readonly result: CallToolResult }
  | { readonly code: number; readonly data?: unknown; readonly kind: 'error'; readonly message: string };

interface TaskRecord {
  readonly controller: AbortController;
  expiry?: ReturnType<typeof setTimeout>;
  outcome?: TaskOutcome;
  progress?: McpTaskProgress;
  readonly sequence: number;
  /** Resolves once the underlying `tools/call` handler settled, however the task ended. */
  readonly settled: Promise<void>;
  task: Task;
  readonly toolName: string;
}

type RequestHandler = (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>;

const isTerminal = (status: TaskStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

const now = (): string => new Date().toISOString();

/** A Standard Schema for the params of one task request, without a schema library dependency. */
const paramsSchema = <T>(
  describe: string,
  parse: (value: Readonly<Record<string, unknown>>) => T | string,
): StandardSchemaV1<unknown, T> => ({
  '~standard': {
    validate: (value: unknown): StandardSchemaV1.Result<T> => {
      if (!isRecord(value)) return { issues: [{ message: `${describe} params must be an object.` }] };
      const parsed = parse(value);
      return typeof parsed === 'string' ? { issues: [{ message: parsed }] } : { value: parsed };
    },
    vendor: 'agent-bundle',
    version: 1,
  },
});

const taskIdParams = (method: string): StandardSchemaV1<unknown, { readonly taskId: string }> =>
  paramsSchema(method, (value) => {
    const taskId = value['taskId'];
    return typeof taskId === 'string' && taskId !== '' ? { taskId } : `${method} requires a non-empty string taskId.`;
  });

const listParams: StandardSchemaV1<unknown, { readonly cursor?: string }> = paramsSchema('tasks/list', (value) => {
  const cursor = value['cursor'];
  if (cursor === undefined) return {};
  return typeof cursor === 'string' ? { cursor } : 'tasks/list cursor must be a string.';
});

const clampTtl = (requested: unknown): number => {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return DEFAULT_MCP_TASK_TTL_MS;
  return Math.min(Math.floor(requested), MAX_MCP_TASK_TTL_MS);
};

const clampPollInterval = (requested: unknown): number => {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return DEFAULT_MCP_TASK_POLL_INTERVAL_MS;
  return Math.max(Math.floor(requested), MIN_MCP_TASK_POLL_INTERVAL_MS);
};

const errorOutcome = (error: unknown): TaskOutcome => {
  if (ProtocolError.isInstance(error)) {
    return { code: error.code, ...(error.data === undefined ? {} : { data: error.data }), kind: 'error', message: error.message };
  }
  const code = isRecord(error) && Number.isSafeInteger(error['code']) ? (error['code'] as number) : ProtocolErrorCode.InternalError;
  return { code, kind: 'error', message: errorMessage(error) };
};

/** The page size of `tasks/list`; the cursor is the sequence of the last task returned. */
const TASK_LIST_PAGE = 50;

const progressStatusMessage = (progress: McpTaskProgress): string => {
  if (progress.message !== undefined) return progress.message;
  return progress.total === undefined
    ? `progress ${String(progress.progress)}`
    : `progress ${String(progress.progress)}/${String(progress.total)}`;
};

/** How one server's tools may be called as tasks; filled while routes register. */
export interface McpTaskSupportRegistry {
  /** Declares a tool's `execution.taskSupport`; `forbidden` tools need no declaration. */
  declare(toolName: string, taskSupport: ToolTaskSupport): void;
  taskSupport(toolName: string): ToolTaskSupport;
}

/**
 * The SDK `Server` with the task lifecycle installed on its `tools/call`
 * handler. Constructed by {@link createTaskAugmentedMcpServer}; the
 * `McpServer` it backs registers tools exactly as before, and this class
 * decides per request whether the registered handler answers directly or
 * behind a task.
 */
export class TaskAugmentedServer extends Server {
  readonly #records = new Map<string, TaskRecord>();
  readonly #support = new Map<string, ToolTaskSupport>();
  #sequence = 0;
  #installed = false;

  protected override _onclose(): void {
    // The session is over: no task can be polled or collected any more.
    this.abortTasks('The MCP session closed before the task settled.');
    super._onclose();
  }

  /** The declared task support of one tool; `forbidden` when it declared none. */
  taskSupport(toolName: string): ToolTaskSupport {
    return this.#support.get(toolName) ?? 'forbidden';
  }

  /** Declares a tool's task support; `forbidden` removes an earlier declaration. */
  declareTaskSupport(toolName: string, taskSupport: ToolTaskSupport): void {
    if (taskSupport === 'forbidden') this.#support.delete(toolName);
    else this.#support.set(toolName, taskSupport);
  }

  /** True once at least one tool may be called as a task. */
  get tasksEnabled(): boolean {
    return this.#support.size > 0;
  }

  /** The tasks this server currently retains, oldest first. */
  tasks(): readonly Task[] {
    return [...this.#records.values()].sort((left, right) => left.sequence - right.sequence).map((record) => record.task);
  }

  /**
   * Advertises the `tasks` capability and installs the task request handlers.
   * Must run before the server connects and only once at least one tool
   * declared task support; a server without one advertises nothing and keeps
   * answering `tasks/*` with the SDK's method-not-found.
   */
  installTaskSupport(): void {
    if (this.#installed || !this.tasksEnabled) return;
    this.#installed = true;
    this.registerCapabilities({ tasks: { cancel: {}, list: {}, requests: { tools: { call: {} } } } });
    this.setRequestHandler('tasks/get', { params: taskIdParams('tasks/get') }, async ({ taskId }) => {
      const record = this.#require(taskId);
      return {
        ...(record.progress === undefined ? {} : { _meta: { [MCP_TASK_PROGRESS_META_KEY]: { ...record.progress } } }),
        ...record.task,
      };
    });
    this.setRequestHandler('tasks/result', { params: taskIdParams('tasks/result') }, async ({ taskId }, ctx) => {
      const record = this.#require(taskId);
      await this.#awaitSettled(record, ctx.mcpReq.signal);
      const outcome = record.outcome;
      if (outcome === undefined) {
        throw new ProtocolError(ProtocolErrorCode.InternalError, `Task ${taskId} settled without an outcome.`);
      }
      switch (outcome.kind) {
        case 'error':
          throw new ProtocolError(outcome.code, outcome.message, outcome.data);
        case 'result':
          return {
            ...outcome.result,
            _meta: { ...outcome.result._meta, [RELATED_TASK_META_KEY]: { taskId } },
          };
        default: {
          const unreachable: never = outcome;
          throw new TypeError(`Unhandled task outcome ${String(unreachable)}.`);
        }
      }
    });
    this.setRequestHandler('tasks/list', { params: listParams }, async ({ cursor }) => {
      const ordered = [...this.#records.values()].sort((left, right) => left.sequence - right.sequence);
      let start = 0;
      if (cursor !== undefined) {
        const after = Number(cursor);
        if (!Number.isSafeInteger(after) || after < 0) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid tasks/list cursor ${JSON.stringify(cursor)}.`);
        }
        start = ordered.findIndex((record) => record.sequence > after);
        if (start === -1) start = ordered.length;
      }
      const page = ordered.slice(start, start + TASK_LIST_PAGE);
      const last = page.at(-1);
      return {
        ...(last !== undefined && start + TASK_LIST_PAGE < ordered.length ? { nextCursor: String(last.sequence) } : {}),
        tasks: page.map((record) => record.task),
      };
    });
    this.setRequestHandler('tasks/cancel', { params: taskIdParams('tasks/cancel') }, async ({ taskId }) => {
      const record = this.#require(taskId);
      if (isTerminal(record.task.status)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Cannot cancel task ${taskId}: already in terminal status '${record.task.status}'.`,
        );
      }
      this.#transition(record, 'cancelled', 'The task was cancelled by request.');
      record.controller.abort(new DOMException('The task was cancelled by request.', 'AbortError'));
      return { ...record.task };
    });
  }

  /** Cancels every task still working — the session is over, so no result can be collected. */
  abortTasks(reason: string): void {
    for (const record of this.#records.values()) {
      if (isTerminal(record.task.status)) continue;
      this.#transition(record, 'cancelled', reason);
      record.controller.abort(new DOMException(reason, 'AbortError'));
    }
    for (const record of this.#records.values()) {
      if (record.expiry !== undefined) clearTimeout(record.expiry);
    }
    this.#records.clear();
  }

  protected override _wrapHandler(method: string, handler: RequestHandler): RequestHandler {
    const wrapped = super._wrapHandler(method, handler);
    if (method !== 'tools/call') return wrapped;
    return async (request, ctx) => {
      // The lifecycle exists only where it was declared: a session on the one
      // revision whose core defines the utility, on a server that advertised
      // the capability. Anywhere else — no tool opted in, or a revision whose
      // wire strips `execution.taskSupport` and `capabilities.tasks` — every
      // call is the ordinary request, `required` tools included, and any
      // task metadata is ignored as the utility requires of a receiver
      // without the capability.
      if (!this.#installed || !this.#taskSession()) return wrapped(request, ctx);
      const params = request.params;
      const toolName = isRecord(params) && typeof params['name'] === 'string' ? params['name'] : undefined;
      // 2025-11-25 Tasks: a request is task-augmented when its params carry a
      // `task` object (the SDK's own guard accepts params without one).
      const augmented = isRecord(params) && isRecord(params['task']);
      const support = toolName === undefined ? 'forbidden' : this.taskSupport(toolName);
      if (!augmented) {
        if (support === 'required') {
          // 2025-11-25 Tasks: a tool with taskSupport "required" MUST be called as a task (-32601).
          throw new ProtocolError(
            ProtocolErrorCode.MethodNotFound,
            `Tool ${String(toolName)} requires task-augmented execution (execution.taskSupport: "required"); call it with params.task.`,
          );
        }
        return wrapped(request, ctx);
      }
      if (support === 'forbidden') {
        // The capability is declared for tools/call, but not by this tool.
        throw new ProtocolError(
          ProtocolErrorCode.MethodNotFound,
          `Tool ${String(toolName)} does not support task-augmented execution (execution.taskSupport is "forbidden").`,
        );
      }
      return this.#createTask(String(toolName), params as Readonly<Record<string, unknown>>, request, ctx, wrapped);
    };
  }

  #taskSession(): boolean {
    return this.getNegotiatedProtocolVersion() === MCP_TASKS_PROTOCOL_VERSION;
  }

  #require(taskId: string): TaskRecord {
    const record = this.#records.get(taskId);
    if (record === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${taskId}`);
    return record;
  }

  #evict(): void {
    if (this.#records.size < MAX_MCP_TASKS_RETAINED) return;
    const settled = [...this.#records.values()]
      .filter((record) => isTerminal(record.task.status))
      .sort((left, right) => left.sequence - right.sequence);
    const oldest = settled[0];
    if (oldest === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `This server is already running ${String(MAX_MCP_TASKS_RETAINED)} tasks; wait for one to settle or cancel one.`,
      );
    }
    this.#forget(oldest);
  }

  #forget(record: TaskRecord): void {
    if (record.expiry !== undefined) clearTimeout(record.expiry);
    this.#records.delete(record.task.taskId);
  }

  #transition(record: TaskRecord, status: TaskStatus, statusMessage: string | undefined): void {
    if (isTerminal(record.task.status)) return;
    record.task = {
      ...record.task,
      lastUpdatedAt: now(),
      status,
      ...(statusMessage === undefined ? {} : { statusMessage }),
    };
    if (statusMessage === undefined) {
      const { statusMessage: _dropped, ...rest } = record.task;
      record.task = rest;
    }
    if (!isTerminal(status)) return;
    const ttl = record.task.ttl ?? DEFAULT_MCP_TASK_TTL_MS;
    record.expiry = setTimeout(() => this.#forget(record), ttl);
    record.expiry.unref?.();
    // Optional per spec; a client that is polling loses nothing if it fails.
    void this.notification({ method: 'notifications/tasks/status', params: { ...record.task } }).catch(() => undefined);
  }

  #observeProgress(record: TaskRecord, params: McpProgressNotificationParams): void {
    if (isTerminal(record.task.status)) return;
    record.progress = {
      progress: params.progress,
      ...(params.message === undefined ? {} : { message: params.message }),
      ...(params.total === undefined ? {} : { total: params.total }),
    };
    record.task = { ...record.task, lastUpdatedAt: now(), statusMessage: progressStatusMessage(record.progress) };
  }

  /**
   * Blocks until the underlying `tools/call` settled — the terminal status of a
   * cancelled task is set before the interrupted render answers, and
   * `tasks/result` must return what that render produced — or until the
   * `tasks/result` request itself is cancelled.
   */
  async #awaitSettled(record: TaskRecord, signal: AbortSignal): Promise<void> {
    if (record.outcome !== undefined) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        reject(new ProtocolError(ProtocolErrorCode.InvalidRequest, 'The tasks/result request was cancelled before the task settled.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void record.settled.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  async #createTask(
    toolName: string,
    params: Readonly<Record<string, unknown>>,
    request: JSONRPCRequest,
    ctx: ServerContext,
    handler: RequestHandler,
  ): Promise<Result> {
    this.#evict();
    const creation = isRecord(params['task']) ? params['task'] : {};
    const taskId = randomUUID();
    const createdAt = now();
    const controller = new AbortController();
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const record: TaskRecord = {
      controller,
      sequence: ++this.#sequence,
      settled,
      task: {
        createdAt,
        lastUpdatedAt: createdAt,
        pollInterval: clampPollInterval(creation['pollInterval']),
        status: 'working',
        taskId,
        ttl: clampTtl(creation['ttl']),
      },
      toolName,
    };
    this.#records.set(taskId, record);

    // The render runs under the task's own signal — tasks/cancel is what
    // interrupts it now, not the answered request — and every progress
    // notification it emits is observed for tasks/get and stamped with the
    // related-task key before it reaches the client's own progress token.
    const clientToken = ctx.mcpReq._meta?.progressToken;
    const notify = ctx.mcpReq.notify;
    const taskContext: ServerContext = {
      ...ctx,
      mcpReq: {
        ...ctx.mcpReq,
        _meta: { ...ctx.mcpReq._meta, progressToken: clientToken ?? `agent-bundle/task/${taskId}` },
        notify: async (notification) => {
          if (notification.method === 'notifications/progress' && isRecord(notification.params)) {
            this.#observeProgress(record, notification.params as unknown as McpProgressNotificationParams);
            if (clientToken === undefined) return;
          }
          await notify({
            ...notification,
            params: {
              ...notification.params,
              _meta: { ...(isRecord(notification.params?._meta) ? notification.params._meta : {}), [RELATED_TASK_META_KEY]: { taskId } },
            },
          });
        },
        signal: controller.signal,
      },
    };
    const { task: _creation, ...ordinaryParams } = params;
    const ordinaryRequest: JSONRPCRequest = { ...request, params: ordinaryParams };
    void handler(ordinaryRequest, taskContext).then(
      (result) => {
        const toolResult = result as CallToolResult;
        record.outcome = { kind: 'result', result: toolResult };
        if (toolResult.isError === true) {
          // 2025-11-25 Tasks: a tool result with isError reaches "failed".
          const text = toolResult.content.find((block) => block.type === 'text');
          this.#transition(record, 'failed', text !== undefined && 'text' in text ? text.text : 'The tool call failed.');
        } else {
          this.#transition(record, 'completed', undefined);
        }
      },
      (error: unknown) => {
        record.outcome = errorOutcome(error);
        this.#transition(record, 'failed', errorMessage(error));
      },
    ).finally(settle);

    const created: Result = {
      _meta: {
        [MODEL_IMMEDIATE_RESPONSE_META_KEY]:
          `The ${toolName} call is running as task ${taskId}. Poll tasks/get for its status and fetch the result with tasks/result.`,
      },
      task: { ...record.task },
    };
    return created;
  }
}

/**
 * Builds the `McpServer` a generated artifact serves with task support wired
 * into its underlying `Server`. Register tools on the returned `McpServer`
 * as usual, declare each tool's task support through `declareTool`, then
 * call `install()` once before connecting a transport.
 */
export interface TaskAugmentedMcpServer {
  readonly server: McpServer;
  readonly tasks: TaskAugmentedServer;
  /**
   * Records a tool's `execution.taskSupport` (advertised in `tools/list`) and
   * registers it with the task lifecycle. `forbidden` — the default — leaves
   * the tool an ordinary request.
   */
  declareTool(tool: RegisteredTool, toolName: string, taskSupport: ToolTaskSupport): void;
  /** Advertises the capability and installs the task handlers when any tool opted in. */
  install(): void;
}

export const createTaskAugmentedMcpServer = (
  serverInfo: Implementation,
  options?: ServerOptions,
): TaskAugmentedMcpServer => {
  const server = new McpServer(serverInfo, options);
  const tasks = new TaskAugmentedServer(serverInfo, options);
  // `McpServer` builds its own `Server` and exposes it read-only; the task-aware
  // subclass replaces it before any handler registers, so every tool the
  // `McpServer` registers is wrapped by the lifecycle above.
  Object.defineProperty(server, 'server', { configurable: true, enumerable: true, value: tasks, writable: false });
  return Object.freeze({
    declareTool: (tool: RegisteredTool, toolName: string, taskSupport: ToolTaskSupport): void => {
      if (taskSupport !== 'forbidden') tool.execution = { taskSupport };
      tasks.declareTaskSupport(toolName, taskSupport);
    },
    install: (): void => tasks.installTaskSupport(),
    server,
    tasks,
  });
};
