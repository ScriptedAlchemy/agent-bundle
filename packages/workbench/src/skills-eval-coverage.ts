export type SkillEvalCoverageKind = 'direct' | 'indirect' | 'negative';

interface CoverageAssertionSummary {
  readonly kind: string;
  readonly skill?: string;
}

interface CoverageCaseSummary {
  readonly assertions: readonly CoverageAssertionSummary[];
  readonly id: string;
  readonly invocation: Readonly<{ readonly mode: string; readonly skill?: string }>;
}

interface CoverageSuiteSummary {
  readonly cases: readonly CoverageCaseSummary[];
  readonly name: string;
}

/** One authored eval case that references the Skill, with every way it covers it. */
export interface SkillEvalCoverageEntry {
  readonly caseId: string;
  readonly kinds: readonly SkillEvalCoverageKind[];
  readonly suite: string;
}

export interface SkillEvalCoverage {
  readonly direct: number;
  readonly entries: readonly SkillEvalCoverageEntry[];
  readonly indirect: number;
  readonly negative: number;
}

/** The Skill page's asynchronous coverage panel state. */
export type SkillEvalCoverageState =
  | Readonly<{ readonly state: 'loading' }>
  | Readonly<{ readonly coverage: SkillEvalCoverage; readonly state: 'ready' }>
  | Readonly<{ readonly state: 'unavailable'; readonly summary: string }>;

const kindsFor = (skillName: string, evalCase: CoverageCaseSummary): readonly SkillEvalCoverageKind[] => {
  const kinds: SkillEvalCoverageKind[] = [];
  const direct = evalCase.assertions.some((assertion) =>
    assertion.kind === 'skill-activation' && assertion.skill === skillName);
  const negative = evalCase.assertions.some((assertion) =>
    assertion.kind === 'no-skill-activation' && (assertion.skill === undefined || assertion.skill === skillName));
  if (direct) kinds.push('direct');
  if (negative) kinds.push('negative');
  if (!direct && !negative && evalCase.invocation.skill === skillName) kinds.push('indirect');
  return kinds;
};

/**
 * Classifies every authored eval case by how it covers the named Skill:
 * direct (asserts the Skill activates), negative (asserts it does not,
 * including blanket no-activation assertions), and indirect (the case invokes
 * the Skill without asserting on its activation).
 */
export const skillEvalCoverageFor = (
  skillName: string,
  suites: readonly CoverageSuiteSummary[],
): SkillEvalCoverage => {
  const entries: SkillEvalCoverageEntry[] = [];
  const counts = { direct: 0, indirect: 0, negative: 0 };
  for (const suite of suites) {
    for (const evalCase of suite.cases) {
      const kinds = kindsFor(skillName, evalCase);
      if (kinds.length === 0) continue;
      for (const kind of kinds) counts[kind] += 1;
      entries.push(Object.freeze({ caseId: evalCase.id, kinds: Object.freeze(kinds), suite: suite.name }));
    }
  }
  return Object.freeze({ ...counts, entries: Object.freeze(entries) });
};
