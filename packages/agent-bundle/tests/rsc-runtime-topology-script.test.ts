import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const script = join(workspaceRoot, 'scripts', 'rsc-runtime-topology.mjs');

const output = 'docs/architecture/rsc-runtime-workbench.md';
const captureCommand = `node packages/workbench/scripts/capture-runtime-playground.mjs \\
  --desktop "$PWD/docs/assets/rsc-runtime-workbench/desktop.png" \\
  --mobile "$PWD/docs/assets/rsc-runtime-workbench/mobile.png" \\
  --hmr-before "$PWD/docs/assets/rsc-runtime-workbench/hmr-before.png" \\
  --hmr-after "$PWD/docs/assets/rsc-runtime-workbench/hmr-after.png" \\
  --compile-error "$PWD/docs/assets/rsc-runtime-workbench/compile-error.png" \\
  --recovered "$PWD/docs/assets/rsc-runtime-workbench/recovered.png" \\
  --evidence /tmp/rsc-runtime-delivery/evidence.json`;
const expectedTree = `packages/
  agent-bundle/
    src/adapters/registry.ts
    src/config/normalize.ts
    src/core/types.ts
    src/dev/mcp-app-action-validation.ts
    src/dev/playground/playground-store.ts
    src/dev/runtime-provider.ts
    src/index.ts
    tests/normalization.test.ts
    tests/playground-service.test.ts
    tests/runtime-provider.test.ts
  workbench/
    src/mcp/runtime-app-bridge.ts
    src/mcp/runtime-consent-dialog.tsx
    src/mcp/runtime-consent-queue.ts
    src/runtime-model.ts
    tests/runtime-app-bridge.test.ts
    tests/runtime-consent-dialog.test.ts
    tests/runtime-consent-queue.test.ts
examples/
  rsc-agent-runtime/
    src/dev/provider.ts`;

const generatedBlock = (tree: string): string => [
  '<!-- BEGIN GENERATED RSC RUNTIME TOPOLOGY -->',
  '```text',
  tree,
  '```',
  '<!-- END GENERATED RSC RUNTIME TOPOLOGY -->',
].join('\n');

const writeFixture = async (root: string, file: string): Promise<void> => {
  const target = join(root, file);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, `${file}\n`);
};

const run = (root: string, check = false): Promise<{ readonly stdout: string; readonly stderr: string }> => execFile(
  process.execPath,
  [script, '--root', root, '--output', output, ...(check ? ['--check'] : [])],
);

describe('rsc runtime topology script', () => {
  it('documents every required absolute runtime capture output', async () => {
    const readme = await readFile(join(workspaceRoot, 'examples', 'rsc-agent-runtime', 'README.md'), 'utf8');

    expect(readme).toContain(captureCommand);
  });

  it('renders the tracked feature tree and detects a stale marker block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsc-runtime-topology-'));
    try {
      await Promise.all([
        'packages/agent-bundle/src/adapters/registry.ts',
        'packages/agent-bundle/src/config/normalize.ts',
        'packages/agent-bundle/src/core/types.ts',
        'packages/agent-bundle/src/dev/mcp-app-action-validation.ts',
        'packages/agent-bundle/src/dev/runtime-provider.ts',
        'packages/agent-bundle/src/index.ts',
        'packages/agent-bundle/src/dev/playground/playground-store.ts',
        'packages/agent-bundle/tests/normalization.test.ts',
        'packages/agent-bundle/tests/playground-service.test.ts',
        'packages/agent-bundle/tests/runtime-provider.test.ts',
        'packages/workbench/src/mcp/runtime-app-bridge.ts',
        'packages/workbench/src/mcp/runtime-consent-dialog.tsx',
        'packages/workbench/src/mcp/runtime-consent-queue.ts',
        'packages/workbench/src/runtime-model.ts',
        'packages/workbench/tests/runtime-app-bridge.test.ts',
        'packages/workbench/tests/runtime-consent-dialog.test.ts',
        'packages/workbench/tests/runtime-consent-queue.test.ts',
        'examples/rsc-agent-runtime/src/dev/provider.ts',
        'dist/ignored.js',
        'node_modules/ignored.js',
        '.agent-bundle/ignored.json',
        'screenshots/outside-docs.png',
      ].map(async (file) => writeFixture(root, file)));
      await writeFixture(root, '.gitignore');
      await writeFile(join(root, '.gitignore'), 'dist/\nnode_modules/\n.agent-bundle/\n');
      await writeFixture(root, output);
      await writeFile(join(root, output), `# Runtime topology\n\n${generatedBlock('stale')}\n`);
      await execFile('git', ['init', '--quiet'], { cwd: root });
      await execFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
      await execFile('git', ['config', 'user.name', 'Topology test'], { cwd: root });
      await execFile('git', ['add', '.'], { cwd: root });
      await execFile('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });

      await run(root);
      const document = await readFile(join(root, output), 'utf8');
      expect(document).toContain(generatedBlock(expectedTree));
      expect(document).not.toContain('dist/ignored.js');
      expect(document).not.toContain('node_modules/ignored.js');
      expect(document).not.toContain('.agent-bundle/ignored.json');
      expect(document).not.toContain('screenshots/outside-docs.png');
      expect(document).not.toContain(root);

      await writeFile(join(root, output), document.replace('src/dev/runtime-provider.ts', 'src/dev/runtime-provider-stale.ts'));
      await expect(run(root, true)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('RSC runtime topology is stale'),
      });
      await run(root);
      await expect(run(root, true)).resolves.toBeDefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
