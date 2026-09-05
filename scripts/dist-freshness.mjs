/**
 * Freshness of the workspace `dist` trees, judged by newest mtime (#576,
 * finding 3-P1 "stale dist").
 *
 * The unit, route-unit and projection pools import `@agent-bundle/runtime`
 * and `agent-bundle` through their package `exports`, which name `dist` only;
 * `pnpm typecheck` types the tests against the same `dist/*.d.ts`; the
 * process pools read `packages/{agent-bundle,workbench}/dist` and copy
 * `examples/rsc-agent-runtime/dist`. None of those paths knows when the
 * sources moved on, so a green run can prove yesterday's build — it did, on
 * #570's own gate. This module answers one question per built output: is
 * every file the build read older than the newest file it wrote? Three
 * callers act on the answer: `scripts/check-dist-fresh.mjs` ahead of
 * `pnpm typecheck`, `rstest.dist-freshness.setup.ts` in each pool's
 * orchestrator before the first worker starts, and
 * `packages/workbench/tests/helpers/runtime-example-payload.ts`, which
 * rebuilds the example payload instead of short-circuiting on a stale one.
 *
 * Comparison. A package is `missing` when its output directory is absent or
 * holds no file, `contaminated` when an output contains the packed runtime
 * fixture marker, `stale` when the newest input mtime is later than the
 * newest output mtime, and `fresh` otherwise. Inputs count files and
 * directories: a directory's mtime moves when an entry is created, renamed
 * or deleted, which is how a removed source file is noticed. Outputs count
 * files only — the bytes a test loads. While walking, `node_modules`,
 * `dist`, `.rstest-temp` and every other dot-directory are skipped inside
 * inputs (an input root that is itself a `dist` is still walked: the example
 * bundles two workspace dists); outputs skip `node_modules` and
 * dot-directories, so a temp writer inside a dist cannot make it look new.
 *
 * False positives run in the safe direction. A `git checkout`, `git stash`
 * or rebase rewrites the touched sources with the current time, so a dist
 * whose content would be byte-identical reads as stale and the guard asks
 * for `pnpm build` (about 15 s warm). The build is the fix in every case; the
 * guard never guesses that unchanged-looking bytes are unchanged. There is
 * no bypass variable: every flow in this repository that runs a pool or
 * `pnpm typecheck` builds first (ci.yml `verify`: build, typecheck, lint,
 * test; the `test:integration`, `test:mcp-conformance` and
 * `check` scripts; scripts/run-packed-tests.mjs; scripts/local-ci.mjs legs;
 * docs.yml runs the website's own typecheck), so a skip switch would only
 * serve to reopen the hole this closes. Add one when a flow that must run
 * over a deliberately prebuilt dist exists, and name that flow beside it.
 *
 * The one false negative the comparison admits: a dist whose newest file
 * postdates the inputs while other files in it are older — a build that
 * failed after writing some outputs, or a hand-touched file. `pnpm build`
 * always rewrites a package's dist whole, so the guard accepts that bound
 * rather than a per-file manifest; a build that fails is reported by the
 * build, and the next successful one restores the invariant.
 *
 * Inputs per package (`workspaceBuildOutputs`), read from each build config:
 *
 * - Every package: `src` (the entries and everything they import), the
 *   Rslib/Rsbuild config, `package.json` (entry list and `exports`;
 *   agent-bundle also bakes its `version` in through `source.define`), the
 *   tsconfig the config names, and the root `tsconfig.json` and
 *   `tsconfig.base.json` those extend (compiler options shape the `.d.ts`
 *   emit and SWC settings). `pnpm-lock.yaml` for all of them: agent-bundle
 *   inlines the TypeScript 5 parser and every devDependency it imports,
 *   create-agent-bundle inlines `@clack/prompts`, so a dependency bump is a
 *   build input too. `LICENSE`/`NOTICE` are copied beside dist, not into it,
 *   and are not inputs; neither are `bin/` and `templates/`, which ship as
 *   files.
 * - rsc-markdown-stream: `dts: false`; `src/index.d.ts` is copied into dist
 *   and lives under `src`, so it is covered.
 * - agent-bundle-workbench: an Rsbuild app — `src`, `index.html` (the
 *   template), `THIRD_PARTY_NOTICES` (copied into dist), `rsbuild.config.ts`.
 *   `pnpm build` produces this dist through agent-bundle's
 *   `build:workbench` step, so it is listed like the publishable four.
 * - agent-bundle: its Rslib build copies `../workbench/dist` into
 *   `dist/workbench`, after its package script has rebuilt the Workbench. The
 *   descriptor therefore lists the Workbench's build inputs — not its dist —
 *   so an in-place Workbench rebuild from unchanged sources (workbench-e2e.ts
 *   and runtime-playground-fixture.ts run one when
 *   AGENT_BUNDLE_WORKBENCH_PREBUILT is unset) does not demand a full
 *   `pnpm build` at the next pool start. The Workbench descriptor still flags
 *   a Workbench dist older than its own sources, so between the two every
 *   stale copy is caught.
 *
 * The rsc-agent-runtime example (`runtimeExampleBuildOutputs`) is not part of
 * `pnpm build`; runtime-example-payload.ts builds it. Its Rsbuild `node`
 * target bundles dependencies, so `packages/rsc-runtime/dist` and the
 * `rsc-markdown-stream` dist it imports are inputs beside `src`,
 * `rsbuild.config.ts` (which imports `src/build/emit-artifacts.js`),
 * `package.json` and the tsconfig chain: a `pnpm build` that rewrote the
 * runtime makes the payload stale, and the ensure-build reruns. One
 * descriptor per payload tree (`dist/app`, `dist/runtime`) keeps
 * "missing" per tree, matching the presence probes it replaces.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * @typedef {object} DistDescriptor
 * @property {string} name Package name, as printed in the failure message.
 * @property {string} root Absolute package root; `inputs` and `output` resolve against it.
 * @property {readonly string[]} inputs Files and directories the build reads, relative to `root` (`..` segments allowed).
 * @property {string} output The directory the build writes, relative to `root`.
 */

