import { basename } from 'node:path';
import { parseArgs } from 'node:util';

export const templateNames = ['minimal', 'mcp-server', 'cli-tool'] as const;
export type TemplateName = (typeof templateNames)[number];

export const targetNames = ['amp', 'portable', 'claude', 'codex', 'cursor'] as const;
export type TargetName = (typeof targetNames)[number];

export interface HostCatalogEntry {
  /** `agent-bundle install <host>` accepts this target (`BundleIdentityHost`). */
  readonly installable: boolean;
  /** Templates this target cannot carry, each with the compiler's own reason. */
  readonly refusedTemplates: Readonly<Partial<Record<TemplateName, string>>>;
}

/**
 * Every built-in compiler target, whether it can be installed into a host, and
 * the templates it cannot carry. `agent-bundle` owns both facts —
 * `createDefaultRegistry()` publishes the target IDs and `BundleIdentityHost`
 * the installable hosts — and `tests/host-catalog.test.ts` holds this table to
 * them, so the next built-in adapter fails a scaffolder test instead of
 * silently disappearing from project creation. The scaffolder reads the table
 * rather than the compiler: project creation must not load the registry,
 * adapters, or renderer.
 */
export const hostCatalog: Readonly<Record<TargetName, HostCatalogEntry>> = Object.freeze({
  amp: Object.freeze({
    installable: true,
    refusedTemplates: Object.freeze({
      // Verified with `agent-bundle validate --target amp` on the template:
      // the generated `status` server is compiler-owned and Amp's pinned
      // skill-scoped MCP contract documents no plugin-root placeholder.
      'mcp-server': 'Amp MCP configuration is skill-scoped and refuses a compiler-owned local server (amp.mcp.generated-local)',
    }),
  }),
  claude: Object.freeze({ installable: true, refusedTemplates: Object.freeze({}) }),
  codex: Object.freeze({ installable: true, refusedTemplates: Object.freeze({}) }),
  cursor: Object.freeze({ installable: true, refusedTemplates: Object.freeze({}) }),
  portable: Object.freeze({ installable: false, refusedTemplates: Object.freeze({}) }),
});

/** The targets `agent-bundle install <host>` accepts, in catalog order. */
export const installableTargets: readonly TargetName[] = Object.freeze(
  targetNames.filter((name) => hostCatalog[name].installable),
);

/** `a`, `b`, or `c` — for prose that lists the alternatives a user can pick. */
export const listAlternatives = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')}, or ${names.at(-1) ?? ''}`;

/** The target set every in-repo example ships with. */
export const defaultTargets: readonly TargetName[] = ['portable', 'codex', 'claude'];

export const packageManagers = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof packageManagers)[number];

/** A user-input problem: reported with usage help and exit code 2, never a stack. */
export class UsageError extends Error {}

export interface ParsedFlags {
  readonly directory?: string;
  readonly frameworkVersion?: string;
  readonly help: boolean;
  readonly install: boolean;
  readonly packageManager?: PackageManager;
  readonly targets?: readonly TargetName[];
  readonly template?: TemplateName;
}

export const templateSummaries: Readonly<Record<TemplateName, string>> = {
  'cli-tool': 'an installable routed CLI: src/cli/<command>.ts routes, a src/scripts/<name>.ts script, and a src/index.ts library export',
  'mcp-server': 'conventional MCP tools: one src/mcp/<server>/tools/<tool>.tsx route with its route-unit and projection test pools, plus a script',
  minimal: 'a skills-only plugin: one Skill and nothing else',
};

/** Every target the catalog refuses for a template, as one help line each. */
const refusedCombinations = (): readonly string[] =>
  targetNames.flatMap((target) =>
    Object.entries(hostCatalog[target].refusedTemplates)
      .map(([template, reason]) => `  ${target} is not available for the ${template} template: ${reason}.`));

export const helpText = `Usage: create-agent-bundle [dir] [options]

Scaffold a new agent-bundle plugin project.

Options:
  -d, --dir <dir>                 create the project in this directory
  -t, --template <name>           project template: ${templateNames.join(', ')}
      --targets <list>            comma-separated host targets: ${targetNames.join(', ')}
                                  (default: ${defaultTargets.join(',')})
      --package-manager <name>    ${packageManagers.join(', ')} (default: detected from the invoking client)
      --no-install                skip installing dependencies after scaffolding
      --framework-version <spec>  agent-bundle dependency spec to pin (version, tarball path, or URL);
                                  defaults to the pkg.pr.new preview paired with this scaffolder build
  -h, --help                      show this help

Templates:
${templateNames.map((name) => `  ${name.padEnd(12)}${templateSummaries[name]}`).join('\n')}

Unavailable combinations:
${refusedCombinations().join('\n')}
`;

