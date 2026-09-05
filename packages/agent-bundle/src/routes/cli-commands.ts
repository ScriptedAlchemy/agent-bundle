import { extname } from 'node:path';

import {
  extractCliArgv,
  projectInputSchemaOptions,
  type CliOptionOverride,
  type CliOptionPolicy,
  type CliReservedKey,
  type ExtractedCliArgv,
} from './cli-argv.ts';
import {
  cliProjectionBindingError,
  cliProjectionContractError,
  extractCliProjection,
  inputKeysRecovery,
  relaxationRecovery,
  relaxationWithoutMapInputDetail,
  stringArray,
  unknownInputKeyDetail,
  type CliProjectionModule,
} from './cli-projection.ts';
import { scanRouteModuleExports } from './contract.ts';
import { mcpRouteProtocolName } from './protocol-name.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import { isRecord } from '../core/strict-json.ts';
import { routeRenderLimits, validateRouteRenderConfig, type RouteRenderBudget } from './render-budget.ts';
import {
  safeIdentitySegment,
  type CompiledAgentRoute,
  type CompiledCliCommand,
  type CompiledCliOption,
  type CompiledServerSurface,
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

const collisionError = (message: string, sourcePath: string): Diagnostic => ({
  code: 'AB4813',
  message,
  recovery: 'Keep exactly one command per name at each nesting level, then inspect again.',
  severity: 'error',
  sourcePath,
});

/** The MCP provenance of one claimed command path: the bulk projection's tool, or a tool's projection module. */
interface McpPathProvenance {
  readonly identity: string;
  /** Project-relative path of the `<tool>.cli.{ts,tsx}` module; absent for the bulk `routes.mcpCommands` projection. */
  readonly projection?: string;
}

/**
 * AB4813 for a projected MCP command: the bulk projection is fixed in config
 * (`routes.mcpCommands.exclude`), an explicit projection in its module
 * (`command`, or removing the module).
 */
const mcpCollisionError = (
  provenance: McpPathProvenance,
  message: string,
  sourcePath: string,
): Diagnostic => ({
  code: 'AB4813',
  message: provenance.projection === undefined
    ? `Projected MCP tool ${JSON.stringify(provenance.identity)} ${message}`
    : `CLI projection ${provenance.projection} of MCP tool ${JSON.stringify(provenance.identity)} ${message}`,
  recovery: provenance.projection === undefined
    ? `Exclude ${JSON.stringify(provenance.identity)} with routes.mcpCommands.exclude, or rename the colliding custom CLI route or alias.`
    : `Change command (or aliases) in ${provenance.projection} or remove the module, or rename the colliding custom CLI route or alias; then inspect again.`,
  severity: 'error',
  sourcePath,
});

const mcpSelectionError = (message: string, recovery?: string): Diagnostic => ({
  code: 'AB4822',
  message,
  recovery: recovery
    ?? 'Correct the routes.mcpCommands include/exclude patterns using one of the listed generated tool identities, then inspect again.',
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

/**
 * Applies `config.positionals` onto the extracted option surface, in declared
 * order. `report` words one rule violation for the declaring module: a CLI
 * route's own AB4814, or a projection module's AB4842 (#596); the detail it
 * receives continues `config.positionals ...` without a final period.
 */
const applyPositionals = (
  options: readonly CompiledCliOption[],
  positionals: readonly string[],
  report: (detail: string) => Diagnostic,
): { readonly diagnostics: readonly Diagnostic[]; readonly options?: readonly CompiledCliOption[] } => {
  const diagnostics: Diagnostic[] = [];
  const byKey = new Map(options.map((option) => [option.key, option]));
  const indexOfKey = new Map<string, number>();
  for (const [index, key] of positionals.entries()) {
    if (indexOfKey.has(key)) {
      diagnostics.push(report(`config.positionals names ${JSON.stringify(key)} twice`));
      continue;
    }
    const option = byKey.get(key);
    if (option === undefined) {
      diagnostics.push(report(`config.positionals names ${JSON.stringify(key)}, which is not a projected inputSchema key`));
      continue;
    }
    if (option.kind === 'boolean') {
      diagnostics.push(report(`config.positionals names the boolean key ${JSON.stringify(key)}; flags cannot be positional`));
      continue;
    }
    if (option.repeated && index !== positionals.length - 1) {
      diagnostics.push(report(
        `config.positionals places the array key ${JSON.stringify(key)} before the end; only the last positional may be variadic`,
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
      diagnostics.push(report(`config.positionals places the required key ${JSON.stringify(key)} after an optional one`));
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

/** One generated tool with its own `<tool>.cli.{ts,tsx}` module: `identity` → project-relative module path. */
interface ProjectedMcpTool extends EligibleMcpTool {
  readonly projection: string;
}

/**
 * Projects selected tools from generated MCP servers into rendered CLI
 * commands. This in-house projection intentionally uses the compiled route
 * graph directly (G7); MCPorter remains an independent live-server client.
 * `projections` maps a tool route id to its projection module (#596): such a
 * tool has one command, the projection's, and leaves the eligible set here.
 */
export const compileMcpCliCommands = (
  servers: readonly CompiledServerSurface[],
  selection: McpCommandSelection,
  projections: ReadonlyMap<string, string> = new Map(),
): CompiledMcpCliCommandSurface => {
  const generatedTools: EligibleMcpTool[] = servers
    .filter((server) => server.mode === 'generated')
    .flatMap((server) => server.routes
      .filter((route) => route.kind === 'tool')
      .map((route) => {
        const tool = mcpRouteProtocolName(route.id);
        return { identity: `${server.name}:${tool}`, route, server: server.name, tool };
      }))
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const eligible = generatedTools.filter((tool) => !projections.has(tool.route.id));
  const projected: ProjectedMcpTool[] = generatedTools
    .flatMap((tool) => {
      const projection = projections.get(tool.route.id);
      return projection === undefined ? [] : [{ ...tool, projection }];
    });
  const available = eligible.length === 0
    ? 'No generated MCP tools are available.'
    : `Available generated MCP tools: ${eligible.map((tool) => tool.identity).join(', ')}.`;
  const diagnostics: Diagnostic[] = [];
  let selected: EligibleMcpTool[];

  // An include pattern that reaches only tools with projection modules names
  // them: the pattern is not wrong about the tools, only about who projects
  // them.
  const onlyProjected = (pattern: string, expression: RegExp): Diagnostic | undefined => {
    const matches = projected.filter((tool) => expression.test(tool.identity));
    if (matches.length === 0) return undefined;
    return mcpSelectionError(
      `routes.mcpCommands.include pattern ${JSON.stringify(pattern)} matches only tools with their own CLI projection modules (${matches.map((tool) => `${tool.identity} via ${tool.projection}`).join(', ')}); a projected tool leaves the bulk projection. ${available}`,
      'Drop the pattern (the projection module already compiles the command), or remove the projection module to project the tool in bulk; then inspect again.',
    );
  };

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
        diagnostics.push(onlyProjected(pattern, expression) ?? mcpSelectionError(
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
    // Excluding a tool that already left the bulk projection through its
    // projection module asks for what is the case; only a pattern that
    // reaches no generated tool at all is a mistake.
    if (matches.length === 0 && !projected.some((tool) => expression.test(tool.identity))) {
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
 * contract exists (AB4814, AB4838, AB4839). `policy` is the projection
 * module's respelling of the keys and the label its diagnostics name (#596).
 */
const routeArgv = (
  route: CompiledAgentRoute,
  moduleText: string,
  options: CompileCliCommandsOptions,
  policy: CliOptionPolicy = {},
): ExtractedCliArgv => {
  const relativePath = route.provenance.relativePath;
  if (route.inputSchema !== undefined) {
    return { ...projectInputSchemaOptions(route.inputSchema, relativePath, route.source, policy), found: true };
  }
  return extractCliArgv(moduleText, relativePath, route.source, {
    policy,
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    source: route.source,
  });
};

/**
 * One tool route of a generated server paired with the `<tool>.cli.{ts,tsx}`
 * module beside it (#596). `toolText` is the tool module's own source, read
 * by the graph; it is parsed again only when the tool has no static
 * contract, so the reason (AB4814/AB4838/AB4839) is reported under the
 * tool's label.
 */
export interface CliProjectionPair {
  readonly module: CliProjectionModule;
  readonly moduleText: string;
  /** Project-relative POSIX path of the projection module. */
  readonly relativePath: string;
  /** Absolute path of the projection module. */
  readonly source: string;
  readonly tool: CompiledAgentRoute;
  readonly toolText?: string;
}

/** The commands the projection modules compile, the tool routes behind them, and where each module lives. */
export interface CompiledProjectedCliCommandSurface extends CompiledMcpCliCommandSurface {
  /** Tool route id → absolute path of its projection module; build-side, never digested. */
  readonly projectionSources: Readonly<Record<string, string>>;
}

const positionalsRecovery = 'Name existing scalar inputSchema keys in argument order; only the last positional may be an array. Then inspect again.';

/**
 * AB4842 on a confirming projection whose tool contract has a key `yes`: the
 * shell keys parsed values by canonical key and reads and strips `yes` as
 * the confirmation, so the tool could never receive it — under any `name`.
 */
const confirmationKeyReservation: CliReservedKey = {
  detail: 'the tool\'s inputSchema has a key "yes", which a confirming command reserves for its --yes confirmation and strips before the tool runs, whatever the key is spelled; set confirm: false or rename the key',
  recovery: 'Declare confirm: false in the projection, or rename the tool\'s "yes" input key; then inspect again.',
};

/**
 * Compiles each tool's explicit CLI surface (#596): the projection module's
 * `config` respells the tool's canonical input onto argv under the one
 * option policy CLI routes use, so kebab-case, reserved-name, and collision
 * rules judge the final spellings and aliases. A pair whose module or
 * binding fails compiles no command; the diagnostics name the module. The
 * command runs the tool (`routeId`, `mcp`) with the projected grammar
 * (`projection`), never `--input`.
 */
export const compileProjectedCliCommands = (
  pairs: readonly CliProjectionPair[],
  compileOptions: CompileCliCommandsOptions = {},
): CompiledProjectedCliCommandSurface => {
  const diagnostics: Diagnostic[] = [];
  const commands: CompiledCliCommand[] = [];
  const routes: CompiledAgentRoute[] = [];
  const projectionSources: Record<string, string> = {};

  for (const pair of [...pairs].sort((left, right) => left.tool.id.localeCompare(right.tool.id))) {
    const { module, relativePath, source, tool } = pair;
    const binding = (detail: string, recovery?: string): Diagnostic =>
      cliProjectionBindingError(relativePath, tool.id, detail, source, recovery);
    const extracted = extractCliProjection(pair.moduleText, relativePath, source, tool.inputSchema, tool, {
      ...(compileOptions.projectRoot === undefined ? {} : { projectRoot: compileOptions.projectRoot }),
    });
    diagnostics.push(...extracted.diagnostics);
    if (extracted.diagnostics.length > 0) continue;
    const { config } = extracted;

    const annotations = tool.config['annotations'];
    const confirm = config.confirm ?? !(isRecord(annotations) && annotations.readOnlyHint === true);
    const aliases = config.aliases ?? [];
    let aliasesValid = true;
    for (const [index, alias] of aliases.entries()) {
      if (!safeIdentitySegment.test(alias)) {
        diagnostics.push(binding(
          `config.aliases[${index}] ${JSON.stringify(alias)} is not a safe identity segment`,
          'Use command aliases of letters, digits, and inner ".", "_", "-" only, then inspect again.',
        ));
        aliasesValid = false;
      } else if (aliases.indexOf(alias) !== index) {
        diagnostics.push(binding(
          `config.aliases declares ${JSON.stringify(alias)} twice`,
          'Declare each command alias once, then inspect again.',
        ));
        aliasesValid = false;
      }
    }
    if (!aliasesValid) continue;

    // The tool text is absent only when the graph's read raced a deletion;
    // the next source snapshot settles it, as for a CLI route.
    if (tool.inputSchema === undefined && pair.toolText === undefined) continue;
    const overrides: Record<string, CliOptionOverride> = {};
    for (const [key, flag] of Object.entries(config.flags ?? {})) overrides[key] = flag;
    const argv = routeArgv(tool, pair.toolText ?? '', compileOptions, {
      label: `Tool route ${tool.provenance.relativePath} (CLI projection ${relativePath})`,
      overrideError: (detail, recovery) => binding(detail, recovery),
      overrides,
      ...(confirm ? { reserved: ['yes'], reservedKeys: { yes: confirmationKeyReservation } } : {}),
    });
    // A tool without an extractable inputSchema is judged by its server's
    // contract diagnostics; the projection has nothing to bind until then.
    if (!argv.found) continue;
    diagnostics.push(...argv.diagnostics);
    if (argv.options === undefined) continue;
    let options = argv.options;

    // Without a canonical contract the binding checks ran against nothing
    // in extractCliProjection; the parsed schema is the contract here.
    if (tool.inputSchema === undefined) {
      const keys = new Set(options.map((option) => option.key));
      const keyRecovery = inputKeysRecovery([...keys]);
      let bound = true;
      for (const [key, flag] of Object.entries(config.flags ?? {})) {
        if (!keys.has(key)) {
          diagnostics.push(binding(unknownInputKeyDetail('flags', key), keyRecovery));
          bound = false;
        }
        if (!extracted.mapInput && argv.relaxed?.includes(key) === true) {
          diagnostics.push(cliProjectionContractError(
            relativePath,
            tool.id,
            relaxationWithoutMapInputDetail(key, flag),
            source,
            relaxationRecovery(key),
          ));
          bound = false;
        }
      }
      if (!bound) continue;
    }

    if (config.positionals !== undefined) {
      const positioned = applyPositionals(options, config.positionals, (detail) => binding(detail, positionalsRecovery));
      diagnostics.push(...positioned.diagnostics);
      if (positioned.options === undefined) continue;
      options = positioned.options;
    }
    // A confirming command takes --yes like the bulk projection does; the
    // spelling was reserved above, so no key of the schema claims it.
    if (confirm) options = [...options, confirmationOption];

    const description = config.description ?? tool.config['description'];
    // The tool's own render budget was validated with its server (AB4835 is
    // reported once, there); the projected command inherits the value.
    const render = routeRenderLimits(tool.config);
    routes.push(tool);
    projectionSources[tool.id] = source;
    commands.push({
      aliases,
      ...(typeof description === 'string' ? { description } : {}),
      exitCode: config.exitCode ?? (tool.config['exitCode'] === 'result' ? 'result' : 'zero'),
      mcp: { confirm, server: module.server, tool: module.stem },
      options,
      path: config.command ?? [module.stem],
      projection: {
        ...(argv.defaults === undefined ? {} : { defaults: argv.defaults }),
        mapInput: extracted.mapInput,
        module: relativePath,
        ...(argv.relaxed === undefined ? {} : { relaxed: argv.relaxed }),
      },
      ...(render === undefined ? {} : { render }),
      rendered: true,
      routeId: tool.id,
    });
  }

  return deepFreeze({ commands, diagnostics, projectionSources, routes });
};

const emptyMcpSurface: CompiledMcpCliCommandSurface = { commands: [], diagnostics: [], routes: [] };
const emptyProjectedSurface: CompiledProjectedCliCommandSurface = { ...emptyMcpSurface, projectionSources: {} };

/**
 * Compiles the generated-mode CLI route surface into the collision-checked
 * command graph. `readModuleText` supplies each plain route's source text
 * (a racing deletion yields undefined and the route simply compiles no
 * command; the next source snapshot settles it). `projected` is the bulk
 * `routes.mcpCommands` projection and `projections` the per-tool projection
 * modules (#596); both join the command set and the collision pass.
 */
export const compileCliCommands = async (
  routes: readonly CompiledAgentRoute[],
  readModuleText: (route: CompiledAgentRoute) => Promise<string | undefined>,
  projected: CompiledMcpCliCommandSurface = emptyMcpSurface,
  compileOptions: CompileCliCommandsOptions = {},
  projections: CompiledProjectedCliCommandSurface = emptyProjectedSurface,
): Promise<CompiledCliCommandSurface> => {
  const diagnostics: Diagnostic[] = [...projected.diagnostics, ...projections.diagnostics];
  const commands: CompiledCliCommand[] = [...projected.commands, ...projections.commands];

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
      const positioned = applyPositionals(options, config.positionals, (detail) =>
        positionalsError(`CLI route ${relativePath} ${detail}.`, route.source));
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
    readonly path: readonly string[];
    readonly provenance?: McpPathProvenance;
    readonly relativePath: string;
    readonly source: string;
  }
  const mcpProvenance = (command: CompiledCliCommand): McpPathProvenance => ({
    identity: `${command.mcp!.server}:${command.mcp!.tool}`,
    ...(command.projection === undefined ? {} : { projection: command.projection.module }),
  });
  // Collision checks run over every discovered custom route's claimed path,
  // even when it compiled no command, plus every compiled MCP projection.
  // Each route id claims at most one path, so the table serves the alias
  // pass below as well.
  const claimByRouteId = new Map<string, PathClaim>();
  for (const route of routes) {
    claimByRouteId.set(route.id, {
      path: cliCommandPath(route),
      relativePath: route.provenance.relativePath,
      source: route.source,
    });
  }
  for (const command of projected.commands) {
    const route = projected.routes.find((candidate) => candidate.id === command.routeId)!;
    claimByRouteId.set(command.routeId, {
      path: command.path,
      provenance: mcpProvenance(command),
      relativePath: route.provenance.relativePath,
      source: route.source,
    });
  }
  for (const command of projections.commands) {
    claimByRouteId.set(command.routeId, {
      path: command.path,
      provenance: mcpProvenance(command),
      relativePath: command.projection!.module,
      source: projections.projectionSources[command.routeId]!,
    });
  }
  const claims = [...claimByRouteId.values()];
  const sides = (claim: PathClaim, existing: PathClaim): {
    readonly mcp: PathClaim;
    readonly other: PathClaim;
    readonly sourcePath: string;
  } => {
    const [mcp, other] = claim.provenance === undefined ? [existing, claim] : [claim, existing];
    // A projection module owns its `command`; the bulk projection is fixed
    // in config, so the colliding custom route is the file to open.
    return { mcp, other, sourcePath: mcp.provenance?.projection === undefined ? other.source : mcp.source };
  };
  const claimedPaths = new Map<string, PathClaim>();
  for (const claim of claims) {
    const path = claim.path.join('/');
    const existing = claimedPaths.get(path);
    if (existing === undefined) {
      claimedPaths.set(path, claim);
      continue;
    }
    const { mcp, other, sourcePath } = sides(claim, existing);
    diagnostics.push(mcp.provenance === undefined
      ? collisionError(
        `CLI command ${JSON.stringify(path.replaceAll('/', ' '))} is claimed by both ${existing.relativePath} and ${claim.relativePath}; the compiler never chooses silently.`,
        claim.source,
      )
      : mcpCollisionError(mcp.provenance, `claims the same command path as ${other.relativePath}.`, sourcePath));
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
    const { mcp, other, sourcePath } = sides(claim, groupClaim);
    diagnostics.push(mcp.provenance === undefined
      ? collisionError(
        `CLI command ${JSON.stringify(path.replaceAll('/', ' '))} is both the command module ${claim.relativePath} and a command group (${groupClaim.relativePath} nests below it); the compiler never chooses silently.`,
        claim.source,
      )
      : mcpCollisionError(
        mcp.provenance,
        mcp.provenance.projection === undefined
          ? `collides with the custom command ${other.relativePath} at its server command group.`
          : `collides with ${other.relativePath} at the command path ${JSON.stringify(path.replaceAll('/', ' '))}, which is both a command and a command group.`,
        sourcePath,
      ));
  }

  // Alias collisions resolve per nesting level: an alias must not equal a
  // sibling command name, a sibling group name, or another sibling alias.
  interface LevelClaim {
    readonly description: string;
    readonly pathClaim: PathClaim;
  }
  const describeOwner = (claim: PathClaim): string => claim.provenance === undefined
    ? `CLI route ${claim.relativePath}`
    : claim.provenance.projection === undefined
      ? `Projected MCP tool ${JSON.stringify(claim.provenance.identity)}`
      : `CLI projection ${claim.provenance.projection}`;
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
      description: claim.provenance === undefined
        ? `the command ${claim.relativePath}`
        : claim.provenance.projection === undefined
          ? `projected MCP tool ${JSON.stringify(claim.provenance.identity)}`
          : `the CLI projection ${claim.provenance.projection} command`,
      pathClaim: claim,
    });
  }
  for (const [path, claim] of groupPaths) {
    const segments = path.split('/');
    claimLevelName(segments.slice(0, -1).join('/'), segments[segments.length - 1]!, {
      description: claim.provenance === undefined
        ? `the ${claim.relativePath} command group`
        : claim.provenance.projection === undefined
          ? `the ${JSON.stringify(claim.provenance.identity)} MCP server command group`
          : `the ${claim.provenance.projection} command group`,
      pathClaim: claim,
    });
  }
  for (const command of commands) {
    const parent = command.path.slice(0, -1).join('/');
    const commandClaim = claimByRouteId.get(command.routeId)!;
    const owner = describeOwner(commandClaim);
    for (const alias of new Set(command.aliases)) {
      if (!safeIdentitySegment.test(alias)) {
        diagnostics.push(collisionError(
          `${owner} declares the unsafe alias ${JSON.stringify(alias)}; use letters, digits, and inner ".", "_", "-" only.`,
          commandClaim.source,
        ));
        continue;
      }
      const existing = claimLevelName(parent, alias, {
        description: `the ${commandClaim.relativePath} alias`,
        pathClaim: commandClaim,
      });
      if (existing === undefined) continue;
      if (commandClaim.provenance !== undefined) {
        // The alias belongs to a projection module (the bulk projection
        // declares none): the module is where it is changed.
        diagnostics.push(mcpCollisionError(
          commandClaim.provenance,
          `declares the alias ${JSON.stringify(alias)}, which collides with ${existing.description} at the same nesting level.`,
          commandClaim.source,
        ));
      } else if (existing.pathClaim.provenance !== undefined) {
        diagnostics.push(mcpCollisionError(
          existing.pathClaim.provenance,
          `collides with the custom alias ${JSON.stringify(alias)} on ${commandClaim.relativePath}.`,
          existing.pathClaim.provenance.projection === undefined ? commandClaim.source : existing.pathClaim.source,
        ));
      } else {
        diagnostics.push(collisionError(
          `CLI alias ${JSON.stringify(alias)} on ${commandClaim.relativePath} collides with ${existing.description} at the same nesting level.`,
          commandClaim.source,
        ));
      }
    }
    const duplicateAlias = command.aliases.find((alias, index) => command.aliases.indexOf(alias) !== index);
    if (duplicateAlias !== undefined) {
      diagnostics.push(collisionError(
        `${owner} declares the alias ${JSON.stringify(duplicateAlias)} twice.`,
        commandClaim.source,
      ));
    }
  }

  return deepFreeze({
    commands: [...commands].sort((left, right) => left.path.join('/').localeCompare(right.path.join('/'))),
    diagnostics,
  });
};
