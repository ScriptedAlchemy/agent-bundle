import { expect, it } from '@rstest/core';

import {
  AGENT_NOTICE_DEFAULT_RETENTION,
  NOTICE_SECRET_PATTERN_SOURCES,
  redactSecretText,
} from '@agent-bundle/runtime/notices';

import { noticeRetentionDefaults } from '../src/config/notice-retention.ts';
import {
  CREDENTIAL_TEXT_PATTERN_SOURCES,
  redactCredentialText,
  urlUserinfoPattern,
} from '../src/core/credentials.ts';

/**
 * `@agent-bundle/runtime` is an optional peer of `agent-bundle`, so the notice
 * ledger's secret pass and the compiler's credential redaction cannot share a
 * module. They share a definition instead: these pins fail the build the
 * moment either copy drifts (the same discipline `inspect-state.test.ts`
 * applies to the state budgets).
 */
it('keeps the notice secret patterns byte-identical to the compiler credential patterns', () => {
  expect(NOTICE_SECRET_PATTERN_SOURCES).toEqual(CREDENTIAL_TEXT_PATTERN_SOURCES);
  expect(NOTICE_SECRET_PATTERN_SOURCES.assignment).toBe(CREDENTIAL_TEXT_PATTERN_SOURCES.assignment);
  expect([...NOTICE_SECRET_PATTERN_SOURCES.provider]).toEqual([...CREDENTIAL_TEXT_PATTERN_SOURCES.provider]);
  expect(NOTICE_SECRET_PATTERN_SOURCES.urlUserinfo).toBe(urlUserinfoPattern.source);
});

it('redacts the same corpus the same way on both sides of the peer boundary', () => {
  const corpus = [
    'token=abc123def456 shipped',
    'authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
    JSON.stringify({ api_key: 'xyz', note: 'keep', password: 'p' }),
    'sk-ant-0123456789abcdef0123 and ghp_abcdefghijklmnopqrstuvwxyz1234',
    'plain coordination text about /repo/src/secrets.ts',
    'status=ok request-id: build-123',
  ];
  for (const sample of corpus) {
    expect(redactSecretText(sample)).toBe(redactCredentialText(sample));
  }
  // The notice pass adds the probe's URL userinfo mask on top of the credential pass.
  const url = 'see https://ops:hunter2@vault.example.test/x and wss://u@relay.example.test/';
  expect(redactSecretText(url)).toBe(redactCredentialText(url).replace(urlUserinfoPattern, '$1[REDACTED]@'));
  expect(redactSecretText(url)).toBe('see https://[REDACTED]@vault.example.test/x and wss://[REDACTED]@relay.example.test/');
});

it('keeps the static notice retention defaults equal to the runtime defaults', () => {
  expect(noticeRetentionDefaults).toEqual(AGENT_NOTICE_DEFAULT_RETENTION);
});
