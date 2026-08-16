import type { DevRuntimeMcpAppRunBinding } from '../../../agent-bundle/src/dev/runtime-protocol.ts';

import type { McpPagePreviewSelection, McpPageSource } from './mcp-page.tsx';
import type { RuntimeAppPreviewProps } from '../runtime-stage.tsx';

export type RuntimeMcpHandoff = Readonly<{
  readonly initialPreview?: Extract<McpPagePreviewSelection, { readonly kind: 'runtime' }>;
  readonly source: Extract<McpPageSource, { readonly kind: 'runtime' }>;
}>;

export type RuntimeHandoffAuthority = Readonly<{
  readonly handoff: Required<RuntimeMcpHandoff>;
  readonly key: string;
}>;

export interface RuntimeHandoffLifecycle {
  close(): Promise<void>;
}

type RuntimePreviewLifecycleRecord = Readonly<{
  readonly authority: RuntimeHandoffAuthority;
  readonly registration: number;
  readonly handle: RuntimeHandoffLifecycle;
}>;

type RuntimeHandoffAttempt = Readonly<{
  readonly generation: number;
  readonly record: RuntimePreviewLifecycleRecord;
}>;

export interface RuntimeMcpHandoffCoordinatorOptions {
  readonly commit: (handoff: Required<RuntimeMcpHandoff>) => void;
  readonly reject: (reason: unknown) => void;
}

const maximumDepth = 32;
const maximumNodes = 4_096;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const stateVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Reads only authority evidence as own data descriptors; lifecycle callbacks never cross this boundary. */
const authorityEvidence = (value: unknown): unknown | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of ['profile', 'profileId', 'run', 'surface'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      Object.defineProperty(copy, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false,
      });
    }
    return Object.freeze(copy);
  } catch {
    return undefined;
  }
};

const sameLifecycle = (
  left: RuntimePreviewLifecycleRecord | undefined,
  right: RuntimePreviewLifecycleRecord | undefined,
): boolean => left !== undefined && right !== undefined && left.handle === right.handle && left.authority.key === right.authority.key;

/** Copies untrusted model evidence into immutable, prototype-inert JSON data. */
const detach = (
  value: unknown,
  ancestors = new WeakSet<object>(),
  state = { nodes: 0 },
  depth = 0,
): unknown | undefined => {
  state.nodes += 1;
  if (depth > maximumDepth || state.nodes > maximumNodes) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || ancestors.has(value)) return undefined;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(value).length !== length + 1) return undefined;
      const copy: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined;
        const entry = detach(descriptor.value, ancestors, state, depth + 1);
        if (entry === undefined) return undefined;
        copy.push(entry);
      }
      return Object.freeze(copy);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      const entry = detach(descriptor.value, ancestors, state, depth + 1);
      if (entry === undefined) return undefined;
      Object.defineProperty(copy, key, { configurable: false, enumerable: true, value: entry, writable: false });
    }
    return Object.freeze(copy);
  } catch {
    return undefined;
  } finally {
    ancestors.delete(value);
  }
};

export const sameRuntimeMcpAppBinding = (left: DevRuntimeMcpAppRunBinding, right: DevRuntimeMcpAppRunBinding): boolean =>
  left.definitionDigest === right.definitionDigest &&
  left.registryRevision === right.registryRevision &&
  left.serverDigest === right.serverDigest &&
  left.serverName === right.serverName &&
  left.sessionId === right.sessionId &&
  left.sessionRevision === right.sessionRevision &&
  left.target === right.target &&
  left.transportDigest === right.transportDigest;

