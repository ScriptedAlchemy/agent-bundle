import { extname } from 'node:path';

import { extractCliArgv } from './cli-argv.ts';
import { scanRouteModuleExports } from './contract.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import type { CompiledAgentRoute, CompiledCliCommand, CompiledCliOption } from './types.ts';

/**
 * The #102 stage-2 command-graph compiler: projects the generated-mode
 * `src/cli/**` route surface into one collision-checked command list. Path
 * segments below the CLI root are the command nesting (`cli:library/audit`
 * -> `library audit`); the statically extracted route config supplies
 * description, aliases, positionals, and the exit-code policy; the bounded
 * argv grammar supplies the option surface. Rendered (`.tsx`) routes compile
 * no command until #102 stage 3 — source validation gates them (AB4816).
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
  return {
    aliases,
    ...(typeof description === 'string' ? { description } : {}),
    diagnostics,
    exitCode,
    ...(positionals === undefined ? {} : { positionals }),
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

/**
 * Compiles the generated-mode CLI route surface into the collision-checked
 * command graph. `readModuleText` supplies each plain route's source text
 * (a racing deletion yields undefined and the route simply compiles no
 * command; the next source snapshot settles it).
 */
export const compileCliCommands = async (
  routes: readonly CompiledAgentRoute[],
  readModuleText: (route: CompiledAgentRoute) => Promise<string | undefined>,
): Promise<CompiledCliCommandSurface> => {
  const diagnostics: Diagnostic[] = [];
  const commands: CompiledCliCommand[] = [];

  for (const route of [...routes].sort((left, right) => left.id.localeCompare(right.id))) {
    if (isRenderedCliRoute(route)) continue;
    const relativePath = route.provenance.relativePath;
    const moduleText = await readModuleText(route);
    if (moduleText === undefined) continue;

    const config = routeCliConfig(route);
    diagnostics.push(...config.diagnostics);

    const exports = scanRouteModuleExports(moduleText, relativePath);
    const argv = extractCliArgv(moduleText, relativePath, route.source);
    const missing = [
      ...(argv.found ? [] : ['inputSchema']),
      ...(exports.named.has('resultSchema') ? [] : ['resultSchema']),
    ];
    if (missing.length > 0 || !exports.asyncDefault) {
      const details = [
        ...(missing.length === 0 ? [] : [`missing named ${missing.join(' and ')}`]),
        ...(exports.asyncDefault ? [] : ['default export is not an async function']),
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
      routeId: route.id,
    });
  }

  // Collision checks run over the compiled commands plus the rendered routes'
  // claimed paths, so a `.tsx` sibling still collides deterministically.
  const claimedPaths = new Map<string, string>();
  for (const route of routes) {
    claimedPaths.set(cliCommandPath(route).join('/'), route.provenance.relativePath);
  }
  const groupPaths = new Map<string, string>();
  for (const route of routes) {
    const path = cliCommandPath(route);
    for (let depth = 1; depth < path.length; depth += 1) {
      const prefix = path.slice(0, depth).join('/');
      if (!groupPaths.has(prefix)) groupPaths.set(prefix, route.provenance.relativePath);
    }
  }
  const sourceByPath = new Map(routes.map((route) => [cliCommandPath(route).join('/'), route.source]));
  for (const [path, relativePath] of claimedPaths) {
    const groupClaim = groupPaths.get(path);
    if (groupClaim !== undefined) {
      diagnostics.push(collisionError(
        `CLI command ${JSON.stringify(path.replaceAll('/', ' '))} is both the command module ${relativePath} and a command group (${groupClaim} nests below it); the compiler never chooses silently.`,
        sourceByPath.get(path)!,
      ));
    }
  }

  // Alias collisions resolve per nesting level: an alias must not equal a
  // sibling command name, a sibling group name, or another sibling alias.
  const levelNames = new Map<string, Map<string, string>>();
  const claimLevelName = (parent: string, name: string, claim: string): string | undefined => {
    const names = levelNames.get(parent) ?? new Map<string, string>();
    levelNames.set(parent, names);
    const existing = names.get(name);
    if (existing !== undefined) return existing;
    names.set(name, claim);
    return undefined;
  };
  for (const [path, relativePath] of claimedPaths) {
    const segments = path.split('/');
    claimLevelName(segments.slice(0, -1).join('/'), segments[segments.length - 1]!, `the command ${relativePath}`);
  }
  for (const [path, relativePath] of groupPaths) {
    const segments = path.split('/');
    claimLevelName(segments.slice(0, -1).join('/'), segments[segments.length - 1]!, `the ${relativePath} command group`);
  }
  for (const command of commands) {
    const parent = command.path.slice(0, -1).join('/');
    const route = routes.find((candidate) => candidate.id === command.routeId)!;
    for (const alias of new Set(command.aliases)) {
      if (!safeIdentitySegment.test(alias)) {
        diagnostics.push(collisionError(
          `CLI route ${route.provenance.relativePath} declares the unsafe alias ${JSON.stringify(alias)}; use letters, digits, and inner ".", "_", "-" only.`,
          route.source,
        ));
        continue;
      }
      const existing = claimLevelName(parent, alias, `the ${route.provenance.relativePath} alias`);
      if (existing !== undefined) {
        diagnostics.push(collisionError(
          `CLI alias ${JSON.stringify(alias)} on ${route.provenance.relativePath} collides with ${existing} at the same nesting level.`,
          route.source,
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
