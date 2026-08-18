import type { PlaygroundJsonObject, PlaygroundSession } from '../services/playground-service.ts';

/** The only operation shapes a browser may request from Playground. */
export type PlaygroundOperationRequest =
  | Readonly<{ readonly operation: 'skill.inspect'; readonly skillId: string; readonly target: string }>
  | Readonly<{ readonly hook: string; readonly input: PlaygroundJsonObject; readonly operation: 'hook.simulate'; readonly target: string }>
  | Readonly<{ readonly arguments: PlaygroundJsonObject; readonly operation: 'mcp.call-tool'; readonly serverName: string; readonly target: string; readonly tool: string }>
  | Readonly<{ readonly operation: 'script.run'; readonly script: string; readonly target: string }>;

export interface PlaygroundRun {
  readonly id: string;
  readonly session: PlaygroundSession;
}
