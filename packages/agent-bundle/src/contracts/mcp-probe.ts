export type McpProbeHost = 'claude' | 'codex' | 'cursor';
export type McpProbeStatus = 'ok' | 'timed-out' | 'unreachable';
export type McpProbeFailureKind = 'connect' | 'handshake' | 'protocol';

export interface McpProbeLaunchStdio {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly kind: 'stdio';
}

export interface McpProbeLaunchRemote {
  readonly kind: 'streamable-http';
  readonly url: string;
}

export type McpProbeLaunch = McpProbeLaunchStdio | McpProbeLaunchRemote;

export interface McpProbeTool {
  readonly description?: string;
  readonly name: string;
  readonly title?: string;
}

export interface McpProbeSnapshot {
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly instructions?: string;
  readonly protocolVersion: string;
  readonly serverInfo: Readonly<{
    readonly name: string;
    readonly title?: string;
    readonly version: string;
  }>;
  readonly tools: readonly McpProbeTool[];
  readonly toolsTruncated: boolean;
}

export interface McpProbeFailure {
  readonly detail: string;
  readonly kind: McpProbeFailureKind;
}

export interface McpProbeReport {
  readonly durationMs: number;
  readonly failure?: McpProbeFailure;
  readonly generatedAt: string;
  readonly host: McpProbeHost;
  readonly launch: McpProbeLaunch;
  readonly serverName: string;
  readonly snapshot?: McpProbeSnapshot;
  readonly status: McpProbeStatus;
}
