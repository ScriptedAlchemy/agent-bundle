// Aliased for the same reason as config-extract.ts: this is a parser-only use
// of the TypeScript 5.x compiler API and route modules are never executed.
import ts from 'typescript-5';

import { deepFreeze } from '../core/freeze.ts';
import { hasExportModifier, positionOf, unwrapExpression } from './syntax.ts';
import type {
  RouteInputArrayItemSchema,
  RouteInputPropertySchema,
  RouteInputSchema,
  RouteInputSchemaLiteral,
} from './types.ts';

// The zod-chain grammar below is this module's own; nothing else imports it.
// Keeping it module-private also keeps `ts.*` out of the shipped declaration
// (see syntax.ts), where `typescript-5` would be unresolvable for consumers.
interface ChainCall {
  readonly args: readonly ts.Expression[];
  readonly method: string;
  readonly node: ts.Node;
}

interface ZodChain {
  readonly base: ChainCall;
  readonly calls: readonly ChainCall[];
}

export type ScalarBaseKind = 'boolean' | 'enum' | 'number' | 'string';

export interface ScalarBase {
  readonly choices?: readonly string[];
  readonly kind: ScalarBaseKind;
}

export interface StaticInputSchemaProperty {
  readonly base: ScalarBase;
  readonly defaultValue?: unknown;
  readonly description?: string;
  readonly hasDefault: boolean;
  readonly key: string;
  readonly optional: boolean;
  readonly repeated: boolean;
}

export interface ParsedInputSchema {
  readonly entries?: readonly ParsedInputSchemaEntry[];
  readonly found: boolean;
  readonly issues: readonly string[];
  readonly properties?: readonly StaticInputSchemaProperty[];
}

export type ParsedInputSchemaEntry =
  | Readonly<{ readonly issue: string }>
  | Readonly<{ readonly property: StaticInputSchemaProperty }>;

/** Flattens `z.base(...).m1(...).m2(...)` into base + ordered calls. */
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

/** Static literal grammar used by `.default(...)`; callers decide which values they can expose. */
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

