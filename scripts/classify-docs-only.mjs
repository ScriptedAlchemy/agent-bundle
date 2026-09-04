import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * Hosted CI docs-only allowlist. Nested markdown outside docs/, website/,
 * and agent-patterns/ is code: examples and packages ship compiled SKILL.md
 * artifacts, and package markdown is part of npm pack audits.
 *
 * website/ is the Rspress documentation site. Its own workflow (docs.yml)
 * typechecks and builds it on every PR, so website-only PRs skip the heavy
 * package jobs here without losing validation.
 *
 * Globs match the workflow `case` that this script replaced: `*` matches
 * slashes, so `.changeset/*.md` includes nested changeset markdown.
 */
export const isDocsOnlyPath = (filePath) => {
  if (
    filePath.startsWith('docs/')
    || filePath.startsWith('agent-patterns/')
    || filePath.startsWith('website/')
  ) {
    return true;
  }
  if (filePath.startsWith('.changeset/') && filePath.endsWith('.md')) {
    return true;
  }
  if (filePath.includes('/')) {
    return false;
  }
  return filePath.endsWith('.md');
};

export const parseGhFilesListing = (text) => text
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => {
    const [filename = '', previousFilename = ''] = line.split('\t');
    return { filename, previousFilename };
  });

export const classifyDocsOnlyListing = ({
  changedFilesCount,
  entries,
  listingOk,
}) => {
  if (!listingOk) {
    return { docsOnly: false, reason: 'listing-error' };
  }
  if (typeof changedFilesCount !== 'string' || !/^[0-9]+$/u.test(changedFilesCount)) {
    return { docsOnly: false, reason: 'invalid-count' };
  }
  if (entries.length === 0) {
    return { docsOnly: false, reason: 'empty-listing' };
  }
  if (entries.length !== Number(changedFilesCount)) {
    return { docsOnly: false, reason: 'truncated-listing' };
  }

  const paths = [];
  for (const entry of entries) {
    paths.push(entry.filename);
    if (entry.previousFilename.length > 0) {
      paths.push(entry.previousFilename);
    }
  }

  for (const path of paths) {
    if (!isDocsOnlyPath(path)) {
      return { docsOnly: false, path, reason: 'non-docs-path' };
    }
  }
  return { docsOnly: true, reason: 'docs-only' };
};

const parseArgs = (argv) => {
  const options = {
    changedFilesCount: undefined,
    listing: undefined,
    listingError: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--listing-error') {
      options.listingError = true;
      continue;
    }
    if (argument === '--changed-files-count') {
      options.changedFilesCount = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--listing') {
      options.listing = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
};

export const runClassify = async ({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) => {
  const options = parseArgs(argv);
  const listingText = options.listing === undefined
    ? ''
    : await readFile(options.listing, 'utf8');
  const result = classifyDocsOnlyListing({
    changedFilesCount: options.changedFilesCount,
    entries: parseGhFilesListing(listingText),
    listingOk: !options.listingError,
  });

  const githubOutput = env.GITHUB_OUTPUT;
  if (githubOutput !== undefined && githubOutput.length > 0) {
    await appendFile(githubOutput, `docs_only=${String(result.docsOnly)}\n`);
  }

  const detail = result.path === undefined ? result.reason : `${result.reason} ${result.path}`;
  process.stdout.write(`${detail}\n`);
  return result;
};

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await runClassify();
}
