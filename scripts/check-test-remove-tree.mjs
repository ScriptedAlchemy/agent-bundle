/**
 * Test teardown that deletes a tree calls `removeTree`. A bare `rm` with
 * `recursive: true` and no `maxRetries` races a late writer and flakes with ENOTEMPTY.
 *
 * Catches bare `rm(`, aliased `import { rm as remove }` calls, and `ns.rm(` when
 * `ns` is a namespace/default import from node:fs, fs, or their /promises forms.
 *
 * Call, option, and import-binding detection is parser-backed (typescript-5):
 * only real node:fs(/promises) ImportDeclaration bindings count, only Node-bound
 * call expressions are considered, and `recursive` / `maxRetries` are read from
 * the second argument's object-literal properties (including quoted keys,
 * shorthand `maxRetries`, and Parenthesized / As / Satisfies wrappers). Nested
 * objects in the path argument, member calls, comments, strings, regexes, and
 * template substitutions are handled by the AST rather than text masking.
 * Named `promises` rebinds from `fs` / `node:fs` count as `.rm` carriers.
 * A later local binding that shadows an import is not treated as Node-bound.
 */
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../packages/agent-bundle/package.json'));
/** @type {typeof import('typescript-5')} */
const ts = require('typescript-5');

const roots = [
  'packages/agent-bundle/tests',
  'packages/workbench/tests',
  'packages/rsc-runtime/tests',
  'packages/rsc-markdown-stream/tests',
  'packages/create-agent-bundle/tests',
];

const nodeFsSpecifier = /^(?:node:)?fs(?:\/promises)?$/u;

const isRemoveTreeHelper = (file) => /(?:^|\/)remove-tree\.ts$/u.test(file.replaceAll('\\', '/'));

const walk = async (directory, files) => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (/\.(?:ts|mts|mjs|js|tsx)$/u.test(entry.name)) files.push(path);
  }
};

/**
 * Named/aliased rm bindings and namespace/default/`promises` bindings that expose .rm.
 * Import bindings are collected from the TypeScript AST so comments and local
 * identifiers cannot forge Node fs.rm bindings.
 */
export const removalBindings = (text, fileName = 'bindings.ts') => {
  const bareNames = new Set();
  const namespaceNames = new Set();
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!nodeFsSpecifier.test(statement.moduleSpecifier.text)) continue;

    const { importClause } = statement;
    if (importClause.isTypeOnly) continue;

    if (importClause.name !== undefined) {
      namespaceNames.add(importClause.name.text);
    }

    const bindings = importClause.namedBindings;
    if (bindings === undefined) continue;

    if (ts.isNamespaceImport(bindings)) {
      namespaceNames.add(bindings.name.text);
      continue;
    }

    if (!ts.isNamedImports(bindings)) continue;
    const isFsRoot = /^(?:node:)?fs$/u.test(statement.moduleSpecifier.text);
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const importedName = element.propertyName === undefined
        ? element.name.text
        : element.propertyName.text;
      const localName = element.name.text;
      if (importedName === 'rm') {
        bareNames.add(localName);
        continue;
      }
      if (importedName === 'promises' && isFsRoot) {
        namespaceNames.add(localName);
      }
    }
  }

  return { bareNames, namespaceNames };
};

const propertyName = (name) => {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
};

const unwrapExpression = (node) => {
  let current = node;
  while (
    current !== undefined
    && (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isTypeAssertionExpression(current)
    )
  ) {
    current = current.expression;
  }
  return current;
};

const declarationNameIs = (nameNode, name) => {
  if (ts.isIdentifier(nameNode)) return nameNode.text === name;
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    return nameNode.elements.some((element) =>
      ts.isBindingElement(element) && declarationNameIs(element.name, name));
  }
  return false;
};

const declarationListDeclares = (list, name) =>
  list.declarations.some((decl) => declarationNameIs(decl.name, name));

const statementDeclares = (statement, name) => {
  if (ts.isVariableStatement(statement)) {
    return declarationListDeclares(statement.declarationList, name);
  }
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    return statement.name !== undefined && statement.name.text === name;
  }
  return false;
};