/** Produces the only runtime App evidence allowed to cross the host handoff boundary. */
export const prepareRuntimeMcpHandoffAuthority = (
  props: RuntimeAppPreviewProps,
  isProfileId: (value: string) => boolean,
): RuntimeHandoffAuthority | undefined => {
  const snapshot = detach(authorityEvidence(props));
  const outer = record(snapshot);
  const profile = outer === undefined ? undefined : record(outer.profile);
  const run = outer === undefined ? undefined : record(outer.run);
  const surface = outer === undefined ? undefined : record(outer.surface);
  const result = run === undefined ? undefined : record(run.result);
  const app = result === undefined ? undefined : record(result.app);
  const binding = app === undefined ? undefined : record(app.mcpBinding);
  const vector = run === undefined ? undefined : record(run.vector);
  if (
    outer === undefined || profile === undefined || run === undefined || surface === undefined || app === undefined || binding === undefined || vector === undefined ||
    !text(outer.profileId) || !text(profile.id) || !text(profile.version) || !text(run.id) || run.status !== 'succeeded' || !text(run.surfaceId) || !text(surface.id) ||
    !text(app.resourceUri) || !text(app.surfaceId) ||
    !text(vector.providerSessionId) || !text(vector.runtimeGenerationId) || !text(vector.sourceRevision) || !text(vector.stateStoreId) || !stateVersion(vector.stateVersion) ||
    !text(binding.definitionDigest) || !revision(binding.registryRevision) || !text(binding.serverDigest) || !text(binding.serverName) || !text(binding.sessionId) ||
    !revision(binding.sessionRevision) || !text(binding.target) || !text(binding.transportDigest)
  ) return undefined;
  const preview = snapshot as RuntimeAppPreviewProps;
  if (!isProfileId(preview.profileId) || preview.profile.id !== preview.profileId || preview.run.surfaceId !== preview.surface.id) {
    return undefined;
  }
  const typedApp = preview.run.result?.app;
  if (typedApp === undefined) return undefined;
  const typedBinding = typedApp.mcpBinding;
  const typedVector = preview.run.vector;
  // McpPage deliberately admits only ordinary own-data shells at its boundary.
  // Their values remain the detached, null-prototype evidence above.
  const handoffBinding = Object.freeze({
    definitionDigest: typedBinding.definitionDigest,
    registryRevision: typedBinding.registryRevision,
    serverDigest: typedBinding.serverDigest,
    serverName: typedBinding.serverName,
    sessionId: typedBinding.sessionId,
    sessionRevision: typedBinding.sessionRevision,
    target: typedBinding.target,
    transportDigest: typedBinding.transportDigest,
  });
  const handoffPreview = Object.freeze({
    profile: preview.profile,
    profileId: preview.profileId,
    run: preview.run,
    surface: preview.surface,
  }) as RuntimeAppPreviewProps;
  return Object.freeze({
    handoff: Object.freeze({
      initialPreview: Object.freeze({ binding: handoffBinding, kind: 'runtime' as const, preview: handoffPreview }),
      source: Object.freeze({ binding: handoffBinding, kind: 'runtime' as const }),
    }),
    key: [
      preview.run.id,
      preview.profile.id,
      preview.profile.version,
      preview.surface.id,
      typedApp.surfaceId,
      typedApp.resourceUri,
      typedVector.providerSessionId,
      typedVector.runtimeGenerationId,
      typedVector.sourceRevision,
      typedVector.stateStoreId,
      typedVector.stateVersion,
      typedBinding.definitionDigest,
      typedBinding.registryRevision,
      typedBinding.serverDigest,
      typedBinding.serverName,
      typedBinding.sessionId,
      typedBinding.sessionRevision,
      typedBinding.target,
      typedBinding.transportDigest,
    ].join('\u0000'),
  });
};

/** Serializes one host-owned Runtime App handoff without retaining React state. */
export class RuntimeMcpHandoffCoordinator {
  readonly #listeners = new Set<() => void>();
  readonly #options: RuntimeMcpHandoffCoordinatorOptions;
  #attempt: RuntimeHandoffAttempt | undefined;
  #generation = 0;
  #registration = 0;
  #record: RuntimePreviewLifecycleRecord | undefined;

  constructor(options: RuntimeMcpHandoffCoordinatorOptions) {
    this.#options = options;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  register(handle: RuntimeHandoffLifecycle, authority: RuntimeHandoffAuthority): () => void {
    const previous = this.#record;
    const record = Object.freeze({ authority, handle, registration: ++this.#registration });
    if (!sameLifecycle(previous, record)) this.#generation += 1;
    this.#record = record;
    this.#notify();
    return () => { queueMicrotask(() => this.#unregister(record)); };
  }

  canOpen(authority: RuntimeHandoffAuthority): boolean {
    return this.#attempt === undefined && this.#record?.authority.key === authority.key;
  }

  open(authority: RuntimeHandoffAuthority): void {
    const record = this.#record;
    if (record === undefined || record.authority.key !== authority.key || this.#attempt !== undefined) return;
    const attempt = Object.freeze({ generation: this.#generation, record });
    this.#attempt = attempt;
    this.#notify();
    void record.handle.close().then(() => {
      if (!this.#isCurrent(attempt)) return;
      this.#record = undefined;
      this.#options.commit(record.authority.handoff);
    }, (reason: unknown) => {
      if (this.#isCurrent(attempt)) this.#options.reject(reason);
    }).finally(() => {
      if (this.#attempt !== attempt) return;
      this.#attempt = undefined;
      this.#notify();
    });
  }

  /** Fences held closes and discards any current lifecycle on reset or navigation. */
  cancel(): void {
    this.#generation += 1;
    this.#attempt = undefined;
    this.#record = undefined;
    this.#notify();
  }

  /** Shutdown revokes future admission before awaiting the latest retained lifecycle close. */
  close(): Promise<void> {
    const record = this.#record;
    this.cancel();
    return record === undefined ? Promise.resolve() : record.handle.close();
  }

  #isCurrent(attempt: RuntimeHandoffAttempt): boolean {
    return this.#attempt === attempt && this.#generation === attempt.generation && sameLifecycle(this.#record, attempt.record);
  }

  #unregister(record: RuntimePreviewLifecycleRecord): void {
    if (this.#record !== record || sameLifecycle(this.#attempt?.record, record)) return;
    this.#generation += 1;
    this.#record = undefined;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // An observer cannot break lifecycle authority for another observer.
      }
    }
  }
}
