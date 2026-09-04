import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Predicate } from 'effect';

import { DiagnosticError } from '../core/diagnostics.ts';
import { isErrno } from '../core/errors.ts';
import { exists } from '../core/paths.ts';

/**
 * Marketplace-style Cursor installation (#407).
 *
 * Cursor installs marketplace plugins from Git repositories that carry a
 * `.cursor-plugin/marketplace.json` (https://cursor.com/docs/reference/plugins,
 * "Cursor multi-plugin repositories"). Observed 2026-09-03 on Cursor 3.18.25:
 * the only surfaces that register such a repository are the Customize UI
 * ("Add Plugins from Local Repository", a native folder picker) and the
 * Dashboard "Import from Repo" flow for hosted GitHub URLs; `cursor-agent
 * plugin marketplace add` rejects `file://` and filesystem paths, and the
 * installed-plugin registry (`state.vscdb` `cursor.plugins.installedIds.*`)
 * holds server-assigned numeric ids that cannot be minted locally. The
 * installer therefore stages a committed local marketplace repository that
 * those official surfaces accept verbatim and prints the exact UI step.
 */

export interface CursorMarketplaceIdentity {
  readonly bundleRoot: string;
  readonly plugin: string;
  readonly version: string;
}

export interface CursorMarketplaceCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
  ): Promise<{ readonly code: number; readonly stderr: string; readonly stdout: string }>;
}

export interface CursorMarketplaceStageResult {
  readonly commit?: string;
  readonly destination: string;
  readonly marketplace: string;
  readonly nextSteps: readonly string[];
  readonly state: 'already-installed' | 'staged';
}

/** Agent Bundle-owned staging root; never inside Cursor's own `plugins/{local,cache,marketplaces}`. */
export const cursorMarketplaceRoot = (cursorRoot: string): string =>
  join(cursorRoot, 'agent-bundle', 'marketplaces');

export const cursorMarketplaceName = (plugin: string): string => `${plugin}-marketplace`;

export const cursorMarketplacePluginPath = (repoRoot: string, plugin: string): string =>
  join(repoRoot, 'plugins', plugin);

const marketplaceManifestPath = '.cursor-plugin/marketplace.json';

export const cursorMarketplaceNextSteps = (
  repoRoot: string,
  plugin: string,
): readonly string[] => Object.freeze([
  `Open Cursor, then Customize -> Plugins -> "Add Plugins from Local Repository" and select ${repoRoot}.`,
  `Choose "${plugin}" in the imported marketplace and select Install (user scope).`,
  'Verify with `agent-bundle doctor --host cursor`: the plugin must appear under ~/.cursor/plugins/cache once Cursor has installed it.',
  'To publish instead, push this repository to GitHub and run `cursor-agent plugin marketplace add <git-url>`.',
]);

const failure = (code: string, message: string): DiagnosticError =>
  new DiagnosticError([{ code, message, severity: 'error', target: 'cursor' }]);

