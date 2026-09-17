/**
 * Test teardown that deletes a tree calls `removeTree`. A bare `rm` with
 * `recursive: true` and no `maxRetries` races a late writer and flakes with ENOTEMPTY.
 *
 * Catches bare `rm(`, aliased `import { rm as remove }` calls, and `ns.rm(` when
 * `ns` is a namespace/default import from node:fs, fs, or their /promises forms.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

const lineCommentAt = (text, index) => {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = text[cursor];
    if (char === '\n') return false;
    if (char === '/' && text[cursor - 1] === '/') return true;
  }
  return false;
};

const sliceCall = (text, openParenIndex) => {
  let depth = 1;
  let inString = null;
  let index = openParenIndex + 1;
  while (index < text.length && depth > 0) {
    const char = text[index];
    if (inString !== null) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === inString) inString = null;
    } else if (char === "'" || char === '"' || char === String.fromCharCode(96)) inString = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    index += 1;
  }
  return { call: text.slice(0, index), end: index };
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

const pushRecursiveCall = (calls, text, startIndex, openParenIndex) => {
  if (lineCommentAt(text, startIndex)) return;
  const { call } = sliceCall(text.slice(startIndex), openParenIndex - startIndex);
  if (!/recursive\s*:\s*true/u.test(call)) return;
  calls.push({
    call,
    hasRetries: /maxRetries\s*:/u.test(call),
    line: text.slice(0, startIndex).split('\n').length,
  });
};

export const recursiveRmCalls = (text) => {
  const { bareNames, namespaceNames } = removalBindings(text);
  const calls = [];

  for (const name of bareNames) {
    const pattern = new RegExp(`\\b${name}\\s*\\(`, 'gu');
    let match = pattern.exec(text);
    while (match !== null) {
      const before = text[match.index - 1];
      if (before === '.' || before === '$') {
        match = pattern.exec(text);
        continue;
      }
      pushRecursiveCall(calls, text, match.index, match.index + match[0].length - 1);
      match = pattern.exec(text);
    }
  }

  for (const namespace of namespaceNames) {
    const pattern = new RegExp(`\\b${namespace}\\s*\\.\\s*rm\\s*\\(`, 'gu');
    let match = pattern.exec(text);
    while (match !== null) {
      pushRecursiveCall(calls, text, match.index, match.index + match[0].length - 1);
      match = pattern.exec(text);
    }
  }

  return calls;
};

export const bareRecursiveRmFailures = (file, text) => {
  if (isRemoveTreeHelper(file)) return [];
  const failures = [];
  for (const call of recursiveRmCalls(text)) {
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
