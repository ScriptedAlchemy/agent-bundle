// Aliased for the same reason as config-extract.ts: this is a parser-only use
// of the TypeScript 5.x compiler API and route modules are never executed.
import ts from 'typescript-5';

import { deepFreeze } from '../core/freeze.ts';
import {
  createModuleScopeResolver,
  rootReferencePath,
  type ModuleScope,
  type ModuleScopeResolver,
  type ModuleSourceFile,
  type ReferencePath,
} from './module-scope.ts';
import { hasExportModifier, positionOf, unwrapExpression, type SyntaxNode } from './syntax.ts';
import type {
  RouteInputArrayItemSchema,
  RouteInputPropertySchema,
  RouteInputSchema,
  RouteInputSchemaLiteral,
} from './types.ts';

// The scope model hands out structural node slices so its shipped declaration
// never names typescript-5 (see module-scope.ts); every slice is a compiler
// node, narrowed back here, once, at the boundary.
const compilerExpression = (node: SyntaxNode): ts.Expression => node as ts.Expression;
const compilerSourceFile = (sourceFile: ModuleSourceFile): ts.SourceFile => sourceFile as ts.SourceFile;

/** How `parseInputSchema` reads the modules a schema reference leads to. */
export interface InputSchemaExtractionOptions {
  /** Absolute project root; a relative import resolving outside it is rejected. Unset = unconstrained (tests). */
  readonly projectRoot?: string;
  /** Reads one module's text by absolute path; undefined when unreadable. Defaults to a sync fs read. */
  readonly readModule?: (path: string) => string | undefined;
  /**
   * Absolute path of the route module; relative imports resolve against its
   * directory. Without it an import reference is rejected (the reason names
   * the missing source path).
   */
  readonly source?: string;
}

/**
 * Where a schema is declared: the module and the binding whose initializer is
 * the schema expression, at the end of any alias chain. `module` is
 * project-relative POSIX when the project root is known (or the route's own
 * relativePath for a route-local declaration); otherwise the path as read.
 */
export interface ResolvedSchemaOrigin {
  readonly binding: string;
  readonly module: string;
}

/**
 * Why a reference in an `inputSchema` declaration could not be followed. The
 * chain is printable: `inputSchema` first, then each binding reached, as
 * `<binding>` when declared in the same module as the previous step and
 * `<binding> (<module>)` otherwise. `reason` continues the last step
 * (`imported from "x", which ...`, `which is ...`).
 */
export type InputSchemaResolutionFailure =
  | { readonly chain: readonly string[]; readonly kind: 'unresolved'; readonly reason: string }
  | { readonly chain: readonly string[]; readonly kind: 'cycle' };

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
  /**
   * AB4814-class grammar issues in their existing wording; a position in a
   * module other than the route is qualified as `<module>:<line>:<col>`.
   */
  readonly issues: readonly string[];
  /** Present whenever the export was found and its declaration site is known. */
  readonly origin?: ResolvedSchemaOrigin;
  readonly properties?: readonly StaticInputSchemaProperty[];
  /**
   * Present when a reference could not be followed; `entries` and
   * `properties` are then absent, and `issues` holds what was judged before
   * the reference was reached.
   */
  readonly resolution?: InputSchemaResolutionFailure;
}

export type ParsedInputSchemaEntry =
  | Readonly<{ readonly issue: string }>
  | Readonly<{ readonly property: StaticInputSchemaProperty }>;

/** One route's statically projected input contract and where it is declared. */
export interface ExtractedInputSchema {
  readonly origin: ResolvedSchemaOrigin;
  readonly schema: RouteInputSchema;
}

/**
 * An expression together with the reference path it is read in: every
 * identifier inside it resolves from `path`, so a schema imported from
 * another module reads that module's bindings, not the route's.
 */
interface Located<Node extends ts.Node = ts.Expression> {
  readonly node: Node;
  readonly path: ReferencePath;
}

// The zod-chain grammar below is this module's own; nothing else imports it.
// Keeping it module-private also keeps `ts.*` out of the shipped declaration
// (see syntax.ts), where `typescript-5` would be unresolvable for consumers.
interface ChainCall {
  readonly args: readonly ts.Expression[];
  readonly method: string;
  readonly node: ts.Node;
  /** Where the call and its arguments live. */
  readonly path: ReferencePath;
}

interface ZodChain {
  readonly base: ChainCall;
  readonly calls: readonly ChainCall[];
}

/** One extraction: the route module's scope, its display path, and the resolver every reference shares. */
interface Parser {
  readonly relativePath: string;
  readonly resolver: ModuleScopeResolver;
  readonly root: ModuleScope;
}

type ResolutionFailed = { readonly failure: InputSchemaResolutionFailure; readonly kind: 'failure' };

