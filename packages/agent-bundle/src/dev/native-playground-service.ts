import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { digest, stableJson } from '../core/digest.ts';
import { isJsonRecord as isRecord, parseJsonWithoutDuplicateKeys, snapshotStrictJsonValue, type JsonValue } from '../core/strict-json.ts';
import { loadConfig } from '../config/load.ts';
import { prepareEvalArtifact, type PreparedEvalArtifact } from '../eval/artifact.ts';
import { runClaudeTrial } from '../eval/claude-harness.ts';
import { runCodexEvalTrial } from '../eval/codex-harness.ts';
import { normalizeEvalConfig } from '../eval/config.ts';
import { discoverEvalSuites } from '../eval/discovery.ts';
import { planEvalFixture } from '../eval/fixtures.ts';
import type { EvalTrialRecord } from '../eval/run-store.ts';
import { normalizeEvalCase } from '../eval/suite.ts';
import type { PlaygroundEventInput } from '../services/playground-service.ts';
import { workspaceDiff, type WorkspaceDiff } from '../eval/workspace-diff.ts';
import { isInsideOrEqual } from '../core/paths.ts';
import { isErrno, isTolerableWin32SyncError } from '../core/errors.ts';
import {
  DiscardingTrialWriter,
  hardcodedProgress,
  normalizedTrialEvents,
  safeResponse,
  workspaceEvidence,
} from './native-playground-evidence.ts';
import {
  catalogSelectionIdentity,
  hasExactKeys,
  hasCanonicalSelectionIdentity,
  maximumCatalogSelections,
  maximumCatalogSnapshotBytes,
  nativePlaygroundHosts,
  persistedSelection,
  relativePathInside,
  resolveContainedPath,
  selectionKey,
  withinCatalogSnapshotNodeBudget,
  type CatalogSelection,
  type PersistedCatalogSelection,
  type PersistedCatalogSnapshot,
} from './native-playground-catalog.ts';

import type {
  NativePlaygroundCatalog,
  NativePlaygroundCatalogItem,
  NativePlaygroundCatalogPublicationOptions,
  NativePlaygroundCatalogPublicationReceipt,
  NativePlaygroundCatalogStorage,
  NativePlaygroundEpochReference,
  NativePlaygroundHost,
  NativePlaygroundModelPin,
  NativePlaygroundPrepared,
  NativePlaygroundProgress,
  NativePlaygroundRequest,
  NativePlaygroundRunResult,
  NativePlaygroundServiceOptions,
} from './native-playground-types.ts';

export type * from './native-playground-types.ts';

interface CatalogSnapshot {
  readonly artifact: Pick<PreparedEvalArtifact, 'binding' | 'root'>;
  readonly catalog: NativePlaygroundCatalog;
  readonly selections: ReadonlyMap<string, CatalogSelection>;
}

interface SidecarFile {
  readonly identity: string;
  readonly raw: string;
}

interface PersistedCatalogPublication {
  readonly receipt: NativePlaygroundCatalogPublicationReceipt;
  readonly snapshot: PersistedCatalogSnapshot;
}


const catalogDurabilityPlatformKey = Symbol.for('agent-bundle.native-playground-service.catalog-durability-platform');
const safeEpochSegment = /^[a-z0-9][a-z0-9._-]*$/iu;

const catalogDurabilityPlatform = (): NodeJS.Platform => {
  if (process.env.NODE_ENV !== 'test') return process.platform;
  const platforms = globalThis as typeof globalThis & Record<symbol, NodeJS.Platform | undefined>;
  return platforms[catalogDurabilityPlatformKey] ?? process.platform;
};


/**
 * The native Playground adapter only resolves immutable server-owned catalog
 * selections and drives the established host harnesses. Durable Playground
 * admission, append ordering, cancellation, terminalization, and epoch leases
 * remain in PlaygroundOrchestrationService.
 */
