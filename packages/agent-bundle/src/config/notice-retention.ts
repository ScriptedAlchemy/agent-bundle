import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import type {
  AgentBundleConfig,
  NormalizedNoticeRetention,
  NormalizedNoticeRetentionPolicy,
  SourceProvenance,
} from '../core/types.ts';

/**
 * `notices.retention` (#99 acceptance item 7): the retention policy of the
 * notice ledger a stateful project co-mounts beside `src/state.ts`. Validated
 * here as `AB4829`; the runtime re-validates the resolved policy when the
 * generated runtime mounts it.
 */

// Kept independent of the optional runtime peer, like the state budgets in
// `core/state-inspection.ts`; `notice-retention-parity.test.ts` compares these
// with `AGENT_NOTICE_DEFAULT_RETENTION` so the two boundaries cannot drift.
export const noticeRetentionDefaults: NormalizedNoticeRetentionPolicy = Object.freeze({
  maxJournalBytes: 16 * 1024 * 1024,
  maxTerminal: 500,
  terminalTtlMs: 7 * 24 * 60 * 60 * 1000,
});

const durationUnits: Readonly<Record<string, number>> = Object.freeze({
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  ms: 1,
  s: 1000,
});

/**
 * Parses a terminal TTL: a positive integer of milliseconds or a duration
 * literal `<integer><ms|s|m|h|d>` such as `'7d'` or `'90s'`. Returns
 * `undefined` for anything else; the caller reports it.
 */
export const parseNoticeRetentionDuration = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+)(ms|s|m|h|d)$/u.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = durationUnits[match[2] as string];
  if (unit === undefined || !Number.isSafeInteger(amount) || amount < 1) return undefined;
  const milliseconds = amount * unit;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
};

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const retentionKeys = new Set(['maxJournalBytes', 'maxTerminal', 'terminalTtl']);

const diagnostic = (message: string, sourcePath: string, hasState: boolean): Diagnostic => ({
  code: 'AB4829',
  message,
  recovery: hasState
    ? 'Declare `notices.retention` as an object whose `terminalTtl` is a positive integer of milliseconds or a duration such as "7d", "12h", or "30m", and whose `maxTerminal` and `maxJournalBytes` are positive integers; omit a field to keep its default.'
    : 'Add a conventional `src/state.ts` (the notice ledger is co-mounted beside it) or remove `notices` from the config.',
  severity: 'error',
  sourcePath,
});

export interface NormalizedNoticesResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly retention?: NormalizedNoticeRetention;
}

/**
 * Validates and resolves `notices.retention`. A project without a state
 * module has no notice ledger, so declaring a policy there is an error
 * rather than a silent no-op.
 */
export const normalizeNoticeRetention = (
  config: AgentBundleConfig,
  configPath: string,
  hasState: boolean,
): NormalizedNoticesResult => {
  const notices = config.notices;
  if (notices === undefined) return { diagnostics: [] };
  if (!isPlainRecord(notices)) {
    return { diagnostics: [diagnostic('`notices` configuration must be an object.', configPath, hasState)] };
  }
  const unknownKeys = Object.keys(notices).filter((key) => key !== 'retention');
  if (unknownKeys.length > 0) {
    return {
      diagnostics: [diagnostic(
        `\`notices\` configuration has unknown ${unknownKeys.length === 1 ? 'key' : 'keys'} ${unknownKeys.map((key) => JSON.stringify(key)).join(', ')}; only \`retention\` is supported.`,
        configPath,
        hasState,
      )],
    };
  }
  const retention = notices.retention;
  if (retention === undefined) return { diagnostics: [] };
  if (!hasState) {
    return {
      diagnostics: [diagnostic(
        '`notices.retention` configures the notice ledger, which is co-mounted only beside a conventional `src/state.ts`; this project declares no state module.',
        configPath,
        hasState,
      )],
    };
  }
  if (!isPlainRecord(retention)) {
    return { diagnostics: [diagnostic('`notices.retention` must be an object.', configPath, hasState)] };
  }
  const diagnostics: Diagnostic[] = [];
  const declared: { maxJournalBytes?: number; maxTerminal?: number; terminalTtlMs?: number } = {};
  for (const [key, value] of Object.entries(retention)) {
    if (!retentionKeys.has(key)) {
      diagnostics.push(diagnostic(
        `\`notices.retention\` has unknown key ${JSON.stringify(key)}; supported keys are terminalTtl, maxTerminal, and maxJournalBytes.`,
        configPath,
        hasState,
      ));
      continue;
    }
    if (key === 'terminalTtl') {
      const milliseconds = parseNoticeRetentionDuration(value);
      if (milliseconds === undefined) {
        diagnostics.push(diagnostic(
          '`notices.retention.terminalTtl` must be a positive integer of milliseconds or a duration such as "7d", "12h", "30m", or "90s".',
          configPath,
          hasState,
        ));
      } else {
        declared.terminalTtlMs = milliseconds;
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      diagnostics.push(diagnostic(`\`notices.retention.${key}\` must be a positive integer.`, configPath, hasState));
      continue;
    }
    declared[key as 'maxJournalBytes' | 'maxTerminal'] = value;
  }
  if (diagnostics.length > 0) return { diagnostics };
  const provenance: SourceProvenance = { kind: 'config', sourcePath: configPath };
  return {
    diagnostics: [],
    retention: deepFreeze({
      declared,
      provenance,
      resolved: { ...noticeRetentionDefaults, ...declared },
    }),
  };
};
