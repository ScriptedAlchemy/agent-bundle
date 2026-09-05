import { dirname } from 'node:path';

import ts from 'typescript-5';

import type { Diagnostic } from '../core/diagnostics.ts';
import { isRelativeSpecifier, moduleCandidates, readModuleFromDisk } from './module-candidates.ts';

const modifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((item) => item.kind === kind) ?? false);

const exported = (node: ts.Node): boolean => modifier(node, ts.SyntaxKind.ExportKeyword);
const asynchronous = (node: ts.Node): boolean => modifier(node, ts.SyntaxKind.AsyncKeyword);
/** `declare function` / `declare const`: a type-level declaration that emits no runtime binding. */
const ambient = (node: ts.Node): boolean => modifier(node, ts.SyntaxKind.DeclareKeyword);
const generator = (node: ts.FunctionDeclaration | ts.FunctionExpression): boolean => node.asteriskToken !== undefined;

const unwrappedExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const diagnostic = (
  code: 'AB4810' | 'AB4811' | 'AB4830' | 'AB4940',
  message: string,
  sourcePath: string,
  recovery: string,
): Diagnostic => ({ code, message, recovery, severity: 'error', sourcePath });

/**
 * A default export the module re-exports from another module
 * (`export { default } from './shared.tsx'`, `export { Page as default } from '../page.tsx'`).
 */
export interface RouteDefaultReExport {
  /** The binding named in the target module (`default` for `export { default } from`). */
  readonly name: string;
  /**
   * `followed`: the target module was read and its binding judged, so
   * `asyncDefault`/`defaultFunction` describe that binding. `unresolved`: the
   * target is a bare specifier, unreadable, or part of a re-export cycle, so
   * the default export's shape is unknown statically and the worker judges it
   * at run time.
   */
  readonly resolution: 'followed' | 'unresolved';
  readonly specifier: string;
}

/** The statically scanned export surface of one route module. */
export interface RouteModuleExports {
  /** True when the default export is an async function or arrow function. */
  readonly asyncDefault: boolean;
  /** True when the default export is a function or arrow function. */
  readonly defaultFunction: boolean;
  /** Set when the default export is re-exported from another module. */
  readonly defaultReExport?: RouteDefaultReExport;
  readonly named: ReadonlySet<string>;
  /**
   * Exported names whose declaration is ambient (`declare function`,
   * `declare const`): TypeScript emits no runtime binding for them, so they
   * are in `named` but in none of the function sets.
   */
  readonly namedAmbient: ReadonlySet<string>;
  /** Exported names bound to an async function or arrow function (async generators included). */
  readonly namedAsyncFunctions: ReadonlySet<string>;
  /** Exported names bound to a function or arrow function that emits a runtime binding (generators included, ambient declarations excluded). */
  readonly namedFunctions: ReadonlySet<string>;
  /** Exported names bound to a generator function (`function*`, `async function*`). */
  readonly namedGeneratorFunctions: ReadonlySet<string>;
  /**
   * Exported names re-exported from a module the scan could not follow (a
   * bare specifier, an unreadable file, or a re-export cycle), keyed to the
   * specifier named, so their shape is unknown statically rather than "not a
   * function".
   */
  readonly namedUnresolved: ReadonlyMap<string, string>;
  /** True when the module exports `execute` or `render` (the retired split contract). */
  readonly splitExport: boolean;
}

/** Where the scanned module lives, so relative re-exports can be followed. */
export interface ScanRouteModuleOptions {
  /**
   * Reads one re-export target's source text by absolute path; undefined when
   * the file is unreadable. Defaults to a synchronous file read.
   */
  readonly readModule?: (absolutePath: string) => string | undefined;
  /** The scanned module's absolute path; relative re-exports resolve against its directory. */
  readonly source?: string;
}

interface PendingReExport {
  readonly name: string;
  readonly specifier: string;
}

/** Scans one route module's top-level export surface without evaluating it. */
export const scanRouteModuleExports = (
  moduleText: string,
  relativePath: string,
  options: ScanRouteModuleOptions = {},
): RouteModuleExports => Object.freeze(scanModuleExports(moduleText, relativePath, options, new Set()));

