/**
 * Test teardown that deletes a tree calls `removeTree`. A bare `rm` with
 * `recursive: true` and no `maxRetries` races a late writer and flakes with ENOTEMPTY.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const roots = [
  'packages/agent-bundle/tests',
  'packages/workbench/tests',
  'packages/rsc-runtime/tests',
  'packages/rsc-markdown-stream/tests',
  'packages/create-agent-bundle/tests',
];

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

const recursiveRmCalls = (text) => {
  const calls = [];
  const pattern = /\brm\s*\(/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    const before = text[match.index - 1];
    if (before === '.' || before === '$') {
      match = pattern.exec(text);
      continue;
    }
    let commented = false;
    for (let index = match.index - 1; index >= 0; index -= 1) {
      const char = text[index];
      if (char === '\n') break;
      if (char === '/' && text[index - 1] === '/') {
        commented = true;
        break;
      }
    }
    if (commented) {
      match = pattern.exec(text);
      continue;
    }
    const open = match.index + match[0].length - 1;
    let depth = 1;
    let inString = null;
    let index = open + 1;
    while (index < text.length && depth > 0) {
      const char = text[index];
      if (inString !== null) {
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (char === inString) inString = null;
      } else if (char === "'" || char === '"' || char === '`') inString = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    const call = text.slice(match.index, index);
    if (/recursive\s*:\s*true/u.test(call)) {
      calls.push({
        call,
        hasRetries: /maxRetries\s*:/u.test(call),
        line: text.slice(0, match.index).split('\n').length,
      });
    }
    match = pattern.exec(text);
  }
  return calls;
};

const failures = [];
const files = [];
for (const root of roots) await walk(root, files);
for (const file of files) {
  const text = await readFile(file, 'utf8');
  for (const call of recursiveRmCalls(text)) {
    if (call.hasRetries) continue;
    failures.push(`${file}:${call.line} bare recursive rm. Use removeTree.`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