export const validationOnlyMethods: Readonly<Record<ScalarBaseKind | 'array', ReadonlySet<string>>> = Object.freeze({
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

type ScalarBaseResult =
  | { readonly base: ScalarBase; readonly ok: true }
  | { readonly message: string; readonly ok: false };

/** Interprets one `z.<base>(...)` call as a bounded scalar projection base. */
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

const validationOnlyChain = (
  calls: readonly ChainCall[],
  kind: ScalarBaseKind | 'array',
): ChainCall | undefined => calls.find((call) => !validationOnlyMethods[kind].has(call.method));

type PropertyProjection =
  | { readonly issue: string }
  | { readonly property: StaticInputSchemaProperty };

const projectProperty = (
  key: string,
  initializer: ts.Expression,
  sourceFile: ts.SourceFile,
  relativePath: string,
): PropertyProjection => {
  const reject = (detail: string, node: ts.Node): PropertyProjection => ({
    issue: `CLI route ${relativePath} property ${JSON.stringify(key)}: ${detail} at ${positionOf(sourceFile, node)} is outside the bounded argv grammar.`,
  });
  const chain = flattenZodChain(initializer);
  if (chain === undefined) {
    const node = unwrapExpression(initializer);
    const description = ts.isIdentifier(node)
      ? `a reference to the identifier ${JSON.stringify(node.text)}`
      : 'an expression outside the z.<base>(...) chain form';
    return reject(description, node);
  }

  let base: ScalarBase;
  let repeated = false;
  if (chain.base.method === 'array') {
    repeated = true;
    const argument = chain.base.args.length === 1 ? chain.base.args[0]! : undefined;
    const element = argument === undefined ? undefined : flattenZodChain(argument);
    if (element === undefined) return reject('z.array without one z.<base>(...) chain argument', chain.base.node);
    const scalar = scalarBaseOf(element, sourceFile, relativePath, key);
    if (!scalar.ok) return { issue: scalar.message };
    if (scalar.base.kind === 'boolean') {
      return reject('z.array of z.boolean cannot be projected onto argv;', chain.base.node);
    }
    const invalidElementCall = validationOnlyChain(element.calls, scalar.base.kind);
    if (invalidElementCall !== undefined) {
      return reject(`the array-element method .${invalidElementCall.method}()`, invalidElementCall.node);
    }
    base = scalar.base;
  } else {
    const scalar = scalarBaseOf(chain, sourceFile, relativePath, key);
    if (!scalar.ok) return { issue: scalar.message };
    base = scalar.base;
  }

  let defaultValue: unknown;
  let hasDefault = false;
  let description: string | undefined;
  let optional = false;
  const validationKind = repeated ? 'array' : base.kind;
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

  return {
    property: {
      base,
      ...(hasDefault ? { defaultValue } : {}),
      ...(description === undefined ? {} : { description }),
      hasDefault,
      key,
      optional,
      repeated,
    },
  };
};

interface InputSchemaExportSite {
  readonly initializer?: ts.Expression;
  readonly rejection?: string;
}

const bindsInputSchemaName = (name: ts.BindingName): boolean => {
  if (ts.isIdentifier(name)) return name.text === 'inputSchema';
  return name.elements.some((element) =>
    !ts.isOmittedExpression(element) && bindsInputSchemaName(element.name));
};

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
 * Parses the shared bounded input-schema grammar. Issues intentionally retain
 * the existing CLI diagnostic wording; non-CLI projection simply ignores them.
 */
export const parseInputSchema = (moduleText: string, relativePath: string): ParsedInputSchema => {
  const sourceFile = ts.createSourceFile(relativePath, moduleText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const site = findInputSchemaExport(sourceFile);
  if (site === undefined) return { found: false, issues: [] };
  if (site.initializer === undefined) {
    return {
      found: true,
      issues: [
        `CLI route ${relativePath} exports inputSchema through ${site.rejection!}; only a single top-level \`export const inputSchema = z.object({ ... })\` declaration is projected onto argv.`,
      ],
    };
  }

  const chain = flattenZodChain(site.initializer);
  const objectBase = chain !== undefined && (chain.base.method === 'object' || chain.base.method === 'strictObject')
    ? chain
    : undefined;
  if (objectBase === undefined) {
    return {
      found: true,
      issues: [
        `CLI route ${relativePath} has an inputSchema outside the argv grammar: the top level must be z.object({ ... }) or z.strictObject({ ... }).`,
      ],
    };
  }
  const invalidTopLevelCall = objectBase.calls.find((call) => call.method !== 'strict');
  if (invalidTopLevelCall !== undefined) {
    return {
      found: true,
      issues: [
        `CLI route ${relativePath} has an inputSchema outside the argv grammar: the top-level method .${invalidTopLevelCall.method}() at ${positionOf(sourceFile, invalidTopLevelCall.node)} is not supported.`,
      ],
    };
  }
  const shape = objectBase.base.args.length === 1 ? unwrapExpression(objectBase.base.args[0]!) : undefined;
  if (shape === undefined || !ts.isObjectLiteralExpression(shape)) {
    return {
      found: true,
      issues: [
        `CLI route ${relativePath} has an inputSchema outside the argv grammar: z.${objectBase.base.method} requires one object-literal argument.`,
      ],
    };
  }

  const issues: string[] = [];
  const entries: ParsedInputSchemaEntry[] = [];
  const properties: StaticInputSchemaProperty[] = [];
  for (const property of shape.properties) {
    if (!ts.isPropertyAssignment(property)) {
      const issue = `CLI route ${relativePath} has an inputSchema property outside the argv grammar at ${positionOf(sourceFile, property)}; use plain \`key: z...\` property assignments.`;
      issues.push(issue);
      entries.push({ issue });
      continue;
    }
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
    if (name === undefined) {
      const issue = `CLI route ${relativePath} has a computed inputSchema property name at ${positionOf(sourceFile, property.name)}; property names must be identifiers or string literals.`;
      issues.push(issue);
      entries.push({ issue });
      continue;
    }
    const projected = projectProperty(name, property.initializer, sourceFile, relativePath);
    if ('issue' in projected) {
      issues.push(projected.issue);
      entries.push({ issue: projected.issue });
    } else {
      properties.push(projected.property);
      entries.push({ property: projected.property });
    }
  }
  return { entries, found: true, issues, properties };
};

const inputSchemaLiteral = (value: unknown): value is RouteInputSchemaLiteral => {
  if (typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) && value.every((entry) =>
    typeof entry === 'boolean' || typeof entry === 'string' ||
    (typeof entry === 'number' && Number.isFinite(entry)));
};

const scalarSchema = (base: ScalarBase): RouteInputArrayItemSchema => {
  switch (base.kind) {
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return { type: 'number' };
    case 'enum':
      return { enum: [...base.choices!], type: 'string' };
    case 'string':
      return { type: 'string' };
    default: {
      const unreachable: never = base.kind;
      throw new TypeError(`Unhandled input schema base ${String(unreachable)}.`);
    }
  }
};

/** Statically projects a route module without ever importing or executing it. */
export const extractInputSchema = (
  moduleText: string,
  relativePath: string,
): RouteInputSchema | undefined => {
  const parsed = parseInputSchema(moduleText, relativePath);
  if (!parsed.found || parsed.issues.length > 0 || parsed.properties === undefined) return undefined;
  if (parsed.properties.some((property) =>
    property.hasDefault && !inputSchemaLiteral(property.defaultValue))) return undefined;

  const properties: Record<string, RouteInputPropertySchema> = {};
  const required: string[] = [];
  for (const property of [...parsed.properties].sort((left, right) => left.key.localeCompare(right.key))) {
    const metadata = {
      ...(property.hasDefault ? { default: property.defaultValue as RouteInputSchemaLiteral } : {}),
      ...(property.description === undefined ? {} : { description: property.description }),
    };
    properties[property.key] = property.repeated
      ? { ...metadata, items: scalarSchema(property.base), type: 'array' }
      : { ...scalarSchema(property.base), ...metadata };
    if (!property.optional && !property.hasDefault) required.push(property.key);
  }
  return deepFreeze({
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
    type: 'object',
  });
};
