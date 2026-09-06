import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  HostAvailability,
  HostSession,
  HostSessionHost,
} from '../../contracts/host-sessions.ts';
import type { TracePublisher } from '../trace/trace-hub.ts';
import {
  loadPtyAdapter,
  type PtyAdapter,
  type PtyProcess,
} from './pty.ts';

export const HOST_SESSION_PTY_UNAVAILABLE_CODE = 'AB8260';
export const HOST_SESSION_MALFORMED_CODE = 'AB8261';
export const HOST_SESSION_UNKNOWN_CODE = 'AB8262';
export const HOST_SESSION_NOT_LAUNCHABLE_CODE = 'AB8263';
export const HOST_SESSION_LIMIT_CODE = 'AB8264';
export const HOST_SESSION_UNAVAILABLE_CODE = 'AB8265';

const hosts = ['claude', 'codex'] as const;
const defaultScrollbackBytes = 256 * 1024;
const defaultTerminationGraceMs = 2_000;
const inputByteLimit = 16 * 1024;
const signalNames = new Map([[9, 'SIGKILL'], [15, 'SIGTERM']]);

export class HostSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HostSessionError';
  }
}

export type HostSessionStreamMessage =
  | Readonly<{ readonly session: HostSession; readonly type: 'state' }>
  | Readonly<{ readonly data: string; readonly type: 'output' }>
  | Readonly<{ readonly session: HostSession; readonly type: 'end' }>;

interface SessionRecord {
  cols: number;
  endedAt?: number;
  exitCode?: number;
  readonly host: HostSessionHost;
  readonly id: string;
  readonly install: string;
  readonly epochId: string;
  readonly listeners: Set<(message: HostSessionStreamMessage) => void>;
  readonly output: Buffer[];
  outputBytes: number;
  readonly process: PtyProcess;
  readonly prompt?: string;
  readonly restartOf?: string;
  rows: number;
  readonly startedAt: number;
  state: HostSession['state'];
  signal?: string;
  terminating: boolean;
  traceSessionId?: string;
  readonly exited: PromiseWithResolvers<void>;
}

export interface HostSessionServiceOptions {
  readonly attached: (host: HostSessionHost) => Readonly<{ readonly destination: string; readonly epochId: string }> | undefined;
  readonly currentEpochId: () => string | undefined;
  readonly environment?: Readonly<NodeJS.ProcessEnv> | (() => Readonly<NodeJS.ProcessEnv>);
  readonly loadPty?: (projectRoot: string) => PtyAdapter;
  readonly now?: () => number;
  readonly projectRoot: string;
  readonly resolveExecutable?: (host: HostSessionHost, environment: Readonly<NodeJS.ProcessEnv>) => Promise<string | undefined>;
  readonly scrollbackBytes?: number;
  readonly terminationGraceMs?: number;
  readonly trace?: TracePublisher;
}

export interface CreateHostSession {
  readonly cols: number;
  readonly host: HostSessionHost;
  readonly prompt?: string;
  readonly restartOf?: string;
  readonly rows: number;
}

