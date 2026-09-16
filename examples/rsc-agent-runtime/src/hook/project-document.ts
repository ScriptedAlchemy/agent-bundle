import type { AgentDocument } from '@agent-bundle/runtime';

interface ProjectedPostToolUseOutput {
  readonly hookSpecificOutput: {
    readonly additionalContext: string;
    readonly hookEventName: 'PostToolUse';
  };
}

export const projectHookDocument = (document: AgentDocument): ProjectedPostToolUseOutput => {
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
