import { extname } from 'node:path';

import { extractCliArgv, projectInputSchemaOptions, type ExtractedCliArgv } from './cli-argv.ts';
import { scanRouteModuleExports } from './contract.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import { isRecord } from '../core/strict-json.ts';
import { routeRenderLimits, validateRouteRenderConfig, type RouteRenderBudget } from './render-budget.ts';
import type {
  CompiledAgentRoute,
  CompiledCliCommand,
  CompiledCliOption,
  CompiledServerSurface,
} from './types.ts';

/**
 * The #102 command-graph compiler: projects the generated-mode `src/cli/**`
 * route surface into one collision-checked command list. Path segments below
 * the CLI root are the command nesting (`cli:library/audit` ->
 * `library audit`); the statically extracted route config supplies
 * description, aliases, positionals, and the exit-code policy; the bounded
 * argv grammar supplies the option surface. Plain (`.ts`) routes execute
 * directly; rendered (`.tsx`/`.jsx`) routes render through the dispatcher
 * (#102 stage 3) — both share one contract: `inputSchema`, `resultSchema`,
 * and one async default function.
 */

const renderedCliExtensions = new Set(['.jsx', '.tsx']);

/** True for a rendered (`.tsx`/`.jsx`) CLI route module (#102 stage 3 surface). */
export const isRenderedCliRoute = (route: CompiledAgentRoute): boolean =>
  renderedCliExtensions.has(extname(route.source).toLowerCase());

/** The path-derived command segments of one CLI route (`cli:library/audit` -> `['library', 'audit']`). */
export const cliCommandPath = (route: CompiledAgentRoute): readonly string[] =>
  route.id.slice('cli:'.length).split('/');

const safeIdentitySegment = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u;

const collisionError = (message: string, sourcePath: string): Diagnostic => ({
  code: 'AB4813',
  message,
  recovery: 'Keep exactly one command per name at each nesting level, then inspect again.',
  severity: 'error',
  sourcePath,
});

const mcpCollisionError = (
  identity: string,
  message: string,
  sourcePath: string,
): Diagnostic => ({
  code: 'AB4813',
  message: `Projected MCP tool ${JSON.stringify(identity)} ${message}`,
  recovery: `Exclude ${JSON.stringify(identity)} with routes.mcpCommands.exclude, or rename the colliding custom CLI route or alias.`,
  severity: 'error',
  sourcePath,
});

const mcpSelectionError = (message: string): Diagnostic => ({
  code: 'AB4822',
  message,
  recovery: 'Correct the routes.mcpCommands include/exclude patterns using one of the listed generated tool identities, then inspect again.',
  severity: 'error',
});

const contractError = (message: string, sourcePath: string): Diagnostic => ({
  code: 'AB4815',
  message,
  recovery: 'Export const inputSchema and resultSchema, plus one async default function receiving { input, signal }.',
  severity: 'error',
  sourcePath,
});

const positionalsError = (message: string, sourcePath: string): Diagnostic => ({
  code: 'AB4814',
  message,
  recovery: 'Name existing scalar schema keys in argument order; only the last positional may be an array.',
  severity: 'error',
  sourcePath,
});

interface RouteCliConfig {
  readonly aliases: readonly string[];
  readonly description?: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: 'result' | 'zero';
  readonly positionals?: readonly string[];
  readonly render?: RouteRenderBudget;
}

const stringArray = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : undefined;

