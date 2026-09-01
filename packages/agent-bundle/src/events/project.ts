import { createHash } from 'node:crypto';

import { Children, cloneElement, isValidElement, type ReactNode } from 'react';
import { z } from 'zod';

import { decodeAgentDocument, type AgentDocument, type AgentDocumentNode } from '@agent-bundle/runtime';
import type {
  AgentEventCanonicalIdentity,
  AgentEventRouteProps,
  CanonicalAgentEvent,
} from '../routes/public.ts';

const resultValueSchema = z.object({
  outcome: z.enum(['continue', 'deny']).optional(),
  reason: z.string().min(1).optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
}).strict();

let eventSequence = 0;

const snapshotNative = (native: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  Object.freeze(structuredClone(native));

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

export const createCanonicalEventProps = (
  event: CanonicalAgentEvent,
  nativeInput: Readonly<Record<string, unknown>>,
  target: string,
  nativeEvent: string,
  hostContractRevision: string,
  signal: AbortSignal,
): AgentEventRouteProps => {
  const native = snapshotNative(nativeInput);
  const canonical: AgentEventCanonicalIdentity = Object.freeze({
    event,
    idempotencyKey: createHash('sha256')
      .update(JSON.stringify({ event, native, target }), 'utf8')
      .digest('hex'),
    observedAt: new Date().toISOString(),
    provenance: Object.freeze({
      host: target,
      hostContractRevision,
      nativeEvent,
      source: 'native',
    }),
    sequence: ++eventSequence,
  });
  return Object.freeze({ canonical, native, signal });
};

const appendContext = (node: AgentDocumentNode, contexts: string[]): void => {
  switch (node.kind) {
    case 'result':
      for (const child of node.children) appendContext(child, contexts);
      break;
    case 'context':
      contexts.push(node.text);
      break;
    case 'audio':
    case 'error':
    case 'image':
    case 'json':
    case 'markdown':
    case 'progress':
    case 'resource':
    case 'text':
      break;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

export const projectEventDocument = (
  document: AgentDocument,
  event: CanonicalAgentEvent,
  target: string,
  nativeEvent: string,
): Readonly<Record<string, unknown>> | undefined => {
  if (target === 'plugin') {
    throw new TypeError('Composite plugin event projection must resolve the invoking host before projecting output.');
  }
  const contexts: string[] = [];
  appendContext(document.root, contexts);
  const additionalContext = contexts.length === 0 ? undefined : contexts.join('');
  const parsedValue = document.value === undefined ? undefined : resultValueSchema.parse(document.value);
  const requireDenyReason = (): string => {
    if (parsedValue?.outcome !== 'deny') {
      throw new TypeError(`${event} did not request a blocking outcome.`);
    }
    if (parsedValue.reason === undefined) {
      throw new TypeError(`${event} requires a nonempty reason when outcome is deny.`);
    }
    return parsedValue.reason;
  };

  if (event === 'stop') {
    if (parsedValue?.outcome !== 'deny') return undefined;
    return target === 'cursor'
      ? Object.freeze({ followup_message: requireDenyReason() })
      : Object.freeze({ decision: 'block', reason: requireDenyReason() });
  }
  if (event === 'agent/start') {
    if (parsedValue?.outcome === 'deny') {
      throw new TypeError('agent/start cannot block subagent creation on any supported host.');
    }
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError('agent/start cannot replace native input.');
    }
    if (additionalContext === undefined) return undefined;
    return target === 'cursor'
      ? Object.freeze({ additional_context: additionalContext })
      : Object.freeze({
          hookSpecificOutput: Object.freeze({
            additionalContext,
            hookEventName: nativeEvent,
          }),
        });
  }
  if (event === 'agent/stop') {
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError('agent/stop cannot replace native input.');
    }
    if (parsedValue?.outcome === 'deny') {
      if (target === 'cursor') {
        throw new TypeError('agent/stop cannot block subagent completion on cursor.');
      }
      return Object.freeze({ decision: 'block', reason: requireDenyReason() });
    }
    if (additionalContext === undefined) return undefined;
    if (target === 'codex') {
      throw new TypeError('agent/stop additional context is not supported by the Codex SubagentStop output schema.');
    }
    return target === 'cursor'
      ? Object.freeze({ additional_context: additionalContext })
      : Object.freeze({
          hookSpecificOutput: Object.freeze({
            additionalContext,
            hookEventName: nativeEvent,
          }),
        });
  }
  if (event === 'tool/before') {
    if (target === 'cursor') {
      if (parsedValue?.outcome === 'deny') {
        return Object.freeze({
          agent_message: parsedValue.reason,
          permission: 'deny',
          user_message: parsedValue.reason,
        });
      }
      return parsedValue?.updatedInput === undefined
        ? undefined
        : Object.freeze({ permission: 'allow', updated_input: parsedValue.updatedInput });
    }
    const output = {
      ...(additionalContext === undefined ? {} : { additionalContext }),
      hookEventName: nativeEvent,
      permissionDecision: parsedValue?.outcome === 'deny' ? 'deny' : 'allow',
      ...(parsedValue?.reason === undefined ? {} : { permissionDecisionReason: parsedValue.reason }),
      ...(parsedValue?.updatedInput === undefined ? {} : { updatedInput: parsedValue.updatedInput }),
    };
    return Object.freeze({ hookSpecificOutput: Object.freeze(output) });
  }
  if (event === 'session/start' || event === 'tool/after') {
    if (additionalContext === undefined) return undefined;
    return target === 'cursor'
      ? Object.freeze({ additional_context: additionalContext })
      : Object.freeze({
          hookSpecificOutput: Object.freeze({
            additionalContext,
            hookEventName: nativeEvent,
          }),
        });
  }
  return undefined;
};