/** What one binding of a scanned module is known to be. */
interface BindingShape {
  /** True when the binding is an ambient declaration with no runtime emit. */
  readonly ambient: boolean;
  readonly asyncFunction: boolean;
  readonly function: boolean;
  readonly generator: boolean;
  /** True when the binding is a re-export the scan could not follow. */
  readonly unresolved: boolean;
}

const unknownShape: BindingShape = { ambient: false, asyncFunction: false, function: false, generator: false, unresolved: true };

const bindingShape = (exports: RouteModuleExports, name: string): BindingShape => name === 'default'
  ? {
    ambient: false,
    asyncFunction: exports.asyncDefault,
    function: exports.defaultFunction,
    generator: false,
    unresolved: exports.defaultReExport?.resolution === 'unresolved',
  }
  : {
    ambient: exports.namedAmbient.has(name),
    asyncFunction: exports.namedAsyncFunctions.has(name),
    function: exports.namedFunctions.has(name),
    generator: exports.namedGeneratorFunctions.has(name),
    unresolved: exports.namedUnresolved.has(name),
  };

const scanModuleExports = (
  moduleText: string,
  relativePath: string,
  options: ScanRouteModuleOptions,
  visited: ReadonlySet<string>,
): RouteModuleExports => {
  const sourceFile = ts.createSourceFile(relativePath, moduleText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Local bindings by shape; an ambient declaration emits nothing, so it
  // joins `ambientBindings` and no function set.
  const ambientBindings = new Set<string>();
  const asyncFunctionBindings = new Set<string>();
  const functionBindings = new Set<string>();
  const generatorBindings = new Set<string>();
  const named = new Set<string>();
  const namedAmbient = new Set<string>();
  const namedAsyncFunctions = new Set<string>();
  const namedFunctions = new Set<string>();
  const namedGeneratorFunctions = new Set<string>();
  // Exported names aliasing a local binding (`export { Foo as bar }`), judged
  // once every declaration is seen, and names re-exported from other modules.
  const namedAliases = new Map<string, string>();
  const namedReExports = new Map<string, PendingReExport>();
  let asyncDefault = false;
  let defaultFunction = false;
  let defaultIdentifier: string | undefined;
  let defaultReExport: PendingReExport | undefined;
  let splitExport = false;

  const addNamed = (name: string): void => {
    named.add(name);
    if (name === 'execute' || name === 'render') splitExport = true;
  };

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (ambient(statement)) ambientBindings.add(declaration.name.text);
        const initializer = declaration.initializer === undefined ? undefined : unwrappedExpression(declaration.initializer);
        if (initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          functionBindings.add(declaration.name.text);
          if (asynchronous(initializer)) asyncFunctionBindings.add(declaration.name.text);
          if (ts.isFunctionExpression(initializer) && generator(initializer)) generatorBindings.add(declaration.name.text);
        }
        if (exported(statement)) {
          addNamed(declaration.name.text);
          namedAliases.set(declaration.name.text, declaration.name.text);
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name !== undefined && ambient(statement)) {
        ambientBindings.add(statement.name.text);
      } else if (statement.name !== undefined) {
        functionBindings.add(statement.name.text);
        if (asynchronous(statement)) asyncFunctionBindings.add(statement.name.text);
        if (generator(statement)) generatorBindings.add(statement.name.text);
      }
      if (exported(statement) && modifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        defaultFunction = true;
        asyncDefault = asynchronous(statement);
        defaultIdentifier = undefined;
        defaultReExport = undefined;
      } else if (exported(statement) && statement.name !== undefined) {
        addNamed(statement.name.text);
        namedAliases.set(statement.name.text, statement.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unwrappedExpression(statement.expression);
      defaultFunction = ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
      asyncDefault = defaultFunction && asynchronous(expression);
      defaultIdentifier = ts.isIdentifier(expression) ? expression.text : undefined;
      defaultReExport = undefined;
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      // Type-only exports (`export type { X }`, `export { type X as default }`)
      // emit no JavaScript binding, so they satisfy no runtime contract.
      if (statement.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const name = element.name.text;
        const propertyName = element.propertyName?.text ?? name;
        if (name === 'default') {
          if (specifier === undefined) {
            defaultIdentifier = propertyName;
            defaultReExport = undefined;
          } else {
            // `export { default } from` / `export { Page as default } from`: the
            // default export lives in another module and is judged there.
            defaultIdentifier = undefined;
            defaultReExport = { name: propertyName, specifier };
          }
          continue;
        }
        addNamed(name);
        if (specifier === undefined) namedAliases.set(name, propertyName);
        else namedReExports.set(name, { name: propertyName, specifier });
      }
    }
  }

  if (defaultIdentifier !== undefined) {
    defaultFunction = functionBindings.has(defaultIdentifier);
    asyncDefault = asyncFunctionBindings.has(defaultIdentifier);
  }
  for (const [name, local] of namedAliases) {
    if (ambientBindings.has(local)) namedAmbient.add(name);
    if (functionBindings.has(local)) namedFunctions.add(name);
    if (asyncFunctionBindings.has(local)) namedAsyncFunctions.add(name);
    if (generatorBindings.has(local)) namedGeneratorFunctions.add(name);
  }

  // Re-exports are followed lazily and once per target module: a placement
  // that re-exports its component and schemas from one shared route reads
  // that route a single time.
  const targets = new Map<string, RouteModuleExports | undefined>();
  const shapeOf = ({ name, specifier }: PendingReExport): BindingShape => {
    if (!targets.has(specifier)) targets.set(specifier, followReExport(specifier, options, visited));
    const exports = targets.get(specifier);
    return exports === undefined ? unknownShape : bindingShape(exports, name);
  };
  let resolvedDefaultReExport: RouteDefaultReExport | undefined;
  if (defaultReExport !== undefined) {
    const shape = shapeOf(defaultReExport);
    resolvedDefaultReExport = { ...defaultReExport, resolution: shape.unresolved ? 'unresolved' : 'followed' };
    defaultFunction = shape.function;
    asyncDefault = shape.asyncFunction;
  }
  const namedUnresolved = new Map<string, string>();
  for (const [name, reExport] of namedReExports) {
    const shape = shapeOf(reExport);
    if (shape.ambient) namedAmbient.add(name);
    if (shape.function) namedFunctions.add(name);
    if (shape.asyncFunction) namedAsyncFunctions.add(name);
    if (shape.generator) namedGeneratorFunctions.add(name);
    if (shape.unresolved) namedUnresolved.set(name, reExport.specifier);
  }

  return {
    asyncDefault,
    defaultFunction,
    ...(resolvedDefaultReExport === undefined ? {} : { defaultReExport: Object.freeze(resolvedDefaultReExport) }),
    named,
    namedAmbient,
    namedAsyncFunctions,
    namedFunctions,
    namedGeneratorFunctions,
    namedUnresolved,
    splitExport,
  };
};

/**
 * Scans the module one relative re-export names. Undefined when the target
 * cannot be judged statically: a bare specifier, no readable candidate file,
 * no `source` to resolve against, or a re-export cycle.
 */
const followReExport = (
  specifier: string,
  options: ScanRouteModuleOptions,
  visited: ReadonlySet<string>,
): RouteModuleExports | undefined => {
  if (options.source === undefined || !isRelativeSpecifier(specifier)) return undefined;
  const read = options.readModule ?? readModuleFromDisk;
  const seen = new Set([...visited, options.source]);
  // The same candidate order the config extractor uses for imported
  // constants, so both static scans name one file for one specifier.
  for (const candidate of moduleCandidates(dirname(options.source), specifier)) {
    if (seen.has(candidate)) return undefined;
    const text = read(candidate);
    if (text === undefined) continue;
    return scanModuleExports(text, candidate, { ...options, source: candidate }, seen);
  }
  return undefined;
};

/**
 * Whether the scanned default export is judged an async function component.
 * A default re-exported from a module the scan could not read (a bare
 * specifier, for example) cannot be judged statically and is accepted here;
 * the worker still verifies the component when it loads the route.
 */
const acceptsAsyncDefault = ({ asyncDefault, defaultReExport }: RouteModuleExports): boolean =>
  asyncDefault || defaultReExport?.resolution === 'unresolved';

/** Same acceptance for the sync-or-async function contracts (layouts, providers). */
const acceptsDefaultFunction = ({ defaultFunction, defaultReExport }: RouteModuleExports): boolean =>
  defaultFunction || defaultReExport?.resolution === 'unresolved';

/** Names the offending default export: the local one, or the binding a followed re-export resolved to. */
const defaultExportDetail = ({ defaultReExport }: RouteModuleExports, expectation: string): string =>
  defaultReExport === undefined
    ? `default export is not ${expectation}`
    : `default export re-exported from ${JSON.stringify(defaultReExport.specifier)} (${defaultReExport.name}) is not ${expectation}`;

/** Validates G8's one executable MCP route contract without evaluating the module. */
export const validateRouteModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const exports = scanRouteModuleExports(moduleText, relativePath, { source: sourcePath });
  const { named, splitExport } = exports;
  const asyncDefault = acceptsAsyncDefault(exports);
  const missing = ['inputSchema', 'resultSchema'].filter((name) => !named.has(name));
  const diagnostics: Diagnostic[] = [];
  if (missing.length > 0 || !asyncDefault) {
    const details = [
      ...(missing.length === 0 ? [] : [`missing named ${missing.join(' and ')}`]),
      ...(asyncDefault ? [] : [defaultExportDetail(exports, 'an async function component')]),
    ];
    diagnostics.push(diagnostic(
      'AB4810',
      `Route module ${relativePath} does not satisfy the public route contract: ${details.join('; ')}.`,
      sourcePath,
      'Export const inputSchema and resultSchema, plus one async default Server Component receiving { input, signal }.',
    ));
  }
  if (splitExport) {
    diagnostics.push(diagnostic(
      'AB4811',
      `Route module ${relativePath} exports execute or render; routed modules use one async default Server Component instead of an execute/render split.`,
      sourcePath,
      'Move execution into the async default component and render Agent.* elements from that component.',
    ));
  }
  return Object.freeze(diagnostics);
};

