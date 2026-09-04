import { pluginReact } from '@rsbuild/plugin-react';
import { expect, it } from '@rstest/core';

import { frameworkOwnedPluginCollisions, frameworkOwnedRsbuildPlugins } from '../src/build/framework-plugins.ts';

// The registry pins plugin names as literals so the validator never loads a
// bundler plugin to read a string; this is the drift check that keeps each
// literal equal to the name the plugin actually publishes.
it('names every framework-owned plugin by the name its package publishes', () => {
  expect(frameworkOwnedRsbuildPlugins.get(pluginReact().name)).toBe('@rsbuild/plugin-react');
  expect([...frameworkOwnedRsbuildPlugins.keys()]).toEqual(['rsbuild:react']);
});

it('collects colliding plugin names once, through nested arrays and holes', () => {
  expect(frameworkOwnedPluginCollisions([
    pluginReact(),
    false,
    [null, undefined, pluginReact({ fastRefresh: true }), { name: 'consumer:banner', setup: () => undefined }],
  ])).toEqual(['rsbuild:react']);
});

it('reports nothing for absent, non-array, unrelated, or deferred plugins', () => {
  expect(frameworkOwnedPluginCollisions(undefined)).toEqual([]);
  expect(frameworkOwnedPluginCollisions('rsbuild:react')).toEqual([]);
  expect(frameworkOwnedPluginCollisions([{ name: 'consumer:banner', setup: () => undefined }])).toEqual([]);
  // A Promise carries no name until awaited; the validator inspects only what is statically visible.
  expect(frameworkOwnedPluginCollisions([Promise.resolve(pluginReact())])).toEqual([]);
});
