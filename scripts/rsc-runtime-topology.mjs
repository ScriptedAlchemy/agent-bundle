#!/usr/bin/env node

import { execFile as executeFile } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);

const BEGIN = '<!-- BEGIN GENERATED RSC RUNTIME TOPOLOGY -->';
const END = '<!-- END GENERATED RSC RUNTIME TOPOLOGY -->';

const ALLOWLIST = Object.freeze([
  'packages/agent-bundle/src/adapters',
  'packages/agent-bundle/src/build',
  'packages/agent-bundle/src/config',
  'packages/agent-bundle/src/core/digest.ts',
  'packages/agent-bundle/src/core/project-context.ts',
  'packages/agent-bundle/src/core/types.ts',
  'packages/agent-bundle/src/dev',
  'packages/agent-bundle/src/index.ts',
  'packages/agent-bundle/src/dev/playground/playground-store.ts',
  'packages/agent-bundle/tests',
  'packages/workbench/rsbuild.config.ts',
  'packages/workbench/scripts',
  'packages/workbench/src',
  'packages/workbench/tests',
  'examples/rsc-agent-runtime',
  'docs/superpowers/specs',
  'docs/superpowers/plans',
]);

const agentBundleSource = new Set([
  'packages/agent-bundle/src/adapters/types.ts',
  'packages/agent-bundle/src/adapters/registry.ts',
  'packages/agent-bundle/src/adapters/portable.ts',
  'packages/agent-bundle/src/adapters/codex.ts',
  'packages/agent-bundle/src/adapters/claude.ts',
  'packages/agent-bundle/src/config/load.ts',
  'packages/agent-bundle/src/config/normalize.ts',
  'packages/agent-bundle/src/config/validate.ts',
  'packages/agent-bundle/src/config/index.ts',
  'packages/agent-bundle/src/core/types.ts',
  'packages/agent-bundle/src/core/digest.ts',
  'packages/agent-bundle/src/core/project-context.ts',
  'packages/agent-bundle/src/index.ts',
  'packages/agent-bundle/src/dev/playground/playground-store.ts',
]);

const agentBundleBuild = new Set([
  'packages/agent-bundle/src/build/build.ts',
  'packages/agent-bundle/src/build/emit.ts',
  'packages/agent-bundle/src/build/entries.ts',
  'packages/agent-bundle/src/build/manifest.ts',
  'packages/agent-bundle/src/build/mcp-apps.ts',
  'packages/agent-bundle/src/build/provenance.ts',
  'packages/agent-bundle/src/build/validate-artifact.ts',
]);

const agentBundleDev = new Set([
  'packages/agent-bundle/src/dev/foreground-server.ts',
  'packages/agent-bundle/src/dev/playground/hook-playground-service.ts',
  'packages/agent-bundle/src/dev/mcp-app-action-validation.ts',
  'packages/agent-bundle/src/dev/mcp-apps/mcp-app-binding-service.ts',
  'packages/agent-bundle/src/dev/mcp-apps/mcp-app-preview-service.ts',
  'packages/agent-bundle/src/dev/mcp-app-runtime-binding-service.ts',
  'packages/agent-bundle/src/dev/mcp-app-runtime-preview-service.ts',
  'packages/agent-bundle/src/dev/mcp-apps/mcp-app-routes.ts',
  'packages/agent-bundle/src/dev/mcp-session/mcp-session-service.ts',
  'packages/agent-bundle/src/dev/project-service.ts',
  'packages/agent-bundle/src/dev/runtime-app-message-limits.ts',
  'packages/agent-bundle/src/dev/runtime-client-surface-proxy.ts',
  'packages/agent-bundle/src/dev/runtime-controller.ts',
  'packages/agent-bundle/src/dev/runtime-generation-store.ts',
  'packages/agent-bundle/src/dev/runtime-mcp-registry.ts',
  'packages/agent-bundle/src/dev/runtime-mcp-routes.ts',
  'packages/agent-bundle/src/dev/runtime-provider-loader.ts',
  'packages/agent-bundle/src/dev/runtime-provider.ts',
  'packages/agent-bundle/src/dev/runtime-routes.ts',
  'packages/agent-bundle/src/dev/workbench-server.ts',
]);

const workbenchSource = new Set([
  'packages/workbench/rsbuild.config.ts',
  'packages/workbench/src/main.tsx',
  'packages/workbench/src/styles.css',
  'packages/workbench/src/project-client.ts',
  'packages/workbench/src/runtime-client.ts',
  'packages/workbench/src/runtime-inspector.tsx',
  'packages/workbench/src/runtime-model.ts',
  'packages/workbench/src/runtime-playground.tsx',
  'packages/workbench/src/runtime-stage.tsx',
  'packages/workbench/src/mcp/mcp-app-client.ts',
  'packages/workbench/src/mcp/mcp-app-frame.tsx',
  'packages/workbench/src/mcp/mcp-app-preview.tsx',
  'packages/workbench/src/mcp/mcp-page.tsx',
  'packages/workbench/src/mcp/mcp-session-controller.ts',
  'packages/workbench/src/mcp/mcp-session-model.ts',
  'packages/workbench/src/mcp/runtime-consent-dialog.tsx',
  'packages/workbench/src/mcp/runtime-consent-queue.ts',
  'packages/workbench/src/mcp/runtime-mcp-handoff.ts',
  'packages/workbench/src/mcp/runtime-app-bridge.ts',
]);

