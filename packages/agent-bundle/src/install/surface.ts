import type { NormalizedPlugin } from '../core/types.ts';
import {
  sortedEntries,
  sourceInputs,
  type TargetArtifactPlan,
  type TargetArtifactWrite,
} from '../adapters/types.ts';

export type BuiltInTarget = 'claude' | 'codex' | 'cursor' | 'plugin' | 'portable';

const marketplaceName = (model: NormalizedPlugin): string => `${model.metadata.name}-marketplace`;

const header = (model: NormalizedPlugin): string[] => [
  `# Install ${model.metadata.name}`,
  '',
  model.metadata.description ?? model.metadata.name,
  '',
  `Version: \`${model.metadata.version}\``,
  '',
  'Run these commands from this bundle directory.',
  '',
];

const claudeInstructions = (model: NormalizedPlugin): string[] => [
  '## Claude Code',
  '',
  'Claude Code installs this bundle through its local marketplace contract:',
  '',
  '```sh',
  'claude plugin marketplace add .',
  `claude plugin install ${model.metadata.name}@${marketplaceName(model)} --scope user`,
  '```',
  '',
  'Replace `user` with `project` or `local` when that Claude scope is intended.',
  '',
];

const codexInstructions = (model: NormalizedPlugin): string[] => [
  '## Codex',
  '',
  'Codex installs this bundle from its local marketplace snapshot:',
  '',
  '```sh',
  'codex plugin marketplace add .',
  `codex plugin add ${model.metadata.name}@${marketplaceName(model)}`,
  '```',
  '',
];

const cursorInstructions = (model: NormalizedPlugin): string[] => [
  '## Cursor',
  '',
  'Cursor has no non-interactive plugin install command. Use the bundled safe-copy installer:',
  '',
  '```sh',
  'node ./install.mjs',
  '```',
  '',
  `It installs to \`~/.cursor/plugins/local/${model.metadata.name}\`. Restart Cursor or run`,
  '`Developer: Reload Window` after installation. The installer never overwrites a different',
  'version or different content.',
  '',
];

const portableInstructions = (model: NormalizedPlugin): string[] => [
  '## Portable Agent Plugin',
  '',
  'Portable is a distribution profile, not a host runtime with one universal install location.',
  'This bundle follows Agent Plugins 1.0 and can be copied into a compatible host. Cursor supports',
  'that format directly, so the bundled installer provides a concrete local install path:',
  '',
  '```sh',
  'node ./install.mjs',
  '```',
  '',
];

const installMarkdown = (model: NormalizedPlugin, target: BuiltInTarget): string => {
  const sections = (() => {
    switch (target) {
      case 'claude':
        return claudeInstructions(model);
      case 'codex':
        return codexInstructions(model);
      case 'cursor':
        return cursorInstructions(model);
      case 'portable':
        return portableInstructions(model);
      case 'plugin':
        return [...claudeInstructions(model), ...codexInstructions(model), ...cursorInstructions(model)];
      default: {
        const exhaustive: never = target;
        throw new TypeError(`Unknown built-in install target ${String(exhaustive)}.`);
      }
    }
  })();
  return [...header(model), ...sections].join('\n');
};