/** Interprets the statically extracted route config's CLI-owned fields. */
const routeCliConfig = (route: CompiledAgentRoute): RouteCliConfig => {
  const relativePath = route.provenance.relativePath;
  const diagnostics: Diagnostic[] = [];
  const description = route.config['description'];
  if (description !== undefined && typeof description !== 'string') {
    diagnostics.push(contractError(
      `CLI route ${relativePath} config.description must be a string.`,
      route.source,
    ));
  }
  const declaredAliases = route.config['aliases'];
  let aliases = declaredAliases === undefined ? [] : stringArray(declaredAliases);
  if (aliases === undefined) {
    diagnostics.push(contractError(
      `CLI route ${relativePath} config.aliases must be an array of strings.`,
      route.source,
    ));
    aliases = [];
  }
  const declaredExitCode = route.config['exitCode'];
  let exitCode: 'result' | 'zero' = 'zero';
  if (declaredExitCode === 'result') {
    exitCode = 'result';
  } else if (declaredExitCode !== undefined) {
    diagnostics.push(contractError(
      `CLI route ${relativePath} config.exitCode must be "result" when declared; the default policy exits 0 on success.`,
      route.source,
    ));
  }
  const declaredPositionals = route.config['positionals'];
  const positionals = declaredPositionals === undefined ? undefined : stringArray(declaredPositionals);
  if (declaredPositionals !== undefined && positionals === undefined) {
    diagnostics.push(positionalsError(
      `CLI route ${relativePath} config.positionals must be an array of schema key strings.`,
      route.source,
    ));
  }
  // A render budget bounds a render session; a plain `.ts` command executes
  // directly and has none, so declaring one there is a mistake to surface.
  const render = validateRouteRenderConfig(route, 'CLI route');
  diagnostics.push(...render.diagnostics);
  // Any declaration counts, including the type-valid `render: {}`: the key has
  // no meaning on a plain command whatever it holds.
  if (route.config['render'] !== undefined && render.diagnostics.length === 0 && !isRenderedCliRoute(route)) {
    diagnostics.push({
      code: 'AB4835',
      message: `CLI route ${relativePath} declares config.render, but a plain .ts command executes without a render session; only rendered .tsx commands take a render budget.`,
      recovery: 'Rename the module to .tsx and render Agent.* elements, or remove config.render.',
      severity: 'error',
      sourcePath: route.source,
    });
  }
  return {
    aliases,
    ...(typeof description === 'string' ? { description } : {}),
    diagnostics,
    exitCode,
    ...(positionals === undefined ? {} : { positionals }),
    ...(render.render === undefined ? {} : { render: render.render }),
  };
};

/** Applies `config.positionals` onto the extracted option surface, in declared order. */
const applyPositionals = (
  options: readonly CompiledCliOption[],
  positionals: readonly string[],
  relativePath: string,
  sourcePath: string,
): { readonly diagnostics: readonly Diagnostic[]; readonly options?: readonly CompiledCliOption[] } => {
  const diagnostics: Diagnostic[] = [];
  const byKey = new Map(options.map((option) => [option.key, option]));
  const indexOfKey = new Map<string, number>();
  for (const [index, key] of positionals.entries()) {
    if (indexOfKey.has(key)) {
      diagnostics.push(positionalsError(
        `CLI route ${relativePath} config.positionals names ${JSON.stringify(key)} twice.`,
        sourcePath,
      ));
      continue;
    }
    const option = byKey.get(key);
    if (option === undefined) {
      diagnostics.push(positionalsError(
        `CLI route ${relativePath} config.positionals names ${JSON.stringify(key)}, which is not a projected inputSchema key.`,
        sourcePath,
      ));
      continue;
    }
    if (option.kind === 'boolean') {
      diagnostics.push(positionalsError(
        `CLI route ${relativePath} config.positionals names the boolean key ${JSON.stringify(key)}; flags cannot be positional.`,
        sourcePath,
      ));
      continue;
    }
    if (option.repeated && index !== positionals.length - 1) {
      diagnostics.push(positionalsError(
        `CLI route ${relativePath} config.positionals places the array key ${JSON.stringify(key)} before the end; only the last positional may be variadic.`,
        sourcePath,
      ));
      continue;
    }
    indexOfKey.set(key, index);
  }
  let sawOptionalPositional = false;
  for (const key of positionals) {
    const option = byKey.get(key);
    if (option === undefined || !indexOfKey.has(key)) continue;
    if (!option.required && !option.repeated) sawOptionalPositional = true;
    else if (option.required && sawOptionalPositional) {
      diagnostics.push(positionalsError(
        `CLI route ${relativePath} config.positionals places the required key ${JSON.stringify(key)} after an optional one.`,
        sourcePath,
      ));
    }
  }
  if (diagnostics.length > 0) return { diagnostics };
  return {
    diagnostics: [],
    options: options.map((option) => {
      const index = indexOfKey.get(option.key);
      return index === undefined ? option : { ...option, positional: index };
    }),
  };
};

