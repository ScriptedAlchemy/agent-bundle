export const AGENT_BROWSER_TEST_REGISTRY_SYMBOL_KEY = 'agent-bundle/test-browser-app-registry';
export const AGENT_BROWSER_TEST_REGISTRY_VERSION = 1;
export const BROWSER_APP_PROOF_LEVEL = 'browser-app' as const;
export const BROWSER_APP_PROOF_LEVEL_LABEL = 'browser-app (MCP App HTML compiled through the production Rsbuild profile, mounted in a real browser page over the product bridge; NOT host embedding, packed-artifact, or Workbench evidence)';

export interface CompiledBrowserTestApp {
  readonly html: string;
  readonly name: string;
  /** Absolute staged HTML path that supplied `html`. */
  readonly output: string;
  readonly proofLevel: 'browser-app';
  readonly resourceUri: string;
  readonly serverIds: readonly string[];
  readonly target: string;
}

export interface AgentBrowserTestRegistry {
  readonly apps: Readonly<Record<string, CompiledBrowserTestApp>>;
  readonly version: number;
}