/**
 * @typedef {object} NewestEntry
 * @property {string} path Absolute path of the newest file or directory.
 * @property {number} mtimeMs Its modification time, in milliseconds since the epoch.
 */

/**
 * @typedef {object} DistFreshness
 * @property {string} name
 * @property {string} output Absolute path of the output directory.
 * @property {'fresh' | 'stale' | 'missing' | 'contaminated'} status
 * @property {NewestEntry} newestInput
 * @property {NewestEntry | undefined} newestOutput Undefined when `status` is `missing`.
 * @property {string | undefined} fixtureMarkerPath File containing the packed-test fixture marker.
 */

const skippedInputDirectoryNames = new Set(['node_modules', 'dist', '.rstest-temp']);

/** Directory names never entered while walking a package's inputs (the input root itself is always walked). */
export const isSkippedInputDirectory = (name) => skippedInputDirectoryNames.has(name) || name.startsWith('.');

/** Directory names never entered while walking an output: a dist is itself the walk root, so only temp and dependency trees are excluded. */
const isSkippedOutputDirectory = (name) => name === 'node_modules' || name.startsWith('.');

/** The later of two entries; either may be undefined (an absent path). */
const newer = (best, candidate) => {
  if (candidate === undefined) return best;
  return best === undefined || candidate.mtimeMs > best.mtimeMs ? candidate : best;
};

/**
 * Newest mtime under `path` (a file or a directory), or undefined when it
 * does not exist. Directories whose name `skip` accepts are not entered.
 * With `countDirectories`, directory mtimes join the comparison. Symbolic
 * links are followed for their mtime; a link to a directory is not entered,
 * so a cycle cannot form.
 *
 * @param {string} path
 * @param {{ readonly countDirectories?: boolean; readonly skip?: (name: string) => boolean }} [options]
 * @returns {NewestEntry | undefined}
 */
