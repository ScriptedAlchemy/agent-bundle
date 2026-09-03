import { createElement, type PropsWithChildren, type ReactElement } from 'react';

import type { JsonValue } from './lower-mcp.js';

export interface AgentResultProps extends PropsWithChildren {
  /**
   * Result-level metadata. On MCP it is the `CallToolResult._meta` object,
   * so it must be a JSON object there; the projection fails closed otherwise.
   */
  readonly metadata?: JsonValue;
  /** The document value; on MCP it is `structuredContent` when it is a JSON object. */
  readonly value?: JsonValue;
}

export interface AgentTextProps {
  readonly children: string;
}

export interface AgentJsonProps {
  readonly value: JsonValue;
}

export interface AgentProgressProps {
  readonly completed: number;
  readonly message?: string;
  readonly total?: number;
}

export interface AgentMediaProps {
  readonly data: string;
  readonly mimeType: string;
}

export interface AgentResourceProps {
  readonly mimeType?: string;
  readonly name: string;
  readonly uri: string;
}

export interface AgentErrorProps extends AgentTextProps {
  readonly code: string;
}

const AgentResult = ({ children, metadata, value }: AgentResultProps): ReactElement =>
  createElement('agent-result', { metadata, value }, children);

const AgentMarkdown = ({ children }: AgentTextProps): ReactElement =>
  createElement('agent-markdown', null, children);

const AgentText = ({ children }: AgentTextProps): ReactElement => createElement('agent-text', null, children);

const AgentContext = ({ children }: AgentTextProps): ReactElement => createElement('agent-context', null, children);

const AgentJson = ({ value }: AgentJsonProps): ReactElement => createElement('agent-json', { value });

const AgentProgress = ({ completed, message, total }: AgentProgressProps): ReactElement =>
  createElement('agent-progress', { completed, message, total });

const AgentImage = ({ data, mimeType }: AgentMediaProps): ReactElement =>
  createElement('agent-image', { data, mimeType });

const AgentAudio = ({ data, mimeType }: AgentMediaProps): ReactElement =>
  createElement('agent-audio', { data, mimeType });

const AgentResource = ({ mimeType, name, uri }: AgentResourceProps): ReactElement =>
  createElement('agent-resource', { mimeType, name, uri });

const AgentError = ({ children, code }: AgentErrorProps): ReactElement =>
  createElement('agent-error', { code }, children);

export const Agent = Object.freeze({
  Audio: AgentAudio,
  Context: AgentContext,
  Error: AgentError,
  Image: AgentImage,
  Json: AgentJson,
  Markdown: AgentMarkdown,
  Progress: AgentProgress,
  Resource: AgentResource,
  Result: AgentResult,
  Text: AgentText,
});

const Result = ({ children }: PropsWithChildren): ReactElement =>
  createElement('agent-hook-result', null, children);

const AdditionalContext = ({ children }: PropsWithChildren): ReactElement =>
  createElement('agent-hook-additional-context', null, children);

export const Hook = { AdditionalContext, Result };

export interface McpResultProps extends PropsWithChildren {
  _meta?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpDataProps {
  data: string;
  mimeType: string;
}

export interface McpResourceLinkProps {
  uri: string;
  name: string;
  mimeType?: string;
}

export interface McpEmbeddedResourceProps extends PropsWithChildren {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

const McpResult = ({ _meta, children, isError, structuredContent }: McpResultProps): ReactElement =>
  createElement('mcp-result', { _meta, isError, structuredContent }, children);

const McpText = ({ children }: PropsWithChildren): ReactElement => createElement('mcp-text', null, children);

const McpImage = ({ data, mimeType }: McpDataProps): ReactElement => createElement('mcp-image', { data, mimeType });

const McpAudio = ({ data, mimeType }: McpDataProps): ReactElement => createElement('mcp-audio', { data, mimeType });

const McpResourceLink = ({ mimeType, name, uri }: McpResourceLinkProps): ReactElement =>
  createElement('mcp-resource-link', { mimeType, name, uri });

const McpEmbeddedResource = ({ blob, children, mimeType, text, uri }: McpEmbeddedResourceProps): ReactElement =>
  createElement('mcp-embedded-resource', { blob, mimeType, text, uri }, children);

export const Mcp = {
  Audio: McpAudio,
  EmbeddedResource: McpEmbeddedResource,
  Image: McpImage,
  ResourceLink: McpResourceLink,
  Result: McpResult,
  Text: McpText,
};
