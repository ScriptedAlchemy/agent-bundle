import { provenanceIdentifierPattern } from '../eval/provenance.ts';
import { redactEvalCredentialText } from '../eval/credentials.ts';
import type { EvalTrialRecord, EvalTrialWriter } from '../eval/run-store.ts';
import type { WorkspaceDiff } from '../eval/workspace-diff.ts';
import type { PlaygroundEventInput, PlaygroundJsonObject } from '../services/playground-service.ts';
import { safeDevWireText } from './dev-log-service.ts';
import type { NativePlaygroundProgress } from './native-playground-types.ts';

/** Native raw trial artifacts have no durable backing store; durable Playground events are the only exposed evidence. */
export class DiscardingTrialWriter implements EvalTrialWriter {
  async writeArtifactFile(relativePath: string, _contents: string): Promise<string> {
    return relativePath;
  }

  async writeTrial(trial: EvalTrialRecord): Promise<EvalTrialRecord> {
    return Object.freeze({ ...trial });
  }
}

export const hardcodedProgress = (phase: NativePlaygroundProgress): PlaygroundEventInput => Object.freeze({
  kind: `native.${phase}`,
  raw: Object.freeze({ phase }),
  source: 'host-preflight',
  summary: phase === 'preflight'
    ? 'Native host preflight completed.'
    : phase === 'fixture.materialized'
      ? 'Native fixture materialized.'
      : phase === 'codex.setup'
        ? 'Codex temporary environment setup started.'
        : 'Native host process started.',
});

const safeNativeProvenanceText = (value: string, projectRoot: string): string => {
  const redacted = safeDevWireText(redactEvalCredentialText(value), projectRoot);
  return provenanceIdentifierPattern.test(redacted) ? redacted : '[REDACTED]';
};

const nativeTrialProvenance = (trial: EvalTrialRecord, projectRoot: string): PlaygroundJsonObject => {
  const provenance = trial.provenance;
  const semanticGrader = provenance?.semanticGrader;
  return Object.freeze({
    ...(provenance?.hostCliVersion === undefined
      ? {}
      : { hostCliVersion: safeNativeProvenanceText(provenance.hostCliVersion, projectRoot) }),
    ...(provenance === undefined
      ? {}
      : {
        invocation: Object.freeze({
          mode: provenance.invocation.mode,
          ...(provenance.invocation.skill === undefined
            ? {}
            : { skill: safeNativeProvenanceText(provenance.invocation.skill, projectRoot) }),
        }),
        ...(semanticGrader === undefined
          ? {}
          : { semanticGrader: semanticGrader === null
            ? null
            : 'state' in semanticGrader
              ? Object.freeze({ state: 'unrecorded' })
              : Object.freeze({
                id: safeNativeProvenanceText(semanticGrader.id, projectRoot),
                model: safeNativeProvenanceText(semanticGrader.model, projectRoot),
              }) }),
      }),
    model: safeNativeProvenanceText(trial.model, projectRoot),
  });
};

/** A completed response is user-facing evidence, but never a raw host stream. */
export const safeResponse = (value: string): string => redactEvalCredentialText(value)
  .replace(/(?:[A-Za-z]:)?(?:[/\\][^\s`'"<>|]*)+/gu, '[path]')
  .replaceAll('\0', '');

export const workspaceEvidence = (diff: WorkspaceDiff): PlaygroundJsonObject => Object.freeze({
  changes: Object.freeze(diff.changes.map((change) => Object.freeze({
    digest: change.digest,
    id: change.id,
    kind: change.kind,
  }))),
  ...(diff.truncated === true ? { truncated: true } : {}),
});

export const normalizedTrialEvents = (
  trial: EvalTrialRecord,
  diff: WorkspaceDiff | undefined,
  hookEvents: readonly string[],
  projectRoot: string,
  response: string | undefined,
): readonly PlaygroundEventInput[] => Object.freeze([
  Object.freeze({
    kind: 'native.provenance',
    raw: nativeTrialProvenance(trial, projectRoot),
    source: 'host-preflight',
    summary: 'Recorded safe native model and host provenance.',
  }),
  Object.freeze({
    kind: 'native.activation',
    raw: Object.freeze({
      activated: Object.freeze(trial.evidence.skillActivation.activated.map((name) => safeDevWireText(name, projectRoot))),
      level: trial.evidence.skillActivation.level,
    }),
    source: 'skill-evidence',
    summary: 'Recorded normalized native Skill activation evidence.',
  }),
  Object.freeze({
    kind: 'native.mcp',
    raw: Object.freeze({
      calls: Object.freeze(trial.evidence.mcp.calls.map((call) => Object.freeze({
        server: safeDevWireText(call.server, projectRoot),
        tool: safeDevWireText(call.tool, projectRoot),
      }))),
      level: trial.evidence.mcp.level,
    }),
    source: 'mcp',
    summary: 'Recorded normalized native MCP evidence.',
  }),
  Object.freeze({
    kind: 'native.assertions',
    raw: Object.freeze({
      assertions: Object.freeze(trial.assertions.map((assertion) => Object.freeze({
        evidence: assertion.evidence,
        id: safeDevWireText(assertion.assertionId, projectRoot),
        kind: safeDevWireText(assertion.kind, projectRoot),
        outcome: assertion.outcome,
      }))),
    }),
    source: 'diagnostics',
    summary: 'Recorded normalized native assertion evidence.',
  }),
  ...(hookEvents.length === 0
    ? []
    : [Object.freeze({
      kind: 'native.hooks',
      raw: Object.freeze({ events: Object.freeze(hookEvents.map((event) => safeDevWireText(event, projectRoot))) }),
      source: 'hook' as const,
      summary: 'Recorded normalized native Hook evidence.',
    })]),
  ...(Object.keys(trial.evidence.scripts.results).length === 0
    ? []
    : [Object.freeze({
      kind: 'native.scripts',
      raw: Object.freeze({
        level: trial.evidence.scripts.level,
        results: Object.freeze(Object.entries(trial.evidence.scripts.results).map(([id, result]) => Object.freeze({
          detail: safeDevWireText(result.detail, projectRoot),
          id: safeDevWireText(id, projectRoot),
          outcome: result.outcome,
        }))),
      }),
      source: 'script' as const,
      summary: 'Recorded normalized native script evidence.',
    })]),
  ...(response === undefined
    ? []
    : [Object.freeze({
      kind: 'native.response',
      raw: Object.freeze({ text: response }),
      source: 'response' as const,
      summary: 'Recorded normalized native host response.',
    })]),
  ...(trial.harnessFailure === undefined
    ? []
    : [Object.freeze({
      kind: 'native.harness.failed',
      raw: Object.freeze({ code: trial.harnessFailure.code, stage: trial.harnessFailure.stage }),
      source: 'host-preflight' as const,
      summary: 'Native host could not complete the requested run.',
    })]),
  ...(diff === undefined
    ? []
    : [Object.freeze({
      kind: 'native.workspace',
      raw: workspaceEvidence(diff),
      source: 'workspace-change' as const,
      summary: 'Recorded bounded native workspace changes.',
    })]),
]);
