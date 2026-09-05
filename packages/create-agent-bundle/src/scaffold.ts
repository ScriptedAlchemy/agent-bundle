import { Effect, FileSystem, Path } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

import { liftTry } from './effect/lift.ts';
import { defaultTargets, UsageError, type TargetName } from './options.ts';
import { assertLocalFrameworkTarball, validatedRuntimeSpecForFramework } from './framework.ts';

/**
 * The literal project name every template is written under. Templates stay
 * valid, buildable projects as checked in; scaffolding replaces the token in
 * every emitted file.
 */
export const placeholderName = 'my-agent-plugin';

/**
 * The rename table `create-rstack` uses, extended by one entry: npm strips
 * `.gitignore` from published tarballs, so templates check the file in
 * without the dot, and template manifests are checked in as `package_json`
 * so the published scaffolder carries no nested `package.json` (publint
 * flags nested manifest fields as ignored by Node.js). Scaffolding restores
 * the real names.
 */
const renamedEntries: Readonly<Record<string, string>> = {
  gitignore: '.gitignore',
  package_json: 'package.json',
};

const renderTargets = (targets: readonly TargetName[]): string =>
  targets.map((target) => `'${target}'`).join(', ');

/** Derived from the shared default list so a change there cannot silently break the drift check. */
const defaultTargetsLiteral = `targets: [${renderTargets(defaultTargets)}]`;
const installableHostNames: readonly TargetName[] = ['claude', 'codex', 'cursor'];

export interface ScaffoldRequest {
  readonly frameworkSpec: string;
  readonly packageName: string;
  readonly pluginName: string;
  readonly targetDirectory: string;
  readonly targets: readonly TargetName[];
  readonly templateRoot: string;
}

/** `ENOENT` on the platform error channel. */
const isNotFound = (error: PlatformError): boolean => error.reason._tag === 'NotFound';

/** The target directory must be absent, empty, or hold nothing but `.git`. */
export const assertScaffoldTarget = Effect.fnUntraced(function* (
  targetDirectory: string,
  displayName: string,
): Effect.fn.Return<void, PlatformError | UsageError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(targetDirectory).pipe(
    Effect.catch((error) => (isNotFound(error) ? Effect.succeed([]) : Effect.fail(error))),
  );
  if (entries.some((entry) => entry !== '.git')) {
    return yield* Effect.fail(
      new UsageError(`Target directory "${displayName}" is not empty. Choose a new directory or empty it first.`),
    );
  }
});

interface TemplateManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
}