export interface CompiledCliCommandSurface {
  readonly commands: readonly CompiledCliCommand[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface McpCommandSelection {
  readonly exclude?: readonly string[];
  readonly include?: readonly string[];
}

export interface CompiledMcpCliCommandSurface extends CompiledCliCommandSurface {
  readonly routes: readonly CompiledAgentRoute[];
}

interface EligibleMcpTool {
  readonly identity: string;
  readonly route: CompiledAgentRoute;
  readonly server: string;
  readonly tool: string;
}

const patternExpression = (pattern: string): RegExp => new RegExp(
  `^${pattern.split('*').map((literal) =>
    literal.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')).join('.*')}$`,
  'u',
);

const toolOption: CompiledCliOption = Object.freeze({
  description: 'Tool input as one JSON object.',
  key: 'input',
  kind: 'string',
  option: 'input',
  repeated: false,
  required: false,
});

const confirmationOption: CompiledCliOption = Object.freeze({
  description: 'Confirm running this mutation-capable MCP tool.',
  key: 'yes',
  kind: 'boolean',
  option: 'yes',
  repeated: false,
  required: false,
});

/**
 * Projects selected tools from generated MCP servers into rendered CLI
 * commands. This in-house projection intentionally uses the compiled route
 * graph directly (G7); MCPorter remains an independent live-server client.
 */
export const compileMcpCliCommands = (
  servers: readonly CompiledServerSurface[],
  selection: McpCommandSelection,
): CompiledMcpCliCommandSurface => {
  const eligible: EligibleMcpTool[] = servers
    .filter((server) => server.mode === 'generated')
    .flatMap((server) => server.routes
      .filter((route) => route.kind === 'tool')
      .map((route) => {
        const tool = route.id.slice(route.id.lastIndexOf('/') + 1);
        return { identity: `${server.name}:${tool}`, route, server: server.name, tool };
      }))
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const available = eligible.length === 0
    ? 'No generated MCP tools are available.'
    : `Available generated MCP tools: ${eligible.map((tool) => tool.identity).join(', ')}.`;
  const diagnostics: Diagnostic[] = [];
  let selected: EligibleMcpTool[];

  if (selection.include === undefined) {
    selected = [...eligible];
  } else if (selection.include.length === 0) {
    diagnostics.push(mcpSelectionError(
      `routes.mcpCommands.include is empty and therefore selects no tools. ${available}`,
    ));
    selected = [];
  } else {
    const included = new Set<string>();
    for (const pattern of selection.include) {
      const expression = patternExpression(pattern);
      const matches = eligible.filter((tool) => expression.test(tool.identity));
      if (matches.length === 0) {
        diagnostics.push(mcpSelectionError(
          `routes.mcpCommands.include pattern ${JSON.stringify(pattern)} matches no eligible tool. ${available}`,
        ));
      }
      for (const match of matches) included.add(match.identity);
    }
    selected = eligible.filter((tool) => included.has(tool.identity));
  }

  for (const pattern of selection.exclude ?? []) {
    const expression = patternExpression(pattern);
    const matches = eligible.filter((tool) => expression.test(tool.identity));
    if (matches.length === 0) {
      diagnostics.push(mcpSelectionError(
        `routes.mcpCommands.exclude pattern ${JSON.stringify(pattern)} matches no eligible tool. ${available}`,
      ));
    }
    const excluded = new Set(matches.map((tool) => tool.identity));
    selected = selected.filter((tool) => !excluded.has(tool.identity));
  }

  const commands = selected.map(({ route, server, tool }) => {
    const annotations = route.config['annotations'];
    const confirm = !(isRecord(annotations) && annotations.readOnlyHint === true);
    const description = route.config['description'];
    // The tool's own render budget was validated with its server (AB4835 is
    // reported once, there); the projected command inherits the value.
    const render = routeRenderLimits(route.config);
    return {
      aliases: [],
      ...(typeof description === 'string' ? { description } : {}),
      exitCode: route.config['exitCode'] === 'result' ? 'result' as const : 'zero' as const,
      mcp: { confirm, server, tool },
      options: confirm ? [toolOption, confirmationOption] : [toolOption],
      path: [server, tool],
      ...(render === undefined ? {} : { render }),
      rendered: true,
      routeId: route.id,
    };
  });
  return deepFreeze({
    commands,
    diagnostics,
    routes: selected.map((tool) => tool.route),
  });
};

export interface CompileCliCommandsOptions {
  /** Absolute project root; an `inputSchema` reference resolving outside it is rejected (AB4838). */
  readonly projectRoot?: string;
}

/**
 * The argv surface of one route: a projection of its canonical contract when
 * the graph bound one (`route.inputSchema` is the contract's normalized
 * `input`), so the command grammar and the route's declared input are one
 * object; otherwise the module is parsed again, which is what reports why no
 * contract exists (AB4814, AB4838, AB4839).
 */
const routeArgv = (
  route: CompiledAgentRoute,
  moduleText: string,
  options: CompileCliCommandsOptions,
): ExtractedCliArgv => {
  const relativePath = route.provenance.relativePath;
  if (route.inputSchema !== undefined) {
    return { ...projectInputSchemaOptions(route.inputSchema, relativePath, route.source), found: true };
  }
  return extractCliArgv(moduleText, relativePath, route.source, {
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    source: route.source,
  });
};

/**
 * Compiles the generated-mode CLI route surface into the collision-checked
 * command graph. `readModuleText` supplies each plain route's source text
 * (a racing deletion yields undefined and the route simply compiles no
 * command; the next source snapshot settles it).
 */
export const compileCliCommands = async (
  routes: readonly CompiledAgentRoute[],
  readModuleText: (route: CompiledAgentRoute) => Promise<string | undefined>,
  projected: CompiledMcpCliCommandSurface = { commands: [], diagnostics: [], routes: [] },
  compileOptions: CompileCliCommandsOptions = {},
): Promise<CompiledCliCommandSurface> => {
  const diagnostics: Diagnostic[] = [...projected.diagnostics];
  const commands: CompiledCliCommand[] = [...projected.commands];

  for (const route of [...routes].sort((left, right) => left.id.localeCompare(right.id))) {
    const relativePath = route.provenance.relativePath;
    const moduleText = await readModuleText(route);
    if (moduleText === undefined) continue;

    const config = routeCliConfig(route);
    diagnostics.push(...config.diagnostics);

    const exports = scanRouteModuleExports(moduleText, relativePath, { source: route.source });
    // A default re-exported from a module the scan cannot read is judged at
    // run time, like the MCP route contract.
    const asyncDefault = exports.asyncDefault || exports.defaultReExport?.resolution === 'unresolved';
    const argv = routeArgv(route, moduleText, compileOptions);
    const missing = [
      ...(argv.found ? [] : ['inputSchema']),
      ...(exports.named.has('resultSchema') ? [] : ['resultSchema']),
    ];
    if (missing.length > 0 || !asyncDefault) {
      const details = [
        ...(missing.length === 0 ? [] : [`missing named ${missing.join(' and ')}`]),
        ...(asyncDefault ? [] : ['default export is not an async function']),
      ];
      diagnostics.push(contractError(
        `CLI route ${relativePath} does not satisfy the routed command contract: ${details.join('; ')}.`,
        route.source,
      ));
      continue;
    }
    diagnostics.push(...argv.diagnostics);
    if (config.diagnostics.length > 0 || argv.options === undefined) continue;

    let options = argv.options;
    if (config.positionals !== undefined) {
      const positioned = applyPositionals(options, config.positionals, relativePath, route.source);
      diagnostics.push(...positioned.diagnostics);
      if (positioned.options === undefined) continue;
      options = positioned.options;
    }

    commands.push({
      aliases: config.aliases,
      ...(config.description === undefined ? {} : { description: config.description }),
      exitCode: config.exitCode,
      options,
      path: cliCommandPath(route),
      ...(config.render === undefined ? {} : { render: config.render }),
      rendered: isRenderedCliRoute(route),
      routeId: route.id,
    });
  }

  interface PathClaim {
    readonly mcp?: NonNullable<CompiledCliCommand['mcp']>;
    readonly path: readonly string[];
    readonly relativePath: string;
    readonly source: string;
  }
  // Collision checks run over every discovered custom route's claimed path,
  // even when it compiled no command, plus every selected MCP projection.
  const claims: PathClaim[] = [
    ...routes.map((route) => ({
      path: cliCommandPath(route),
      relativePath: route.provenance.relativePath,
      source: route.source,
    })),
    ...projected.commands.map((command) => {
      const route = projected.routes.find((candidate) => candidate.id === command.routeId)!;
      return {
        mcp: command.mcp!,
        path: command.path,
        relativePath: route.provenance.relativePath,
        source: route.source,
      };
    }),
  ];
  const mcpIdentity = (claim: PathClaim): string | undefined =>
    claim.mcp === undefined ? undefined : `${claim.mcp.server}:${claim.mcp.tool}`;
  const claimedPaths = new Map<string, PathClaim>();
  for (const claim of claims) {
    const path = claim.path.join('/');
    const existing = claimedPaths.get(path);
    if (existing === undefined) {
      claimedPaths.set(path, claim);
      continue;
    }
    const mcp = claim.mcp === undefined ? existing : claim;
    const identity = mcpIdentity(mcp);
    diagnostics.push(identity === undefined
      ? collisionError(
        `CLI command ${JSON.stringify(path.replaceAll('/', ' '))} is claimed by both ${existing.relativePath} and ${claim.relativePath}; the compiler never chooses silently.`,
        claim.source,
      )
      : mcpCollisionError(
        identity,
        `claims the same command path as ${claim.mcp === undefined ? claim.relativePath : existing.relativePath}.`,
        claim.mcp === undefined ? claim.source : existing.source,
      ));
  }
  const groupPaths = new Map<string, PathClaim>();
  for (const claim of claims) {
    for (let depth = 1; depth < claim.path.length; depth += 1) {
      const prefix = claim.path.slice(0, depth).join('/');
      if (!groupPaths.has(prefix)) groupPaths.set(prefix, claim);
    }
  }
  for (const [path, claim] of claimedPaths) {
    const groupClaim = groupPaths.get(path);
    if (groupClaim === undefined) continue;
    const mcp = claim.mcp === undefined ? groupClaim : claim;
    const identity = mcpIdentity(mcp);
    diagnostics.push(identity === undefined
      ? collisionError(
        `CLI command ${JSON.stringify(path.replaceAll('/', ' '))} is both the command module ${claim.relativePath} and a command group (${groupClaim.relativePath} nests below it); the compiler never chooses silently.`,
        claim.source,
      )
      : mcpCollisionError(
        identity,
        `collides with the custom command ${claim.mcp === undefined ? claim.relativePath : groupClaim.relativePath} at its server command group.`,
        claim.mcp === undefined ? claim.source : groupClaim.source,
      ));
  }

  // Alias collisions resolve per nesting level: an alias must not equal a
  // sibling command name, a sibling group name, or another sibling alias.
  interface LevelClaim {
    readonly description: string;
    readonly pathClaim: PathClaim;
  }
  const levelNames = new Map<string, Map<string, LevelClaim>>();
  const claimLevelName = (parent: string, name: string, claim: LevelClaim): LevelClaim | undefined => {
    const names = levelNames.get(parent) ?? new Map<string, LevelClaim>();
    levelNames.set(parent, names);
    const existing = names.get(name);
    if (existing !== undefined) return existing;
    names.set(name, claim);
    return undefined;
  };
  for (const [path, claim] of claimedPaths) {
    const segments = path.split('/');
    claimLevelName(segments.slice(0, -1).join('/'), segments[segments.length - 1]!, {
      description: claim.mcp === undefined
        ? `the command ${claim.relativePath}`
        : `projected MCP tool ${JSON.stringify(mcpIdentity(claim))}`,
      pathClaim: claim,
    });
  }
  for (const [path, claim] of groupPaths) {
    const segments = path.split('/');
    claimLevelName(segments.slice(0, -1).join('/'), segments[segments.length - 1]!, {
      description: claim.mcp === undefined
        ? `the ${claim.relativePath} command group`
        : `the ${JSON.stringify(mcpIdentity(claim))} MCP server command group`,
      pathClaim: claim,
    });
  }
  for (const command of commands) {
    const parent = command.path.slice(0, -1).join('/');
    const route = [...routes, ...projected.routes].find((candidate) => candidate.id === command.routeId)!;
    const commandClaim: PathClaim = {
      ...(command.mcp === undefined ? {} : { mcp: command.mcp }),
      path: command.path,
      relativePath: route.provenance.relativePath,
      source: route.source,
    };
    for (const alias of new Set(command.aliases)) {
      if (!safeIdentitySegment.test(alias)) {
        diagnostics.push(collisionError(
          `CLI route ${route.provenance.relativePath} declares the unsafe alias ${JSON.stringify(alias)}; use letters, digits, and inner ".", "_", "-" only.`,
          route.source,
        ));
        continue;
      }
      const existing = claimLevelName(parent, alias, {
        description: `the ${route.provenance.relativePath} alias`,
        pathClaim: commandClaim,
      });
      if (existing !== undefined) {
        const mcp = commandClaim.mcp === undefined ? existing.pathClaim : commandClaim;
        const identity = mcpIdentity(mcp);
        diagnostics.push(identity === undefined
          ? collisionError(
            `CLI alias ${JSON.stringify(alias)} on ${route.provenance.relativePath} collides with ${existing.description} at the same nesting level.`,
            route.source,
          )
          : mcpCollisionError(
            identity,
            `collides with the custom alias ${JSON.stringify(alias)} on ${commandClaim.mcp === undefined ? route.provenance.relativePath : existing.pathClaim.relativePath}.`,
            commandClaim.mcp === undefined ? route.source : existing.pathClaim.source,
          ));
      }
    }
    const duplicateAlias = command.aliases.find((alias, index) => command.aliases.indexOf(alias) !== index);
    if (duplicateAlias !== undefined) {
      diagnostics.push(collisionError(
        `CLI route ${route.provenance.relativePath} declares the alias ${JSON.stringify(duplicateAlias)} twice.`,
        route.source,
      ));
    }
  }

  return deepFreeze({
    commands: [...commands].sort((left, right) => left.path.join('/').localeCompare(right.path.join('/'))),
    diagnostics,
  });
};
