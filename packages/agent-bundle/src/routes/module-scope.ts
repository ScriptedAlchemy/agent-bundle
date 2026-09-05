import { dirname } from 'node:path';

// Aliased for the same reason as config-extract.ts: this is a parser-only use
// of the TypeScript 5.x compiler API, bundled into the package (#381).
import ts from 'typescript-5';

import { isInside, toPosixRelative } from '../core/paths.ts';
import { isRelativeSpecifier, moduleCandidates, readModuleFromDisk } from './module-candidates.ts';
import {
  hasExportModifier,
  unwrapExpression,
  type SyntaxNode,
  type SyntaxSourceFile,
  type SyntaxStatement,
} from './syntax.ts';

/**
 * The static module-scope model every extractor that follows an identifier
 * shares: which top-level bindings a parsed module declares, and a resolver
 * that walks a reference from its use site through same-module `const`
 * aliases and named relative imports to the expression that declares it.
 * Modules are parsed, never executed, so only what the source text states is
 * known. Like syntax.ts, the exported signatures name structural node slices
 * rather than `ts.*` types: `typescript-5` is a devDependency the package
 * bundles and consumers never install, so a shipped declaration must not
 * import it. Every slice handed out here is a compiler node; callers narrow
 * it back with one documented cast.
 */

/** The structural slice of a parsed module (`ts.SourceFile`) the scope model exposes. */
export interface ModuleSourceFile extends SyntaxNode, SyntaxSourceFile {
  readonly fileName: string;
  readonly statements: readonly SyntaxStatement[];
  readonly text: string;
}

/** One top-level `const` declaration of a module. */
export interface ConstBinding {
  readonly exported: boolean;
  /** The declared initializer; absent for an initializer-less `declare const`. */
  readonly initializer?: SyntaxNode;
}

/** One `import { name as local } from '<specifier>'` binding of a module. */
export interface ImportedBinding {
  readonly importedName: string;
  readonly specifier: string;
}

/** The top-level bindings of one parsed module a reference may name. */
export interface ModuleScope {
  /** Top-level `const` declarations by local name. */
  readonly consts: ReadonlyMap<string, ConstBinding>;
  /** Named value imports by local name; type-only imports are not bindings at run time. */
  readonly imports: ReadonlyMap<string, ImportedBinding>;
  /**
   * Local names that are known but never static — bound by `let`/`var`, a
   * destructuring pattern, a function, class, enum, or namespace, a default
   * import, or a namespace import — each described for the diagnostic.
   */
  readonly nonConst: ReadonlyMap<string, string>;
  /**
   * How chains, origins, and qualified positions name the module:
   * project-relative POSIX when the project root is known and the module lies
   * inside it, else the path as read (a caller-supplied relative path for the
   * module the extraction started from).
   */
  readonly relativePath: string;
  /** Absolute module path; absent when only a relative path is known, so relative imports cannot be followed. */
  readonly source?: string;
  readonly sourceFile: ModuleSourceFile;
}

/**
 * One point on a reference path: the binding whose initializer is being read,
 * the scope that declares it, the printable chain that reached it (the root
 * binding first; a later step is `<binding>` when declared in the same module
 * as the previous one, else `<binding> (<module>)`), and every
 * `<module>#<binding>` visited on the way — reaching one again is a cycle.
 */
export interface ReferencePath {
  readonly binding: string;
  readonly chain: readonly string[];
  readonly scope: ModuleScope;
  readonly visited: ReadonlySet<string>;
}

/** Which static boundary stopped a resolution. */
export type ReferenceBoundary =
  | 'bare-specifier'
  | 'missing-export'
  | 'no-initializer'
  | 'no-source'
  | 'non-const'
  | 'outside-project'
  | 'unknown'
  | 'unreadable';

/**
 * Where a reference ends. `resolved` is itself a {@link ReferencePath} for the
 * declaring binding, so a caller reading the initializer resolves the
 * identifiers inside it from there. `unresolved` names the boundary in a
 * phrase that follows the chain's last step (`imported from "x", which ...`,
 * `which is ...`, `whose ...`); `cycle` ends the chain with the step visited
 * twice.
 */
export type ReferenceResolution =
  | (ReferencePath & { readonly initializer: SyntaxNode; readonly kind: 'resolved' })
  | {
    readonly boundary: ReferenceBoundary;
    readonly chain: readonly string[];
    readonly kind: 'unresolved';
    readonly reason: string;
  }
  | { readonly chain: readonly string[]; readonly kind: 'cycle' };

export interface ModuleScopeResolverOptions {
  /**
   * Absolute project root. A relative import that resolves outside it is not
   * project source and is rejected. Unset means unconstrained (tests).
   */
  readonly projectRoot?: string;
  /**
   * Reads one module's text by absolute path; `undefined` when the path is
   * not a readable file. Defaults to a synchronous filesystem read.
   */
  readonly readModule?: (path: string) => string | undefined;
}

