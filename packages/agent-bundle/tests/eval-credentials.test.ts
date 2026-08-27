import { expect, it } from '@rstest/core';

import {
  redactEvalCredentialText,
  withoutEvalCredentialEnvironment,
} from '../src/eval/credentials.ts';

const providerToken = 'sk-proj-abcdefghijklmnopqrstuvwxyz';

it('removes credential-named and credential-shaped environment entries without breaking CLI paths', () => {
  const environment = withoutEvalCredentialEnvironment({
    ANTHROPIC_API_KEY: 'configured-secret',
    BUILD_LABEL: providerToken,
    CODEX_HOME: `/tmp/${providerToken}`,
    CUSTOM_CONTROL: 'keep',
    HOME: `/home/${providerToken}`,
    PATH: `/opt/${providerToken}/bin`,
  });

  expect(environment).toEqual({
    CODEX_HOME: `/tmp/${providerToken}`,
    CUSTOM_CONTROL: 'keep',
    HOME: `/home/${providerToken}`,
    PATH: `/opt/${providerToken}/bin`,
  });
  expect(Object.isFrozen(environment)).toBe(true);
});

it('redacts assignments and provider forms while keeping serialized evidence valid', () => {
  const source = JSON.stringify({
    authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
    message: `CLI returned ${providerToken}`,
    token: 'ordinary-but-sensitive',
  });

  const redacted = redactEvalCredentialText(source);

  expect(JSON.parse(redacted)).toEqual({
    authorization: '[REDACTED]',
    message: 'CLI returned [REDACTED]',
    token: '[REDACTED]',
  });
  expect(redactEvalCredentialText(redacted)).toBe(redacted);
  expect(redacted).not.toContain(providerToken);
});

it('leaves ordinary output byte-identical', () => {
  const output = 'tool completed\nstatus=ok\nrequest-id: build-123\n';

  expect(redactEvalCredentialText(output)).toBe(output);
});
