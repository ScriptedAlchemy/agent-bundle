import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import * as AgentRuntime from '@agent-bundle/runtime';
import { createJiti, type JitiOptions, type TransformOptions } from 'jiti';
import * as React from 'react';
import ts from 'typescript-5';

import { isRelativeSpecifier } from '../../routes/module-candidates.ts';
import { parseModule } from '../../routes/module-scope.ts';

/**
 * Evaluates one project module from live source: a route, layout, provider,
 * or state module by absolute path, as the Workbench's unit-render mode and
 * the route-unit harness see it.
 */
export interface RouteModuleLoader {
  readonly load: <Module>(source: string) => () => Promise<Module>;
}

/**
 * Classic JSX runtime, as in the playground's lifecycle render child: the
 * automatic runtime would import `react/jsx-runtime`, which jiti resolves
 * without the child's `--conditions=react-server`, binding the client runtime
 * to the server `react` and throwing inside React (#441). Compiled JSX calls
 * `React.createElement` instead, on the route's own `react` import or on the
 * global below for modules that do not import it.
 */
(globalThis as typeof globalThis & { React?: typeof React }).React = React;

const jitiOptions: JitiOptions = {
  fsCache: false,
  interopDefault: false,
  jsx: { runtime: 'classic' },
  moduleCache: false,
  nativeModules: ['typescript'],
  virtualModules: {
    '@agent-bundle/runtime': AgentRuntime,
    react: React,
  },
};

interface SpecifierLiteral {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

const specifierLiteral = (sourceFile: ts.SourceFile, expression: ts.Expression | undefined): SpecifierLiteral | undefined =>
  expression !== undefined && ts.isStringLiteralLike(expression)
    ? { end: expression.end, start: expression.getStart(sourceFile), text: expression.text }
    : undefined;

/**
 * The string literals that name modules — `import … from`, `export … from`,
 * and a literal dynamic `import()` — in source order. A string literal
 * anywhere else (JSX text, a prop, an expression) names no module and is
 * never one of them.
 */
const moduleSpecifierLiterals = (sourceFile: ts.SourceFile): readonly SpecifierLiteral[] => {
  const literals: SpecifierLiteral[] = [];
  const visit = (node: ts.Node): void => {
    let literal: SpecifierLiteral | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal = specifierLiteral(sourceFile, node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      literal = specifierLiteral(sourceFile, node.arguments[0]);
    }
    if (literal !== undefined) literals.push(literal);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals;
};

/**
 * Project code imports its TypeScript siblings by their emitted `.js` name
 * (`moduleResolution: NodeNext`); the build resolves those through Rspack's
 * `extensionAlias`. jiti only retries `.js` as `.ts`, so a `.js` specifier
 * whose source is a `.tsx` component never resolves. Point each such module
 * specifier at the file on disk before the transform sees the module. Only
 * import/export specifiers change: `<Agent.Text>{'./panel.js'}</Agent.Text>`
 * renders `./panel.js` here exactly as the compiled program does.
 */
const rewriteTsxSpecifiers = ({ filename, source }: TransformOptions): string => {
  if (filename === undefined) return source;
  const directory = dirname(filename);
  const sourceFile = parseModule(filename, source) as ts.SourceFile;
  let rewritten = source;
  for (const literal of moduleSpecifierLiterals(sourceFile).toReversed()) {
    if (!isRelativeSpecifier(literal.text) || !literal.text.endsWith('.js')) continue;
    const stem = resolve(directory, literal.text.slice(0, -'.js'.length));
    if (existsSync(`${stem}.js`) || existsSync(`${stem}.ts`) || !existsSync(`${stem}.tsx`)) continue;
    const quote = source[literal.start]!;
    rewritten = `${rewritten.slice(0, literal.start)}${quote}${literal.text}x${quote}${rewritten.slice(literal.end)}`;
  }
  return rewritten;
};

/**
 * Jiti over live project source with the framework's own `react` and
 * `@agent-bundle/runtime` instances, no module cache, and the `.js`-to-`.tsx`
 * module specifier rewrite. `load(source)` returns a lazy loader in the shape
 * the harness registry's `*Loaders` maps take.
 */
export const createRouteModuleLoader = (): RouteModuleLoader => {
  const baseJiti = createJiti(import.meta.url, jitiOptions);
  const jiti = createJiti(import.meta.url, {
    ...jitiOptions,
    transform: (options) => ({ code: baseJiti.transform({ ...options, source: rewriteTsxSpecifiers(options) }) }),
  });
  return Object.freeze({
    load: <Module>(source: string) => async () => jiti.import<Module>(source),
  });
};
