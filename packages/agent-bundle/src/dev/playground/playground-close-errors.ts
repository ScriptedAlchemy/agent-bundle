import type { PlaygroundCleanupFailure } from './playground-protocol.ts';

/** Cleanup-failure errors raised while closing playground sessions or the whole service. */

export class PlaygroundSessionCloseError extends Error {
  readonly failures: readonly PlaygroundCleanupFailure[];
  readonly sessionId: string;

  constructor(sessionId: string, failures: readonly PlaygroundCleanupFailure[]) {
    super(`Playground session ${JSON.stringify(sessionId)} closed with cleanup failures.`);
    this.name = 'PlaygroundSessionCloseError';
    this.sessionId = sessionId;
    this.failures = failures;
  }
}

export interface PlaygroundServiceCloseFailure {
  readonly error: unknown;
  readonly sessionId: string;
}

export class PlaygroundServiceCloseError extends Error {
  readonly failures: readonly PlaygroundServiceCloseFailure[];

  constructor(failures: readonly PlaygroundServiceCloseFailure[]) {
    super('Playground service closed with session cleanup failures.');
    this.name = 'PlaygroundServiceCloseError';
    this.failures = failures;
  }
}
