import type { AgentBundleConfig, AgentBundleMcpApp, AgentBundleMcpServer } from 'agent-bundle/config';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';

import {
  AgentBundle,
  McpApp,
  McpServer,
  Operation,
  Script,
  Skill,
  type AgentBundleProps,
  type McpAppProps,
  type McpServerProps,
  type OperationProps,
  type ScriptProps,
  type SkillProps,
} from './plugin-elements.js';
import { frozenJsonRecord } from './lower-mcp.js';
import type { RscOperationDefinition } from './operation.js';

type DefinitionElement = { readonly props: Record<string, unknown>; readonly type: string };
type DefinitionComponent = (props: never) => ReactElement;
type ScriptEntry = { readonly entry: string; readonly targets: readonly string[] };

const components = new Set<unknown>([AgentBundle, Skill, Script, McpApp, McpServer, Operation]);
const canonicalName = /^[a-z][a-z0-9._-]{0,63}$/u;
const canonicalTarget = /^[a-z][a-z0-9-]{0,31}$/u;
const canonicalAppName = /^[a-z][a-z0-9-]{0,63}$/u;

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

const requiredAppName = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !canonicalAppName.test(value)) {
    throw new Error(`${label} must be a stable lowercase kebab-case identifier`);
  }
  return value;
};

const requiredResourceUri = (value: unknown, label: string): string => {
  if (typeof value === 'string') {
    try {
      const uri = new URL(value);
      if (uri.protocol === 'ui:' && uri.hostname.length > 0) return value;
    } catch {
      // fall through to the shared error below
    }
  }
  throw new Error(`${label} must use ui:// with a nonempty host`);
};

/** Deterministic JSON with recursively sorted object keys, for value-identity comparisons. */
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) =>
  entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : entry) ?? 'undefined';

const lowerMcpApps = (
  children: unknown,
  serverName: string,
  serverTargets: readonly string[],
): Readonly<Record<string, AgentBundleMcpApp>> | undefined => {
  const apps: Array<readonly [string, Readonly<AgentBundleMcpApp>]> = [];
  for (const appNode of Children.toArray(children as ReactNode)) {
    const app = resolveElement(appNode);
    if (app.type !== 'rsc-agent-mcp-app') {
      throw new Error(`MCP server ${serverName} contains unsupported child ${app.type}`);
    }
    const props = app.props as unknown as McpAppProps;
    const appName = requiredAppName(props.name, `MCP server ${serverName} app name`);
    apps.push(Object.freeze([appName, Object.freeze<AgentBundleMcpApp>({
      ...(props._meta === undefined
        ? {}
        : { _meta: frozenJsonRecord(props._meta, `MCP app ${appName} _meta must be JSON-serializable`) }),
      entry: requiredPath(props.entry, `MCP app ${appName} entry`),
      resourceUri: requiredResourceUri(props.resourceUri, `MCP app ${appName} resourceUri`),
      targets: childTargets(props.targets, serverTargets, `MCP app ${appName} targets`),
      ...(props.template === undefined ? {} : { template: requiredPath(props.template, `MCP app ${appName} template`) }),
    })]));
  }
  if (apps.length === 0) return undefined;
  duplicate(apps.map(([appName]) => appName), `MCP app name on server ${serverName}`);
  return Object.freeze(Object.fromEntries(apps));
};

/**
 * The same app name may appear on several servers only as one shared app: an
 * identical declaration compiled once and served from every declaring server.
 * Targets may differ per server; everything else must match, and a resource
 * URI may not span app names.
 */
const assertSharedApps = (servers: readonly (readonly [string, Readonly<AgentBundleMcpServer>])[]): void => {
  const identities = new Map<string, string>();
  const uriOwners = new Map<string, string>();
  for (const [serverName, server] of servers) {
    for (const [appName, app] of Object.entries(server.apps ?? {})) {
      const identity = canonicalJson({ _meta: app._meta, entry: app.entry, resourceUri: app.resourceUri, template: app.template });
      const known = identities.get(appName);
      if (known !== undefined && known !== identity) {
        throw new Error(`MCP app ${appName} on server ${serverName} does not match its declaration on another server`);
      }
      identities.set(appName, identity);
      const owner = uriOwners.get(app.resourceUri);
      if (owner !== undefined && owner !== appName) {
        throw new Error(`MCP app resource URI ${app.resourceUri} is already declared by app ${owner}`);
      }
      uriOwners.set(app.resourceUri, appName);
    }
  }
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
        const serverTargets = childTargets(props.targets, rootTargets, `MCP server ${serverName} targets`);
        const apps = lowerMcpApps(child.props.children, serverName, serverTargets);
        servers.push(Object.freeze([serverName, Object.freeze({
          ...(apps === undefined ? {} : { apps }),
          entry: requiredPath(props.entry, `MCP server ${serverName} entry`),
          targets: serverTargets,
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
  assertSharedApps(servers);
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
