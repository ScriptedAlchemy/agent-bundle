import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { compileMcpApps } from '../build/mcp-apps.ts';
import type { NormalizedMcpApp } from '../core/types.ts';
import { compileTestManifest, proofLevelLabel, type TestableAppDescriptor } from '../test/manifest.ts';
import { writeBrowserTestSetup } from './browser-setup-module.ts';
import { metaModuleAlias, writeTestMetaModule } from './meta-module.ts';

const browserAppInclude = 'tests/browser-app/**/*.test.{ts,tsx}';

export interface AgentBundleBrowserRstestOptions {
  /** Explicit Agent Bundle configuration path; discovered from `root` when omitted. */
  readonly configPath?: string;
  /** Test files for the browser-app level; defaults to `tests/browser-app/**`. */
  readonly include?: readonly string[];
  /** Project root; defaults to the working directory Rstest was started in. */
  readonly root?: string;
  /** Extra setup files, appended after the generated browser registry. */
  readonly setupFiles?: readonly string[];
  /**
   * Compiles every app for this target. By default each app uses its first
   * declared target that is also selected by the project.
   */
  readonly target?: string;
}

export interface AgentBundleBrowserRstestConfig {
  browser: {
    enabled: true;
    headless: true;
    provider: 'playwright';
    providerOptions: { launch: { channel: 'chrome' } };
    viewport: { height: 900; width: 1440 };
  };
  include: string[];
  /** Routes the reserved `agent-bundle/meta` specifier to the generated identity module. */
  resolve: { alias: { [specifier: string]: string } };
  setupFiles: string[];
  source?: { tsconfigPath: string };
  tools: {
    rspack: {
      resolve: {
        extensionAlias: { '.js': string[]; '.jsx': string[] };
      };
    };
    swc: { jsc: { transform: { react: { runtime: 'automatic' } } } };
  };
}

const appTarget = (
  app: TestableAppDescriptor,
  projectTargets: readonly string[],
  override: string | undefined,
  configPath: string,
): string => {
  const target = override ?? app.targets.find((candidate) => projectTargets.includes(candidate));
  if (target === undefined || !projectTargets.includes(target) || !app.targets.includes(target)) {
    throw new Error([
      `MCP App ${JSON.stringify(app.name)} has no browser compilation target selected by the project.`,
      `  proof level: ${proofLevelLabel('browser-app')}`,
      `  app:         ${app.name} (${app.resourceUri})`,
      `  config:      ${configPath}`,
      `  app targets: ${app.targets.join(', ') || 'none'}`,
      `  selected:    ${projectTargets.join(', ') || 'none'}`,
      ...(override === undefined ? [] : [`  override:    ${override}`]),
    ].join('\n'));
  }
  return target;
};

const normalizedApp = (app: TestableAppDescriptor, configPath: string): NormalizedMcpApp => {
  const serverId = app.serverIds[0];
  if (serverId === undefined) {
    throw new Error(`MCP App ${JSON.stringify(app.name)} has no owning server in ${JSON.stringify(configPath)}.`);
  }
  return {
    ...(app._meta === undefined ? {} : { _meta: app._meta }),
    id: app.id,
    name: app.name,
    ...(app.prebuilt === undefined ? {} : { prebuilt: app.prebuilt }),
    provenance: { kind: 'config', sourcePath: configPath },
    resourceUri: app.resourceUri,
    serverId,
    serverName: serverId.startsWith('mcp:') ? serverId.slice(4) : serverId,
    source: app.source,
    targets: app.targets,
    ...(app.template === undefined ? {} : { template: app.template }),
  };
};

export const agentBundleBrowserRstest = async (
  options: AgentBundleBrowserRstestOptions = {},
): Promise<AgentBundleBrowserRstestConfig> => {
  const root = resolve(options.root ?? process.cwd());
  const manifest = await compileTestManifest({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    root,
  });
  const configPath = manifest.configPath ?? resolve(root, options.configPath ?? 'agent-bundle.config.ts');
  const apps = Object.values(manifest.apps);
  if (apps.length === 0) {
    throw new Error(
      `Browser-App test pool for ${JSON.stringify(configPath)} declares no MCP Apps to prove.`,
    );
  }
  const prebuilt = apps.find((app) => app.prebuilt === true);
  if (prebuilt !== undefined) {
    throw new Error(
      `Browser-App test pool cannot compile prebuilt MCP App ${JSON.stringify(prebuilt.name)} from ${JSON.stringify(configPath)}.`,
    );
  }

  const normalized = apps.map((app) => normalizedApp(app, configPath));
  const targets = Object.fromEntries(
    apps.map((app) => [app.id, appTarget(app, manifest.targets, options.target, configPath)]),
  );
  const outputRoot = resolve(root, '.agent-bundle', 'test', 'browser-app-build');
  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(outputRoot, { recursive: true });
  const compiled = await compileMcpApps(normalized, {
    cwd: root,
    meta: {
      name: manifest.plugin.name,
      packageName: manifest.plugin.packageName,
      packageVersion: manifest.plugin.packageVersion,
      version: manifest.plugin.version,
    },
    outDir: outputRoot,
    targets,
  });
  if (compiled.length !== apps.length) {
    throw new Error(
      `Browser-App compiler emitted ${String(compiled.length)} of ${String(apps.length)} declared apps for ${JSON.stringify(configPath)}.`,
    );
  }
  const setup = await writeBrowserTestSetup(root, compiled);
  // The compiled app bundles already carry the stamped identity; the alias
  // covers test files and view helpers the browser pool bundles itself.
  const metaModule = await writeTestMetaModule(root, manifest);
  const tsconfigPath = resolve(root, 'tsconfig.json');
  return {
    browser: {
      enabled: true,
      headless: true,
      provider: 'playwright',
      providerOptions: { launch: { channel: 'chrome' } },
      viewport: { height: 900, width: 1440 },
    },
    include: [...(options.include ?? [browserAppInclude])],
    resolve: { alias: metaModuleAlias(metaModule) },
    setupFiles: [setup, ...(options.setupFiles ?? [])],
    ...(existsSync(tsconfigPath) ? { source: { tsconfigPath } } : {}),
    tools: {
      rspack: {
        resolve: {
          extensionAlias: { '.js': ['.js', '.ts', '.tsx'], '.jsx': ['.jsx', '.tsx'] },
        },
      },
      swc: { jsc: { transform: { react: { runtime: 'automatic' } } } },
    },
  };
};
