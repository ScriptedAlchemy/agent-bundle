import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { Mcp } from './elements.js';

type McpElement = {
  type: string;
  props: Record<string, unknown>;
};

const mcpComponents = new Set<unknown>(Object.values(Mcp));

const isMcpComponent = (value: unknown): value is ((props: Record<string, unknown>) => ReactElement) =>
  mcpComponents.has(value);

const asMcpElement = (node: ReactNode): McpElement => {
  let element = node;
  while (isValidElement(element) && isMcpComponent(element.type)) {
    element = element.type(element.props as Record<string, unknown>);
  }

  if (!isValidElement(element) || typeof element.type !== 'string' || !element.type.startsWith('mcp-')) {
    throw new Error('Expected an MCP result element');
  }

  return { props: element.props as Record<string, unknown>, type: element.type };
};

const requiredString = (value: unknown, message: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(message);
  }

  return value;
};

const textChild = (children: unknown, message: string): string => {
  const values = Children.toArray(children as ReactNode);
  if (values.length !== 1 || typeof values[0] !== 'string') {
    throw new Error(message);
  }

  return values[0];
};

const jsonRecord = (value: unknown, message: string): Record<string, unknown> => {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error('undefined');
    }

    const decoded: unknown = JSON.parse(encoded);
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('not an object');
    }

    return decoded as Record<string, unknown>;
  } catch {
    throw new Error(message);
  }
};

const lowerContent = (node: ReactNode): CallToolResult['content'][number] => {
  const element = asMcpElement(node);
  const { props } = element;

  switch (element.type) {
    case 'mcp-text':
      return { text: textChild(props.children, 'mcp-text requires one text child'), type: 'text' };
    case 'mcp-image':
      return {
        data: requiredString(props.data, 'mcp-image requires non-empty data and mimeType'),
        mimeType: requiredString(props.mimeType, 'mcp-image requires non-empty data and mimeType'),
        type: 'image',
      };
    case 'mcp-audio':
      return {
        data: requiredString(props.data, 'mcp-audio requires non-empty data and mimeType'),
        mimeType: requiredString(props.mimeType, 'mcp-audio requires non-empty data and mimeType'),
        type: 'audio',
      };
    case 'mcp-resource-link': {
      const mimeType = props.mimeType;
      if (mimeType !== undefined && typeof mimeType !== 'string') {
        throw new Error('mcp-resource-link mimeType must be a string');
      }

      return {
        ...(mimeType === undefined ? {} : { mimeType }),
        name: requiredString(props.name, 'mcp-resource-link requires non-empty uri and name'),
        type: 'resource_link',
        uri: requiredString(props.uri, 'mcp-resource-link requires non-empty uri and name'),
      };
    }
    case 'mcp-embedded-resource': {
      const hasText = props.text !== undefined;
      const hasTextChild = props.children !== undefined;
      const hasBlob = props.blob !== undefined;
      if (Number(hasText) + Number(hasTextChild) + Number(hasBlob) !== 1) {
        throw new Error('mcp-embedded-resource accepts exactly one text or blob value');
      }

      const mimeType = props.mimeType;
      if (mimeType !== undefined && typeof mimeType !== 'string') {
        throw new Error('mcp-embedded-resource mimeType must be a string');
      }

      const resource = {
        ...(mimeType === undefined ? {} : { mimeType }),
        uri: requiredString(props.uri, 'mcp-embedded-resource requires a non-empty uri'),
        ...(hasBlob
          ? { blob: requiredString(props.blob, 'mcp-embedded-resource blob must be non-empty') }
          : {
              text:
                hasTextChild
                  ? textChild(props.children, 'mcp-embedded-resource requires one text child')
                  : requiredString(props.text, 'mcp-embedded-resource text must be non-empty'),
            }),
      };
      return { resource, type: 'resource' };
    }
    case 'mcp-result':
      throw new Error('mcp-result may not be nested');
    default:
      throw new Error(`Unsupported MCP result element: ${element.type}`);
  }
};

export const lowerMcpResult = (node: ReactNode): CallToolResult => {
  const root = asMcpElement(node);
  if (root.type !== 'mcp-result') {
    throw new Error('Expected mcp-result as the root element');
  }

  if (root.props.isError !== undefined && typeof root.props.isError !== 'boolean') {
    throw new Error('mcp-result isError must be a boolean');
  }

  const structuredContent = root.props.structuredContent;
  return {
    content: Children.toArray(root.props.children as ReactNode).map(lowerContent),
    ...(structuredContent === undefined
      ? {}
      : { structuredContent: jsonRecord(structuredContent, 'mcp-result structuredContent must be JSON-serializable') }),
    ...(root.props.isError === undefined ? {} : { isError: root.props.isError }),
  };
};