/** Scopes modules on demand — each file read and parsed once per extraction — and resolves references through them. */
export interface ModuleScopeResolver {
  /** The scope of the module at an absolute path, read through `readModule`; undefined when unreadable. Misses are cached too. */
  readonly load: (path: string) => ModuleScope | undefined;
  /** Resolves `name` as written in the initializer of `from`. */
  readonly resolve: (from: ReferencePath, name: string) => ReferenceResolution;
  /**
   * Scopes already-read module text. Registered under `source` when known so
   * a relative import that leads back to the module shares its scope.
   */
  readonly scopeOf: (text: string, relativePath: string, source?: string) => ModuleScope;
}

const scriptKindOf = (path: string): ts.ScriptKind => {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

/**
 * Parses one module's text with the script kind its extension implies (TSX
 * for `.tsx`, JSX for `.jsx`, JS for `.js`/`.mjs`/`.cjs`, TS otherwise), so a
 * `.ts` generic arrow and a `.tsx` element both parse as written. The module
 * is never executed.
 */
export const parseModule = (path: string, text: string): ModuleSourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));

/** Names one rejected construct for a diagnostic (AB4806, AB4838). */
export const describeExpression = (node: SyntaxNode): string => {
  const expression = node as ts.Node;
  if (ts.isIdentifier(expression)) {
    return expression.text === 'undefined'
      ? 'the non-JSON value `undefined`'
      : `a reference to the identifier ${JSON.stringify(expression.text)}`;
  }
  if (ts.isCallExpression(expression)) return 'a call expression';
  if (ts.isTemplateExpression(expression)) return 'a template literal with substitutions';
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return 'a function expression';
  if (ts.isSpreadAssignment(expression) || ts.isSpreadElement(expression)) return 'a spread';
  if (ts.isShorthandPropertyAssignment(expression)) return 'a shorthand property reference';
  if (
    ts.isMethodDeclaration(expression) ||
    ts.isGetAccessorDeclaration(expression) ||
    ts.isSetAccessorDeclaration(expression)
  ) {
    return 'a method or accessor';
  }
  if (ts.isComputedPropertyName(expression)) return 'a computed property name';
  if (ts.isOmittedExpression(expression)) return 'an array hole';
  if (expression.kind === ts.SyntaxKind.BigIntLiteral) return 'a bigint literal';
  if (expression.kind === ts.SyntaxKind.RegularExpressionLiteral) return 'a regular expression literal';
  return `a ${ts.SyntaxKind[expression.kind] ?? 'dynamic'} expression`;
};

const collectBindingNames = (name: ts.BindingName, description: string, into: Map<string, string>): void => {
  if (ts.isIdentifier(name)) {
    into.set(name.text, description);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, description, into);
  }
};

const scopeOfSourceFile = (sourceFile: ts.SourceFile, relativePath: string, source: string | undefined): ModuleScope => {
  const consts = new Map<string, ConstBinding>();
  const imports = new Map<string, ImportedBinding>();
  const nonConst = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      const exported = hasExportModifier(statement);
      for (const declaration of statement.declarationList.declarations) {
        if (isConst && ts.isIdentifier(declaration.name)) {
          consts.set(declaration.name.text, {
            exported,
            ...(declaration.initializer === undefined ? {} : { initializer: declaration.initializer }),
          });
        } else {
          collectBindingNames(
            declaration.name,
            isConst ? 'a destructuring declaration' : 'a `let`/`var` declaration',
            nonConst,
          );
        }
      }
      continue;
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (clause.name !== undefined) nonConst.set(clause.name.text, 'a default import');
      const bindings = clause.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings)) {
        nonConst.set(bindings.name.text, 'a namespace import');
        continue;
      }
      for (const element of bindings.elements) {
        if (clause.isTypeOnly || element.isTypeOnly) continue;
        const importedName = element.propertyName?.text ?? element.name.text;
        imports.set(element.name.text, { importedName, specifier });
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      nonConst.set(statement.name.text, 'a function declaration');
    } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      nonConst.set(statement.name.text, 'a class declaration');
    } else if (ts.isEnumDeclaration(statement)) {
      nonConst.set(statement.name.text, 'an enum declaration');
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      nonConst.set(statement.name.text, 'a namespace declaration');
    }
  }
  return {
    consts,
    imports,
    nonConst,
    relativePath,
    ...(source === undefined ? {} : { source }),
    sourceFile,
  };
};

const bindingKey = (scope: ModuleScope, binding: string): string => `${scope.source ?? scope.relativePath}#${binding}`;

/** The path a resolution starts from: the root binding (`inputSchema`, `config`) in the module that declares it. */
export const rootReferencePath = (scope: ModuleScope, binding: string): ReferencePath => ({
  binding,
  chain: [binding],
  scope,
  visited: new Set([bindingKey(scope, binding)]),
});