export class NativePlaygroundService {
  readonly #catalogDirectory: string | undefined;
  readonly #catalogStorage: NativePlaygroundCatalogStorage;
  readonly #catalogs = new Map<string, Promise<CatalogSnapshot>>();
  readonly #catalogPublications = new Map<string, NativePlaygroundCatalogPublicationReceipt>();
  /** Abort listeners run synchronously and cannot await the close they help complete. */
  readonly #abortReentryCompletion = Promise.resolve();
  readonly #controllers = new Set<AbortController>();
  readonly #runs = new Set<Promise<NativePlaygroundRunResult>>();
  readonly #discover: NonNullable<NativePlaygroundServiceOptions['discover']>;
  readonly #environment: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly #inspectArtifact: NonNullable<NativePlaygroundServiceOptions['inspectArtifact']>;
  readonly #native: NativePlaygroundServiceOptions['native'];
  readonly #planFixture: NonNullable<NativePlaygroundServiceOptions['planFixture']>;
  readonly #projectRoot: string;
  #abortDispatchDepth = 0;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: NativePlaygroundServiceOptions) {
    this.#catalogDirectory = options.catalogDirectory;
    this.#catalogStorage = options.catalogStorage ?? Object.freeze({ link, mkdir, open, rename, remove: rm });
    this.#projectRoot = options.projectRoot;
    this.#environment = options.environment;
    this.#native = options.native;
    this.#discover = options.discover ?? (async (projectRoot) => {
      const loaded = await loadConfig({ command: 'eval', mode: 'development', root: projectRoot });
      return discoverEvalSuites({ config: normalizeEvalConfig(loaded.config.evals), projectRoot });
    });
    this.#inspectArtifact = options.inspectArtifact ?? (async (reference) =>
      prepareEvalArtifact({ artifact: reference.root, projectRoot: this.#projectRoot, runDirectory: reference.root }));
    this.#planFixture = options.planFixture ?? planEvalFixture;
  }

  async catalog(reference: NativePlaygroundEpochReference): Promise<NativePlaygroundCatalog> {
    this.#assertOpen();
    return (await this.#snapshot(reference)).catalog;
  }

  /** Captures an epoch publication receipt without exposing native catalog contents. */
  async publishCatalogSnapshot(reference: NativePlaygroundEpochReference): Promise<NativePlaygroundCatalogPublicationReceipt> {
    this.#assertOpen();
    await this.#snapshot(reference);
    return this.#catalogPublications.get(reference.epoch.id) ?? await this.#acceptedPublicationReceipt(reference);
  }

  async prepare(
    reference: NativePlaygroundEpochReference,
    request: NativePlaygroundRequest,
  ): Promise<NativePlaygroundPrepared> {
    this.#assertOpen();
    if (request.epochId !== undefined && request.epochId !== reference.epoch.id) {
      throw new Error('Native Playground catalog selection is not bound to the requested epoch.');
    }
    const snapshot = await this.#snapshot(reference);
    const selected = snapshot.selections.get(selectionKey(request));
    if (
      selected === undefined ||
      selected.fixtureId !== request.fixtureId ||
      selected.host !== request.host ||
      selected.modelPinId !== request.modelPinId ||
      !nativePlaygroundHosts.has(request.host) ||
      snapshot.artifact.binding.targetDigests[request.target] === undefined
    ) {
      throw new Error('Native Playground catalog selection is not available for this exact epoch.');
    }
    return Object.freeze({
      artifact: snapshot.artifact,
      epochId: reference.epoch.id,
      evalCase: Object.freeze({ ...selected.evalCase, prompt: request.prompt }),
      fixtureDigest: selected.fixturePlan.digest,
      fixturePlan: selected.fixturePlan,
      host: selected.host,
      prompt: request.prompt,
      suiteDir: selected.suiteDir,
      target: request.target,
    });
  }

  run(
    prepared: NativePlaygroundPrepared,
    options: Readonly<{
      readonly emit: (event: PlaygroundEventInput) => Promise<void>;
      readonly signal: AbortSignal;
    }>,
  ): Promise<NativePlaygroundRunResult> {
    this.#assertOpen();
    const controller = new AbortController();
    const externalSignal = options.signal;
    const abortFromExternal = (): void => this.#dispatchAbort(controller, externalSignal.reason);
    if (externalSignal.aborted) abortFromExternal();
    else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    this.#controllers.add(controller);
    const running = this.#run(prepared, Object.freeze({ ...options, signal: controller.signal })).finally(() => {
      externalSignal.removeEventListener('abort', abortFromExternal);
      this.#controllers.delete(controller);
      this.#runs.delete(running);
    });
    this.#runs.add(running);
    return running;
  }

  async #run(
    prepared: NativePlaygroundPrepared,
    options: Readonly<{
      readonly emit: (event: PlaygroundEventInput) => Promise<void>;
      readonly signal: AbortSignal;
    }>,
  ): Promise<NativePlaygroundRunResult> {
    const signal = options.signal;
    const nativeRoot = await this.#createWorkspaceRoot();
    let completedResponse: string | undefined;
    let completedWorkspace: WorkspaceDiff | undefined;
    let completedHooks: readonly string[] = Object.freeze([]);
    const onProgress = async (phase: NativePlaygroundProgress): Promise<void> => {
      await options.emit(hardcodedProgress(phase));
    };
    const onCompleted = async (result: Readonly<{
      readonly hookEvents?: readonly string[];
      readonly response?: string;
      readonly workspacePath?: string;
    }>): Promise<void> => {
      if (result.hookEvents !== undefined) completedHooks = Object.freeze([...result.hookEvents]);
      if (result.response !== undefined) completedResponse = safeResponse(result.response);
      if (result.workspacePath !== undefined) completedWorkspace = await this.#workspaceDiff(result.workspacePath, prepared);
    };
    try {
      const writer = new DiscardingTrialWriter();
      let trial: EvalTrialRecord;
      if (prepared.host === 'claude') {
        trial = await runClaudeTrial({
          artifact: prepared.artifact as PreparedEvalArtifact,
          ...(this.#environment === undefined ? {} : { environment: this.#environment }),
          evalCase: prepared.evalCase,
          fixturePlan: prepared.fixturePlan,
          host: prepared.host,
          ...(this.#native?.claudeRun === undefined ? {} : { run: this.#native.claudeRun }),
          onCompleted,
          onProgress,
          signal,
          suiteDir: prepared.suiteDir,
          target: prepared.target,
          trialIndex: 0,
          workspaceRoot: nativeRoot,
          writer,
        });
      } else {
        trial = await runCodexEvalTrial({
          artifact: prepared.artifact,
          ...(this.#environment === undefined ? {} : { environment: this.#environment }),
          evalCase: prepared.evalCase,
          fixturePlan: prepared.fixturePlan,
          host: prepared.host,
          ...(this.#native?.codexRun === undefined ? {} : { run: this.#native.codexRun }),
          onCompleted,
          onProgress,
          signal,
          suiteDir: prepared.suiteDir,
          target: prepared.target,
          trialIndex: 0,
          workspaceRoot: nativeRoot,
          writer,
        });
      }
      return Object.freeze({
        events: normalizedTrialEvents(trial, completedWorkspace, completedHooks, this.#projectRoot, completedResponse),
        ...(completedResponse === undefined ? {} : { response: completedResponse }),
        status: trial.harnessFailure === undefined && trial.outcome === 'pass' ? 'passed' : 'failed',
        ...(completedWorkspace === undefined ? {} : { workspace: workspaceEvidence(completedWorkspace) }),
      });
    } finally {
      await rm(nativeRoot, { force: true, recursive: true });
    }
  }

  close(): Promise<void> {
    if (this.#abortDispatchDepth > 0) return this.#abortReentryCompletion;
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    const closing = Promise.withResolvers<void>();
    this.#closePromise = closing.promise;
    void this.#close().then(closing.resolve, closing.reject);
    return closing.promise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#controllers) {
      this.#dispatchAbort(controller, new Error('Native Playground service is closed.'));
    }
    await Promise.allSettled([...this.#runs, ...this.#catalogs.values()]);
    this.#catalogs.clear();
    this.#catalogPublications.clear();
  }

  #dispatchAbort(controller: AbortController, reason: unknown): void {
    this.#abortDispatchDepth += 1;
    try { controller.abort(reason); }
    finally { this.#abortDispatchDepth -= 1; }
  }

  async #snapshot(reference: NativePlaygroundEpochReference): Promise<CatalogSnapshot> {
    const existing = this.#catalogs.get(reference.epoch.id);
    if (existing !== undefined) return existing;
    const created = this.#createSnapshot(reference);
    this.#catalogs.set(reference.epoch.id, created);
    try { return await created; }
    catch (error) {
      if (this.#catalogs.get(reference.epoch.id) === created) this.#catalogs.delete(reference.epoch.id);
      throw error;
    }
  }

  async #createSnapshot(reference: NativePlaygroundEpochReference): Promise<CatalogSnapshot> {
    const artifact = await this.#inspectArtifact(reference);
    const persisted = await this.#readSnapshot(reference);
    this.#assertOpen();
    const discovered = persisted ?? await this.#discoverSnapshot(reference);
    this.#assertOpen();
    const publication = persisted === undefined ? await this.#persistSnapshot(reference, discovered) : undefined;
    const snapshot = publication?.snapshot ?? persisted;
    if (snapshot === undefined) throw new Error('Native Playground catalog snapshot could not be persisted.');
    const receipt = publication?.receipt ?? await this.#acceptedPublicationReceipt(reference);
    this.#catalogPublications.set(reference.epoch.id, receipt);
    try {
      this.#assertOpen();
      return await this.#hydrateSnapshot(artifact, snapshot);
    } catch (error) {
      return this.#rollbackPublicationAndThrow(receipt, error, 'Native Playground catalog hydration and rollback both failed.');
    }
  }

  async #discoverSnapshot(reference: NativePlaygroundEpochReference): Promise<PersistedCatalogSnapshot> {
    const suites = await this.#discover(this.#projectRoot);
    const selections: PersistedCatalogSelection[] = [];
    for (const discovered of suites) {
      for (const evalCase of discovered.suite.cases) {
        const fixturePlan = await this.#planFixture({ baseDir: this.#suiteDirectory(discovered.sourcePath), fixture: evalCase.fixture });
        const suiteDir = this.#suiteDirectory(discovered.sourcePath);
        const persistedEvalCase = normalizeEvalCase({
          ...evalCase,
          fixture: Object.freeze({
            ...evalCase.fixture,
            path: relativePathInside(suiteDir, resolve(suiteDir, evalCase.fixture.path), true),
          }),
        });
        const persistedFixturePlan = Object.freeze({
          digest: fixturePlan.digest,
          entries: Object.freeze(fixturePlan.entries.map((entry) => Object.freeze({ ...entry }))),
          git: fixturePlan.git,
          sourcePath: relativePathInside(suiteDir, fixturePlan.sourcePath, true),
        });
        for (const host of Object.keys(evalCase.hosts).filter((host): host is NativePlaygroundHost => nativePlaygroundHosts.has(host as NativePlaygroundHost)).sort()) {
          const identity = catalogSelectionIdentity({
            epoch: reference.epoch,
            evalCase: persistedEvalCase,
            fixturePlan: persistedFixturePlan,
            host,
            suiteDigest: discovered.suite.digest,
            suiteName: discovered.suite.name,
          });
          selections.push(Object.freeze({
            caseId: identity.caseId,
            caseLabel: identity.caseLabel,
            evalCase: persistedEvalCase,
            fixtureId: identity.fixtureId,
            fixtureLabel: identity.fixtureLabel,
            fixturePlan: persistedFixturePlan,
            host,
            modelPinId: identity.modelPinId,
            modelPinLabel: identity.modelPinLabel,
            suiteDir: relativePathInside(this.#projectRoot, suiteDir, true),
            suiteDigest: discovered.suite.digest,
            suiteName: discovered.suite.name,
          }));
        }
      }
    }
    if (selections.length > maximumCatalogSelections) {
      throw new Error('Native Playground catalog has too many selections.');
    }
    return Object.freeze({
      epochId: reference.epoch.id,
      selections: Object.freeze([...selections].sort((left, right) => selectionKey(left).localeCompare(selectionKey(right)))),
    });
  }

  async #hydrateSnapshot(
    artifact: Pick<PreparedEvalArtifact, 'binding' | 'root'>,
    snapshot: PersistedCatalogSnapshot,
  ): Promise<CatalogSnapshot> {
    const cases = new Map<string, NativePlaygroundCatalogItem>();
    const fixtures = new Map<string, NativePlaygroundCatalogItem>();
    const modelPins = new Map<string, NativePlaygroundModelPin>();
    const selections = new Map<string, CatalogSelection>();
    for (const persisted of snapshot.selections) {
      const selection = await this.#hydrateSelection(persisted);
      const key = selectionKey(selection);
      if (selections.has(key)) throw new Error('Native Playground catalog snapshot contains duplicate selections.');
      cases.set(selection.caseId, Object.freeze({ id: selection.caseId, label: selection.caseLabel }));
      fixtures.set(selection.fixtureId, Object.freeze({ id: selection.fixtureId, label: selection.fixtureLabel }));
      modelPins.set(selection.modelPinId, Object.freeze({
        host: selection.host,
        id: selection.modelPinId,
        label: selection.modelPinLabel,
      }));
      selections.set(key, selection);
    }
    return Object.freeze({
      artifact,
      catalog: Object.freeze({
        cases: Object.freeze([...cases.values()].sort((left, right) => left.id.localeCompare(right.id))),
        epochId: snapshot.epochId,
        fixtures: Object.freeze([...fixtures.values()].sort((left, right) => left.id.localeCompare(right.id))),
        modelPins: Object.freeze([...modelPins.values()].sort((left, right) => left.id.localeCompare(right.id))),
        selections: Object.freeze(snapshot.selections.map((selection) => Object.freeze({
          caseId: selection.caseId,
          fixtureId: selection.fixtureId,
          host: selection.host,
          modelPinId: selection.modelPinId,
        }))),
      }),
      selections,
    });
  }

  async #hydrateSelection(persisted: PersistedCatalogSelection): Promise<CatalogSelection> {
    const suiteDir = resolveContainedPath(this.#projectRoot, persisted.suiteDir, true);
    const sourcePath = resolveContainedPath(suiteDir, persisted.fixturePlan.sourcePath, true);
    await this.#assertLivePath(suiteDir, 'directory', this.#projectRoot);
    await this.#assertLivePath(sourcePath, 'directory', suiteDir);
    const entries = await Promise.all(persisted.fixturePlan.entries.map(async (entry) => {
      const source = resolveContainedPath(sourcePath, entry.path);
      await this.#assertLivePath(source, 'file', sourcePath);
      return Object.freeze({ ...entry });
    }));
    return Object.freeze({
      caseId: persisted.caseId,
      caseLabel: persisted.caseLabel,
      evalCase: persisted.evalCase,
      fixtureId: persisted.fixtureId,
      fixtureLabel: persisted.fixtureLabel,
      fixturePlan: Object.freeze({
        digest: persisted.fixturePlan.digest,
        entries: Object.freeze(entries),
        git: persisted.fixturePlan.git,
        sourcePath,
      }),
      host: persisted.host,
      modelPinId: persisted.modelPinId,
      modelPinLabel: persisted.modelPinLabel,
      suiteDir,
    });
  }

  async #assertLivePath(path: string, kind: 'directory' | 'file', root: string): Promise<void> {
    let metadata;
    try { metadata = await lstat(path); }
    catch (error) {
      // A retained catalog remains browseable after authored sources disappear;
      // materialization will report its existing stable fixture failure later.
      if (isErrno(error, 'ENOENT')) return;
      throw new Error('Native Playground catalog snapshot is invalid.', { cause: error });
    }
    if (metadata.isSymbolicLink() || (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile())) {
      throw new Error('Native Playground catalog snapshot is invalid.');
    }
    try {
      if (!isInsideOrEqual(await realpath(root), await realpath(path))) {
        throw new Error('Native Playground catalog snapshot is invalid.');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Native Playground catalog snapshot is invalid.') throw error;
      throw new Error('Native Playground catalog snapshot is invalid.', { cause: error });
    }
  }

  async #readSnapshot(reference: NativePlaygroundEpochReference): Promise<PersistedCatalogSnapshot | undefined> {
    const path = this.#snapshotPath(reference);
    await this.#assertCatalogDirectory(reference, dirname(path), true);
    const sidecar = await this.#readSidecar(path);
    if (sidecar === undefined) return undefined;
    let value: JsonValue;
    try {
      const parsed = parseJsonWithoutDuplicateKeys(sidecar.raw);
      if (!withinCatalogSnapshotNodeBudget(parsed)) throw new Error('Native Playground catalog snapshot exceeds its cumulative value budget.');
      value = snapshotStrictJsonValue(parsed);
    }
    catch { throw new Error('Native Playground catalog snapshot is invalid.'); }
    if (!isRecord(value) || !hasExactKeys(value, ['epochId', 'selections']) ||
      value.epochId !== reference.epoch.id || !Array.isArray(value.selections) || value.selections.length > maximumCatalogSelections) {
      throw new Error('Native Playground catalog snapshot is invalid.');
    }
    const selections = value.selections.map(persistedSelection);
    if (selections.some((selection) => selection === undefined)) throw new Error('Native Playground catalog snapshot is invalid.');
    const resolved = selections as PersistedCatalogSelection[];
    if (new Set(resolved.map(selectionKey)).size !== resolved.length || !resolved.every((selection) => hasCanonicalSelectionIdentity(reference.epoch, selection))) {
      throw new Error('Native Playground catalog snapshot is invalid.');
    }
    return Object.freeze({ epochId: value.epochId, selections: Object.freeze(resolved) });
  }

  async #readSidecar(path: string): Promise<SidecarFile | undefined> {
    let before;
    try { before = await lstat(path); }
    catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw new Error('Native Playground catalog snapshot is invalid.', { cause: error });
    }
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Native Playground catalog snapshot is invalid.');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error('Native Playground catalog snapshot is invalid.');
      }
      if (opened.size > maximumCatalogSnapshotBytes) throw new Error('Native Playground catalog snapshot is invalid.');
      const bytes = Buffer.allocUnsafe(Math.min(maximumCatalogSnapshotBytes + 1, opened.size + 1));
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      const after = await handle.stat();
      if (bytesRead > maximumCatalogSnapshotBytes || after.size !== bytesRead) {
        throw new Error('Native Playground catalog snapshot is invalid.');
      }
      const raw = bytes.subarray(0, bytesRead).toString('utf8');
      return Object.freeze({ identity: digest({ contents: raw, dev: opened.dev, ino: opened.ino }), raw });
    } catch (error) {
      if (error instanceof Error && error.message === 'Native Playground catalog snapshot is invalid.') throw error;
      throw new Error('Native Playground catalog snapshot is invalid.', { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #persistSnapshot(
    reference: NativePlaygroundEpochReference,
    snapshot: PersistedCatalogSnapshot,
  ): Promise<PersistedCatalogPublication> {
    const path = this.#snapshotPath(reference);
    const directory = dirname(path);
    await this.#catalogStorage.mkdir(directory, { recursive: true });
    await this.#assertCatalogDirectory(reference, directory, false);
    const temporary = join(directory, `.${reference.epoch.id}.stage-${process.pid}-${Math.random().toString(16).slice(2)}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    let primary: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      handle = await this.#catalogStorage.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${stableJson(snapshot)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await this.#catalogStorage.link(temporary, path);
        created = true;
      }
      catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
      }
      await this.#syncCatalogDirectory(directory);
    } catch (error) {
      primary = error;
    } finally {
      if (handle !== undefined) {
        try { await handle.close(); }
        catch (error) { cleanupFailures.push(error); }
      }
      try { await this.#catalogStorage.remove(temporary, { force: true }); }
      catch (error) { cleanupFailures.push(error); }
      if (primary !== undefined && created) {
        try {
          await (await this.#snapshotReceipt(reference, true)).rollback();
        } catch (error) { cleanupFailures.push(error); }
      }
    }
    if (primary !== undefined) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError([primary, ...cleanupFailures], 'Native Playground catalog publication and cleanup both failed.', { cause: primary });
      }
      throw primary;
    }
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Native Playground catalog staging cleanup failed.', { cause: cleanupFailures[0] });
    const receipt = await this.#snapshotReceipt(reference, created);
    try {
      const persisted = await this.#readSnapshot(reference);
      if (persisted === undefined) throw new Error('Native Playground catalog snapshot could not be persisted.');
      return Object.freeze({ receipt, snapshot: persisted });
    } catch (error) {
      return this.#rollbackPublicationAndThrow(receipt, error, 'Native Playground catalog validation and rollback both failed.');
    }
  }

  async #acceptedPublicationReceipt(reference: NativePlaygroundEpochReference): Promise<NativePlaygroundCatalogPublicationReceipt> {
    return this.#snapshotReceipt(reference, false);
  }

  async #snapshotReceipt(
    reference: NativePlaygroundEpochReference,
    created: boolean,
  ): Promise<NativePlaygroundCatalogPublicationReceipt> {
    const path = this.#snapshotPath(reference);
    await this.#assertCatalogDirectory(reference, dirname(path), false);
    const sidecar = await this.#readSidecar(path);
    if (sidecar === undefined) throw new Error('Native Playground catalog snapshot could not be persisted.');
    return this.#publicationReceipt(path, sidecar.identity, created);
  }

  #publicationReceipt(
    path: string,
    identity: string,
    created: boolean,
  ): NativePlaygroundCatalogPublicationReceipt {
    return Object.freeze({
      created,
      identity,
      rollback: async () => {
        if (!created) return;
        const current = await this.#readSidecar(path);
        if (current === undefined || current.identity !== identity) return;
        const directory = dirname(path);
        const quarantine = join(directory, `.rollback-${process.pid}-${Math.random().toString(16).slice(2)}`);
        try { await this.#catalogStorage.rename(path, quarantine); }
        catch (error) {
          if (isErrno(error, 'ENOENT')) return;
          throw error;
        }
        const moved = await this.#readSidecar(quarantine);
        if (moved === undefined) throw new Error('Native Playground catalog rollback lost its quarantined sidecar.');
        if (moved.identity !== identity) {
          try { await this.#catalogStorage.link(quarantine, path); }
          catch (error) {
            if (isErrno(error, 'EEXIST')) {
              throw new Error('Native Playground catalog changed during rollback; the raced replacement remains quarantined.', { cause: error });
            }
            throw error;
          }
        }
        await this.#catalogStorage.remove(quarantine, { force: true });
        await this.#syncCatalogDirectory(directory);
      },
    });
  }

  async #syncCatalogDirectory(directory: string): Promise<void> {
    const handle = await this.#catalogStorage.open(directory, 'r');
    try {
      await handle.sync();
    } catch (error) {
      if (isTolerableWin32SyncError(catalogDurabilityPlatform(), error)) return;
      throw error;
    } finally {
      await handle.close();
    }
  }

  async #rollbackPublicationAndThrow(
    receipt: NativePlaygroundCatalogPublicationReceipt,
    primary: unknown,
    message: string,
  ): Promise<never> {
    if (!receipt.created) throw primary;
    try { await receipt.rollback(); }
    catch (rollbackFailure) { throw new AggregateError([primary, rollbackFailure], message, { cause: rollbackFailure }); }
    throw primary;
  }

  #snapshotPath(reference: NativePlaygroundEpochReference): string {
    if (!safeEpochSegment.test(reference.epoch.id)) throw new Error('Native Playground epoch id is not safe for catalog storage.');
    const directory = this.#catalogDirectory ?? join(dirname(reference.root), '.metadata', 'native-playground');
    return join(directory, `${reference.epoch.id}.json`);
  }

  async #assertCatalogDirectory(
    reference: NativePlaygroundEpochReference,
    directory: string,
    allowMissing: boolean,
  ): Promise<void> {
    let metadata;
    try { metadata = await lstat(directory); }
    catch (error) {
      if (allowMissing && isErrno(error, 'ENOENT')) return;
      throw new Error('Native Playground catalog directory is invalid.', { cause: error });
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Native Playground catalog directory is invalid.');
    }
    if (this.#catalogDirectory !== undefined) return;
    try {
      const resolvedEpochRoot = await realpath(dirname(reference.root));
      const resolvedDirectory = await realpath(directory);
      if (!isInsideOrEqual(resolvedEpochRoot, resolvedDirectory)) {
        throw new Error('Native Playground catalog directory is invalid.');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Native Playground catalog directory is invalid.') throw error;
      throw new Error('Native Playground catalog directory is invalid.', { cause: error });
    }
  }

  async #createWorkspaceRoot(): Promise<string> {
    const root = join(this.#projectRoot, '.agent-bundle');
    await mkdir(root, { recursive: true });
    return mkdtemp(join(root, 'native-playground-'));
  }

  async #workspaceDiff(workspace: string, prepared: NativePlaygroundPrepared): Promise<WorkspaceDiff | undefined> {
    try {
      return await workspaceDiff({
        plan: prepared.fixturePlan,
        workspace,
      });
    } catch { return undefined; } // Workspace diffs are optional evidence and must not fail a trial.
  }

  #suiteDirectory(sourcePath: string): string {
    const separator = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
    return separator < 0 ? this.#projectRoot : sourcePath.slice(0, separator);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Native Playground service is closed.');
  }
}

/** Captures the complete native selection set while its artifact epoch publishes. */
export const publishNativePlaygroundCatalogSnapshot = async (
  options: NativePlaygroundCatalogPublicationOptions,
): Promise<NativePlaygroundCatalogPublicationReceipt> => {
  const root = join(resolve(options.projectRoot), '.agent-bundle', 'epochs', options.epoch.id);
  const service = new NativePlaygroundService({
    ...(options.catalogDirectory === undefined ? {} : { catalogDirectory: options.catalogDirectory }),
    ...(options.catalogStorage === undefined ? {} : { catalogStorage: options.catalogStorage }),
    ...(options.discover === undefined ? {} : { discover: options.discover }),
    inspectArtifact: async (reference) => Object.freeze({
      binding: Object.freeze({
        manifestPath: join(reference.root, 'agent-bundle.manifest.json'),
        source: 'explicit' as const,
        targetDigests: reference.epoch.targetDigests,
      }),
      root: reference.root,
    }),
    ...(options.planFixture === undefined ? {} : { planFixture: options.planFixture }),
    projectRoot: options.projectRoot,
  });
  try {
    return await service.publishCatalogSnapshot(Object.freeze({ close: async () => undefined, epoch: options.epoch, root }));
  } finally {
    await service.close();
  }
};
