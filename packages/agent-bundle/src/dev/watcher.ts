import chokidar from 'chokidar';
import { stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { freezeInvalidation, type Invalidation } from './types.ts';

export type SourceWatchEvent = 'add' | 'addDir' | 'change' | 'ready' | 'unlink' | 'unlinkDir';

export interface SourceWatcher {
  close(): Promise<void>;
  on(event: SourceWatchEvent, listener: (path: string) => void): SourceWatcher;
}

export interface ProjectWatcherOptions {
  readonly createWatcher?: (root: string, options: Readonly<{ readonly ignored: (path: string) => boolean }>) => SourceWatcher;
  readonly debounceMs?: number;
  readonly ignoredPaths?: readonly string[];
  readonly isIgnored?: (source: string) => boolean;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  readonly onInvalidation: (invalidation: Invalidation) => Promise<unknown>;
  readonly outputPaths?: readonly string[];
  readonly readPathSignature?: (path: string) => Promise<string | undefined>;
  readonly root: string;
}

const sourceEvents: readonly SourceWatchEvent[] = ['add', 'addDir', 'change', 'unlink', 'unlinkDir'];
const excludedDirectoryNames = new Set(['.agent-bundle', '.git', 'node_modules']);
const deletedPathSignature = 'deleted';

const relativePath = (root: string, path: string): string | undefined => {
  const value = relative(root, resolve(root, path)).replaceAll('\\', '/');
  return value === '..' || value.startsWith('../') ? undefined : value;
};

const defaultPathSignature = async (path: string): Promise<string | undefined> => {
  try {
    const source = await stat(path, { bigint: true });
    return `${source.dev}:${source.ino}:${source.size}:${source.mtimeNs}:${source.mode}:${source.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const defaultWatcher = (
  root: string,
  options: Readonly<{ readonly ignored: (path: string) => boolean }>,
): SourceWatcher => {
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: options.ignored,
    persistent: true,
  });
  const sourceWatcher: SourceWatcher = {
    close: async () => watcher.close(),
    on: (event, listener) => {
      if (event === 'ready') {
        watcher.on('ready', () => listener(''));
      } else {
        watcher.on(event, (path: string) => listener(path));
      }
      return sourceWatcher;
    },
  };
  return sourceWatcher;
};

/** Broad project watcher which emits stable debounced source invalidations. */
export class ProjectWatcher {
  readonly #debounceMs: number;
  readonly #ignored: (path: string) => boolean;
  readonly #now: () => Date;
  readonly #onError?: (error: unknown) => void;
  readonly #onInvalidation: (invalidation: Invalidation) => Promise<unknown>;
  readonly #outputPaths = new Set<string>();
  readonly #paths = new Set<string>();
  readonly #readPathSignature: (path: string) => Promise<string | undefined>;
  readonly #ready: Promise<void>;
  readonly #root: string;
  readonly #signatures = new Map<string, string>();
  readonly #watcher: SourceWatcher;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #delivery: Promise<unknown> = Promise.resolve();
  #flushTail: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ProjectWatcherOptions) {
    if (!Number.isSafeInteger(options.debounceMs ?? 100) || (options.debounceMs ?? 100) < 0) {
      throw new RangeError('debounceMs must be a non-negative safe integer.');
    }
    this.#debounceMs = options.debounceMs ?? 100;
    this.#root = resolve(options.root);
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError;
    this.#onInvalidation = options.onInvalidation;
    this.#readPathSignature = options.readPathSignature ?? defaultPathSignature;
    this.addOutputPaths([...(options.ignoredPaths ?? []), ...(options.outputPaths ?? ['dist'])]);
    this.#ignored = (path) => {
      const source = relativePath(this.#root, path);
      if (source === undefined) return true;
      if (source.split('/').some((part) => excludedDirectoryNames.has(part))) return true;
      for (const ignored of this.#outputPaths) {
        if (source === ignored || source.startsWith(`${ignored}/`)) return true;
      }
      return source.length > 0 && options.isIgnored?.(resolve(this.#root, path)) === true;
    };
    const ready = Promise.withResolvers<void>();
    this.#ready = ready.promise;
    this.#watcher = (options.createWatcher ?? defaultWatcher)(this.#root, { ignored: this.#ignored });
    for (const event of sourceEvents) this.#watcher.on(event, (path) => this.#record(path));
    if (options.createWatcher === undefined) {
      this.#watcher.on('ready', () => ready.resolve());
    } else {
      ready.resolve();
    }
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  /** Adds generated roots discovered after a configuration recovery without replacing the live watcher. */
  addOutputPaths(paths: readonly string[]): void {
    for (const path of paths) {
      const relativeOutput = relativePath(this.#root, path);
      if (relativeOutput !== undefined && relativeOutput.length > 0) this.#outputPaths.add(relativeOutput);
    }
  }

  flush(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#clearTimer();
    if (this.#paths.size === 0) return this.#flushTail;
    const paths = [...this.#paths].sort((left, right) => left.localeCompare(right));
    this.#paths.clear();
    const flush = this.#flushTail.then(async () => this.#flushPaths(paths));
    this.#flushTail = flush.catch(() => undefined);
    return flush;
  }

  async #flushPaths(paths: readonly string[]): Promise<void> {
    const signatures = await Promise.all(paths.map(async (path) => Object.freeze({
      path,
      signature: await this.#readPathSignature(resolve(this.#root, path)),
    })));
    const changedPaths: string[] = [];
    for (const { path, signature } of signatures) {
      const normalizedSignature = signature ?? deletedPathSignature;
      if (this.#signatures.has(path) && this.#signatures.get(path) === normalizedSignature) continue;
      changedPaths.push(path);
      this.#signatures.set(path, normalizedSignature);
    }
    if (changedPaths.length === 0) return;
    const invalidation = freezeInvalidation({
      occurredAt: this.#now().toISOString(),
      paths: Object.freeze(changedPaths),
      reason: 'source-change',
    });
    this.#delivery = Promise.resolve(this.#onInvalidation(invalidation));
    await this.#delivery;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#clearTimer();
    this.#paths.clear();
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  #record(path: string): void {
    if (this.#closed || this.#ignored(path)) return;
    const source = relativePath(this.#root, path);
    if (source === undefined || source.length === 0) return;
    this.#paths.add(source);
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      void this.flush().catch((error: unknown) => this.#onError?.(error));
    }, this.#debounceMs);
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #close(): Promise<void> {
    await this.#flushTail;
    await this.#delivery;
    await this.#watcher.close();
  }
}
