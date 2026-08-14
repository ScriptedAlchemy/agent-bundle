import chokidar from 'chokidar';
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
  readonly root: string;
}

const sourceEvents: readonly SourceWatchEvent[] = ['add', 'addDir', 'change', 'unlink', 'unlinkDir'];
const excludedDirectoryNames = new Set(['.agent-bundle', '.git', 'node_modules']);

const relativePath = (root: string, path: string): string | undefined => {
  const value = relative(root, resolve(root, path)).replaceAll('\\', '/');
  return value === '..' || value.startsWith('../') ? undefined : value;
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
  readonly #paths = new Set<string>();
  readonly #ready: Promise<void>;
  readonly #root: string;
  readonly #watcher: SourceWatcher;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #delivery: Promise<unknown> = Promise.resolve();
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
    const ignoredPaths = new Set([...(options.ignoredPaths ?? []), ...(options.outputPaths ?? ['dist'])]
      .map((path) => relativePath(this.#root, path))
      .filter((path): path is string => path !== undefined));
    this.#ignored = (path) => {
      const source = relativePath(this.#root, path);
      if (source === undefined) return true;
      const parts = source.split('/');
      return parts.some((part) => excludedDirectoryNames.has(part)) ||
        [...ignoredPaths].some((ignored) => source === ignored || source.startsWith(`${ignored}/`)) ||
        (source.length > 0 && options.isIgnored?.(resolve(this.#root, path)) === true);
    };
    let resolveReady: (() => void) | undefined;
    this.#ready = new Promise<void>((resolvePromise) => {
      resolveReady = resolvePromise;
    });
    this.#watcher = (options.createWatcher ?? defaultWatcher)(this.#root, { ignored: this.#ignored });
    for (const event of sourceEvents) this.#watcher.on(event, (path) => this.#record(path));
    if (options.createWatcher === undefined) {
      this.#watcher.on('ready', () => resolveReady?.());
    } else {
      resolveReady?.();
    }
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  async flush(): Promise<void> {
    if (this.#closed) return;
    this.#clearTimer();
    if (this.#paths.size === 0) return;
    const invalidation = freezeInvalidation({
      occurredAt: this.#now().toISOString(),
      paths: Object.freeze([...this.#paths].sort((left, right) => left.localeCompare(right))),
      reason: 'source-change',
    });
    this.#paths.clear();
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
    await this.#delivery;
    await this.#watcher.close();
  }
}
