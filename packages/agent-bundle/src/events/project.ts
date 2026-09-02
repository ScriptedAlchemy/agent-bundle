import { Children, cloneElement, isValidElement, type ReactNode } from 'react';

import { decodeAgentDocument, type AgentDocument } from '@agent-bundle/runtime';

import type { AgentEventRouteProps } from '../routes/public.ts';

export {
  createCanonicalEventProps,
  projectEventDocument,
  validateNativeEventEnvelope,
  type NativeEventEnvelopeValidation,
} from './projection.ts';

const resolveServerNode = async (node: ReactNode): Promise<ReactNode> => {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServerNode));
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  const type: unknown = node.type;
  if (type === Symbol.for('react.fragment')) {
    return Promise.all(Children.toArray(node.props.children as ReactNode).map(resolveServerNode));
  }
  if (typeof type === 'function') {
    const component = type as (props: Record<string, unknown>) => ReactNode | Promise<ReactNode>;
    return resolveServerNode(await component(node.props));
  }
  if (typeof type !== 'string') {
    throw new TypeError('Standalone event routes may render only Server Components and Agent protocol elements.');
  }
  const children = await Promise.all(Children.toArray(node.props.children as ReactNode).map(resolveServerNode));
  return cloneElement(node, undefined, ...children);
};

export const renderStandaloneEventRoute = async (
  component: (props: AgentEventRouteProps) => ReactNode | Promise<ReactNode>,
  props: AgentEventRouteProps,
): Promise<AgentDocument> => decodeAgentDocument(await resolveServerNode(await component(props)));
