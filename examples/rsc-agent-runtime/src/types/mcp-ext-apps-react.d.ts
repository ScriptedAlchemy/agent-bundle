declare module '@modelcontextprotocol/ext-apps/react' {
  import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
  import type { App, McpUiAppCapabilities, McpUiHostContext } from '@modelcontextprotocol/ext-apps';

  export type UseAppOptions = {
    appInfo: Implementation;
    capabilities: McpUiAppCapabilities;
    onAppCreated?: (app: App) => void;
  };

  export type AppState = {
    app: App | null;
    error: Error | null;
    isConnected: boolean;
  };

  export function useApp(options: UseAppOptions): AppState;
  export function useHostStyles(app: App | null, initialContext?: McpUiHostContext | null): void;
}