/** `from` is the child the walk came up through; names, computed keys, and decorators sit outside the function scope. */
const functionLikeDeclares = (node, from, name) => {
  if (
    !(
      ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node)
      || ts.isConstructorDeclaration(node)
    )
  ) {
    return false;
  }
  if (from !== node.body && !node.parameters.includes(from)) return false;
  if (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))
    && node.name !== undefined
    && node.name.text === name
  ) {
    return true;
  }
  return node.parameters.some((parameter) => declarationNameIs(parameter.name, name));
};

/**
 * True when a later/inner local binding hides the Node fs import of `name`.
 * ponytail: `var` is treated as block-scoped, so a `var` hoisted out of a nested
 * block is missed and its call still fails the gate (false positive, never a
 * false negative). Track function-scoped `var` if that ever bites.
 */
const identifierIsLocallyShadowed = (identifier) => {
  const name = identifier.text;
  let from = identifier;
  let current = identifier.parent;
  while (current !== undefined) {
    if (
      ts.isSourceFile(current)
      || ts.isBlock(current)
      || ts.isModuleBlock(current)
      || ts.isCaseClause(current)
      || ts.isDefaultClause(current)
    ) {
      const shadowed = current.statements.some((statement) => {
        if (ts.isSourceFile(current) && ts.isImportDeclaration(statement)) return false;
        return statementDeclares(statement, name);
      });
      if (shadowed) return true;
    }
    if (
      (ts.isForStatement(current) || ts.isForOfStatement(current) || ts.isForInStatement(current))
      && current.initializer !== undefined
      && ts.isVariableDeclarationList(current.initializer)
      && declarationListDeclares(current.initializer, name)
    ) {
      return true;
    }
    if (functionLikeDeclares(current, from, name)) return true;
    if (
      ts.isCatchClause(current)
      && current.variableDeclaration !== undefined
      && declarationNameIs(current.variableDeclaration.name, name)
    ) {
      return true;
    }
    from = current;
    current = current.parent;
  }
  return false;
};

/** Options flags from a call's second-argument object literal only. */
const optionsFlags = (optionsArg) => {
  const unwrapped = unwrapExpression(optionsArg);
  if (unwrapped === undefined || !ts.isObjectLiteralExpression(unwrapped)) {
    return { recursive: false, hasRetries: false };
  }
  let recursive = false;
  let hasRetries = false;
  for (const property of unwrapped.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === 'maxRetries') hasRetries = true;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyName(property.name);
    if (key === 'recursive' && property.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      recursive = true;
    }
    if (key === 'maxRetries') hasRetries = true;
  }
  return { recursive, hasRetries };
};

const isNodeBoundRmCall = (expression, bareNames, namespaceNames) => {
  if (ts.isIdentifier(expression)) {
    return bareNames.has(expression.text) && !identifierIsLocallyShadowed(expression);
  }
  if (
    ts.isPropertyAccessExpression(expression)
    && !expression.questionDotToken
    && expression.name.text === 'rm'
    && ts.isIdentifier(expression.expression)
  ) {
    return namespaceNames.has(expression.expression.text)
      && !identifierIsLocallyShadowed(expression.expression);
  }
  return false;
};

const scriptKindFor = (fileName) => {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.mjs') || fileName.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

export const recursiveRmCalls = (text, fileName = 'check.ts') => {
  const { bareNames, namespaceNames } = removalBindings(text, fileName);
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
  const calls = [];

  const visit = (node) => {
    if (ts.isCallExpression(node) && isNodeBoundRmCall(node.expression, bareNames, namespaceNames)) {
      const flags = optionsFlags(node.arguments[1]);
      if (flags.recursive) {
        const start = node.getStart(sourceFile);
        calls.push({
          call: text.slice(start, node.getEnd()),
          hasRetries: flags.hasRetries,
          line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return calls;
};

export const bareRecursiveRmFailures = (file, text) => {
  if (isRemoveTreeHelper(file)) return [];
  const failures = [];
  for (const call of recursiveRmCalls(text, file)) {
    if (call.hasRetries) continue;
    failures.push(`${file}:${call.line} bare recursive rm. Use removeTree.`);
  }
  return failures;
};

const run = async () => {
  const failures = [];
  const files = [];
  for (const root of roots) await walk(root, files);
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    failures.push(...bareRecursiveRmFailures(file, text));
  }

  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
};

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) await run();
