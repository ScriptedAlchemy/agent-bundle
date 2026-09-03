import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
const installerTargetNames: readonly TargetName[] = ['claude', 'codex', 'cursor', 'plugin'];

export interface ScaffoldRequest {
  readonly frameworkSpec: string;
  readonly packageName: string;
  readonly pluginName: string;
  readonly targetDirectory: string;
  readonly targets: readonly TargetName[];
  readonly templateRoot: string;
}

/** The target directory must be absent, empty, or hold nothing but `.git`. */
export const assertScaffoldTarget = async (targetDirectory: string, displayName: string): Promise<void> => {
  let entries: readonly string[];
  try {
    entries = await readdir(targetDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entries.some((entry) => entry !== '.git')) {
    throw new UsageError(`Target directory "${displayName}" is not empty. Choose a new directory or empty it first.`);
  }
};

interface TemplateManifest {
  bin?: Record<string, string>;
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
  if (
    manifest.bin !== undefined &&
    !request.targets.some((target) => installerTargetNames.includes(target))
  ) {
    const suffixedInstallerName = `${request.pluginName}-install`;
    const installerName = Object.hasOwn(manifest.bin, suffixedInstallerName)
      ? suffixedInstallerName
      : request.pluginName;
    delete manifest.bin[installerName];
    if (Object.keys(manifest.bin).length === 0) delete manifest.bin;
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
};

const rewriteConfigTargets = (contents: string, targets: readonly TargetName[]): string => {
  if (!contents.includes(defaultTargetsLiteral)) {
    throw new Error(`Template drift: agent-bundle.config.ts no longer contains \`${defaultTargetsLiteral}\`.`);
  }
  return contents.replace(defaultTargetsLiteral, `targets: [${renderTargets(targets)}]`);
};

/** The hosts the generated installer bin accepts, in the package build's order. */
const installableHosts = (targets: readonly TargetName[]): readonly TargetName[] =>
  (['claude', 'codex', 'cursor'] as const)
    .filter((host) => targets.some((target) => target === host || target === 'plugin'));

/**
 * Template READMEs are written against the default targets, so their install
 * example names `claude`. The checked-in shape is one shell comment followed
 * by `npx <installer-bin> install claude`, plus the prose sentence naming the
 * `<installer-bin> install <host>` command; both markers are drift-checked.
 */
const readmeInstallExample = /^(# after publishing[^\n]*)\n(npx \S+) install claude\n/mu;
const readmeInstallProse = /^Installing the npm package does not mutate any host; run the generated\n`(\S+) install <host>` command explicitly\.\n/mu;

/**
 * Rewrite a template README's install instructions for the selected targets:
 * one example line per installable host, or — when no `claude`, `codex`,
 * `cursor`, or `plugin` target is selected and therefore no installer bin is
 * generated — an explanation of how to get one. Templates without an install
 * section (the skills-only template) pass through unchanged.
 */
const rewriteReadmeInstall = (contents: string, targets: readonly TargetName[]): string => {
  const example = readmeInstallExample.exec(contents);
  const prose = readmeInstallProse.exec(contents);
  if (example === null && prose === null) return contents;
  if (example === null || prose === null) {
    throw new Error('Template drift: README.md install example and prose must both be present or both absent.');
  }
  const hosts = installableHosts(targets);
  // Every group is unconditional in the patterns above.
  const comment = example[1] ?? '';
  const exampleBin = example[2] ?? '';
  const proseBin = prose[1] ?? '';
  if (hosts.length === 0) {
    // The scaffold also dropped this bin mapping from package.json, and the
    // build never restores manifest entries, so re-enabling installers needs
    // both edits: the config target and the bin entry the npx command resolves.
    const binEntry = `"${proseBin}": "./dist/bin/${proseBin}.js"`;
    return contents
      .replace(readmeInstallExample, [
        '# no installer bin is generated for these targets; add claude, codex, or cursor',
        '# to `targets` in agent-bundle.config.ts and restore the package.json bin entry',
        `# ${binEntry} to get one`,
        '',
      ].join('\n'))
      .replace(readmeInstallProse, [
        'Installing the npm package does not mutate any host. This project selects',
        `no installable host target (${renderTargets(targets)}), so no \`${proseBin} install\``,
        'command is generated and its `bin` entry was dropped from `package.json`. To',
        'generate one, add `claude`, `codex`, or `cursor` to `targets` in',
        `\`agent-bundle.config.ts\` and restore \`${binEntry}\` under \`bin\` in`,
        '`package.json`; the build emits the installer file but never edits the manifest.',
        '',
      ].join('\n'));
  }
  return contents
    .replace(readmeInstallExample, [
      comment,
      ...hosts.map((host) => `${exampleBin} install ${host}`),
      '',
    ].join('\n'))
    .replace(readmeInstallProse, [
      'Installing the npm package does not mutate any host; run the generated',
      `\`${proseBin} install <host>\` command explicitly. The installer accepts the`,
      `selected host targets only: ${hosts.map((host) => `\`${host}\``).join(', ')}.`,
      '',
    ].join('\n'));
};

/**
 * Copy one template directory into the target, substituting the placeholder
 * project name in every file, rewriting `package.json` (real package name,
 * `workspace:*` framework placeholder pinned to the resolved spec, installer
 * bins omitted when no installable host is selected), the config's target
 * list, and the README's install instructions. Returns the emitted
 * project-relative paths, sorted.
 */
export const scaffold = async (request: ScaffoldRequest): Promise<readonly string[]> => {
  const templateManifest = JSON.parse(
    await readFile(join(request.templateRoot, 'package_json'), 'utf8'),
  ) as TemplateManifest;
  const usesWorkspaceRuntime = [templateManifest.dependencies, templateManifest.devDependencies]
    .some((section) => section?.['@agent-bundle/runtime'] === 'workspace:*');
  let runtimeSpec: string | undefined;
  if (usesWorkspaceRuntime) {
    runtimeSpec = await validatedRuntimeSpecForFramework(request.frameworkSpec, request.targetDirectory);
  } else {
    await assertLocalFrameworkTarball(request.frameworkSpec, request.targetDirectory);
  }
  const emitted: string[] = [];
  const copyDirectory = async (from: string, to: string, relative: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const name = renamedEntries[entry.name] ?? entry.name;
      const source = join(from, entry.name);
      const destination = join(to, name);
      const relativePath = relative === '' ? name : `${relative}/${name}`;
      if (entry.isDirectory()) {
        await copyDirectory(source, destination, relativePath);
        continue;
      }
      let contents = (await readFile(source, 'utf8')).replaceAll(placeholderName, request.pluginName);
      if (relativePath === 'package.json') contents = rewriteManifest(contents, request, runtimeSpec);
      if (relativePath === 'agent-bundle.config.ts') contents = rewriteConfigTargets(contents, request.targets);
      if (relativePath === 'README.md') contents = rewriteReadmeInstall(contents, request.targets);
      await writeFile(destination, contents);
      emitted.push(relativePath);
    }
  };
  await copyDirectory(request.templateRoot, request.targetDirectory, '');
  // Code-unit order, not localeCompare: the emitted inventory must be stable
  // across machines and locales.
  return emitted.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
};
