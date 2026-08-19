export const npmCliInvocation = (environment = process.env) => {
  const entrypoint = environment.npm_execpath;
  if (typeof entrypoint !== 'string' || entrypoint.length === 0) {
    throw new Error('npm_execpath is required; run this command through an npm script.');
  }
  const command = environment.npm_node_execpath ?? process.execPath;
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('A Node.js executable is required to launch npm.');
  }
  return Object.freeze({ args: Object.freeze([entrypoint]), command });
};
