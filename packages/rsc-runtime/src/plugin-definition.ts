import type { AgentBundleConfig, AgentBundleMcpServer } from 'agent-bundle/config';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';

import {
  AgentBundle,
  McpServer,
  Operation,
  Script,
  Skill,
  type AgentBundleProps,
  type McpServerProps,
  type OperationProps,
  type ScriptProps,
  type SkillProps,
} from './plugin-elements.js';
import type { RscOperationDefinition } from './operation.js';

type DefinitionElement = { readonly props: Record<string, unknown>; readonly type: string };
type DefinitionComponent = (props: never) => ReactElement;
type ScriptEntry = { readonly entry: string; readonly targets: readonly string[] };

const components = new Set<unknown>([AgentBundle, Skill, Script, McpServer, Operation]);
const canonicalName = /^[a-z][a-z0-9._-]{0,63}$/u;
const canonicalTarget = /^[a-z][a-z0-9-]{0,31}$/u;

const resolveElement = (node: ReactNode): DefinitionElement => {
  let candidate = node;
  while (isValidElement(candidate) && components.has(candidate.type)) {
    candidate = (candidate.type as DefinitionComponent)(candidate.props as never);
  }
  if (!isValidElement(candidate) || typeof candidate.type !== 'string' || !candidate.type.startsWith('rsc-agent-')) {
    throw new Error('RSC plugin definition contains an unsupported element');
  }
  return { props: candidate.props as Record<string, unknown>, type: candidate.type };
};

const requiredName = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !canonicalName.test(value)) throw new Error(`${label} must be a canonical lowercase identifier`);
  return value;
};

const requiredPath = (value: unknown, label: string): string => {
  if (
    typeof value !== 'string'
    || value.length < 3
    || value.length > 4096
    || !value.startsWith('./')
    || value.includes('\\')
    || value.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error(`${label} must be a contained project-relative path`);
  }
  return value;
};

const targets = (value: unknown, label: string): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) throw new Error(`${label} must not be empty`);
  const normalized = value.map((entry) => {
    if (typeof entry !== 'string' || !canonicalTarget.test(entry)) throw new Error(`${label} contains an invalid target`);
    return entry;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains a duplicate target`);
  return Object.freeze(normalized);
};

const childTargets = (value: unknown, rootTargets: readonly string[], label: string): readonly string[] => {
  if (value === undefined) return rootTargets;
  const selected = targets(value, label);
  if (selected.some((target) => !rootTargets.includes(target))) throw new Error(`${label} selects an undeclared target`);
  return selected;
};

const duplicate = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) throw new Error(`RSC plugin definition contains a duplicate ${label}`);
};

const immutableConfigArray = <T>(values: readonly T[]): T[] => Object.freeze([...values]) as T[];

export interface RscAgentBundleApplication {
  readonly config: Readonly<AgentBundleConfig>;
  readonly operations: readonly Readonly<RscOperationDefinition>[];
}

export const defineRscAgentBundle = (node: ReactNode): Readonly<RscAgentBundleApplication> => {
  const root = resolveElement(node);
  if (root.type !== 'rsc-agent-bundle') throw new Error('Expected exactly one AgentBundle root');
  const rootProps = root.props as unknown as AgentBundleProps;
  const name = requiredName(rootProps.name, 'Agent Bundle name');
  const version = typeof rootProps.version === 'string' && rootProps.version.trim() !== ''
    ? rootProps.version
    : (() => { throw new Error('Agent Bundle version must be non-empty'); })();
  const rootTargets = targets(rootProps.targets, 'Agent Bundle targets');
  const skills: string[] = [];
  const scripts: Array<readonly [string, Readonly<ScriptEntry>]> = [];
  const servers: Array<readonly [string, Readonly<AgentBundleMcpServer>]> = [];
  const operations: Readonly<RscOperationDefinition>[] = [];

  for (const childNode of Children.toArray(rootProps.children)) {
    const child = resolveElement(childNode);
    switch (child.type) {
      case 'rsc-agent-skill': {
        const props = child.props as unknown as SkillProps;
        skills.push(requiredPath(props.source, 'Skill source'));
        break;
      }
      case 'rsc-agent-script': {
        const props = child.props as unknown as ScriptProps;
        const scriptName = requiredName(props.name, 'Script name');
        scripts.push(Object.freeze([scriptName, Object.freeze({
          entry: requiredPath(props.entry, `Script ${scriptName} entry`),
          targets: childTargets(props.targets, rootTargets, `Script ${scriptName} targets`),
        })]));
        break;
      }
      case 'rsc-agent-mcp-server': {
        const props = child.props as unknown as McpServerProps;
        const serverName = requiredName(props.name, 'MCP server name');
        servers.push(Object.freeze([serverName, Object.freeze({
          entry: requiredPath(props.entry, `MCP server ${serverName} entry`),
          targets: childTargets(props.targets, rootTargets, `MCP server ${serverName} targets`),
        })]));
        break;
      }
      case 'rsc-agent-operation': {
        const props = child.props as unknown as OperationProps;
        if (props.definition === null || typeof props.definition !== 'object' || !Object.isFrozen(props.definition)) {
          throw new Error('Operation definition must come from defineOperation');
        }
        operations.push(props.definition);
        break;
      }
      default:
        throw new Error(`AgentBundle contains unsupported child ${child.type}`);
    }
  }

  duplicate(skills, 'skill source');
  duplicate(scripts.map(([scriptName]) => scriptName), 'script name');
  duplicate(servers.map(([serverName]) => serverName), 'MCP server name');
  duplicate(operations.map((operation) => operation.id), 'operation id');
  duplicate(operations.flatMap((operation) => operation.cli === undefined ? [] : [operation.cli.name]), 'CLI command');
  duplicate(operations.flatMap((operation) => operation.mcp === undefined ? [] : [`${operation.mcp.server}:${operation.mcp.name}`]), 'MCP tool');
  const serverNames = new Set(servers.map(([serverName]) => serverName));
  for (const operation of operations) {
    if (operation.mcp !== undefined && !serverNames.has(operation.mcp.server)) {
      throw new Error(`Operation ${operation.id} references unknown MCP server ${operation.mcp.server}`);
    }
  }

  const config = Object.freeze<AgentBundleConfig>({
    ...(servers.length === 0 ? {} : { mcp: Object.freeze({ servers: Object.freeze(Object.fromEntries(servers)) }) }),
    ...(rootProps.marketplace === undefined ? {} : { marketplace: rootProps.marketplace }),
    plugin: Object.freeze({
      ...(rootProps.description === undefined ? {} : { description: rootProps.description }),
      name,
      version,
    }),
    ...(rootProps.node === undefined ? {} : { runtime: Object.freeze({ node: rootProps.node }) }),
    ...(scripts.length === 0 ? {} : { scripts: Object.freeze(Object.fromEntries(scripts)) }),
    ...(skills.length === 0 ? {} : { skills: immutableConfigArray(skills) }),
    targets: immutableConfigArray(rootTargets),
  });

  return Object.freeze({ config, operations: Object.freeze([...operations]) });
};