const isTemplateName = (value: string): value is TemplateName =>
  (templateNames as readonly string[]).includes(value);

const isTargetName = (value: string): value is TargetName =>
  (targetNames as readonly string[]).includes(value);

const isPackageManager = (value: string): value is PackageManager =>
  (packageManagers as readonly string[]).includes(value);

const parseTargets = (raw: string): readonly TargetName[] => {
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (entries.length === 0) {
    throw new UsageError(`--targets needs at least one of: ${targetNames.join(', ')}.`);
  }
  const targets: TargetName[] = [];
  for (const entry of entries) {
    if (!isTargetName(entry)) {
      throw new UsageError(`Unknown target "${entry}". Valid targets: ${targetNames.join(', ')}.`);
    }
    if (!targets.includes(entry)) targets.push(entry);
  }
  return targets;
};

export const parseFlags = (argv: readonly string[]): ParsedFlags => {
  let parsed: ReturnType<typeof parseArgs<{
    readonly allowPositionals: true;
    readonly options: {
      readonly dir: { readonly short: 'd'; readonly type: 'string' };
      readonly 'framework-version': { readonly type: 'string' };
      readonly help: { readonly short: 'h'; readonly type: 'boolean' };
      readonly 'no-install': { readonly type: 'boolean' };
      readonly 'package-manager': { readonly type: 'string' };
      readonly targets: { readonly type: 'string' };
      readonly template: { readonly short: 't'; readonly type: 'string' };
    };
  }>>;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      args: [...argv],
      options: {
        dir: { short: 'd', type: 'string' },
        'framework-version': { type: 'string' },
        help: { short: 'h', type: 'boolean' },
        'no-install': { type: 'boolean' },
        'package-manager': { type: 'string' },
        targets: { type: 'string' },
        template: { short: 't', type: 'string' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError('Pass at most one directory argument.');
  }

  const directory = parsed.values.dir ?? parsed.positionals[0];
  const template = parsed.values.template;
  if (template !== undefined && !isTemplateName(template)) {
    throw new UsageError(`Unknown template "${template}". Valid templates: ${templateNames.join(', ')}.`);
  }
  const packageManager = parsed.values['package-manager'];
  if (packageManager !== undefined && !isPackageManager(packageManager)) {
    throw new UsageError(`Unknown package manager "${packageManager}". Valid values: ${packageManagers.join(', ')}.`);
  }

  return {
    ...(directory === undefined ? {} : { directory }),
    ...(parsed.values['framework-version'] === undefined ? {} : { frameworkVersion: parsed.values['framework-version'] }),
    help: parsed.values.help === true,
    install: parsed.values['no-install'] !== true,
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(parsed.values.targets === undefined ? {} : { targets: parseTargets(parsed.values.targets) }),
    ...(template === undefined ? {} : { template }),
  };
};

export interface ProjectName {
  readonly packageName: string;
  readonly pluginName: string;
  readonly targetDir: string;
}

/**
 * `create-rstack` name semantics: `foo/bar` scaffolds into `<cwd>/foo/bar`
 * and names the package `bar`; `@scope/foo` keeps the full scoped name as
 * the package name. The plugin name additionally drops the scope and is
 * sanitized to the strictest host contract — Cursor's lowercase kebab-case
 * (`/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/`, at most 64 characters), which is
 * also a valid safe package-output name — so every selectable target
 * validates and the
 * `plugin.name`-derived package executable convention always applies.
 */
export const formatProjectName = (input: string): ProjectName => {
  const formatted = input.trim().replace(/\/+$/u, '');
  const packageName = formatted.startsWith('@') ? formatted : basename(formatted);
  return { packageName, pluginName: pluginNameFrom(packageName), targetDir: formatted };
};

const pluginNameFrom = (packageName: string): string => {
  const bare = packageName.startsWith('@')
    ? packageName.slice(packageName.indexOf('/') + 1)
    : packageName;
  const cleaned = bare
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .slice(0, 64)
    .replace(/[^a-z0-9]+$/u, '');
  return cleaned === '' ? 'my-agent-plugin' : cleaned;
};

/** `create-rstack` reads the invoking client from `npm_config_user_agent`. */
export const detectPackageManager = (userAgent: string | undefined): PackageManager => {
  const name = userAgent?.split(' ')[0]?.split('/')[0] ?? '';
  return isPackageManager(name) ? name : 'npm';
};

export interface Prompter {
  multiselect(options: {
    readonly initialValues: readonly string[];
    readonly message: string;
    readonly options: readonly { readonly hint?: string; readonly label: string; readonly value: string }[];
  }): Promise<readonly string[]>;
  select(options: {
    readonly message: string;
    readonly options: readonly { readonly hint?: string; readonly label: string; readonly value: string }[];
  }): Promise<string>;
  text(options: {
    readonly defaultValue: string;
    readonly message: string;
    readonly placeholder: string;
  }): Promise<string>;
}

export interface ResolvedOptions {
  readonly frameworkVersion?: string;
  readonly install: boolean;
  readonly packageManager: PackageManager;
  readonly packageName: string;
  readonly pluginName: string;
  readonly targetDir: string;
  readonly targets: readonly TargetName[];
  readonly template: TemplateName;
}

/**
 * Fill missing values with prompts when interactive; fail with a usage error
 * otherwise. Like `create-rstack`, a run that names both a directory and a
 * template on the command line is treated as scripted and asks nothing —
 * remaining values fall back to their defaults.
 */
export const resolveOptions = async (
  flags: ParsedFlags,
  context: { readonly interactive: boolean; readonly prompter: Prompter; readonly userAgent: string | undefined },
): Promise<ResolvedOptions> => {
  const scripted = flags.directory !== undefined && flags.template !== undefined;
  const interactive = context.interactive && !scripted;

  let directory = flags.directory;
  if (directory === undefined) {
    if (!interactive) {
      throw new UsageError('A project directory is required. Pass one as the first argument, e.g. `create-agent-bundle my-plugin`.');
    }
    directory = await context.prompter.text({
      defaultValue: 'my-agent-plugin',
      message: 'Project name or path',
      placeholder: 'my-agent-plugin',
    });
  }
  if (directory.trim().replace(/\/+$/u, '') === '') {
    throw new UsageError('The project directory must not be empty.');
  }

  let template = flags.template;
  if (template === undefined) {
    if (!interactive) {
      throw new UsageError(`A template is required in non-interactive runs. Pass --template <${templateNames.join('|')}>.`);
    }
    template = await context.prompter.select({
      message: 'Select a template',
      options: templateNames.map((name) => ({ hint: templateSummaries[name], label: name, value: name })),
    }) as TemplateName;
  }

  // A target the template cannot carry is never offered interactively, and is
  // a usage error when a scripted run names it: the project would scaffold and
  // then fail its first build.
  const offered = targetNames.filter((name) => hostCatalog[name].refusedTemplates[template] === undefined);

  let targets = flags.targets;
  if (targets === undefined) {
    if (!interactive) {
      targets = defaultTargets;
    } else {
      const selected = await context.prompter.multiselect({
        initialValues: [...defaultTargets],
        message: 'Select host targets (space to toggle, enter to confirm)',
        options: offered.map((name) => ({ label: name, value: name })),
      });
      if (selected.length === 0) {
        throw new UsageError('Select at least one host target.');
      }
      targets = selected.filter((value): value is TargetName => (offered as readonly string[]).includes(value));
    }
  }
  for (const target of targets) {
    const reason = hostCatalog[target].refusedTemplates[template];
    if (reason === undefined) continue;
    throw new UsageError(
      `Target "${target}" cannot be scaffolded from the ${template} template: ${reason}. `
      + `Templates for ${target}: ${listAlternatives(templateNames.filter((name) => hostCatalog[target].refusedTemplates[name] === undefined))}.`,
    );
  }

  return {
    ...(flags.frameworkVersion === undefined ? {} : { frameworkVersion: flags.frameworkVersion }),
    install: flags.install,
    packageManager: flags.packageManager ?? detectPackageManager(context.userAgent),
    ...formatProjectName(directory),
    targets,
    template,
  };
};