type ImportTarget =
  | { readonly scope: ModuleScope }
  | { readonly boundary: ReferenceBoundary; readonly reason: string };

/**
 * One extraction's resolver: every module it reaches is read and parsed once
 * (misses included), and every reference path shares that cache.
 */
export const createModuleScopeResolver = (options: ModuleScopeResolverOptions = {}): ModuleScopeResolver => {
  const read = options.readModule ?? readModuleFromDisk;
  const { projectRoot } = options;
  const scopes = new Map<string, ModuleScope | undefined>();

  const load = (path: string): ModuleScope | undefined => {
    if (scopes.has(path)) return scopes.get(path);
    const text = read(path);
    const relativePath = projectRoot !== undefined && isInside(projectRoot, path)
      ? toPosixRelative(projectRoot, path)
      : path;
    const scope = text === undefined
      ? undefined
      : scopeOfSourceFile(parseModule(path, text) as ts.SourceFile, relativePath, path);
    scopes.set(path, scope);
    return scope;
  };

  const scopeOf = (text: string, relativePath: string, source?: string): ModuleScope => {
    const scope = scopeOfSourceFile(parseModule(source ?? relativePath, text) as ts.SourceFile, relativePath, source);
    if (source !== undefined) scopes.set(source, scope);
    return scope;
  };

  /**
   * The module one relative import names, with the shared candidate order,
   * rejected when the specifier is not relative, when the importing module's
   * location is unknown, when any candidate resolves outside the project, or
   * when no candidate reads.
   */
  const followImport = (from: ModuleScope, binding: ImportedBinding): ImportTarget => {
    const imported = `imported from ${JSON.stringify(binding.specifier)}`;
    if (!isRelativeSpecifier(binding.specifier)) {
      return { boundary: 'bare-specifier', reason: `${imported}, which is not a relative module path` };
    }
    if (from.source === undefined) {
      return {
        boundary: 'no-source',
        reason: `${imported}, which cannot be followed because the importing module's source path is unknown`,
      };
    }
    for (const candidate of moduleCandidates(dirname(from.source), binding.specifier)) {
      if (projectRoot !== undefined && !isInside(projectRoot, candidate)) {
        return { boundary: 'outside-project', reason: `${imported}, which resolves outside the project` };
      }
      const scope = load(candidate);
      if (scope !== undefined) return { scope };
    }
    return {
      boundary: 'unreadable',
      reason: `${imported}, which does not resolve to a module inside the project`,
    };
  };

  const resolve = (from: ReferencePath, name: string): ReferenceResolution => {
    const chain = [...from.chain];
    const visited = new Set(from.visited);
    let scope = from.scope;
    let current = name;
    for (;;) {
      let declaring = scope;
      let binding = current;
      let declaration = scope.consts.get(current);
      if (declaration === undefined) {
        const imported = scope.imports.get(current);
        if (imported === undefined) {
          const description = scope.nonConst.get(current);
          return description === undefined
            ? {
              boundary: 'unknown',
              chain: [...chain, current],
              kind: 'unresolved',
              reason: 'which is neither a top-level const in this module nor a named import from a relative module',
            }
            : {
              boundary: 'non-const',
              chain: [...chain, current],
              kind: 'unresolved',
              reason: `which is not a top-level \`const\` but ${description}`,
            };
        }
        const target = followImport(scope, imported);
        if (!('scope' in target)) {
          return { boundary: target.boundary, chain: [...chain, current], kind: 'unresolved', reason: target.reason };
        }
        declaring = target.scope;
        binding = imported.importedName;
        declaration = declaring.consts.get(binding);
        if (declaration === undefined || !declaration.exported) {
          return {
            boundary: 'missing-export',
            chain: [...chain, current],
            kind: 'unresolved',
            reason: `imported from ${JSON.stringify(imported.specifier)}, which does not declare a top-level \`export const ${binding}\``,
          };
        }
      }
      chain.push(declaring === scope ? binding : `${binding} (${declaring.relativePath})`);
      const key = bindingKey(declaring, binding);
      if (visited.has(key)) return { chain, kind: 'cycle' };
      visited.add(key);
      if (declaration.initializer === undefined) {
        return {
          boundary: 'no-initializer',
          chain,
          kind: 'unresolved',
          reason: 'whose declaration has no initializer',
        };
      }
      // An alias (`export const a = b`) hops on; anything else is the
      // expression the reference stands for, judged by the caller.
      const initializer = unwrapExpression(declaration.initializer) as ts.Node;
      if (ts.isIdentifier(initializer) && initializer.text !== 'undefined') {
        scope = declaring;
        current = initializer.text;
        continue;
      }
      return { binding, chain, initializer: declaration.initializer, kind: 'resolved', scope: declaring, visited };
    }
  };

  return { load, resolve, scopeOf };
};
