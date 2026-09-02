import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { UsageError, type TargetName } from './options.ts';
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

const defaultTargetsLiteral = "targets: ['portable', 'codex', 'claude']";
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
  return contents.replace(defaultTargetsLiteral, `targets: [${targets.map((target) => `'${target}'`).join(', ')}]`);
};

/**
 * Copy one template directory into the target, substituting the placeholder
 * project name in every file, rewriting `package.json` (real package name,
 * `workspace:*` framework placeholder pinned to the resolved spec, installer
 * bins omitted when no installable host is selected) and the config's target
 * list. Returns the emitted project-relative paths, sorted.
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
      await writeFile(destination, contents);
      emitted.push(relativePath);
    }
  };
  await copyDirectory(request.templateRoot, request.targetDirectory, '');
  // Code-unit order, not localeCompare: the emitted inventory must be stable
  // across machines and locales.
  return emitted.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
};