const rewriteManifest = (contents: string, request: ScaffoldRequest, runtimeSpec: string | undefined): string => {
  const manifest = JSON.parse(contents) as TemplateManifest;
  manifest.name = request.packageName;
  for (const section of [manifest.dependencies, manifest.devDependencies]) {
    if (section === undefined) continue;
    for (const [dependency, range] of Object.entries(section)) {
      if (range !== 'workspace:*') continue;
      if (dependency === '@agent-bundle/runtime') {
        if (runtimeSpec === undefined) {
          throw new Error('Template drift: @agent-bundle/runtime was not declared in the root template manifest.');
        }
        section[dependency] = runtimeSpec;
      } else {
        section[dependency] = request.frameworkSpec;
      }
    }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
};

const rewriteConfigTargets = (contents: string, targets: readonly TargetName[]): string => {
  if (!contents.includes(defaultTargetsLiteral)) {
    throw new Error(`Template drift: agent-bundle.config.ts no longer contains \`${defaultTargetsLiteral}\`.`);
  }
  return contents.replace(defaultTargetsLiteral, `targets: [${renderTargets(targets)}]`);
};

/** Installable hosts in the package build's order. */
const installableHosts = (targets: readonly TargetName[]): readonly TargetName[] =>
  installableHostNames.filter((host) => targets.includes(host));

/**
 * Template READMEs are written against the default targets, so their install
 * example names `claude`. The checked-in shape is one shell comment followed
 * by the public install command for Claude, plus the prose sentence naming the
 * generic public install command; both markers are drift-checked.
 */
const readmeInstallExample =
  /^(# after publishing[^\n]*)\nnpx agent-bundle install claude --from node_modules\/\S+\n/mu;
const readmeInstallProse =
  /^Installing the npm package does not mutate any host; run\n`npx agent-bundle install <host> --from node_modules\/<package>` explicitly\.\n/mu;

/**
 * Rewrite a template README's install instructions for the selected targets:
 * one example line per installable host, or — when no `claude`, `codex`, or
 * `cursor` target is selected — an explanation of how to enable one.
 * Templates without an install
 * section (the skills-only template) pass through unchanged.
 */
const rewriteReadmeInstall = (
  contents: string,
  packageName: string,
  targets: readonly TargetName[],
): string => {
  const example = readmeInstallExample.exec(contents);
  const prose = readmeInstallProse.exec(contents);
  if (example === null && prose === null) return contents;
  if (example === null || prose === null) {
    throw new Error('Template drift: README.md install example and prose must both be present or both absent.');
  }
  const hosts = installableHosts(targets);
  // Every group is unconditional in the patterns above.
  const comment = example[1] ?? '';
  if (hosts.length === 0) {
    return contents
      .replace(readmeInstallExample, [
        '# no installable host is selected; add claude, codex, or cursor',
        '# to `targets` in agent-bundle.config.ts before installing',
        '',
      ].join('\n'))
      .replace(readmeInstallProse, [
        'Installing the npm package does not mutate any host. This project selects',
        `no installable host target (${renderTargets(targets)}). Add \`claude\`, \`codex\`,`,
        'or `cursor` to `targets` in `agent-bundle.config.ts` before using',
        '`agent-bundle install`.',
        '',
      ].join('\n'));
  }
  return contents
    .replace(readmeInstallExample, [
      comment,
      ...hosts.map((host) => `npx agent-bundle install ${host} --from node_modules/${packageName}`),
      '',
    ].join('\n'))
    .replace(readmeInstallProse, [
      'Installing the npm package does not mutate any host; run',
      `\`npx agent-bundle install <host> --from node_modules/${packageName}\` explicitly.`,
      `The package contains these selected host targets: ${hosts.map((host) => `\`${host}\``).join(', ')}.`,
      '',
    ].join('\n'));
};

/**
 * Copy one template directory into the target, substituting the placeholder
 * project name in every file, rewriting `package.json` (real package name,
 * `workspace:*` framework placeholder pinned to the resolved spec), the
 * config's target list, and the README's install instructions. Returns the emitted
 * project-relative paths, sorted.
 */
export const scaffold = Effect.fnUntraced(function* (
  request: ScaffoldRequest,
): Effect.fn.Return<readonly string[], PlatformError | UsageError | Error, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestSource = yield* fs.readFileString(path.join(request.templateRoot, 'package_json'));
  const templateManifest = yield* liftTry(() => JSON.parse(manifestSource) as TemplateManifest);
  const usesWorkspaceRuntime = [templateManifest.dependencies, templateManifest.devDependencies]
    .some((section) => section?.['@agent-bundle/runtime'] === 'workspace:*');
  let runtimeSpec: string | undefined;
  if (usesWorkspaceRuntime) {
    runtimeSpec = yield* validatedRuntimeSpecForFramework(request.frameworkSpec, request.targetDirectory);
  } else {
    yield* assertLocalFrameworkTarball(request.frameworkSpec, request.targetDirectory);
  }
  const emitted: string[] = [];
  const copyDirectory: (
    from: string,
    to: string,
    relative: string,
  ) => Effect.Effect<void, PlatformError> = Effect.fnUntraced(function* (from, to, relative) {
    yield* fs.makeDirectory(to, { recursive: true });
    for (const entryName of yield* fs.readDirectory(from)) {
      const name = renamedEntries[entryName] ?? entryName;
      const source = path.join(from, entryName);
      const destination = path.join(to, name);
      const relativePath = relative === '' ? name : `${relative}/${name}`;
      const info = yield* fs.stat(source);
      if (info.type === 'Directory') {
        yield* copyDirectory(source, destination, relativePath);
        continue;
      }
      let contents = (yield* fs.readFileString(source)).replaceAll(placeholderName, request.pluginName);
      // Template drift is a checked-in-template bug: the rewrites throw and
      // the defect crosses the boundary as the same Error it always was.
      if (relativePath === 'package.json') contents = rewriteManifest(contents, request, runtimeSpec);
      if (relativePath === 'agent-bundle.config.ts') contents = rewriteConfigTargets(contents, request.targets);
      if (relativePath === 'README.md') {
        contents = rewriteReadmeInstall(contents, request.packageName, request.targets);
      }
      yield* fs.writeFileString(destination, contents);
      emitted.push(relativePath);
    }
  });
  yield* copyDirectory(request.templateRoot, request.targetDirectory, '');
  // Code-unit order, not localeCompare: the emitted inventory must be stable
  // across machines and locales.
  return emitted.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
});
