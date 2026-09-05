import { readFile } from 'node:fs/promises';

import { describe, expect, it } from '@rstest/core';
import flightManifest from 'react-server-dom-rspack/package.json' with { type: 'json' };

import runtimeManifest from '../package.json' with { type: 'json' };

const caretRange = /^\^(\d+)\.(\d+)\.(\d+)$/u;
const exactVersion = /^(\d+)\.(\d+)\.(\d+)$/u;

type Version = readonly [major: number, minor: number, patch: number];

const versionOf = (pattern: RegExp, text: string): Version => {
  const match = pattern.exec(text);
  expect(match, text).not.toBeNull();
  const [, major, minor, patch] = match as RegExpExecArray;
  return [Number(major), Number(minor), Number(patch)];
};

const atLeast = ([major, minor, patch]: Version, [floorMajor, floorMinor, floorPatch]: Version): boolean =>
  major === floorMajor && (minor > floorMinor || (minor === floorMinor && patch >= floorPatch));

/**
 * `@agent-bundle/runtime` hands React to the host. The peers are caret
 * ranges, not exact pins (#566): React's own contract is that `react` and
 * `react-dom` match each other exactly, which react-dom enforces at runtime
 * whatever range a library declares, while the runtime itself only calls
 * stable React 19 APIs (`createElement`, `Children`, `isValidElement`). What
 * bounds the range is the Flight binding: `react-server-dom-rspack` reads
 * React's server internals, so the runtime must never admit a React that
 * binding rejects, and the floor is the minor the workspace suite proves.
 */
describe('@agent-bundle/runtime manifest', () => {
  const peers = runtimeManifest.peerDependencies;
  const pinnedReact = runtimeManifest.devDependencies.react;

  it('declares react and react-dom as one caret range', () => {
    expect(peers.react).toMatch(caretRange);
    expect(peers['react-dom']).toBe(peers.react);
  });

  it('never admits a React the Flight binding rejects', () => {
    for (const name of ['react', 'react-dom'] as const) {
      expect(flightManifest.peerDependencies[name], name).toMatch(caretRange);
      expect(
        atLeast(versionOf(caretRange, peers[name]), versionOf(caretRange, flightManifest.peerDependencies[name])),
        `${name}: ${peers[name]} is not within react-server-dom-rspack's ${flightManifest.peerDependencies[name]}`,
      ).toBe(true);
    }
  });

  it('is proven against a React inside the range', () => {
    expect(runtimeManifest.devDependencies['react-dom']).toBe(pinnedReact);
    expect(atLeast(versionOf(exactVersion, pinnedReact), versionOf(caretRange, peers.react))).toBe(true);
  });

  it('depends on the workspace rsc-markdown-stream, which the packer rewrites to a caret', () => {
    expect(runtimeManifest.dependencies['rsc-markdown-stream']).toBe('workspace:^');
  });

  it('documents the React contract the manifest declares', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(`React/React DOM \`${peers.react}\``);
    expect(readme).not.toMatch(/exact compatibility pins/u);
  });
});