const executableOnPath = async (
  host: HostSessionHost,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string | undefined> => {
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = resolve(directory, host);
    try {
      await access(candidate, 1);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
};

const maxAncestryHops = 32;

/**
 * Codex hands its stdio MCP servers eight whitelisted variables, so the dev
 * proxy cannot carry `AGENT_BUNDLE_DEV_SESSION`; it reports its pid instead
 * and the session is found by walking up to the PTY child.
 */
const parentPid = async (pid: number): Promise<number | undefined> => {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
    const fields = stat?.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields === undefined ? undefined : Number(fields[1]);
  }
  const { stdout } = await promisify(execFile)('ps', ['-o', 'ppid=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
  const parsed = Number(stdout.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/** node-pty reports `signal: 0` for a normal exit; only a real signal is a signal. */
const signalName = (signal: number | undefined): string | undefined =>
  signal === undefined || signal === 0 ? undefined : signalNames.get(signal) ?? String(signal);

export class HostSessionService {
  readonly #attached: HostSessionServiceOptions['attached'];
  readonly #currentEpochId: HostSessionServiceOptions['currentEpochId'];
  readonly #environment: () => Readonly<NodeJS.ProcessEnv>;
  readonly #loadPty: NonNullable<HostSessionServiceOptions['loadPty']>;
  readonly #now: () => number;
  readonly #projectRoot: string;
  readonly #resolveExecutable: NonNullable<HostSessionServiceOptions['resolveExecutable']>;
  readonly #scrollbackBytes: number;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #terminationGraceMs: number;
  readonly #trace: TracePublisher | undefined;
  #closed = false;
  #pty: PtyAdapter | undefined;

  constructor(options: HostSessionServiceOptions) {
    this.#attached = options.attached;
    this.#currentEpochId = options.currentEpochId;
    const environment = options.environment;
    this.#environment = typeof environment === 'function'
      ? environment
      : () => environment ?? process.env;
    this.#loadPty = options.loadPty ?? loadPtyAdapter;
    this.#now = options.now ?? Date.now;
    this.#projectRoot = options.projectRoot;
    this.#resolveExecutable = options.resolveExecutable ?? executableOnPath;
    this.#scrollbackBytes = options.scrollbackBytes ?? defaultScrollbackBytes;
    this.#terminationGraceMs = options.terminationGraceMs ?? defaultTerminationGraceMs;
    this.#trace = options.trace;
  }

  async availability(): Promise<readonly HostAvailability[]> {
    let ptyFailure: HostSessionError | undefined;
    try {
      this.#adapter();
    } catch (error) {
      if (error instanceof HostSessionError) ptyFailure = error;
      else throw error;
    }
    return Promise.all(hosts.map(async (host): Promise<HostAvailability> => {
      if (ptyFailure !== undefined) return { host, launchable: false, reason: `${ptyFailure.code}: ${ptyFailure.message}` };
      const attached = this.#attached(host);
      if (attached === undefined || attached.epochId !== this.#currentEpochId()) {
        return { host, launchable: false, reason: 'no dev install attached' };
      }
      const executable = await this.#resolveExecutable(host, this.#environment());
      return executable === undefined
        ? { host, launchable: false, reason: `${host} is not on PATH` }
        : { executable, host, launchable: true };
    }));
  }

  list(): readonly HostSession[] {
    return [...this.#sessions.values()].map((record) => this.#snapshot(record));
  }

  read(id: string): HostSession | undefined {
    const record = this.#sessions.get(id);
    return record === undefined ? undefined : this.#snapshot(record);
  }

  attach(devSession: string, hostSessionId: string | undefined): void {
    const record = this.#sessions.get(devSession);
    if (
      record === undefined
      || record.state !== 'running'
      || hostSessionId === undefined
      || record.traceSessionId !== undefined
    ) return;
    record.traceSessionId = hostSessionId;
    this.#publish(record, 'session.attached', 'ok', { hostSessionId });
    this.#send(record, { session: this.#snapshot(record), type: 'state' });
  }

  traceSessionId(devSession: string): string {
    return this.#sessions.get(devSession)?.traceSessionId ?? devSession;
  }

  /** The live session whose PTY child is `pid` or one of its ancestors. */
  async sessionForProcess(pid: number): Promise<string | undefined> {
    const byPid = new Map(
      [...this.#sessions.values()].filter((record) => record.state === 'running').map((record) => [record.process.pid, record.id]),
    );
    let current: number | undefined = pid;
    for (let hop = 0; current !== undefined && current > 1 && hop < maxAncestryHops; hop += 1) {
      const id = byPid.get(current);
      if (id !== undefined) return id;
      current = await parentPid(current);
    }
    return undefined;
  }

  async create(request: CreateHostSession): Promise<HostSession> {
    if (this.#closed) throw new HostSessionError(HOST_SESSION_UNAVAILABLE_CODE, 'Host-session service is not available.', 503);
    if ([...this.#sessions.values()].filter((record) => record.state === 'running').length >= 4) {
      throw new HostSessionError(HOST_SESSION_LIMIT_CODE, 'Host-session limit reached.', 409);
    }
    const attached = this.#attached(request.host);
    if (attached === undefined || attached.epochId !== this.#currentEpochId()) {
      throw new HostSessionError(HOST_SESSION_NOT_LAUNCHABLE_CODE, `${request.host} has no dev install attached to the adopted epoch.`, 409);
    }
    const environment = this.#environment();
    const executable = await this.#resolveExecutable(request.host, environment);
    if (executable === undefined) {
      throw new HostSessionError(HOST_SESSION_NOT_LAUNCHABLE_CODE, `${request.host} is not on PATH`, 409);
    }
    const id = `hs_${randomBytes(8).toString('hex')}`;
    let process: PtyProcess;
    try {
      process = this.#adapter().spawn(executable, request.prompt === undefined ? [] : [request.prompt], {
        cols: request.cols,
        cwd: this.#projectRoot,
        env: {
          ...environment,
          AGENT_BUNDLE_DEV_SESSION: id,
          COLORTERM: 'truecolor',
          TERM: 'xterm-256color',
        },
        name: 'xterm-256color',
        rows: request.rows,
      });
    } catch (error) {
      if (error instanceof HostSessionError) throw error;
      throw new HostSessionError(
        HOST_SESSION_NOT_LAUNCHABLE_CODE,
        `Failed to launch ${request.host}: ${error instanceof Error ? error.message : String(error)}`,
        409,
      );
    }
    const record: SessionRecord = {
      cols: request.cols,
      epochId: attached.epochId,
      exited: Promise.withResolvers<void>(),
      host: request.host,
      id,
      install: attached.destination,
      listeners: new Set(),
      output: [],
      outputBytes: 0,
      process,
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.restartOf === undefined ? {} : { restartOf: request.restartOf }),
      rows: request.rows,
      startedAt: this.#now(),
      state: 'running',
      terminating: false,
    };
    this.#sessions.set(id, record);
    process.onData((data) => this.#output(record, Buffer.from(data)));
    process.onExit((event) => this.#exit(record, event.exitCode, signalName(event.signal)));
    this.#publish(record, 'session.started', 'running');
    return this.#snapshot(record);
  }

  input(id: string, data: string): void {
    const record = this.#running(id);
    if (Buffer.byteLength(data, 'utf8') > inputByteLimit) {
      throw new HostSessionError(HOST_SESSION_MALFORMED_CODE, 'Host-session input exceeds 16 KiB.', 400);
    }
    record.process.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const record = this.#running(id);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 500 || rows < 1 || rows > 500) {
      throw new HostSessionError(HOST_SESSION_MALFORMED_CODE, 'Host-session dimensions must be integers between 1 and 500.', 400);
    }
    record.cols = cols;
    record.rows = rows;
    record.process.resize(cols, rows);
    this.#send(record, { session: this.#snapshot(record), type: 'state' });
  }

  async terminate(id: string): Promise<HostSession> {
    const record = this.#known(id);
    if (record.state !== 'running') return this.#snapshot(record);
    if (!record.terminating) {
      record.terminating = true;
      record.process.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (record.state === 'running') record.process.kill('SIGKILL');
      }, this.#terminationGraceMs);
      await record.exited.promise;
      clearTimeout(timer);
    } else {
      await record.exited.promise;
    }
    return this.#snapshot(record);
  }

  async restart(id: string, size: Readonly<{ readonly cols: number; readonly rows: number }>): Promise<HostSession> {
    const previous = this.#known(id);
    if (previous.state === 'running') await this.terminate(id);
    return this.create({
      cols: size.cols,
      host: previous.host,
      ...(previous.prompt === undefined ? {} : { prompt: previous.prompt }),
      restartOf: id,
      rows: size.rows,
    });
  }

  forget(id: string): boolean {
    const record = this.#known(id);
    if (record.state === 'running') {
      throw new HostSessionError(HOST_SESSION_MALFORMED_CODE, 'A live host session cannot be forgotten.', 409);
    }
    return this.#sessions.delete(id);
  }

  subscribe(id: string, listener: (message: HostSessionStreamMessage) => void): () => void {
    const record = this.#known(id);
    listener({ session: this.#snapshot(record), type: 'state' });
    for (const output of record.output) listener({ data: output.toString('base64'), type: 'output' });
    if (record.state === 'running') record.listeners.add(listener);
    else listener({ session: this.#snapshot(record), type: 'end' });
    return () => record.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#sessions.values()]
      .filter((record) => record.state === 'running')
      .map((record) => this.terminate(record.id)));
  }

  #adapter(): PtyAdapter {
    if (this.#pty !== undefined) return this.#pty;
    try {
      this.#pty = this.#loadPty(this.#projectRoot);
      return this.#pty;
    } catch {
      throw new HostSessionError(HOST_SESSION_PTY_UNAVAILABLE_CODE, 'PTY module @lydell/node-pty is unavailable.', 503);
    }
  }

  #known(id: string): SessionRecord {
    const record = this.#sessions.get(id);
    if (record === undefined) throw new HostSessionError(HOST_SESSION_UNKNOWN_CODE, `Host session ${JSON.stringify(id)} was not found.`, 404);
    return record;
  }

  #running(id: string): SessionRecord {
    const record = this.#known(id);
    if (record.state !== 'running') throw new HostSessionError(HOST_SESSION_MALFORMED_CODE, 'Host session is not running.', 409);
    return record;
  }

  #snapshot(record: SessionRecord): HostSession {
    return Object.freeze({
      authority: Object.freeze({ epochId: record.epochId, install: record.install, projectRoot: this.#projectRoot }),
      cols: record.cols,
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      host: record.host,
      id: record.id,
      ...(record.state === 'running' ? { pid: record.process.pid } : {}),
      ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
      ...(record.restartOf === undefined ? {} : { restartOf: record.restartOf }),
      rows: record.rows,
      startedAt: record.startedAt,
      state: record.state,
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      ...(record.traceSessionId === undefined ? {} : { traceSessionId: record.traceSessionId }),
    });
  }

  #output(record: SessionRecord, chunk: Buffer): void {
    const retained = chunk.byteLength > this.#scrollbackBytes ? chunk.subarray(chunk.byteLength - this.#scrollbackBytes) : chunk;
    record.output.push(Buffer.from(retained));
    record.outputBytes += retained.byteLength;
    while (record.outputBytes > this.#scrollbackBytes && record.output.length > 1) {
      record.outputBytes -= record.output.shift()!.byteLength;
    }
    const excess = record.outputBytes - this.#scrollbackBytes;
    if (excess > 0 && record.output[0] !== undefined) {
      record.output[0] = record.output[0].subarray(excess);
      record.outputBytes -= excess;
    }
    this.#send(record, { data: chunk.toString('base64'), type: 'output' });
  }

  #exit(record: SessionRecord, exitCode: number, signal: string | undefined): void {
    if (record.state !== 'running') return;
    record.state = record.terminating ? 'terminated' : 'exited';
    record.endedAt = this.#now();
    record.exitCode = exitCode;
    record.signal = signal;
    const session = this.#snapshot(record);
    this.#send(record, { session, type: 'state' });
    this.#send(record, { session, type: 'end' });
    record.listeners.clear();
    record.exited.resolve();
    this.#publish(record, record.terminating ? 'session.terminated' : 'session.exited', 'ok');
  }

  #send(record: SessionRecord, message: HostSessionStreamMessage): void {
    for (const listener of record.listeners) listener(message);
  }

  #publish(
    record: SessionRecord,
    kind: string,
    status: 'running' | 'ok',
    extras: Readonly<{ readonly hostSessionId?: string }> = {},
  ): void {
    this.#trace?.publish({
      correlation: { epochId: record.epochId, host: record.host, sessionId: this.traceSessionId(record.id) },
      details: {
        ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
        host: record.host,
        ...(extras.hostSessionId === undefined ? {} : { hostSessionId: extras.hostSessionId }),
        ...(record.state === 'running' ? { pid: record.process.pid } : {}),
        ...(record.restartOf === undefined ? {} : { restartOf: record.restartOf }),
        ...(record.signal === undefined ? {} : { signal: record.signal }),
      },
      href: `/sessions?session=${record.id}`,
      kind,
      source: 'session',
      status,
      summary: `${record.host} session ${record.state}`,
    });
  }
}
