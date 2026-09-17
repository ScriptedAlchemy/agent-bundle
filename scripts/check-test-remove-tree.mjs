/**
 * Test teardown that deletes a tree calls `removeTree`. A bare `rm` with
 * `recursive: true` and no `maxRetries` races a late writer and flakes with ENOTEMPTY.
 *
 * Catches bare `rm(`, aliased `import { rm as remove }` calls, and `ns.rm(` when
 * `ns` is a namespace/default import from node:fs, fs, or their /promises forms.
 *
 * Call and option detection is parser-backed (typescript-5): only Node-bound call
 * expressions are considered, and `recursive` / `maxRetries` are read from the
 * second argument's object-literal properties (including quoted keys). Nested
 * objects in the path argument, member calls, comments, strings, regexes, and
 * template substitutions are handled by the AST rather than text masking.
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

/** Named/aliased rm bindings and namespace/default bindings that expose .rm. */
export const removalBindings = (text) => {
  const bareNames = new Set(['rm']);
  const namespaceNames = new Set();

  const named = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/gu;
  let match = named.exec(text);
  while (match !== null) {
    if (nodeFsSpecifier.test(match[3])) {
      for (const part of match[1].split(',')) {
        const specifier = part.trim();
        if (specifier.length === 0 || specifier.startsWith('type ')) continue;
        const alias = /^\s*(?:type\s+)?rm(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/u.exec(specifier);
        if (alias === null) continue;
        bareNames.add(alias[1] ?? 'rm');
      }
    }
    match = named.exec(text);
  }

  const star = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*(['"])([^'"]+)\2/gu;
  match = star.exec(text);
  while (match !== null) {
    if (nodeFsSpecifier.test(match[3])) namespaceNames.add(match[1]);
    match = star.exec(text);
  }

  const defaults = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*(['"])([^'"]+)\2/gu;
  match = defaults.exec(text);
  while (match !== null) {
    if (nodeFsSpecifier.test(match[3])) namespaceNames.add(match[1]);
    match = defaults.exec(text);
  }

  return { bareNames, namespaceNames };
};

const propertyName = (name) => {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
};

/** Options flags from a call's second-argument object literal only. */
const optionsFlags = (optionsArg) => {
  if (optionsArg === undefined || !ts.isObjectLiteralExpression(optionsArg)) {
    return { recursive: false, hasRetries: false };
  }
  let recursive = false;
  let hasRetries = false;
  for (const property of optionsArg.properties) {
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
  if (ts.isIdentifier(expression)) return bareNames.has(expression.text);
  if (
    ts.isPropertyAccessExpression(expression)
    && !expression.questionDotToken
    && expression.name.text === 'rm'
    && ts.isIdentifier(expression.expression)
  ) {
    return namespaceNames.has(expression.expression.text);
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
  const { bareNames, namespaceNames } = removalBindings(text);
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
