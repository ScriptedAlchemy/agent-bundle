import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import * as AgentRuntime from '@agent-bundle/runtime';
import { createJiti, type JitiOptions, type TransformOptions } from 'jiti';
import * as React from 'react';
import ts from 'typescript-5';

import { isRelativeSpecifier } from '../../routes/module-candidates.ts';
import { parseModule } from '../../routes/module-scope.ts';

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
    const specifier = literal.text.slice(0, -'.js'.length);
    const stem = resolve(directory, specifier);
    if (existsSync(`${stem}.js`) || existsSync(`${stem}.ts`) || !existsSync(`${stem}.tsx`)) continue;
    const quote = source[literal.start]!;
    rewritten = `${rewritten.slice(0, literal.start)}${quote}${specifier}.tsx${quote}${rewritten.slice(literal.end)}`;
  }
  return rewritten;
};

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
