// Aliased: the workspace toolchain is typescript@7 (native compiler, no
// single-file parse API), and a plain `typescript` dependency here would
// shadow it for rslib's declaration generation. The alias ships the 5.x
// compiler API for parsing only.
import ts from 'typescript-5';

import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import type { CompiledCliOption } from './types.ts';

/**
 * The bounded zod-to-argv grammar (#102 stage 2). A routed CLI command's
 * `inputSchema` is projected onto argv statically — the module is parsed,
 * never executed — so the initializer must be built from these forms only:
 *
 * - the top level is `z.object({ ... })` or `z.strictObject({ ... })`,
 *   optionally followed by `.strict()`;
 * - each property is a zod chain rooted at `z.string()`, `z.number()`,
 *   `z.boolean()`, `z.url()` (a string-valued option validated as a URL at
 *   run time), `z.enum([...string literals])`, or `z.array(<element>)`
 *   where the element chain roots at `z.string()`, `z.number()`, or
 *   `z.enum([...])`;
 * - chains may append `.optional()`, `.default(<static literal>)`, and
 *   `.describe('<string literal>')` — these shape the argv contract — plus a
 *   bounded set of validation-only refinements the projection accepts
 *   without interpreting (strings: `min`, `max`, `length`, `regex`,
 *   `startsWith`, `endsWith`, `includes`; numbers: `int`, `min`, `max`,
 *   `gt`, `gte`, `lt`, `lte`, `positive`, `nonnegative`, `negative`,
 *   `nonpositive`, `finite`, `safe`, `multipleOf`, `step`; arrays: `min`,
 *   `max`, `length`, `nonempty`), because the module's real zod schema still
 *   validates every input at run time;
 * - `as`/`satisfies` casts, non-null assertions, and parentheses unwrap.
 *
 * Everything else — identifier references (including shared schema
 * constants), unions, tuples, nested objects, records, literals,
 * transforms, refinements, coercions, template substitutions — is outside
 * the projection and raises AB4814 naming the offending construct. Argv
 * policy: property keys project to kebab-case `--options` (`maxFiles` ->
 * `--max-files`); `--help`, `--json`, `--ndjson`, and `--version` are
 * reserved; booleans are flags and must carry `.optional()` or
 * `.default(...)`; `config.positionals` names the keys consumed as bare
 * arguments in order.
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
 * that state); `options` is absent whenever a diagnostic fired.
 */
export interface ExtractedCliArgv {
  readonly diagnostics: readonly Diagnostic[];
  readonly found: boolean;
  readonly options?: readonly CompiledCliOption[];
}

const grammarRecovery = `Restrict the inputSchema initializer to the bounded argv grammar (${cliArgvGrammar}), then inspect again.`;

const argvError = (message: string, sourcePath: string): Diagnostic => ({
  code: 'AB4814',
  message,
  recovery: grammarRecovery,
  severity: 'error',
  sourcePath,
});