const cursorInstallerSource = (model: NormalizedPlugin): string => {
  const name = JSON.stringify(model.metadata.name);
  const version = JSON.stringify(model.metadata.version);
  return [
    '#!/usr/bin/env node',
    "import { createHash } from 'node:crypto';",
    "import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';",
    "import { homedir } from 'node:os';",
    "import { basename, join, resolve } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    `const pluginName = ${name};`,
    `const pluginVersion = ${version};`,
    "const source = resolve(fileURLToPath(new URL('.', import.meta.url)));",
    "const installRoot = join(homedir(), '.cursor', 'plugins', 'local');",
    'const destination = join(installRoot, pluginName);',
    '',
    'const exists = async (path) => {',
    '  try { await lstat(path); return true; }',
    "  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }",
    '};',
    '',
    'const treeHash = async (root, prefix = \'\') => {',
    "  const hash = createHash('sha256');",
    '  const visit = async (relative) => {',
    '    const absolute = join(root, relative);',
    '    const metadata = await lstat(absolute);',
    '    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {',
    "      throw new Error(`Refusing unsupported filesystem entry ${JSON.stringify(relative || '.')}.`);",
    '    }',
    '    if (metadata.isDirectory()) {',
    '      for (const name of (await readdir(absolute)).sort()) await visit(join(relative, name));',
    '      return;',
    '    }',
    "    hash.update(relative.replaceAll('\\\\', '/'));",
    "    hash.update('\\0');",
    '    hash.update(await readFile(absolute));',
    "    hash.update('\\0');",
    '  };',
    "  for (const name of (await readdir(root)).sort()) await visit(join(prefix, name));",
    "  return hash.digest('hex');",
    '};',
    '',
    'const installedVersion = async () => {',
    "  for (const manifest of ['.cursor-plugin/plugin.json', 'plugin.json']) {",
    '    try {',
    "      const value = JSON.parse(await readFile(join(destination, manifest), 'utf8'));",
    "      if (typeof value.version === 'string') return value.version;",
    "    } catch (error) { if (error?.code !== 'ENOENT') throw error; }",
    '  }',
    '  return undefined;',
    '};',
    '',
    'await mkdir(installRoot, { recursive: true });',
    'if (await exists(destination)) {',
    '  const currentVersion = await installedVersion();',
    '  if (currentVersion !== undefined && currentVersion !== pluginVersion) {',
    '    throw new Error(`Refusing version collision at ${destination}: found ${currentVersion}, requested ${pluginVersion}.`);',
    '  }',
    '  if (source === destination || await treeHash(source) === await treeHash(destination)) {',
    '    console.log(`Already installed ${pluginName}@${pluginVersion} at ${destination}`);',
    '    process.exit(0);',
    '  }',
    '  throw new Error(`Refusing content collision at ${destination}.`);',
    '}',
    '',
    'const stageParent = await mkdtemp(join(installRoot, `.${basename(destination)}.stage-`));',
    "const stage = join(stageParent, 'bundle');",
    'try {',
    '  await cp(source, stage, { errorOnExist: true, force: false, recursive: true, verbatimSymlinks: true });',
    '  await treeHash(stage);',
    '  await rename(stage, destination);',
    '  console.log(`Installed ${pluginName}@${pluginVersion} at ${destination}`);',
    '} finally {',
    '  await rm(stageParent, { force: true, recursive: true });',
    '}',
    '',
  ].join('\n');
};

const needsCursorInstaller = (target: BuiltInTarget): boolean =>
  target === 'cursor' || target === 'plugin' || target === 'portable';

export const installSurfaceRequirements = (
  target: string,
): readonly string[] => {
  if (target === 'cursor' || target === 'plugin' || target === 'portable') {
    return Object.freeze(['INSTALL.md', 'install.mjs']);
  }
  if (target === 'claude' || target === 'codex') {
    return Object.freeze(['INSTALL.md']);
  }
  return Object.freeze([]);
};

export const installSurfaceEntries = (
  model: NormalizedPlugin,
  target: BuiltInTarget,
): readonly TargetArtifactWrite[] => Object.freeze([
  Object.freeze({
    content: installMarkdown(model, target),
    kind: 'write' as const,
    relativePath: 'INSTALL.md',
    sourceInputs: sourceInputs(model.metadata.provenance.sourcePath),
  }),
  ...(needsCursorInstaller(target)
    ? [Object.freeze({
        content: cursorInstallerSource(model),
        kind: 'write' as const,
        relativePath: 'install.mjs',
        sourceInputs: sourceInputs(model.metadata.provenance.sourcePath),
      })]
    : []),
]);

export const withInstallSurface = (
  plan: TargetArtifactPlan,
  model: NormalizedPlugin,
  target: BuiltInTarget,
): TargetArtifactPlan => Object.freeze({
  ...plan,
  entries: sortedEntries([...plan.entries, ...installSurfaceEntries(model, target)]),
});
