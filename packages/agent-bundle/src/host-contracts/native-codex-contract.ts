import { dirname } from 'node:path';

import { Effect, FileSystem } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

import { runWithPlatform } from '../effect/platform.ts';
import { isCredentialKey, isProviderEndpointKey } from '../core/credentials.ts';
import { withoutEnvironmentKeysMatching } from './native-host-spine.ts';

// Shared union credential classifier plus provider endpoint routing, so the
// hermetic child cannot see credential material or an env-configured endpoint.
const providerApiKeyName = (name: string): boolean =>
  isCredentialKey(name) || isProviderEndpointKey(name);

export const withoutProviderApiKeys = (environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv =>
  withoutEnvironmentKeysMatching(environment, providerApiKeyName);

/** Copies `auth.json` bytes and permission bits into a temporary home; nothing inspects the contents. */
export const copyOpaqueCodexAuthStateProgram = Effect.fnUntraced(function* (
  source: string,
  destination: string,
): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const sourceStat = yield* fs.stat(source);
  yield* fs.makeDirectory(dirname(destination), { recursive: true });
  yield* fs.copyFile(source, destination);
  yield* fs.chmod(destination, sourceStat.mode & 0o777);
});

export const copyOpaqueCodexAuthState = (source: string, destination: string): Promise<void> =>
  runWithPlatform(copyOpaqueCodexAuthStateProgram(source, destination));
