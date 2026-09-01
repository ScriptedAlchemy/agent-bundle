import { Children, isValidElement, type ReactNode } from 'react';

import {
  AgentContractError,
  createAgentDocument,
  type AgentDocument,
  type AgentDocumentNode,
  type AgentRenderLimits,
} from './agent-document.js';
import type { JsonValue } from './lower-mcp.js';

const agentElementTypes = Object.freeze([
  'agent-result',
  'agent-markdown',
  'agent-text',
  'agent-json',
  'agent-progress',
  'agent-image',
  'agent-audio',
  'agent-resource',
  'agent-error',
] as const);

type AgentElementType = typeof agentElementTypes[number];

interface AgentProtocolElement {
  readonly props: Record<string, unknown>;
  readonly type: AgentElementType;
}

const isAgentElementType = (value: string): value is AgentElementType =>
  (agentElementTypes as readonly string[]).includes(value);

const protocolElement = (node: ReactNode): AgentProtocolElement => {
  if (
    !isValidElement(node) ||
    typeof node.type !== 'string' ||
    !isAgentElementType(node.type)
  ) {
    throw new AgentContractError(
      'invalid-document',
      'Flight output must contain only Agent protocol elements; function components and HTML are unsupported',
    );
  }
  return { props: node.props as Record<string, unknown>, type: node.type };
};

const textChild = (children: unknown, type: AgentElementType): string => {
  const values = Children.toArray(children as ReactNode);
  if (values.length !== 1 || typeof values[0] !== 'string') {
    throw new AgentContractError('invalid-document', `${type} requires exactly one string child`);
  }
  return values[0];
};

interface DecodeState {
  representedError: boolean;
}

const decodeNode = (node: ReactNode, state: DecodeState): AgentDocumentNode => {
  const element = protocolElement(node);
  const { props } = element;
  switch (element.type) {
    case 'agent-result':
      return {
        children: Children.toArray(props.children as ReactNode).map((child) => decodeNode(child, state)),
        kind: 'result',
        ...(props.metadata === undefined ? {} : { metadata: props.metadata as JsonValue }),
      };
    case 'agent-markdown':
      return { kind: 'markdown', text: textChild(props.children, element.type) };
    case 'agent-text':
      return { kind: 'text', text: textChild(props.children, element.type) };
    case 'agent-json':
      return { kind: 'json', value: props.value as JsonValue };
    case 'agent-progress':
      return {
        completed: props.completed as number,
        kind: 'progress',
        ...(props.message === undefined ? {} : { message: props.message as string }),
        ...(props.total === undefined ? {} : { total: props.total as number }),
      };
    case 'agent-image':
      return { data: props.data as string, kind: 'image', mimeType: props.mimeType as string };
    case 'agent-audio':
      return { data: props.data as string, kind: 'audio', mimeType: props.mimeType as string };
    case 'agent-resource':
      return {
        kind: 'resource',
        ...(props.mimeType === undefined ? {} : { mimeType: props.mimeType as string }),
        name: props.name as string,
        uri: props.uri as string,
      };
    case 'agent-error':
      state.representedError = true;
      return {
        code: props.code as string,
        kind: 'error',
        message: textChild(props.children, element.type),
      };
    default: {
      const exhaustive: never = element.type;
      throw new AgentContractError('invalid-document', `Unsupported Agent protocol element: ${String(exhaustive)}`);
    }
  }
};

export const decodeAgentDocument = (
  node: ReactNode,
  limits: Partial<AgentRenderLimits> = {},
): AgentDocument => {
  const root = protocolElement(node);
  if (root.type !== 'agent-result') {
    throw new AgentContractError('invalid-document', 'Flight output must have Agent.Result as its root');
  }
  const state: DecodeState = { representedError: false };
  const documentRoot = decodeNode(node, state);
  return createAgentDocument({
    root: documentRoot,
    status: state.representedError ? 'represented-error' : 'success',
    ...(root.props.value === undefined ? {} : { value: root.props.value as JsonValue }),
    version: 1,
  }, limits);
};