export const newestEntry = (path, options = {}) => {
  const skip = options.skip ?? (() => false);
  const countDirectories = options.countDirectories ?? false;
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (!stat.isDirectory()) return { path, mtimeMs: stat.mtimeMs };
  let newest = countDirectories ? { path, mtimeMs: stat.mtimeMs } : undefined;
  const pending = [path];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      const entryStat = statSync(entryPath, { throwIfNoEntry: false });
      if (entryStat === undefined) continue;
      if (entryStat.isDirectory()) {
        if (skip(entry.name)) continue;
        if (countDirectories) newest = newer(newest, { path: entryPath, mtimeMs: entryStat.mtimeMs });
        if (!entry.isSymbolicLink()) pending.push(entryPath);
        continue;
      }
      if (entryStat.isFile()) newest = newer(newest, { path: entryPath, mtimeMs: entryStat.mtimeMs });
    }
  }
  return newest;
};

export const runtimeRebundleFixtureMarker = 'AGENT_BUNDLE_RUNTIME_REBUNDLE_FIXTURE_EXECUTED';

/** Returns the first built file containing the packed-only runtime marker. */
const fixtureMarkerPath = (root) => {
  const marker = Buffer.from(runtimeRebundleFixtureMarker);
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (isSkippedOutputDirectory(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && readFileSync(path).includes(marker)) return path;
    }
  }
  return undefined;
};

/**
 * Freshness of one built output. Declared inputs that do not exist are
 * ignored (a package may lack an optional config file); a descriptor none of
 * whose inputs exist is a mistake and throws.
 *
 * @param {DistDescriptor} descriptor
 * @returns {DistFreshness}
 */
export const distFreshness = (descriptor) => {
  const { name, root } = descriptor;
  let newestInput;
  for (const input of descriptor.inputs) {
    newestInput = newer(newestInput, newestEntry(resolve(root, input), { countDirectories: true, skip: isSkippedInputDirectory }));
  }
  if (newestInput === undefined) {
    throw new Error(`dist-freshness: none of the ${descriptor.inputs.length} declared inputs of ${name} exist under ${root}; the descriptor is wrong.`);
  }
  const output = resolve(root, descriptor.output);
  const newestOutput = newestEntry(output, { skip: isSkippedOutputDirectory });
  const markerPath = newestOutput === undefined ? undefined : fixtureMarkerPath(output);
  const status = newestOutput === undefined
    ? 'missing'
    : markerPath !== undefined
      ? 'contaminated'
      : newestInput.mtimeMs > newestOutput.mtimeMs
        ? 'stale'
        : 'fresh';
  return { name, output, status, newestInput, newestOutput, fixtureMarkerPath: markerPath };
};

/**
 * @param {readonly DistDescriptor[]} descriptors
 * @returns {readonly DistFreshness[]}
 */
export const checkDistFreshness = (descriptors) => descriptors.map(distFreshness);

const timestamp = (mtimeMs) => new Date(mtimeMs).toISOString();

/**
 * One actionable message naming every stale, missing, or contaminated output
 * and ending with the fix, or the empty string when every result is fresh.
 * Paths print relative to `relativeTo` (default: the working directory) when
 * they lie under it.
 *
 * @param {readonly DistFreshness[]} results
 * @param {{ readonly relativeTo?: string }} [options]
 * @returns {string}
 */
export const formatDistFreshnessFailure = (results, options = {}) => {
  const relativeTo = options.relativeTo ?? process.cwd();
  const display = (path) => {
    const relativePath = relative(relativeTo, path);
    return relativePath.length > 0 && !relativePath.startsWith('..') ? relativePath : path;
  };
  const lines = [];
  for (const result of results) {
    if (result.status === 'fresh') continue;
    if (result.status === 'contaminated') {
      lines.push(`  ${result.name}: contaminated — ${display(result.fixtureMarkerPath ?? result.output)} contains the packed runtime fixture marker`);
      continue;
    }
    if (result.status === 'missing' || result.newestOutput === undefined) {
      lines.push(`  ${result.name}: missing — ${display(result.output)} has no built files`);
      continue;
    }
    lines.push(
      `  ${result.name}: stale — ${display(result.newestInput.path)} (${timestamp(result.newestInput.mtimeMs)})`
      + ` is newer than ${display(result.newestOutput.path)} (${timestamp(result.newestOutput.mtimeMs)})`,
    );
  }
  if (lines.length === 0) return '';
  return [
    'Built output is stale, missing, or contaminated; tests and `pnpm typecheck` load it from dist:',
    ...lines,
    'A green run over that dist tests old code; run `pnpm build`.',
  ].join('\n');
};

