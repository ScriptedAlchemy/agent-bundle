const typescriptApiConsumers = new Set([
  '@rspress/plugin-twoslash',
  '@rspress/plugin-typedoc',
  '@shikijs/twoslash',
  'twoslash',
  'typedoc',
]);

function readPackage(pkg) {
  if (pkg.name === 'effect-rstest' && pkg.version === '0.1.0'
    && pkg.peerDependencies?.['@rstest/core'] === '^0.11.11') {
    // Let the pinned helper share the workspace's Rstest 0.12 runner.
    pkg.peerDependencies['@rstest/core'] = '^0.11.11 || ^0.12.0';
  }
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
