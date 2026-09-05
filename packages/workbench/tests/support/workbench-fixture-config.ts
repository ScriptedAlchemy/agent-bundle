import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { RsbuildConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

const workbenchRoot = join(import.meta.dirname, '..', '..');
const requireFromWorkbench = createRequire(join(workbenchRoot, 'package.json'));

const dependencyRoot = (name: string): string => dirname(requireFromWorkbench.resolve(`${name}/package.json`));

/**
 * The Workbench's own React resolution, so a fixture entry written to a temp
 * directory outside the package still bundles the single React the Workbench
 * sources use.
 */
const workbenchBrowserAliases = {
  react: dependencyRoot('react'),
  'react-dom': dependencyRoot('react-dom'),
  'react-dom/client': join(dependencyRoot('react-dom'), 'client.js'),
};

/**
 * The one Rsbuild profile for the Workbench browser fixtures: a throwaway
 * entry that mounts a Workbench component, compiled into a per-test temp
 * `dist` and served by the test's own loopback static server.
 *
 * This is deliberately not `createWorkbenchConfig()` from `rsbuild.config.ts`.
 * The production config exists to ship the Workbench: it renders the checked-in
 * `index.html` template, copies THIRD_PARTY_NOTICES and APP-RENDERER-LICENSE
 * into `dist`, sets `root` to the package, and — whenever
 * `AGENT_BUNDLE_WORKBENCH_API_PROXY` happens to be set in the contributor's
 * shell — adds the `/api` dev proxy. None of that is fixture behaviour, and
 * fixtures that mutated the production config inherited all of it, so their
 * output depended on the shell they ran in. What every fixture actually shares
 * is exactly what this module returns:
 *
 * - `mode: 'production'`, pinned. Rsbuild infers the mode from
 *   `process.env.NODE_ENV`, which a test runner sets to `test`; that maps to
 *   mode `none`, which drops the `process.env.NODE_ENV` define (the bundle then
 *   throws "process is not defined" in the browser) and minification. Pinning
 *   the mode makes Rsbuild define `process.env.NODE_ENV` itself, so fixtures
 *   carry no manual `source.define` copy.
 * - `pluginReact()` and `workbenchBrowserAliases`.
 * - A flat, unhashed `assets/` layout (`<name>.html`, `assets/<name>.js`,
 *   `assets/<name>.css`). It differs from the production `static/` tree on
 *   purpose: it is the layout the fixtures have always emitted and their
 *   servers have always served, and `cleanDistPath: false` because the dist is
 *   a fresh `mkdtemp` child the test removes itself.
 *
 * Anything a fixture needs beyond this is an explicit, typed option here — a
 * test never mutates the returned config.
 */
export type WorkbenchFixtureConfigOptions = Readonly<{
  /** Absolute output root; `<name>.html` and `assets/<name>.{js,css}` land under it. */
  readonly distRoot: string;
  /** Entry name → absolute source path. The name is the emitted document's basename. */
  readonly entry: Readonly<Record<string, string>>;
}>;

export const createWorkbenchFixtureConfig = ({ distRoot, entry }: WorkbenchFixtureConfigOptions): RsbuildConfig => ({
  mode: 'production',
  output: {
    cleanDistPath: false,
    distPath: { css: 'assets', js: 'assets', root: distRoot },
    filename: { css: '[name].css', js: '[name].js' },
    filenameHash: false,
  },
  plugins: [pluginReact()],
  resolve: {
    alias: { ...workbenchBrowserAliases },
  },
  source: {
    entry: { ...entry },
  },
});
