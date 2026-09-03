import { describe, expect, it } from '@rstest/core';

import {
  normalizeNoticeRetention,
  noticeRetentionDefaults,
  parseNoticeRetentionDuration,
} from '../src/config/notice-retention.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';

const config = (notices: unknown): AgentBundleConfig => ({
  notices,
  plugin: { name: 'fixture', version: '1.0.0' },
} as AgentBundleConfig);

describe('notices.retention config (AB4833)', () => {
  it('parses durations as positive integers of milliseconds or unit literals', () => {
    expect(parseNoticeRetentionDuration(1)).toBe(1);
    expect(parseNoticeRetentionDuration(86_400_000)).toBe(86_400_000);
    expect(parseNoticeRetentionDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseNoticeRetentionDuration(' 12h ')).toBe(12 * 60 * 60 * 1000);
    expect(parseNoticeRetentionDuration('30m')).toBe(30 * 60 * 1000);
    expect(parseNoticeRetentionDuration('90s')).toBe(90_000);
    expect(parseNoticeRetentionDuration('250ms')).toBe(250);
    for (const invalid of [0, -1, 1.5, Number.NaN, '', '0d', '7', '7 d', '1w', 'seven days', '1e3', null, true, {}]) {
      expect(parseNoticeRetentionDuration(invalid)).toBeUndefined();
    }
  });

  it('resolves declared fields over the runtime defaults with config provenance', () => {
    const result = normalizeNoticeRetention(
      config({ retention: { maxTerminal: 25, terminalTtl: '2d' } }),
      '/project/agent-bundle.config.ts',
      true,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.retention).toEqual({
      declared: { maxTerminal: 25, terminalTtlMs: 2 * 24 * 60 * 60 * 1000 },
      provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
      resolved: { ...noticeRetentionDefaults, maxTerminal: 25, terminalTtlMs: 2 * 24 * 60 * 60 * 1000 },
    });
    expect(Object.isFrozen(result.retention)).toBe(true);
    expect(Object.isFrozen(result.retention?.resolved)).toBe(true);
    // No config at all, or `notices: {}`, means the runtime defaults and nothing to report.
    expect(normalizeNoticeRetention({ plugin: { name: 'f', version: '1.0.0' } }, '/p/c.ts', true)).toEqual({ diagnostics: [] });
    expect(normalizeNoticeRetention(config({}), '/p/c.ts', false)).toEqual({ diagnostics: [] });
  });

  it('reports malformed shapes, unknown keys, and non-positive values as AB4833 errors', () => {
    const cases: readonly [unknown, RegExp][] = [
      ['nope', /`notices` configuration must be an object/u],
      [{ retentoin: {} }, /unknown key "retentoin"/u],
      [{ retention: 5 }, /`notices.retention` must be an object/u],
      [{ retention: { maxTerminal: 0 } }, /maxTerminal` must be a positive integer/u],
      [{ retention: { maxJournalBytes: 1.5 } }, /maxJournalBytes` must be a positive integer/u],
      [{ retention: { terminalTtl: '1w' } }, /terminalTtl` must be a positive integer of milliseconds or a duration/u],
      [{ retention: { ttl: '7d' } }, /unknown key "ttl"/u],
    ];
    for (const [notices, message] of cases) {
      const result = normalizeNoticeRetention(config(notices), '/project/agent-bundle.config.ts', true);
      expect(result.retention).toBeUndefined();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        code: 'AB4833',
        message: expect.stringMatching(message),
        severity: 'error',
        sourcePath: '/project/agent-bundle.config.ts',
      });
    }
    // Several bad fields are reported together, once each.
    const many = normalizeNoticeRetention(config({ retention: { maxTerminal: -1, terminalTtl: 'x' } }), '/p/c.ts', true);
    expect(many.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['AB4833', 'AB4833']);
  });

  it('refuses a retention policy for a project without a state module', () => {
    const result = normalizeNoticeRetention(config({ retention: { maxTerminal: 3 } }), '/p/agent-bundle.config.ts', false);
    expect(result.retention).toBeUndefined();
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'AB4833',
      message: expect.stringContaining('declares no state module'),
      recovery: expect.stringContaining('src/state.ts'),
    })]);
  });
});
