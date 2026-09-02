import type { AgentFlightExecutionHost, AgentRenderDispatch } from './dispatcher.js';

export type AgentRuntimeErrorCode =
  | 'artifact-epoch-mismatch'
  | 'runtime-restarted'
  | 'runtime-unavailable';

export class AgentRuntimeError extends Error {
  readonly code: AgentRuntimeErrorCode;
  readonly expectedEpoch?: string;
  readonly receivedEpoch?: string;

  constructor(
    code: AgentRuntimeErrorCode,
    message: string,
    options?: ErrorOptions & {
      readonly expectedEpoch?: string;
      readonly receivedEpoch?: string;
    },
  ) {
    super(message, options);
    this.code = code;
    this.name = 'AgentRuntimeError';
    this.expectedEpoch = options?.expectedEpoch;
    this.receivedEpoch = options?.receivedEpoch;
  }
}

export const assertArtifactEpoch = (expected: string, received: string | undefined): void => {
  if (received === undefined || received === expected) return;
  throw new AgentRuntimeError(
    'artifact-epoch-mismatch',
    `Runtime artifact epoch ${JSON.stringify(expected)} does not match request epoch ${JSON.stringify(received)}`,
    { expectedEpoch: expected, receivedEpoch: received },
  );
};

export interface WarmRuntimeIdentity {
  readonly artifactEpoch: string;
  readonly instanceId: string;
}

export interface WarmFlightHost extends AgentFlightExecutionHost {
  readonly close: () => Promise<void>;
  readonly identity: WarmRuntimeIdentity;
  readonly markUnavailable: (code?: Exclude<AgentRuntimeErrorCode, 'artifact-epoch-mismatch'>) => void;
}

export interface CreateWarmFlightHostOptions {
  readonly artifactEpoch: string;
  readonly close?: () => Promise<void>;
  readonly host: AgentFlightExecutionHost;
  readonly instanceId?: string;
  /** Optional generated state owner whose lifetime is the warm host lifetime. */
  readonly runtimeState?: { close(): Promise<void> };
}

const unavailableError = (
  code: Exclude<AgentRuntimeErrorCode, 'artifact-epoch-mismatch'>,
): AgentRuntimeError => {
  switch (code) {
    case 'runtime-restarted':
      return new AgentRuntimeError(
        code,
        'The MCP render runtime restarted; this process no longer serves requests',
      );
    case 'runtime-unavailable':
      return new AgentRuntimeError(code, 'The MCP render runtime is unavailable');
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
};

export const createWarmFlightHost = (options: CreateWarmFlightHostOptions): WarmFlightHost => {
  const identity: WarmRuntimeIdentity = Object.freeze({
    artifactEpoch: options.artifactEpoch,
    instanceId: options.instanceId ?? crypto.randomUUID(),
  });
  let unavailable: AgentRuntimeError | undefined;
  return Object.freeze({
    identity,
    markUnavailable(code: Exclude<AgentRuntimeErrorCode, 'artifact-epoch-mismatch'> = 'runtime-unavailable') {
      unavailable ??= unavailableError(code);
    },
    async close() {
      try {
        await options.close?.();
      } finally {
        await options.runtimeState?.close();
      }
    },
    async execute(request: AgentRenderDispatch) {
      if (unavailable !== undefined) throw unavailable;
      assertArtifactEpoch(identity.artifactEpoch, request.artifactEpoch);
      return options.host.execute(request);
    },
  });
};
