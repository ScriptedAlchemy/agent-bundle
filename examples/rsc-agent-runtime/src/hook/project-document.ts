import type { AgentDocument, NativePostToolUseOutput } from '@agent-bundle/runtime';

export const projectHookDocument = (document: AgentDocument): NativePostToolUseOutput => {
  if (document.status === 'failed' || document.root.kind !== 'result') {
    throw new Error('Hook render requires a successful Agent.Result document');
  }
  if (document.root.children.length !== 1 || document.root.children[0]?.kind !== 'text') {
    throw new Error('Hook render requires exactly one Agent.Text child');
  }
  return {
    hookSpecificOutput: {
      additionalContext: document.root.children[0].text,
      hookEventName: 'PostToolUse',
    },
  };
};
