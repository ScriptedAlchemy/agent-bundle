import type { link, mkdir, open, rename, rm } from 'node:fs/promises';

import type { CodexCommandRunner } from '../../eval/codex-harness.ts';
import type { DiscoveredEvalSuite } from '../../eval/discovery.ts';
import type { PreparedEvalArtifact } from '../../eval/artifact.ts';
import type { EvalFixturePlan } from '../../eval/fixtures.ts';
import type { EvalCase } from '../../eval/types.ts';
import type { NativeClaudeProcessRunner } from '../../host-contracts/native-claude-contract.ts';
import type { PlaygroundEventInput, PlaygroundJsonObject } from './playground-store.ts';
import type { ArtifactEpoch } from '../types.ts';
import type { NativeHost } from '../../host-contracts/native-hosts.ts';

export type NativePlaygroundHost = NativeHost;

/** The exact browser shape accepted only after route-level strict decoding. */
export interface NativePlaygroundRequest {
  readonly caseId: string;
  readonly epochId?: string;
  readonly fixtureId: string;
  readonly host: NativePlaygroundHost;
  readonly modelPinId: string;
  readonly operation: 'native.prompt';
  readonly prompt: string;
  readonly target: string;
}

export interface NativePlaygroundEpochReference {
  close(): Promise<void>;
  readonly epoch: ArtifactEpoch;
  readonly root: string;
}

export interface NativePlaygroundCatalogItem {
  readonly id: string;
  readonly label: string;
}

export interface NativePlaygroundModelPin extends NativePlaygroundCatalogItem {
  readonly host: NativePlaygroundHost;
}

/** One browser-admissible opaque selection. IDs are meaningful only as this complete tuple. */
export interface NativePlaygroundCatalogSelection {
  readonly caseId: string;
  readonly fixtureId: string;
  readonly host: NativePlaygroundHost;
  readonly modelPinId: string;
}

export interface NativePlaygroundCatalog {
  readonly cases: readonly NativePlaygroundCatalogItem[];
  readonly epochId: string;
  readonly fixtures: readonly NativePlaygroundCatalogItem[];
  readonly modelPins: readonly NativePlaygroundModelPin[];
  readonly selections: readonly NativePlaygroundCatalogSelection[];
}

export type NativePlaygroundProgress = 'codex.setup' | 'fixture.materialized' | 'host.started' | 'preflight';

export interface NativePlaygroundPrepared {
  readonly artifact: Pick<PreparedEvalArtifact, 'binding' | 'root'>;
  readonly epochId: string;
  readonly evalCase: EvalCase;
  readonly fixtureDigest: string;
  readonly fixturePlan: EvalFixturePlan;
  readonly host: NativePlaygroundHost;
  readonly prompt: string;
  readonly suiteDir: string;
  readonly target: string;
}

export interface NativePlaygroundRunResult {
  readonly events: readonly PlaygroundEventInput[];
  readonly response?: string;
  readonly status: 'failed' | 'passed';
  readonly workspace?: PlaygroundJsonObject;
}

export interface NativePlaygroundServiceOptions {
  /** Test-only storage override; production snapshots live beside retained epoch metadata. */
  readonly catalogDirectory?: string;
  /** @internal Fault-injection seam for durable epoch-sidecar publication. */
  readonly catalogStorage?: NativePlaygroundCatalogStorage;
  /** Test seams preserve the same production discovery and harness contracts. */
  readonly discover?: (projectRoot: string) => Promise<readonly DiscoveredEvalSuite[]>;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly inspectArtifact?: (reference: NativePlaygroundEpochReference) => Promise<Pick<PreparedEvalArtifact, 'binding' | 'root'>>;
  readonly native?: Readonly<{
    readonly claudeRun?: NativeClaudeProcessRunner;
    readonly codexRun?: CodexCommandRunner;
  }>;
  readonly planFixture?: (options: { readonly baseDir: string; readonly fixture: EvalCase['fixture'] }) => Promise<EvalFixturePlan>;
  readonly projectRoot: string;
}

export interface NativePlaygroundCatalogStorage {
  readonly link: typeof link;
  readonly mkdir: typeof mkdir;
  readonly open: typeof open;
  readonly rename: typeof rename;
  readonly remove: typeof rm;
}

/** Publication-time authority captured before active epoch metadata changes. */
export interface NativePlaygroundCatalogPublicationOptions {
  readonly catalogDirectory?: string;
  readonly catalogStorage?: NativePlaygroundCatalogStorage;
  readonly discover?: NativePlaygroundServiceOptions['discover'];
  readonly epoch: ArtifactEpoch;
  readonly planFixture?: NativePlaygroundServiceOptions['planFixture'];
  readonly projectRoot: string;
}

export interface NativePlaygroundCatalogPublicationReceipt {
  /** True only when this publisher installed the exact sidecar inode. */
  readonly created: boolean;
  /** Opaque inode-and-content identity used to make rollback ownership-safe. */
  readonly identity: string;
  rollback(): Promise<void>;
}
