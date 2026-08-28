import { createElement, type PropsWithChildren, type ReactElement } from 'react';

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
