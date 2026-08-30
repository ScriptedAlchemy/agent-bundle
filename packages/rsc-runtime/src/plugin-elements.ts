import { createElement, type PropsWithChildren, type ReactElement } from 'react';

import type { RscOperationDefinition } from './operation.js';

export interface AgentBundleProps extends PropsWithChildren {
  readonly description?: string;
  readonly marketplace?: boolean;
  readonly name: string;
  readonly node?: string;
  readonly targets: readonly string[];
  readonly version: string;
}

export interface SkillProps {
  readonly source: string;
}

export interface ScriptProps {
  readonly entry: string;
  readonly name: string;
  readonly targets?: readonly string[];
}

export interface McpServerProps extends PropsWithChildren {
  readonly entry: string;
  readonly name: string;
  readonly targets?: readonly string[];
}

export interface McpAppProps {
  /** Resource-level metadata compiled into the app registry, e.g. host presentation hints. */
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly entry: string;
  readonly name: string;
  readonly resourceUri: string;
  readonly targets?: readonly string[];
  readonly template?: string;
}

export interface OperationProps {
  readonly definition: Readonly<RscOperationDefinition>;
}

export const AgentBundle = ({ children, ...props }: AgentBundleProps): ReactElement =>
  createElement('rsc-agent-bundle', props, children);

export const Skill = (props: SkillProps): ReactElement => createElement('rsc-agent-skill', props);

export const Script = (props: ScriptProps): ReactElement => createElement('rsc-agent-script', props);

export const McpServer = ({ children, ...props }: McpServerProps): ReactElement =>
  createElement('rsc-agent-mcp-server', props, children);

export const McpApp = (props: McpAppProps): ReactElement => createElement('rsc-agent-mcp-app', props);

export const Operation = (props: OperationProps): ReactElement => createElement('rsc-agent-operation', props);