type Dereferenced =
  | ResolutionFailed
  | { readonly kind: 'expression'; readonly located: Located };

/** `undefined` is a value, not a binding to follow; every other identifier is a reference. */
const isReference = (node: ts.Node): node is ts.Identifier => ts.isIdentifier(node) && node.text !== 'undefined';

/**
 * The 1-based position every issue quotes, qualified with the module when
 * the node lies outside the route module.
 */
const locate = (parser: Parser, located: Located<ts.Node>): string => {
  const position = positionOf(located.path.scope.sourceFile, located.node);
  return located.path.scope === parser.root ? position : `${located.path.scope.relativePath}:${position}`;
};

/**
 * Follows a bare identifier through the resolver to the expression it stands
 * for, read in its declaring scope; any other expression stands as written
 * (wrappers removed).
 */
const dereference = (located: Located, parser: Parser): Dereferenced => {
  const node = unwrapExpression(located.node);
  if (!isReference(node)) return { kind: 'expression', located: { node, path: located.path } };
  const resolution = parser.resolver.resolve(located.path, node.text);
  switch (resolution.kind) {
    case 'resolved': {
      const { binding, chain, scope, visited } = resolution;
      return {
        kind: 'expression',
        located: {
          node: unwrapExpression(compilerExpression(resolution.initializer)),
          path: { binding, chain, scope, visited },
        },
      };
    }
    case 'unresolved':
      return { failure: { chain: resolution.chain, kind: 'unresolved', reason: resolution.reason }, kind: 'failure' };
    case 'cycle':
      return { failure: { chain: resolution.chain, kind: 'cycle' }, kind: 'failure' };
    default: {
      const unreachable: never = resolution;
      throw new TypeError(`Unhandled reference resolution ${String(unreachable)}.`);
    }
  }
};

type ChainOutcome =
  | ResolutionFailed
  | { readonly chain: ZodChain; readonly kind: 'chain' }
  | { readonly kind: 'outside'; readonly located: Located };

/**
 * Flattens `z.base(...).m1(...).m2(...)` into base + ordered calls. A chain
 * may also be rooted at a reference (`shared` or `shared.optional()`): the
 * referenced chain is flattened in its own scope and its calls come first,
 * then the local ones. `outside` names an expression that is not a chain.
 */
const flattenZodChain = (located: Located, parser: Parser): ChainOutcome => {
  const calls: ChainCall[] = [];
  let current = unwrapExpression(located.node);
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    calls.unshift({ args: current.arguments, method: current.expression.name.text, node: current, path: located.path });
    current = unwrapExpression(current.expression.expression);
    if (ts.isIdentifier(current) && current.text === 'z') {
      const base = calls.shift()!;
      return { chain: { base, calls }, kind: 'chain' };
    }
  }
  if (!isReference(current)) {
    return { kind: 'outside', located: { node: unwrapExpression(located.node), path: located.path } };
  }
  const resolved = dereference({ node: current, path: located.path }, parser);
  if (resolved.kind === 'failure') return resolved;
  const referenced = flattenZodChain(resolved.located, parser);
  if (referenced.kind !== 'chain' || calls.length === 0) return referenced;
  return { chain: { base: referenced.chain.base, calls: [...referenced.chain.calls, ...calls] }, kind: 'chain' };
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
  | ResolutionFailed
  | { readonly base: ScalarBase; readonly kind: 'base' }
  | { readonly kind: 'issue'; readonly message: string };

