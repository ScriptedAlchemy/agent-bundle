import { containsProviderCredential, isCredentialKey } from '../core/credentials.ts';
import { isRecord } from '../core/strict-json.ts';

export { isCredentialKey, redactCredentialText as redactEvalCredentialText } from '../core/credentials.ts';

const structuralEnvironmentKeys = new Set(['codex_home', 'home', 'path']);

export const findCredentialConfiguration = (value: unknown, path = ''): string | undefined => {
  if (typeof value === 'string') {
    return containsProviderCredential(value) ? (path === '' ? 'value' : path) : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findCredentialConfiguration(item, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const keyPath = path === '' ? key : `${path}.${key}`;
      if (isCredentialKey(key)) return keyPath;
      const found = findCredentialConfiguration(item, keyPath);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/** Native eval children reuse signed-in CLI state, never credential-shaped environment variables. */
export const withoutEvalCredentialEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => Object.freeze(Object.fromEntries(
  Object.entries(environment).filter(([name, value]) =>
    structuralEnvironmentKeys.has(name.toLocaleLowerCase('en-US'))
    || (!isCredentialKey(name) && (value === undefined || findCredentialConfiguration(value) === undefined))),
));
