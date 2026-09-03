import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A minimal route-mode project whose host-facing adoption can be gated by
 * `dev.contracts`: one generated `fixture` server with one `version` tool and a
 * project-local contract fixture module the dev server reloads per epoch.
 */
export interface DevContractProject {
  readonly contractFixtures: string;
  readonly toolSource: string;
}

export const DEV_CONTRACT_SERVER = 'fixture';
export const DEV_CONTRACT_TOOL_ROUTE = 'tool:fixture/version';

const fixtureNodeModules = join(import.meta.dirname, '..', '..', '..', '..', 'examples', 'audiobook-curator', 'node_modules');

export const devContractToolSource = (version: string, projectRoot: string): string => [
  `// fixture: ${projectRoot}`,
  "import { createElement } from 'react';",
  "import { z } from 'zod';",
  '',
  "export const config = { description: 'Reports the generated epoch version.' };",
  'export const inputSchema = z.object({ token: z.string() });',
  'export const resultSchema = z.object({ version: z.string() });',
  '',
  'export default async function Version() {',
  `  return createElement('agent-result', { value: { version: ${JSON.stringify(version)} } }, createElement('agent-text', null, ${JSON.stringify(version)}));`,
  '}',
  '',
].join('\n');

export const devContractFixtureSource = (routeId: string): string => [
  'export default {',
  `  ${JSON.stringify(routeId)}: { input: { token: 'fixture' }, resultCompat: 'closed' },`,
  '};',
  '',
].join('\n');

export const writeDevContractProject = async (
  root: string,
  options: { readonly contracts: boolean },
): Promise<DevContractProject> => {
  const toolSource = join(root, 'src', 'mcp', DEV_CONTRACT_SERVER, 'tools', 'version.tsx');
  const contractFixtures = join(root, 'contract-fixtures.ts');
  await Promise.all([
    mkdir(join(root, 'src', 'mcp', DEV_CONTRACT_SERVER, 'tools'), { recursive: true }),
    symlink(fixtureNodeModules, join(root, 'node_modules'), 'dir'),
  ]);
  await Promise.all([
    writeFile(join(root, '.gitignore'), '.dist.stage-*\ndist/\n'),
    writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'dev-contract-gate',
      type: 'module',
      version: '1.0.0',
    })),
    writeFile(toolSource, devContractToolSource('v1', root)),
    writeFile(contractFixtures, devContractFixtureSource(DEV_CONTRACT_TOOL_ROUTE)),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      ...(options.contracts
        ? [`  dev: { contracts: { fixtures: './contract-fixtures.ts', server: ${JSON.stringify(DEV_CONTRACT_SERVER)} } },`]
        : []),
      "  plugin: { name: 'dev-contract-gate', version: '1.0.0' },",
      '  routes: { mcpCommands: true },',
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n')),
  ]);
  return Object.freeze({ contractFixtures, toolSource });
};