/** Interprets one `z.<base>(...)` call as a bounded scalar projection base. */
const scalarBaseOf = (chain: ZodChain, parser: Parser, key: string): ScalarBaseResult => {
  const { args, method, node, path } = chain.base;
  const reject = (detail: string): ScalarBaseResult => ({
    kind: 'issue',
    message: `CLI route ${parser.relativePath} property ${JSON.stringify(key)}: ${detail} at ${locate(parser, { node, path })} is outside the bounded argv grammar.`,
  });
  switch (method) {
    case 'string':
    case 'number':
    case 'boolean': {
      if (args.length > 0) return reject(`z.${method} with arguments`);
      return { base: { kind: method }, kind: 'base' };
    }
    case 'url': {
      if (args.length > 0) return reject('z.url with arguments');
      return { base: { kind: 'string' }, kind: 'base' };
    }
    case 'enum': {
      if (args.length !== 1) return reject('z.enum without one array-literal argument');
      // `z.enum(requestStatuses)` reads the referenced `as const` array in its own module.
      const argument = dereference({ node: args[0]!, path }, parser);
      if (argument.kind === 'failure') return argument;
      const members = argument.located.node;
      if (!ts.isArrayLiteralExpression(members)) return reject('z.enum without one array-literal argument');
      const choices: string[] = [];
      for (const element of members.elements) {
        const literal = unwrapExpression(element as ts.Expression);
        if (!ts.isStringLiteral(literal) && !ts.isNoSubstitutionTemplateLiteral(literal)) {
          return reject('a non-string-literal z.enum member');
        }
        choices.push(literal.text);
      }
      if (choices.length === 0) return reject('an empty z.enum');
      return { base: { choices, kind: 'enum' }, kind: 'base' };
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
  | ResolutionFailed
  | { readonly issue: string; readonly kind: 'issue' }
  | { readonly kind: 'property'; readonly property: StaticInputSchemaProperty };

const projectProperty = (key: string, initializer: Located, parser: Parser): PropertyProjection => {
  const reject = (detail: string, at: Located<ts.Node>): PropertyProjection => ({
    issue: `CLI route ${parser.relativePath} property ${JSON.stringify(key)}: ${detail} at ${locate(parser, at)} is outside the bounded argv grammar.`,
    kind: 'issue',
  });
  const flattened = flattenZodChain(initializer, parser);
  if (flattened.kind === 'failure') return flattened;
  if (flattened.kind === 'outside') {
    return reject('an expression outside the z.<base>(...) chain form', flattened.located);
  }
  const { chain } = flattened;

  let base: ScalarBase;
  let repeated = false;
  if (chain.base.method === 'array') {
    repeated = true;
    const invalidArray = (): PropertyProjection =>
      reject('z.array without one z.<base>(...) chain argument', chain.base);
    if (chain.base.args.length !== 1) return invalidArray();
    const element = flattenZodChain({ node: chain.base.args[0]!, path: chain.base.path }, parser);
    if (element.kind === 'failure') return element;
    if (element.kind === 'outside') return invalidArray();
    const scalar = scalarBaseOf(element.chain, parser, key);
    if (scalar.kind !== 'base') return scalar.kind === 'issue' ? { issue: scalar.message, kind: 'issue' } : scalar;
    if (scalar.base.kind === 'boolean') {
      return reject('z.array of z.boolean cannot be projected onto argv;', chain.base);
    }
    const invalidElementCall = validationOnlyChain(element.chain.calls, scalar.base.kind);
    if (invalidElementCall !== undefined) {
      return reject(`the array-element method .${invalidElementCall.method}()`, invalidElementCall);
    }
    base = scalar.base;
  } else {
    const scalar = scalarBaseOf(chain, parser, key);
    if (scalar.kind !== 'base') return scalar.kind === 'issue' ? { issue: scalar.message, kind: 'issue' } : scalar;
    base = scalar.base;
  }

  let defaultValue: unknown;
  let hasDefault = false;
  let description: string | undefined;
  let optional = false;
  const validationKind = repeated ? 'array' : base.kind;
  for (const call of chain.calls) {
    if (call.method === 'optional') {
      if (call.args.length > 0) return reject('.optional() with arguments', call);
      optional = true;
      continue;
    }
    if (call.method === 'default') {
      const invalidDefault = (): PropertyProjection => reject('.default() without one static literal argument', call);
      if (call.args.length !== 1) return invalidDefault();
      // `.default(defaultStatus)` reads the referenced literal in its own module.
      const argument = dereference({ node: call.args[0]!, path: call.path }, parser);
      if (argument.kind === 'failure') return argument;
      const literal = staticLiteral(argument.located.node);
      if (literal.kind === 'dynamic') return invalidDefault();
      defaultValue = literal.value;
      hasDefault = true;
      continue;
    }
    if (call.method === 'describe') {
      const argument = call.args.length === 1 ? unwrapExpression(call.args[0]!) : undefined;
      if (argument === undefined || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
        return reject('.describe() without one string-literal argument', call);
      }
      description = argument.text;
      continue;
    }
    if (validationOnlyMethods[validationKind].has(call.method)) continue;
    return reject(`the method .${call.method}()`, call);
  }

  return {
    kind: 'property',
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

type ParsedShape = Pick<ParsedInputSchema, 'entries' | 'issues' | 'properties' | 'resolution'>;

/** Parses the declared schema expression — `z.object({ ... })` and its properties — in the scope that declares it. */
const parseObjectSchema = (declared: Located, parser: Parser): ParsedShape => {
  const { relativePath } = parser;
  const flattened = flattenZodChain(declared, parser);
  if (flattened.kind === 'failure') return { issues: [], resolution: flattened.failure };
  const objectBase = flattened.kind === 'chain' &&
    (flattened.chain.base.method === 'object' || flattened.chain.base.method === 'strictObject')
    ? flattened.chain
    : undefined;
  if (objectBase === undefined) {
    return {
      issues: [
        `CLI route ${relativePath} has an inputSchema outside the argv grammar: the top level must be z.object({ ... }) or z.strictObject({ ... }).`,
      ],
    };
  }
  const invalidTopLevelCall = objectBase.calls.find((call) => call.method !== 'strict');
  if (invalidTopLevelCall !== undefined) {
    return {
      issues: [
        `CLI route ${relativePath} has an inputSchema outside the argv grammar: the top-level method .${invalidTopLevelCall.method}() at ${locate(parser, invalidTopLevelCall)} is not supported.`,
      ],
    };
  }
  const invalidShape: ParsedShape = {
    issues: [
      `CLI route ${relativePath} has an inputSchema outside the argv grammar: z.${objectBase.base.method} requires one object-literal argument.`,
    ],
  };
  if (objectBase.base.args.length !== 1) return invalidShape;
  // `z.object(shape)` reads the referenced object literal in its own module.
  const shapeArgument = dereference({ node: objectBase.base.args[0]!, path: objectBase.base.path }, parser);
  if (shapeArgument.kind === 'failure') return { issues: [], resolution: shapeArgument.failure };
  const shape = shapeArgument.located;
  if (!ts.isObjectLiteralExpression(shape.node)) return invalidShape;

  const issues: string[] = [];
  const entries: ParsedInputSchemaEntry[] = [];
  const properties: StaticInputSchemaProperty[] = [];
  for (const property of shape.node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      const issue = `CLI route ${relativePath} has an inputSchema property outside the argv grammar at ${locate(parser, { node: property, path: shape.path })}; use plain \`key: z...\` property assignments.`;
      issues.push(issue);
      entries.push({ issue });
      continue;
    }
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
    if (name === undefined) {
      const issue = `CLI route ${relativePath} has a computed inputSchema property name at ${locate(parser, { node: property.name, path: shape.path })}; property names must be identifiers or string literals.`;
      issues.push(issue);
      entries.push({ issue });
      continue;
    }
    const projected = projectProperty(name, { node: property.initializer, path: shape.path }, parser);
    switch (projected.kind) {
      case 'failure':
        return { issues, resolution: projected.failure };
      case 'issue':
        issues.push(projected.issue);
        entries.push({ issue: projected.issue });
        break;
      case 'property':
        properties.push(projected.property);
        entries.push({ property: projected.property });
        break;
      default: {
        const unreachable: never = projected;
        throw new TypeError(`Unhandled property projection ${String(unreachable)}.`);
      }
    }
  }
  return { entries, issues, properties };
};

/**
 * Parses the shared bounded input-schema grammar. The `inputSchema`
 * initializer may be a reference: it is followed through same-module
 * `const` aliases and named relative imports (module-scope.ts) to the
 * declaring expression, which is then read in its own module's scope, so a
 * schema shared through `src/lib` projects exactly as the inline form. Issues
 * intentionally retain the existing CLI diagnostic wording; non-CLI
 * projection simply ignores them.
 */
export const parseInputSchema = (
  moduleText: string,
  relativePath: string,
  options: InputSchemaExtractionOptions = {},
): ParsedInputSchema => {
  const resolver = createModuleScopeResolver(options);
  const root = resolver.scopeOf(moduleText, relativePath, options.source);
  const site = findInputSchemaExport(compilerSourceFile(root.sourceFile));
  if (site === undefined) return { found: false, issues: [] };
  if (site.initializer === undefined) {
    return {
      found: true,
      issues: [
        `CLI route ${relativePath} exports inputSchema through ${site.rejection!}; only a single top-level \`export const inputSchema = z.object({ ... })\` declaration is projected onto argv.`,
      ],
    };
  }

  const parser: Parser = { relativePath, resolver, root };
  // The declaration site is the end of the alias chain from the export.
  const declared = dereference({ node: site.initializer, path: rootReferencePath(root, 'inputSchema') }, parser);
  if (declared.kind === 'failure') return { found: true, issues: [], resolution: declared.failure };
  const origin: ResolvedSchemaOrigin = {
    binding: declared.located.path.binding,
    module: declared.located.path.scope.relativePath,
  };
  return { ...parseObjectSchema(declared.located, parser), found: true, origin };
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

/**
 * Statically projects a route module without ever importing or executing it.
 * `undefined` when the export is absent, a reference cannot be followed, or
 * the schema leaves the grammar: non-CLI routes stay silent either way.
 */
export const extractInputSchema = (
  moduleText: string,
  relativePath: string,
  options: InputSchemaExtractionOptions = {},
): ExtractedInputSchema | undefined => {
  const parsed = parseInputSchema(moduleText, relativePath, options);
  if (!parsed.found || parsed.issues.length > 0 || parsed.properties === undefined || parsed.origin === undefined) {
    return undefined;
  }
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
    origin: parsed.origin,
    schema: {
      additionalProperties: false,
      properties,
      ...(required.length === 0 ? {} : { required }),
      type: 'object',
    },
  });
};