/** Validates an event route's single async component contract without requiring MCP schemas. */
export const validateEventRouteModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const exports = scanRouteModuleExports(moduleText, relativePath, { source: sourcePath });
  const { splitExport } = exports;
  const diagnostics: Diagnostic[] = [];
  if (!acceptsAsyncDefault(exports)) {
    diagnostics.push(diagnostic(
      'AB4810',
      `Event route module ${relativePath} does not satisfy the public route contract: ${defaultExportDetail(exports, 'an async function component')}.`,
      sourcePath,
      'Export one async default Server Component receiving { canonical, native, signal }.',
    ));
  }
  if (splitExport) {
    diagnostics.push(diagnostic(
      'AB4811',
      `Event route module ${relativePath} exports execute or render; routed modules use one async default Server Component instead of an execute/render split.`,
      sourcePath,
      'Move execution into the async default component and render Agent.* elements from that component.',
    ));
  }
  return Object.freeze(diagnostics);
};

/**
 * Validates one conventional layout module without evaluating it: the default
 * export must be a function component (sync or async) and the module must
 * not carry the route contract's `inputSchema`/`resultSchema`/`config`
 * exports — a layout wraps routes, it is not one, and a stray schema export
 * usually means a route module was saved under the reserved layout name.
 */
export const validateLayoutModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const exports = scanRouteModuleExports(moduleText, relativePath, { source: sourcePath });
  const { named, splitExport } = exports;
  const routeExports = ['config', 'inputSchema', 'resultSchema'].filter((name) => named.has(name));
  const details = [
    ...(acceptsDefaultFunction(exports) ? [] : [defaultExportDetail(exports, 'a function component')]),
    ...(routeExports.length === 0 ? [] : [`exports route-only ${routeExports.join(', ')}`]),
    ...(splitExport ? ['exports execute or render'] : []),
  ];
  if (details.length === 0) return Object.freeze([]);
  return Object.freeze([diagnostic(
    'AB4830',
    `Layout module ${relativePath} does not satisfy the layout contract: ${details.join('; ')}.`,
    sourcePath,
    'Default-export one function component receiving { children, route, signal } that renders Agent.Result around children, and keep route schemas in route modules.',
  )]);
};

/** Validates one context provider's default factory export without evaluating the module. */
export const validateProviderModuleContract = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
): readonly Diagnostic[] => {
  const exports = scanRouteModuleExports(moduleText, relativePath, { source: sourcePath });
  if (acceptsDefaultFunction(exports)) return Object.freeze([]);
  return Object.freeze([diagnostic(
    'AB4940',
    `Provider module ${relativePath} does not satisfy the public provider contract: ${defaultExportDetail(exports, 'a function')}.`,
    sourcePath,
    'Default-export a provider factory receiving { invocation, plugin, signal }.',
  )]);
};
