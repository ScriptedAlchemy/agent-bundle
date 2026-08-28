import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const npmCliInvocation = (environment = process.env) => {
  const entrypoint = environment.npm_execpath;
  const command = environment.npm_node_execpath ?? process.execPath;
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('A Node.js executable is required to launch npm.');
  }
  if (typeof entrypoint !== 'string' || entrypoint.length === 0) {
    const nodeDirectory = dirname(command);
    const candidates = [
      join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    const npmCli = candidates.find((candidate) => existsSync(candidate));
    if (npmCli === undefined) throw new Error('The npm CLI could not be resolved from the Node.js installation.');
    return Object.freeze({ args: Object.freeze([npmCli]), command });
  }
  const packageManager = environment.npm_config_user_agent?.split('/')[0];
  const args = packageManager === 'pnpm'
    ? [entrypoint, 'exec', 'npm']
    : [entrypoint];
  return Object.freeze({ args: Object.freeze(args), command });
};
