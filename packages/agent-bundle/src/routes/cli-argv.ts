import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import {
  parseInputSchema,
  type InputSchemaExtractionOptions,
  type InputSchemaResolutionFailure,
  type ParsedInputSchemaEntry,
  type ResolvedSchemaOrigin,
  type ScalarBase,
  type StaticInputSchemaProperty,
} from './input-schema.ts';
import type {
  CompiledCliOption,
  RouteInputArrayItemSchema,
  RouteInputPropertySchema,
  RouteInputSchema,
} from './types.ts';

/**
 * The bounded zod-to-argv grammar (#102 stage 2). A routed CLI command's
 * `inputSchema` is projected onto argv statically — the module is parsed,
 * never executed. Parsing and property-chain interpretation are shared with
 * the route JSON-Schema projection; argv-specific naming and flag policy stay
 * here.
 */
export const cliArgvGrammar =
  'z.object of z.string/z.number/z.boolean/z.enum/z.array chains with optional/default/describe and bounded validation-only refinements';

/** Option names the generated CLI shell owns; schema keys must not project onto them. */
export const reservedCliOptionNames: ReadonlySet<string> = Object.freeze(new Set([
  'help',
  'json',
  'ndjson',
  'version',
]));

/**
 * The statically extracted argv projection of one CLI route module's
 * `inputSchema` export. `found` is false when the module has no extractable
 * `export const inputSchema` declaration (the route-contract diagnostic owns
 * that state); `options` is absent whenever a diagnostic fired; `origin` is
 * where the schema is declared whenever that is known.
 */
export interface ExtractedCliArgv {
  readonly diagnostics: readonly Diagnostic[];
  readonly found: boolean;
  readonly options?: readonly CompiledCliOption[];
  readonly origin?: ResolvedSchemaOrigin;
}

const grammarRecovery = `Restrict the inputSchema initializer to the bounded argv grammar (${cliArgvGrammar}), then inspect again.`;

const argvError = (message: string, sourcePath: string): Diagnostic => ({
  code: 'AB4814',
  message,
  recovery: grammarRecovery,
  severity: 'error',
  sourcePath,
});

const resolutionRecovery = 'Declare the schema inline, or reference a top-level `export const` of a module reached through relative imports inside the project (alias chains such as `export const inputSchema = shared` are followed); then inspect again.';

/** AB4838 for a reference the static resolver cannot follow; AB4839 for a reference cycle. */
const resolutionError = (
  failure: InputSchemaResolutionFailure,
  relativePath: string,
  sourcePath: string,
): Diagnostic => {
  const chain = failure.chain.join(' -> ');
  return {
    code: failure.kind === 'cycle' ? 'AB4839' : 'AB4838',
    message: failure.kind === 'cycle'
      ? `CLI route ${relativePath} inputSchema: ${chain} is a reference cycle.`
      : `CLI route ${relativePath} inputSchema: ${chain} ${failure.reason}.`,
    recovery: resolutionRecovery,
    severity: 'error',
    sourcePath,
  };
};

const optionNameOf = (key: string): string => key
  .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
  .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
  .toLowerCase();

interface CliPropertyProjection {
  readonly diagnostic?: Diagnostic;
  readonly option?: CompiledCliOption;
}

/** The argv policy for one schema property: flag rule, kebab-case naming, and reserved names. */
const cliOptionFor = (
  property: StaticInputSchemaProperty,
  relativePath: string,
  sourcePath: string,
): CliPropertyProjection => {
  const required = !property.optional && !property.hasDefault;
  if (property.base.kind === 'boolean' && required) {
    return {
      diagnostic: argvError(
        `CLI route ${relativePath} property ${JSON.stringify(property.key)}: a required boolean cannot be expressed as a flag; add .optional() or .default(false).`,
        sourcePath,
      ),
    };
  }

  const option = optionNameOf(property.key);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(option)) {
    return {
      diagnostic: argvError(
        `CLI route ${relativePath} property ${JSON.stringify(property.key)} does not project onto a kebab-case option name.`,
        sourcePath,
      ),
    };
  }
  if (reservedCliOptionNames.has(option)) {
    return {
      diagnostic: argvError(
        `CLI route ${relativePath} property ${JSON.stringify(property.key)} projects onto the reserved option --${option}.`,
        sourcePath,
      ),
    };
  }

  return {
    option: {
      ...(property.base.choices === undefined ? {} : { choices: property.base.choices }),
      ...(property.hasDefault ? { defaultValue: property.defaultValue } : {}),
      ...(property.description === undefined ? {} : { description: property.description }),
      key: property.key,
      kind: property.base.kind,
      option,
      repeated: property.repeated,
      required,
    },
  };
};

