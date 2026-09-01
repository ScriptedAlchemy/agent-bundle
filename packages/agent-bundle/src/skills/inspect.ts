import { deepFreeze } from '../core/freeze.ts';
import type { SkillHostDocument, SkillIr, SkillTokenLoweringRecord, SkillTreeLayoutDecision } from './ir.ts';
import { decideSkillTreeLayout, lowerSkillIrForHosts } from './lower.ts';
import type { SkillHost } from './tokens.ts';

export interface SkillProjectionInspection {
  readonly authoredMarkdown: string;
  readonly authoredSource: string;
  readonly hostDocuments: Readonly<Record<string, SkillHostDocument>>;
  readonly skillTreeLayout: SkillTreeLayoutDecision;
  readonly tokenLowering: readonly SkillTokenLoweringRecord[];
}

export const inspectSkillProjection = (
  ir: SkillIr,
  hosts: readonly SkillHost[],
): SkillProjectionInspection => {
  const hostDocuments = lowerSkillIrForHosts(ir, hosts);
  const tokenLowering = Object.freeze(
    hosts.flatMap((host) => hostDocuments[host]?.tokenLowering ?? []),
  );
  return deepFreeze({
    authoredMarkdown: ir.markdown,
    authoredSource: ir.source,
    hostDocuments,
    skillTreeLayout: decideSkillTreeLayout(hostDocuments),
    tokenLowering,
  });
};
