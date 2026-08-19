import type { ComponentType } from 'react';
import type {
  CallToolResult,
  GetPromptResult,
  LoggingLevel,
  Prompt,
  Resource,
  ResourceTemplateType as ResourceTemplate,
  Tool,
} from '@modelcontextprotocol/client';

export type SortDirection = 'oldest-first' | 'newest-first';

export interface ListPaginationControlsProps {
  readonly canLoadMore: boolean;
  readonly loadedPages: number;
  readonly onLoadMore: () => void;
  readonly onPaginatedChange: (paginated: boolean) => void;
  readonly paginated: boolean;
}

export interface LogEntryData {
  readonly params: Readonly<{ readonly data: unknown; readonly level: LoggingLevel; readonly logger?: string }>;
  readonly receivedAt: Date;
}

export interface ToolCallState {
  readonly error?: string;
  readonly result?: CallToolResult;
  readonly status: 'idle' | 'pending' | 'ok' | 'error';
}

export interface ToolsUiState {
  readonly formValues: Record<string, unknown>;
  readonly runAsTask: boolean;
  readonly search: string;
  readonly selectedToolName?: string;
}

export interface ReadResourceState {
  readonly error?: string;
  readonly result?: unknown;
  readonly status: 'idle' | 'pending' | 'ok' | 'error';
  readonly uri?: string;
}

export interface ResourcesUiState {
  readonly openSections?: string[];
  readonly originatingTemplateUri?: string;
  readonly search: string;
  readonly selectedResourceUri?: string;
  readonly selectedTemplateUri?: string;
}

export interface GetPromptState {
  readonly error?: string;
  readonly promptName?: string;
  readonly result?: GetPromptResult;
  readonly status: 'idle' | 'pending' | 'ok' | 'error';
}

export interface PromptsUiState {
  readonly argumentValues: Record<string, string>;
  readonly search: string;
  readonly selectedPromptName?: string;
  readonly submittedFor?: string;
}

export interface MessageEntry {
  readonly direction: 'request' | 'response' | 'notification';
  readonly id: string;
  readonly message: unknown;
  readonly origin?: 'client' | 'server';
  readonly timestamp: Date;
}

export interface ProtocolUiState {
  readonly search: string;
  readonly visibleDirections: Record<'client' | 'server', boolean>;
}

export interface LogsUiState {
  readonly filterText: string;
  readonly visibleLevels: Record<LoggingLevel, boolean>;
}

export const ToolsScreen: ComponentType<{
  readonly callState?: ToolCallState;
  readonly listChanged: boolean;
  readonly onCallTool: (name: string, args: Record<string, unknown>) => void;
  readonly onCancelCall?: () => void;
  readonly onClearResult?: () => void;
  readonly onRefreshList: () => void;
  readonly onUiChange: (next: ToolsUiState) => void;
  readonly pagination: ListPaginationControlsProps;
  readonly serverSupportsTaskToolCalls: boolean;
  readonly tools: Tool[];
  readonly ui: ToolsUiState;
}>;
export const ResourcesScreen: ComponentType<{
  readonly compact: boolean;
  readonly listChanged: boolean;
  readonly onCompactChange: (next: boolean) => void;
  readonly onReadResource: (uri: string) => void;
  readonly onRefreshList: () => void;
  readonly onSubscribeResource: (uri: string) => void;
  readonly onUiChange: (next: ResourcesUiState) => void;
  readonly onUnsubscribeResource: (uri: string) => void;
  readonly pagination: ListPaginationControlsProps;
  readonly readState?: ReadResourceState;
  readonly resources: Resource[];
  readonly subscriptions: unknown[];
  readonly subscriptionsSupported?: boolean;
  readonly templates: ResourceTemplate[];
  readonly ui: ResourcesUiState;
}>;
export const PromptsScreen: ComponentType<{
  readonly getPromptState?: GetPromptState;
  readonly listChanged: boolean;
  readonly onGetPrompt: (name: string, args: Record<string, string>) => void;
  readonly onRefreshList: () => void;
  readonly onUiChange: (next: PromptsUiState) => void;
  readonly pagination: ListPaginationControlsProps;
  readonly prompts: Prompt[];
  readonly ui: PromptsUiState;
}>;
export const ProtocolScreen: ComponentType<{
  readonly compact: boolean;
  readonly entries: MessageEntry[];
  readonly onClearAll: () => void;
  readonly onClearSection: (section: 'pinned' | 'history') => void;
  readonly onExport: () => void;
  readonly onExportSection: (section: 'pinned' | 'history') => void;
  readonly onReplay: (id: string) => void;
  readonly onSortChange: (next: SortDirection) => void;
  readonly onToggleCompact: () => void;
  readonly onTogglePin: (id: string) => void;
  readonly onUiChange: (next: ProtocolUiState) => void;
  readonly pinnedIds: Set<string>;
  readonly sortDirection: SortDirection;
  readonly ui: ProtocolUiState;
}>;
export const LoggingScreen: ComponentType<{
  readonly currentLevel: LoggingLevel;
  readonly embedded?: boolean;
  readonly entries: LogEntryData[];
  readonly onClear: () => void;
  readonly onExport: () => void;
  readonly onSetLevel: (level: LoggingLevel) => void;
  readonly onSortChange: (next: SortDirection) => void;
  readonly onUiChange: (next: LogsUiState) => void;
  readonly sortDirection: SortDirection;
  readonly ui: LogsUiState;
}>;
export const ALL_LEVELS_VISIBLE: Record<LoggingLevel, boolean>;
export const clearScrollMemory: () => void;