const readMarketplacePluginVersion = async (pluginDirectory: string): Promise<string | undefined> => {
  try {
    const document = JSON.parse(await readFile(join(pluginDirectory, '.cursor-plugin/plugin.json'), 'utf8')) as unknown;
    return Predicate.isObject(document) && typeof document.version === 'string' ? document.version : undefined;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
};

const readManifestField = async (
  bundleRoot: string,
  key: 'author' | 'description',
): Promise<unknown> => {
  const document = JSON.parse(await readFile(join(bundleRoot, '.cursor-plugin/plugin.json'), 'utf8')) as unknown;
  return Predicate.isObject(document) ? document[key] : undefined;
};

export const cursorMarketplaceManifest = async (
  identity: CursorMarketplaceIdentity,
): Promise<Record<string, unknown>> => {
  const [author, description] = await Promise.all([
    readManifestField(identity.bundleRoot, 'author'),
    readManifestField(identity.bundleRoot, 'description'),
  ]);
  const ownerName = Predicate.isObject(author) && typeof author.name === 'string' ? author.name : identity.plugin;
  return {
    metadata: {
      description: `Agent Bundle local marketplace for ${identity.plugin}@${identity.version}.`,
    },
    name: cursorMarketplaceName(identity.plugin),
    owner: { name: ownerName },
    // Only the pinned marketplace schema's entry fields (name/source/description);
    // the plugin version lives in plugins/<name>/.cursor-plugin/plugin.json.
    plugins: [{
      ...(typeof description === 'string' ? { description } : {}),
      name: identity.plugin,
      source: `plugins/${identity.plugin}`,
    }],
  };
};

const serializeManifest = (manifest: Record<string, unknown>): string => `${JSON.stringify(manifest, null, 2)}\n`;

const stagedManifestMatches = async (repoRoot: string, expected: string): Promise<boolean> => {
  try {
    return await readFile(join(repoRoot, marketplaceManifestPath), 'utf8') === expected;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
};

const runGit = async (
  runner: CursorMarketplaceCommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> => {
  let result: Awaited<ReturnType<CursorMarketplaceCommandRunner['run']>>;
  try {
    result = await runner.run('git', args, { cwd });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw failure(
        'AB7002',
        'git is required for `--mode marketplace` (Cursor imports marketplaces from Git repositories); install git or use `--mode local`.',
      );
    }
    throw error;
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw failure('AB7004', `Cursor marketplace staging failed: git ${args[0]}: ${detail}`);
  }
  return result.stdout.trim();
};

const gitIdentity = Object.freeze([
  '-c', 'user.name=agent-bundle',
  '-c', 'user.email=agent-bundle@localhost',
  '-c', 'commit.gpgsign=false',
]);

/**
 * First `.git` entry (directory or gitlink file) inside a bundle, relative to its root. `git add` records a
 * nested repository as a `160000` gitlink instead of committing its files, so the staged marketplace would
 * import an empty plugin; symlinks are not followed (treeHash refuses them anyway).
 */
const findNestedGit = async (root: string, relative = ''): Promise<string | undefined> => {
  for (const name of (await readdir(join(root, relative))).sort((left, right) => left.localeCompare(right))) {
    const child = relative === '' ? name : join(relative, name);
    if (name === '.git') return child;
    const metadata = await lstat(join(root, child));
    if (!metadata.isSymbolicLink() && metadata.isDirectory()) {
      const nested = await findNestedGit(root, child);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
};

/**
 * Git attributes (`text`, `eol`, `filter`, `ident`, `working-tree-encoding`) rewrite file contents on the way into
 * the index while leaving the working tree — and therefore `git status` — clean, so Cursor would import different
 * bytes than the ones `treeHash` verified. `$GIT_DIR/info/attributes` has the highest precedence and disables them
 * for every path; the commit is then proven byte-for-byte against the staged files via blob ids (SHA-1 object format).
 */
const stagingAttributes = '* -text -eol -filter -ident -working-tree-encoding -export-ignore -export-subst\n';
const stagingGitConfig = Object.freeze(['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false']);

const blobId = (bytes: Buffer): string => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** `<relative '/'-separated path> -> blob id` for every regular file under `root`, skipping the top-level `.git`. */
const blobIndex = async (root: string, relative = ''): Promise<Map<string, string>> => {
  const index = new Map<string, string>();
  for (const name of await readdir(join(root, relative))) {
    if (relative === '' && name === '.git') continue;
    const child = relative === '' ? name : `${relative}/${name}`;
    const metadata = await lstat(join(root, child));
    if (metadata.isDirectory()) {
      for (const [path, id] of await blobIndex(root, child)) index.set(path, id);
    } else if (metadata.isFile()) {
      index.set(child, blobId(await readFile(join(root, child))));
    }
  }
  return index;
};

const parseTree = (listing: string): Map<string, string> => {
  const tree = new Map<string, string>();
  for (const entry of listing.split('\0')) {
    if (entry === '') continue;
    const tab = entry.indexOf('\t');
    const [, , id] = entry.slice(0, tab).split(' ');
    if (id !== undefined) tree.set(entry.slice(tab + 1), id);
  }
  return tree;
};

const assertCommittedBytes = async (
  runner: CursorMarketplaceCommandRunner,
  stage: string,
): Promise<void> => {
  const [expected, committed] = await Promise.all([
    blobIndex(stage),
    runGit(runner, stage, ['ls-tree', '-r', '-z', 'HEAD']).then(parseTree),
  ]);
  const drifted = [...expected].filter(([path, id]) => committed.get(path) !== id).map(([path]) => path);
  const extra = [...committed.keys()].filter((path) => !expected.has(path));
  if (drifted.length > 0 || extra.length > 0) {
    throw failure(
      'AB7004',
      'Cursor marketplace staging failed: the committed tree differs from the staged bundle bytes ' +
        `(${[...drifted, ...extra].map((path) => JSON.stringify(path)).join(', ')}); a Git attribute or filter transformed them.`,
    );
  }
};

export const stageCursorMarketplace = async (options: {
  readonly cursorRoot: string;
  readonly identity: CursorMarketplaceIdentity;
  readonly runner: CursorMarketplaceCommandRunner;
  readonly treeHash: (root: string) => Promise<string>;
}): Promise<CursorMarketplaceStageResult> => {
  const { cursorRoot, identity, runner } = options;
  const root = cursorMarketplaceRoot(cursorRoot);
  const repoRoot = join(root, identity.plugin);
  const pluginDirectory = cursorMarketplacePluginPath(repoRoot, identity.plugin);
  const marketplace = cursorMarketplaceName(identity.plugin);
  const nextSteps = cursorMarketplaceNextSteps(repoRoot, identity.plugin);
  await options.treeHash(identity.bundleRoot);
  if (!(await exists(join(identity.bundleRoot, '.cursor-plugin', 'plugin.json')))) {
    throw failure(
      'AB7003',
      '`--mode marketplace` requires a Cursor Plugin bundle (`.cursor-plugin/plugin.json`): Cursor marketplaces resolve ' +
        '`plugins/<name>/.cursor-plugin/plugin.json`. Agent Plugins (root `plugin.json`) packs install with `--mode local`.',
    );
  }
  const nestedGit = await findNestedGit(identity.bundleRoot);
  if (nestedGit !== undefined) {
    throw failure(
      'AB7003',
      `\`--mode marketplace\` refuses bundle-internal Git metadata at ${JSON.stringify(nestedGit)}: git would record it as an ` +
        'empty gitlink and Cursor would import a plugin without files. Stage from a built bundle directory without `.git`, or use `--mode local`.',
    );
  }
  const manifest = serializeManifest(await cursorMarketplaceManifest(identity));
  await mkdir(root, { recursive: true });
  if (await exists(repoRoot)) {
    const currentVersion = await readMarketplacePluginVersion(pluginDirectory);
    if (currentVersion !== undefined && currentVersion !== identity.version) {
      throw failure(
        'AB7005',
        `Refusing version collision at ${repoRoot}: found ${currentVersion}, requested ${identity.version}.`,
      );
    }
    if (
      await exists(pluginDirectory) &&
      await exists(join(repoRoot, '.git')) &&
      await options.treeHash(identity.bundleRoot) === await options.treeHash(pluginDirectory)
    ) {
      if (!(await stagedManifestMatches(repoRoot, manifest))) {
        throw failure(
          'AB7005',
          `Refusing content collision at ${repoRoot}: ${marketplaceManifestPath} differs from the generated marketplace manifest; remove the staged repository and rerun.`,
        );
      }
      // Cursor imports the commit, not the working tree: the verified bytes must be what HEAD records.
      const dirty = await runGit(runner, repoRoot, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']);
      if (dirty !== '') {
        throw failure(
          'AB7005',
          `Refusing content collision at ${repoRoot}: the working tree differs from the committed HEAD Cursor would import; remove the staged repository and rerun.`,
        );
      }
      const commit = await runGit(runner, repoRoot, ['rev-parse', 'HEAD']);
      return { ...(commit === '' ? {} : { commit }), destination: repoRoot, marketplace, nextSteps, state: 'already-installed' };
    }
    throw failure('AB7005', `Refusing content collision at ${repoRoot}.`);
  }
  const stageParent = await mkdtemp(join(root, `.${identity.plugin}.stage-`));
  const stage = join(stageParent, 'repo');
  try {
    await mkdir(join(stage, '.cursor-plugin'), { recursive: true });
    await cp(identity.bundleRoot, cursorMarketplacePluginPath(stage, identity.plugin), {
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true,
    });
    await writeFile(join(stage, marketplaceManifestPath), manifest);
    await options.treeHash(cursorMarketplacePluginPath(stage, identity.plugin));
    await runGit(runner, stage, ['init', '-q', '--object-format=sha1']);
    await mkdir(join(stage, '.git', 'info'), { recursive: true });
    await writeFile(join(stage, '.git', 'info', 'attributes'), stagingAttributes);
    // --force: bundle-internal .gitignore or global excludes must not drop files Cursor needs from the commit.
    await runGit(runner, stage, [...stagingGitConfig, 'add', '--all', '--force']);
    await runGit(runner, stage, [...gitIdentity, 'commit', '-q', '-m', `${identity.plugin}@${identity.version}`]);
    await assertCommittedBytes(runner, stage);
    const commit = await runGit(runner, stage, ['rev-parse', 'HEAD']);
    await rename(stage, repoRoot);
    return { ...(commit === '' ? {} : { commit }), destination: repoRoot, marketplace, nextSteps, state: 'staged' };
  } finally {
    await rm(stageParent, { force: true, recursive: true });
  }
};
