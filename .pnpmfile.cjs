const typescriptApiConsumers = new Set([
  '@rspress/plugin-twoslash',
  '@rspress/plugin-typedoc',
  '@shikijs/twoslash',
  'twoslash',
  'typedoc',
]);

function readPackage(pkg) {
  if (!typescriptApiConsumers.has(pkg.name)) {
    return pkg;
  }
  // Keep JavaScript-API consumers isolated from the website's native TypeScript 7 peer.
  pkg.dependencies ??= {};
  pkg.dependencies.typescript = pkg.peerDependencies?.typescript ?? '*';
  if (pkg.peerDependencies) {
    delete pkg.peerDependencies.typescript;
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
