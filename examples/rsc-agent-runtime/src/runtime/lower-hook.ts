import { Children, isValidElement, type ReactNode } from 'react';

export interface NativePostToolUseOutput {
  hookSpecificOutput: {
    additionalContext: string;
    hookEventName: 'PostToolUse';
  };
}

type AgentElementProps = { children?: ReactNode };

const isAgentElement = (node: ReactNode, name: string): node is React.ReactElement<AgentElementProps> =>
  isValidElement<AgentElementProps>(node) && node.type === name;

const flattenText = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(flattenText).join('');
  }

  if (isAgentElement(node, 'agent-hook-result')) {
    throw new Error('Hook result contains duplicate roots');
  }

  throw new Error('Hook additional context may contain only string or number children');
};

export const lowerHookResult = (node: ReactNode): NativePostToolUseOutput => {
  const roots = Children.toArray(node);
  if (roots.length !== 1 || !isAgentElement(roots[0] as ReactNode, 'agent-hook-result')) {
    throw new Error('Expected exactly one agent-hook-result root');
  }

  const result = roots[0] as React.ReactElement<AgentElementProps>;
  const contexts = Children.toArray(result.props.children).map((child) => {
    if (isAgentElement(child, 'agent-hook-result')) {
      throw new Error('Hook result contains duplicate roots');
    }

    if (!isAgentElement(child, 'agent-hook-additional-context')) {
      throw new Error('Hook result may contain only agent-hook-additional-context elements');
    }

    return flattenText(child.props.children);
  });

  if (contexts.length === 0) {
    throw new Error('Hook result requires additional context');
  }

  return {
    hookSpecificOutput: {
      additionalContext: contexts.join(''),
      hookEventName: 'PostToolUse',
    },
  };
};