/** The option surface one schema projects onto; `options` is absent whenever a diagnostic fired. */
export interface ProjectedCliOptions {
  readonly diagnostics: readonly Diagnostic[];
  readonly options?: readonly CompiledCliOption[];
}

/** The one argv projection policy: per-property rules, then option-name collisions, then deterministic order. */
const projectOptions = (
  entries: readonly ParsedInputSchemaEntry[],
  relativePath: string,
  sourcePath: string,
): ProjectedCliOptions => {
  const diagnostics: Diagnostic[] = [];
  const options: CompiledCliOption[] = [];
  const seenOptions = new Map<string, string>();
  for (const entry of entries) {
    if ('issue' in entry) {
      diagnostics.push(argvError(entry.issue, sourcePath));
      continue;
    }
    const projected = cliOptionFor(entry.property, relativePath, sourcePath);
    if (projected.diagnostic !== undefined) {
      diagnostics.push(projected.diagnostic);
      continue;
    }
    const option = projected.option!;
    const claimed = seenOptions.get(option.option);
    if (claimed !== undefined) {
      diagnostics.push(argvError(
        `CLI route ${relativePath} properties ${JSON.stringify(claimed)} and ${JSON.stringify(option.key)} both project onto --${option.option}.`,
        sourcePath,
      ));
      continue;
    }
    seenOptions.set(option.option, option.key);
    options.push(option);
  }
  if (diagnostics.length > 0) return { diagnostics };
  return {
    diagnostics: [],
    options: [...options].sort((left, right) => left.option.localeCompare(right.option)),
  };
};

const scalarBaseOfSchema = (schema: RouteInputArrayItemSchema): ScalarBase =>
  schema.type === 'string' && schema.enum !== undefined
    ? { choices: schema.enum, kind: 'enum' }
    : { kind: schema.type };

/** One canonical contract property in the shape the module parse produces, so both take the same policy. */
const staticPropertyOf = (
  key: string,
  schema: RouteInputPropertySchema,
  required: readonly string[],
): StaticInputSchemaProperty => ({
  base: schema.type === 'array' ? scalarBaseOfSchema(schema.items) : scalarBaseOfSchema(schema),
  ...(schema.default === undefined ? {} : { defaultValue: schema.default }),
  ...(schema.description === undefined ? {} : { description: schema.description }),
  hasDefault: schema.default !== undefined,
  key,
  optional: !required.includes(key),
  repeated: schema.type === 'array',
});

/**
 * Projects a route's canonical input contract — the `RouteInputSchema`
 * graph.ts normalized once, shared by every route bound to it — onto argv
 * with exactly the policy the module parse applies, so the command grammar
 * is a projection of the contract rather than a second reading of the
 * module.
 */
export const projectInputSchemaOptions = (
  schema: RouteInputSchema,
  relativePath: string,
  sourcePath: string,
): ProjectedCliOptions => deepFreeze(projectOptions(
  Object.entries(schema.properties).map(([key, property]) => ({
    property: staticPropertyOf(key, property, schema.required ?? []),
  })),
  relativePath,
  sourcePath,
));

/**
 * Statically projects one CLI route module's `export const inputSchema`
 * declaration onto the argv contract. The module is parsed with the
 * TypeScript compiler and never executed; validation-only refinements pass
 * through uninterpreted because the real zod schema validates at run time. A
 * schema reached through a reference the resolver cannot follow is AB4838
 * (AB4839 for a cycle); grammar issues stay AB4814.
 */
export const extractCliArgv = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
  options: InputSchemaExtractionOptions = {},
): ExtractedCliArgv => {
  const parsed = parseInputSchema(moduleText, relativePath, options);
  if (!parsed.found) return deepFreeze({ diagnostics: [], found: false });
  const origin = parsed.origin === undefined ? {} : { origin: parsed.origin };
  if (parsed.entries === undefined) {
    return deepFreeze({
      diagnostics: [
        ...parsed.issues.map((issue) => argvError(issue, sourcePath)),
        ...(parsed.resolution === undefined ? [] : [resolutionError(parsed.resolution, relativePath, sourcePath)]),
      ],
      found: true,
      ...origin,
    });
  }
  return deepFreeze({ ...projectOptions(parsed.entries, relativePath, sourcePath), found: true, ...origin });
};
