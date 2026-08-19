export const AppsScreen: unknown;
export const LoggingScreen: unknown;
export const NetworkScreen: unknown;
export const PromptsScreen: unknown;
export const ProtocolScreen: unknown;
export const ResourcesScreen: unknown;
export const ToolsScreen: unknown;

import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import type { Ref, RefObject } from 'react';

export type McpAppRendererDisplayMode = 'fullscreen' | 'inline' | 'pip';

export type McpAppRendererJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly McpAppRendererJsonValue[]
  | Readonly<Record<string, McpAppRendererJsonValue>>;

export type McpAppRendererTool = Tool;

export interface McpAppRendererMessage {
  readonly content: readonly McpAppRendererJsonValue[];
  readonly role: 'user';
}

export interface AppRendererBridge {
  addEventListener(type: 'initialized', listener: () => void): void;
  addEventListener(type: 'loggingmessage', listener: (params: Readonly<{ readonly data: McpAppRendererJsonValue; readonly level: string; readonly logger?: string }>) => void): void;
  addEventListener(type: 'sizechange', listener: (params: Readonly<{ readonly height?: number; readonly width?: number }>) => void): void;
  close(): Promise<void>;
  onmessage?: (params: McpAppRendererMessage) => Promise<Readonly<{ readonly isError?: true }>>;
  onrequestdisplaymode?: (params: Readonly<{ readonly mode: McpAppRendererDisplayMode }>) => Promise<Readonly<{ readonly mode: McpAppRendererDisplayMode }>>;
  sendHostContextChange(context: Partial<McpAppRendererHostContext>): Promise<void>;
  sendToolCancelled(params: Readonly<{ readonly reason: string }>): Promise<void>;
  sendToolInput(params: Readonly<{ readonly arguments: Record<string, McpAppRendererJsonValue> }>): Promise<void>;
  sendToolInputPartial(params: Readonly<{ readonly arguments: Record<string, McpAppRendererJsonValue> }>): Promise<void>;
  sendToolResult(result: CallToolResult): Promise<void>;
  teardownResource(params: Readonly<Record<string, never>>): Promise<Readonly<Record<string, never>>>;
}

export type BridgeFactory = (
  iframe: HTMLIFrameElement,
  tool: McpAppRendererTool,
) => AppRendererBridge | Promise<AppRendererBridge>;

export interface AppRendererHandle {
  sendToolCancelled(reason: string): Promise<void>;
  sendToolInput(args: Record<string, McpAppRendererJsonValue>): Promise<void>;
  sendToolResult(result: CallToolResult): Promise<void>;
  teardown(): Promise<void>;
}

export interface AppRendererProps {
  readonly bridgeFactory: BridgeFactory;
  readonly displayMode?: McpAppRendererDisplayMode;
  readonly onAppStatusChange?: (status: 'error' | 'loading' | 'ready') => void;
  readonly onError?: (error: Error) => void;
  readonly onLog?: (params: Readonly<{ readonly data: McpAppRendererJsonValue; readonly level: string; readonly logger?: string }>) => void;
  readonly onMessage?: (params: McpAppRendererMessage) => void;
  readonly onRequestDisplayMode?: (requested: McpAppRendererDisplayMode) => McpAppRendererDisplayMode;
  readonly onSizeChange?: (size: Readonly<{ readonly height?: number; readonly width?: number }>) => void;
  readonly partialInputs?: readonly Readonly<Record<string, McpAppRendererJsonValue>>[];
  readonly containerRef?: RefObject<HTMLElement | null>;
  readonly ref?: Ref<AppRendererHandle>;
  readonly sandboxPath: string;
  readonly tool: McpAppRendererTool;
}

export const AppRenderer: (props: AppRendererProps) => import('react').ReactNode;

export interface McpAppRendererHostContext {
  readonly availableDisplayModes?: readonly McpAppRendererDisplayMode[];
  readonly containerDimensions?: Readonly<{ readonly height: number; readonly width: number }>;
  readonly displayMode?: McpAppRendererDisplayMode;
  readonly theme?: 'dark' | 'light';
}

export const snapshotHostContext: (
  container: HTMLElement | null,
  availableDisplayModes: readonly McpAppRendererDisplayMode[],
) => McpAppRendererHostContext;
