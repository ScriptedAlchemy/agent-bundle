/**
 * Packs one workspace package the way a release ships it: `changeset publish`
 * runs `pnpm publish`, whose packer rewrites `workspace:` ranges to the packed
 * sibling's version (`@agent-bundle/runtime`'s `rsc-markdown-stream:
 * workspace:^` becomes `^<version>`), applies `publishConfig` overrides, and
 * drops the prepublish scripts. `npm pack` would leave `workspace:^` in the
 * tarball's manifest for a consumer's npm to refuse.
 *
 * `pnpm pack --json` prints one object — `name`, `version`, `filename`, and
 * `files: [{ path }]` — with `filename` absolute; it is returned as the bare
 * file name so callers join it to their destination like an `npm pack` entry.
 */
import { execFile as executeFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export const pnpmPackOutputFromJson = (stdout) => {
  const parsed = JSON.parse(stdout);
  if (!isRecord(parsed) || typeof parsed.filename !== 'string' || !Array.isArray(parsed.files)) {
    throw new TypeError('pnpm pack --json returned no pack entry; expected one object with filename and files.');
  }
  return { ...parsed, filename: basename(parsed.filename) };
};

export const pnpmPack = async ({ cwd, destination, env }) => {
  const { stdout } = await execFile('pnpm', ['pack', '--json', '--pack-destination', destination], { cwd, env });
  const packOutput = pnpmPackOutputFromJson(stdout);
  return { packOutput, tarball: join(destination, packOutput.filename) };
};