/**
 * Throws an Error carrying `formatDistFreshnessFailure`'s message when any
 * descriptor's output is stale, missing, or contaminated.
 *
 * @param {readonly DistDescriptor[]} descriptors
 * @param {{ readonly relativeTo?: string }} [options]
 */
export const assertFreshDist = (descriptors, options = {}) => {
  const message = formatDistFreshnessFailure(checkDistFreshness(descriptors), options);
  if (message.length > 0) throw new Error(message);
};

/** Read by every package build, relative to a package root: the tsconfig chain the package tsconfigs extend, and the dependency graph. */
const workspaceConfigInputs = Object.freeze(['../../tsconfig.json', '../../tsconfig.base.json', '../../pnpm-lock.yaml']);

/** The Workbench Rsbuild build's inputs, relative to packages/workbench. */
const workbenchInputs = Object.freeze(['src', 'index.html', 'THIRD_PARTY_NOTICES', 'rsbuild.config.ts', 'package.json', 'tsconfig.json']);

/** An Rslib package's inputs, given the tsconfig its config names. */
const rslibInputs = (tsconfig) => Object.freeze(['src', 'rslib.config.ts', 'package.json', tsconfig, ...workspaceConfigInputs]);

/**
 * Every dist the root `pnpm build` script produces, in the order it produces
 * them. Resolved against `workspaceRoot` (default: the working directory).
 *
 * @param {string} [workspaceRoot]
 * @returns {readonly DistDescriptor[]}
 */
export const workspaceBuildOutputs = (workspaceRoot = process.cwd()) => Object.freeze([
  {
    name: 'rsc-markdown-stream',
    root: resolve(workspaceRoot, 'packages/rsc-markdown-stream'),
    inputs: rslibInputs('tsconfig.json'),
    output: 'dist',
  },
  {
    name: '@agent-bundle/runtime',
    root: resolve(workspaceRoot, 'packages/rsc-runtime'),
    inputs: rslibInputs('tsconfig.build.json'),
    output: 'dist',
  },
  {
    name: 'agent-bundle-workbench',
    root: resolve(workspaceRoot, 'packages/workbench'),
    inputs: Object.freeze([...workbenchInputs, ...workspaceConfigInputs]),
    output: 'dist',
  },
  {
    name: 'agent-bundle',
    root: resolve(workspaceRoot, 'packages/agent-bundle'),
    inputs: Object.freeze([
      ...rslibInputs('tsconfig.build.json'),
      ...workbenchInputs.map((input) => `../workbench/${input}`),
    ]),
    output: 'dist',
  },
  {
    name: 'create-agent-bundle',
    root: resolve(workspaceRoot, 'packages/create-agent-bundle'),
    inputs: rslibInputs('tsconfig.build.json'),
    output: 'dist',
  },
]);

/**
 * The rsc-agent-runtime example's prebuilt payload trees, one descriptor per
 * payload directory under its `dist` (see runtimeExamplePayloads in
 * packages/workbench/tests/helpers/runtime-example-payload.ts). Not part of
 * `pnpm build`: the ensure-build there is the only production caller.
 *
 * @param {string} [workspaceRoot]
 * @param {readonly string[]} [payloads]
 * @returns {readonly DistDescriptor[]}
 */
export const runtimeExampleBuildOutputs = (workspaceRoot = process.cwd(), payloads = ['app', 'runtime']) => {
  const root = resolve(workspaceRoot, 'examples/rsc-agent-runtime');
  const inputs = Object.freeze([
    'src',
    'rsbuild.config.ts',
    'package.json',
    'tsconfig.json',
    ...workspaceConfigInputs,
    '../../packages/rsc-runtime/dist',
    '../../packages/rsc-markdown-stream/dist',
  ]);
  return Object.freeze(payloads.map((payload) => ({
    name: `@agent-bundle/rsc-agent-runtime-demo dist/${payload}`,
    root,
    inputs,
    output: `dist/${payload}`,
  })));
};
