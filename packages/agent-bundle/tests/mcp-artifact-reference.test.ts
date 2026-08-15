import { posix, win32 } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  classifyMcpArtifactArgument,
  type McpArtifactPathApi,
} from '../src/services/mcp-artifact-reference.ts';

const pathApi = (path: typeof posix | typeof win32, sep: McpArtifactPathApi['sep']): McpArtifactPathApi => ({
  isAbsolute: path.isAbsolute,
  normalize: path.normalize,
  relative: path.relative,
  resolve: path.resolve,
  sep,
});

const posixPath = pathApi(posix, '/');
const windowsPath = pathApi(win32, '\\');

it.each([
  ['POSIX local slash path', posixPath, { artifactRoot: '/artifact', targetRoot: '/artifact/target' }, './mcp/server.mjs', { path: 'mcp/server.mjs', status: 'artifact-local' }],
  ['POSIX normalized backslash path', posixPath, { artifactRoot: '/artifact', targetRoot: '/artifact/target' }, 'scripts\\missing.mjs', { path: 'scripts/missing.mjs', status: 'artifact-local' }],
  ['POSIX Windows drive escape', posixPath, { artifactRoot: '/artifact', targetRoot: '/artifact/target' }, 'C:\\artifact\\target\\mcp\\server.mjs', { status: 'escaped' }],
  ['POSIX drive-relative escape', posixPath, { artifactRoot: '/artifact', targetRoot: '/artifact/target' }, 'C:relative\\server.mjs', { status: 'escaped' }],
  ['POSIX local file URL', posixPath, { artifactRoot: '/artifact', targetRoot: '/artifact/target' }, 'file:///artifact/target/mcp/with%20space.mjs', { path: 'mcp/with space.mjs', status: 'artifact-local' }],
  ['POSIX local file URL assignment', posixPath, { artifactRoot: '/artifact', targetRoot: '/artifact/target' }, '--config=file:///artifact/target/mcp/with%20space.mjs', { path: 'mcp/with space.mjs', status: 'artifact-local' }],
  ['POSIX external file URL', posixPath, { artifactRoot: '/artifact', targetRoot: '/artifact/target' }, 'file:///outside/server.mjs', { status: 'escaped' }],
  ['POSIX HTTPS external argument', posixPath, { artifactRoot: '/artifact', targetRoot: '/artifact/target' }, 'https://mcp.example.test/resource?query=value#fragment', { status: 'external' }],
  ['POSIX HTTPS assignment', posixPath, { artifactRoot: '/artifact', targetRoot: '/artifact/target' }, '--url=https://mcp.example.test/resource', { status: 'external' }],
  ['POSIX unknown scheme', posixPath, { artifactRoot: '/artifact', targetRoot: '/artifact/target' }, 'ssh://mcp.example.test/server', { status: 'escaped' }],
  ['Windows drive-local path', windowsPath, { artifactRoot: 'C:\\artifact', targetRoot: 'C:\\artifact\\target' }, 'C:\\artifact\\target\\mcp\\server.mjs', { path: 'mcp/server.mjs', status: 'artifact-local' }],
  ['Windows drive-cross escape', windowsPath, { artifactRoot: 'C:\\artifact', targetRoot: 'C:\\artifact\\target' }, 'D:\\artifact\\target\\mcp\\server.mjs', { status: 'escaped' }],
  ['Windows drive-relative escape', windowsPath, { artifactRoot: 'C:\\artifact', targetRoot: 'C:\\artifact\\target' }, 'C:relative\\server.mjs', { status: 'escaped' }],
  ['Windows UNC-local path', windowsPath, { artifactRoot: '\\\\server\\share\\artifact', targetRoot: '\\\\server\\share\\artifact\\target' }, '\\\\server\\share\\artifact\\target\\mcp\\server.mjs', { path: 'mcp/server.mjs', status: 'artifact-local' }],
  ['Windows UNC escape', windowsPath, { artifactRoot: '\\\\server\\share\\artifact', targetRoot: '\\\\server\\share\\artifact\\target' }, '\\\\server\\share\\outside\\server.mjs', { status: 'escaped' }],
  ['Windows local file URL', windowsPath, { artifactRoot: 'C:\\artifact', targetRoot: 'C:\\artifact\\target' }, 'file:///C:/artifact/target/mcp/with%20space.mjs', { path: 'mcp/with space.mjs', status: 'artifact-local' }],
])('classifies %s with injected path semantics', (_name, path, roots, value, expected) => {
  expect(classifyMcpArtifactArgument({ path, roots, value })).toEqual(expected);
});