const workbenchTests = /^(?:packages\/workbench\/tests\/(?:helpers\/runtime-playground-fixture\.ts|(?:mcp-app|mcp-page|mcp-session|runtime-|project-client|rsbuild-workbench|runtime-playground).+\.(?:test|e2e\.test|browser\.test)\.(?:ts|tsx))|packages\/workbench\/scripts\/capture-runtime-playground\.mjs)$/u;
const agentBundleTests = /^packages\/agent-bundle\/tests\/(?:normalization|duplicate-key|public-api|canonical-digest|emitted-host|native-host|target-registry|portable|codex|claude|dev-artifact|host-adapters|runtime-|mcp-app|mcp-session|foreground-server|project-service|dev-workbench|rsc-runtime-(?:optional-packaging|topology-script)|playground-service).*\.test\.ts$/u;
const exampleRuntime = /^examples\/rsc-agent-runtime\/(?:package\.json|rsbuild\.config\.ts|tsconfig\.json|src\/definition\.ts$|src\/(?:build|dev|flight|hook|mcp|rsc|runtime|widget|types)\/|scripts\/(?:capture-widget|eval-evidence|eval-host-environment|eval-hosts|package-hosts)\.mjs$|tests\/(?:dev-provider|generation-materializer|dev-invocation|host-artifacts|runtime-artifact-manifest|mcp-transports|mcp-lowering|rsc-hook|state-and-definition|http-security|eval-evidence|host-extensions|widget-accessibility|docs-contract).+\.(?:ts|tsx)$)/u;

const usage = () => {
  throw new Error('Usage: node scripts/rsc-runtime-topology.mjs --root <repository> --output <markdown> [--check]');
};

const parseArguments = (arguments_) => {
  let root;
  let output;
  let check = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--check') {
      if (check) usage();
      check = true;
      continue;
    }
    if (argument !== '--root' && argument !== '--output') usage();
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) usage();
    index += 1;
    if (argument === '--root') {
      if (root !== undefined) usage();
      root = value;
    } else {
      if (output !== undefined) usage();
      output = value;
    }
  }
  if (root === undefined || output === undefined || isAbsolute(output)) usage();
  return Object.freeze({ check, output, root });
};

const isWithin = (root, candidate) => {
  const relativePath = relative(root, candidate);
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
};

const retained = (path, generatedOutput) => {
  if (path === generatedOutput || path.includes('/node_modules/') || path.includes('/dist/') || path.includes('/.agent-bundle/')) return false;
  if (/\.(?:png|jpe?g|webp)$/iu.test(path) && !path.startsWith('docs/assets/rsc-runtime-workbench/')) return false;
  return agentBundleSource.has(path)
    || agentBundleBuild.has(path)
    || agentBundleDev.has(path)
    || agentBundleTests.test(path)
    || workbenchSource.has(path)
    || workbenchTests.test(path)
    || exampleRuntime.test(path);
};

const compare = (left, right) => left.localeCompare(right);

const renderTree = (paths) => {
  const groups = [
    ['packages/agent-bundle/', 'packages', 'agent-bundle'],
    ['packages/workbench/', 'packages', 'workbench'],
    ['examples/rsc-agent-runtime/', 'examples', 'rsc-agent-runtime'],
  ];
  const lines = [];
  for (const root of ['packages', 'examples']) {
    const groupPaths = groups.filter(([, group]) => group === root);
    if (!groupPaths.some(([prefix]) => paths.some((path) => path.startsWith(prefix)))) continue;
    lines.push(`${root}/`);
    for (const [prefix, , name] of groupPaths) {
      const children = paths.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)).sort(compare);
      if (children.length === 0) continue;
      lines.push(`  ${name}/`);
      lines.push(...children.map((child) => `    ${child}`));
    }
  }
  return lines.join('\n');
};

const replaceBlock = (document, tree) => {
  const start = document.indexOf(BEGIN);
  const end = document.indexOf(END);
  if (start === -1 || end === -1 || end < start || document.indexOf(BEGIN, start + BEGIN.length) !== -1 || document.indexOf(END, end + END.length) !== -1) {
    throw new Error('RSC runtime topology markers must occur exactly once and in order.');
  }
  const block = `${BEGIN}\n\`\`\`text\n${tree}\n\`\`\`\n${END}`;
  return `${document.slice(0, start)}${block}${document.slice(end + END.length)}`;
};

const main = async () => {
  const arguments_ = parseArguments(process.argv.slice(2));
  const root = await realpath(arguments_.root);
  const unresolvedOutput = resolve(root, arguments_.output);
  const outputParent = await realpath(dirname(unresolvedOutput));
  if (!isWithin(root, outputParent)) throw new Error('Topology output must remain beneath --root.');
  const outputPath = join(outputParent, basename(unresolvedOutput));
  const outputRelative = relative(root, outputPath).split(sep).join('/');
  const { stdout } = await execFile('git', ['ls-files', '-z', '--', ...ALLOWLIST], { cwd: root, encoding: 'buffer' });
  const paths = stdout.toString('utf8').split('\0').filter(Boolean).filter((path) => retained(path, outputRelative)).sort(compare);
  const current = await readFile(outputPath, 'utf8');
  const next = replaceBlock(current, renderTree(paths));
  if (arguments_.check) {
    if (next !== current) {
      process.stderr.write('RSC runtime topology is stale. Run npm run docs:runtime-topology.\n');
      process.exitCode = 1;
    }
    return;
  }
  await writeFile(outputPath, next);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