/** Casts, assertions, and parentheses carry no runtime value; unwrap them. */
const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const positionOf = (sourceFile: ts.SourceFile, node: ts.Node): string => {
  const { character, line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${line + 1}:${character + 1}`;
};

interface ChainCall {
  readonly args: readonly ts.Expression[];
  readonly method: string;
  readonly node: ts.Node;
}

interface ZodChain {
  /** The `z.<base>(...)` call name and arguments. */
  readonly base: ChainCall;
  /** Chained method calls after the base, innermost first. */
  readonly calls: readonly ChainCall[];
}

/** Flattens `z.base(...).m1(...).m2(...)` into base + ordered calls; undefined when the shape is not a `z.` chain. */
const flattenZodChain = (expression: ts.Expression): ZodChain | undefined => {
  const calls: ChainCall[] = [];
  let current = unwrapExpression(expression);
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const target = unwrapExpression(current.expression.expression);
    calls.unshift({ args: current.arguments, method: current.expression.name.text, node: current });
    if (ts.isIdentifier(target) && target.text === 'z') {
      const base = calls.shift()!;
      return { base, calls };
    }
    current = target;
  }
  return undefined;
};

type StaticLiteral =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'dynamic'; readonly node: ts.Node };

/** Static literal grammar for `.default(...)` arguments: scalars and arrays of scalars. */
const staticLiteral = (expression: ts.Expression): StaticLiteral => {
  const node = unwrapExpression(expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'value', value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'value', value: false };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: 'value', value: node.text };
  }
  if (ts.isNumericLiteral(node)) return { kind: 'value', value: Number(node.text) };
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = unwrapExpression(node.operand);
    if (
      ts.isNumericLiteral(operand) &&
      (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
    ) {
      const magnitude = Number(operand.text);
      return { kind: 'value', value: node.operator === ts.SyntaxKind.MinusToken ? -magnitude : magnitude };
    }
    return { kind: 'dynamic', node };
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return { kind: 'dynamic', node: element };
      const extracted = staticLiteral(element);
      if (extracted.kind === 'dynamic') return extracted;
      values.push(extracted.value);
    }
    return { kind: 'value', value: values };
  }
  return { kind: 'dynamic', node };
};

type ScalarBaseKind = 'boolean' | 'enum' | 'number' | 'string';

const validationOnlyMethods: Readonly<Record<ScalarBaseKind | 'array', ReadonlySet<string>>> = Object.freeze({
  array: new Set(['length', 'max', 'min', 'nonempty']),
  boolean: new Set<string>(),
  enum: new Set<string>(),
  number: new Set([
    'finite',
    'gt',
    'gte',
    'int',
    'lt',
    'lte',
    'max',
    'min',
    'multipleOf',
    'negative',
    'nonnegative',
    'nonpositive',
    'positive',
    'safe',
    'step',
  ]),
  string: new Set(['endsWith', 'includes', 'length', 'max', 'min', 'regex', 'startsWith']),
});

interface ScalarBase {
  readonly choices?: readonly string[];
  readonly kind: ScalarBaseKind;
}

type ScalarBaseResult =
  | { readonly base: ScalarBase; readonly ok: true }
  | { readonly message: string; readonly ok: false };

/** Interprets one `z.<base>(...)` call as a scalar argv projection base. */
const scalarBaseOf = (
  chain: ZodChain,
  sourceFile: ts.SourceFile,
  relativePath: string,
  key: string,
): ScalarBaseResult => {
  const { args, method, node } = chain.base;
  const reject = (detail: string): ScalarBaseResult => ({
    message: `CLI route ${relativePath} property ${JSON.stringify(key)}: ${detail} at ${positionOf(sourceFile, node)} is outside the bounded argv grammar.`,
    ok: false,
  });
  switch (method) {
    case 'string':
    case 'number':
    case 'boolean': {
      if (args.length > 0) return reject(`z.${method} with arguments`);
      return { base: { kind: method }, ok: true };
    }
    case 'url': {
      // A string-valued option; the module's real zod schema enforces the
      // URL format at run time.
      if (args.length > 0) return reject('z.url with arguments');
      return { base: { kind: 'string' }, ok: true };
    }
    case 'enum': {
      const argument = args.length === 1 ? unwrapExpression(args[0]!) : undefined;
      if (argument === undefined || !ts.isArrayLiteralExpression(argument)) {
        return reject('z.enum without one array-literal argument');
      }
      const choices: string[] = [];
      for (const element of argument.elements) {
        const literal = unwrapExpression(element as ts.Expression);
        if (!ts.isStringLiteral(literal) && !ts.isNoSubstitutionTemplateLiteral(literal)) {
          return reject('a non-string-literal z.enum member');
        }
        choices.push(literal.text);
      }
      if (choices.length === 0) return reject('an empty z.enum');
      return { base: { choices, kind: 'enum' }, ok: true };
    }
    default:
      return reject(`the zod base z.${method}`);
  }
};

/** True when every chained call is validation-only for the given base kind. */
const validationOnlyChain = (
  calls: readonly ChainCall[],
  kind: ScalarBaseKind | 'array',
): ChainCall | undefined => calls.find((call) => !validationOnlyMethods[kind].has(call.method));

interface PropertyProjection {
  readonly diagnostics: readonly Diagnostic[];
  readonly option?: CompiledCliOption;
}

const projectProperty = (
  key: string,
  initializer: ts.Expression,
  sourceFile: ts.SourceFile,
  relativePath: string,
  sourcePath: string,
): PropertyProjection => {
  const reject = (detail: string, node: ts.Node): PropertyProjection => ({
    diagnostics: [argvError(
      `CLI route ${relativePath} property ${JSON.stringify(key)}: ${detail} at ${positionOf(sourceFile, node)} is outside the bounded argv grammar.`,
      sourcePath,
    )],
  });
  const chain = flattenZodChain(initializer);
  if (chain === undefined) {
    const node = unwrapExpression(initializer);
    const description = ts.isIdentifier(node)
      ? `a reference to the identifier ${JSON.stringify(node.text)}`
      : 'an expression outside the z.<base>(...) chain form';
    return reject(description, node);
  }

  let elementBase: ScalarBase | undefined;
  let repeated = false;
  if (chain.base.method === 'array') {
    repeated = true;
    const argument = chain.base.args.length === 1 ? chain.base.args[0]! : undefined;
    const element = argument === undefined ? undefined : flattenZodChain(argument);
    if (element === undefined) {
      return reject('z.array without one z.<base>(...) chain argument', chain.base.node);
    }
    const scalar = scalarBaseOf(element, sourceFile, relativePath, key);
    if (!scalar.ok) return { diagnostics: [argvError(scalar.message, sourcePath)] };
    if (scalar.base.kind === 'boolean') {
      return reject('z.array of z.boolean cannot be projected onto argv;', chain.base.node);
    }
    const invalidElementCall = validationOnlyChain(element.calls, scalar.base.kind);
    if (invalidElementCall !== undefined) {
      return reject(`the array-element method .${invalidElementCall.method}()`, invalidElementCall.node);
    }
    elementBase = scalar.base;
  } else {
    const scalar = scalarBaseOf(chain, sourceFile, relativePath, key);
    if (!scalar.ok) return { diagnostics: [argvError(scalar.message, sourcePath)] };
    elementBase = scalar.base;
  }

  let defaultValue: unknown;
  let hasDefault = false;
  let description: string | undefined;
  let optional = false;
  const validationKind = repeated ? 'array' : elementBase.kind;
  for (const call of chain.calls) {
    if (call.method === 'optional') {
      if (call.args.length > 0) return reject('.optional() with arguments', call.node);
      optional = true;
      continue;
    }
    if (call.method === 'default') {
      const argument = call.args.length === 1 ? staticLiteral(call.args[0]!) : undefined;
      if (argument === undefined || argument.kind === 'dynamic') {
        return reject('.default() without one static literal argument', call.node);
      }
      defaultValue = argument.value;
      hasDefault = true;
      continue;
    }
    if (call.method === 'describe') {
      const argument = call.args.length === 1 ? unwrapExpression(call.args[0]!) : undefined;
      if (argument === undefined || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
        return reject('.describe() without one string-literal argument', call.node);
      }
      description = argument.text;
      continue;
    }
    if (validationOnlyMethods[validationKind].has(call.method)) continue;
    return reject(`the method .${call.method}()`, call.node);
  }

  const required = !optional && !hasDefault;
  if (elementBase.kind === 'boolean' && required) {
    return {
      diagnostics: [argvError(
        `CLI route ${relativePath} property ${JSON.stringify(key)}: a required boolean cannot be expressed as a flag; add .optional() or .default(false).`,
        sourcePath,
      )],
    };
  }

  const option = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
    .toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(option)) {
    return {
      diagnostics: [argvError(
        `CLI route ${relativePath} property ${JSON.stringify(key)} does not project onto a kebab-case option name.`,
        sourcePath,
      )],
    };
  }
  if (reservedCliOptionNames.has(option)) {
    return {
      diagnostics: [argvError(
        `CLI route ${relativePath} property ${JSON.stringify(key)} projects onto the reserved option --${option}.`,
        sourcePath,
      )],
    };
  }

  return {
    diagnostics: [],
    option: {
      ...(elementBase.choices === undefined ? {} : { choices: elementBase.choices }),
      ...(hasDefault ? { defaultValue } : {}),
      ...(description === undefined ? {} : { description }),
      key,
      kind: elementBase.kind,
      option,
      repeated,
      required,
    },
  };
};

interface InputSchemaExportSite {
  /** The accepted-form initializer; absent for every rejected declaration shape. */
  readonly initializer?: ts.Expression;
  readonly rejection?: string;
}

const bindsInputSchemaName = (name: ts.BindingName): boolean => {
  if (ts.isIdentifier(name)) return name.text === 'inputSchema';
  return name.elements.some((element) =>
    !ts.isOmittedExpression(element) && bindsInputSchemaName(element.name));
};

const hasExportModifier = (statement: ts.Statement): boolean =>
  ts.canHaveModifiers(statement) &&
  (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/** Finds the first top-level statement that exports an `inputSchema` binding. */
const findInputSchemaExport = (sourceFile: ts.SourceFile): InputSchemaExportSite | undefined => {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      const declaration = statement.declarationList.declarations
        .find((candidate) => bindsInputSchemaName(candidate.name));
      if (declaration === undefined) continue;
      if (!ts.isIdentifier(declaration.name)) return { rejection: 'a destructuring declaration' };
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
        return { rejection: 'a mutable `let`/`var` declaration' };
      }
      if (declaration.initializer === undefined) return { rejection: 'a declaration without an initializer' };
      return { initializer: declaration.initializer };
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)) {
      const named = statement.exportClause.elements
        .find((element) => element.name.text === 'inputSchema');
      if (named !== undefined) return { rejection: 'an indirect `export { inputSchema }` clause' };
    }
  }
  return undefined;
};

/**
 * Statically projects one CLI route module's `export const inputSchema`
 * declaration onto the argv contract. The module is parsed with the
 * TypeScript compiler and never executed; the module's real zod schema still
 * validates parsed input at run time, so validation-only refinements pass
 * through uninterpreted.
 */
export const extractCliArgv = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): ExtractedCliArgv => {
  const sourceFile = ts.createSourceFile(relativePath, moduleText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const site = findInputSchemaExport(sourceFile);
  if (site === undefined) return deepFreeze({ diagnostics: [], found: false });
  if (site.initializer === undefined) {
    return deepFreeze({
      diagnostics: [argvError(
        `CLI route ${relativePath} exports inputSchema through ${site.rejection!}; only a single top-level \`export const inputSchema = z.object({ ... })\` declaration is projected onto argv.`,
        sourcePath,
      )],
      found: true,
    });
  }

  const chain = flattenZodChain(site.initializer);
  const objectBase = chain !== undefined && (chain.base.method === 'object' || chain.base.method === 'strictObject')
    ? chain
    : undefined;
  if (objectBase === undefined) {
    return deepFreeze({
      diagnostics: [argvError(
        `CLI route ${relativePath} has an inputSchema outside the argv grammar: the top level must be z.object({ ... }) or z.strictObject({ ... }).`,
        sourcePath,
      )],
      found: true,
    });
  }
  const invalidTopLevelCall = objectBase.calls.find((call) => call.method !== 'strict');
  if (invalidTopLevelCall !== undefined) {
    return deepFreeze({
      diagnostics: [argvError(
        `CLI route ${relativePath} has an inputSchema outside the argv grammar: the top-level method .${invalidTopLevelCall.method}() at ${positionOf(sourceFile, invalidTopLevelCall.node)} is not supported.`,
        sourcePath,
      )],
      found: true,
    });
  }
  const shape = objectBase.base.args.length === 1 ? unwrapExpression(objectBase.base.args[0]!) : undefined;
  if (shape === undefined || !ts.isObjectLiteralExpression(shape)) {
    return deepFreeze({
      diagnostics: [argvError(
        `CLI route ${relativePath} has an inputSchema outside the argv grammar: z.${objectBase.base.method} requires one object-literal argument.`,
        sourcePath,
      )],
      found: true,
    });
  }

  const diagnostics: Diagnostic[] = [];
  const options: CompiledCliOption[] = [];
  const seenOptions = new Map<string, string>();
  for (const property of shape.properties) {
    if (!ts.isPropertyAssignment(property)) {
      diagnostics.push(argvError(
        `CLI route ${relativePath} has an inputSchema property outside the argv grammar at ${positionOf(sourceFile, property)}; use plain \`key: z...\` property assignments.`,
        sourcePath,
      ));
      continue;
    }
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
    if (name === undefined) {
      diagnostics.push(argvError(
        `CLI route ${relativePath} has a computed inputSchema property name at ${positionOf(sourceFile, property.name)}; property names must be identifiers or string literals.`,
        sourcePath,
      ));
      continue;
    }
    const projected = projectProperty(name, property.initializer, sourceFile, relativePath, sourcePath);
    diagnostics.push(...projected.diagnostics);
    if (projected.option === undefined) continue;
    const claimed = seenOptions.get(projected.option.option);
    if (claimed !== undefined) {
      diagnostics.push(argvError(
        `CLI route ${relativePath} properties ${JSON.stringify(claimed)} and ${JSON.stringify(name)} both project onto --${projected.option.option}.`,
        sourcePath,
      ));
      continue;
    }
    seenOptions.set(projected.option.option, name);
    options.push(projected.option);
  }

  if (diagnostics.length > 0) return deepFreeze({ diagnostics, found: true });
  return deepFreeze({
    diagnostics: [],
    found: true,
    options: [...options].sort((left, right) => left.option.localeCompare(right.option)),
  });
};
