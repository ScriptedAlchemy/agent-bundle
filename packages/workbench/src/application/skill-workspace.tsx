/**
 * The Skill leaf workspace (#600): the rendered Skill document is the center
 * (authored by default, the host-generated document per target on demand);
 * the source/generated comparison, frontmatter, resources, and eval coverage
 * sit in the inspector drawer. Fetches the authored document per source
 * revision and the generated one per published build and target.
 */
import React, { useEffect, useMemo, useState } from 'react';

import type { ProjectStatus } from '../../../agent-bundle/src/contracts/project.ts';
import type { ServedSkillDocument } from '../../../agent-bundle/src/contracts/skills.ts';
import { errorMessage } from '../client-helpers.ts';
import type { EvalClient } from '../evals/eval-client.ts';
import { SkillClient, SkillClientError } from '../skill-client.ts';
import { skillEvalCoverageFor, type SkillEvalCoverageState } from '../skills-eval-coverage.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import { WorkspaceHeader } from './executable-route-workspace.tsx';
import { InspectorDrawer, type InspectorTabDefinition } from './route-inspector.tsx';
import {
  SkillDocumentPanel,
  SkillEvalCoverage,
  SkillFrontmatter,
  skillGenerationSummaryFor,
  SkillResourceTree,
  type SkillDocumentKind,
  type SkillView,
} from './skill-document-panel.tsx';
import { publishedEpochFor, type WorkspaceClients } from './workspace-contracts.ts';
import './workspace.css';

export type SkillInspectorTab = 'coverage' | 'diff' | 'frontmatter' | 'resources';

type DocumentState =
  | Readonly<{ readonly state: 'loading'; readonly summary: string }>
  | Readonly<{ readonly document: ServedSkillDocument; readonly state: 'ready' }>
  | Readonly<{ readonly state: 'unavailable'; readonly summary: string }>;

type SuiteSummaries = Parameters<typeof skillEvalCoverageFor>[1];

type SuitesState =
  | Readonly<{ readonly state: 'loading' }>
  | Readonly<{ readonly state: 'ready'; readonly suites: SuiteSummaries }>
  | Readonly<{ readonly state: 'unavailable' }>;

const loading = (summary: string): DocumentState => Object.freeze({ state: 'loading', summary });
const unavailable = (summary: string): DocumentState => Object.freeze({ state: 'unavailable', summary });

/** The served skill id this leaf names (`skill:<id>` in the tree ref). */
export const skillIdFor = (leaf: ApplicationLeaf): string | undefined => leaf.ref.kind === 'skill' ? leaf.ref.id : undefined;

export interface SkillWorkspaceProps {
  readonly clients: Pick<WorkspaceClients, 'evalClient' | 'skillClient'>;
  readonly leaf: ApplicationLeaf;
  readonly status: ProjectStatus;
}

const useSourceDocument = (client: SkillClient, skillId: string | undefined, revision: string | undefined): DocumentState => {
  const [state, setState] = useState<DocumentState>(() => loading('Loading the authored Skill…'));
  useEffect(() => {
    let current = true;
    if (skillId === undefined) {
      setState(unavailable('This leaf is not a Skill.'));
      return () => { current = false; };
    }
    setState(loading('Loading the authored Skill…'));
    void client.source(skillId).then(
      (document) => { if (current) setState(Object.freeze({ document, state: 'ready' })); },
      (reason: unknown) => { if (current) setState(unavailable(errorMessage(reason, 'The authored Skill could not be loaded.'))); },
    );
    return () => { current = false; };
  }, [client, revision, skillId]);
  return state;
};

const useGeneratedDocument = (client: SkillClient, skillId: string | undefined, epochId: string | undefined, target: string | undefined): DocumentState => {
  const [state, setState] = useState<DocumentState>(() => unavailable('No successful build is available.'));
  useEffect(() => {
    let current = true;
    if (skillId === undefined || epochId === undefined) {
      setState(unavailable('No successful build is available.'));
      return () => { current = false; };
    }
    if (target === undefined) {
      setState(unavailable('The selected build has no generated targets.'));
      return () => { current = false; };
    }
    setState(loading(`Loading ${target} from the current build…`));
    void client.generated(epochId, target, skillId).then(
      (document) => { if (current) setState(Object.freeze({ document, state: 'ready' })); },
      (reason: unknown) => {
        if (!current) return;
        setState(unavailable(reason instanceof SkillClientError && reason.code === 'SKILL_TARGET_UNAVAILABLE'
          ? reason.message
          : `Generated Skills are unavailable: ${errorMessage(reason, 'the request failed')}`));
      },
    );
    return () => { current = false; };
  }, [client, epochId, skillId, target]);
  return state;
};

const useSuites = (evalClient: EvalClient, revision: string | undefined): SuitesState => {
  const [state, setState] = useState<SuitesState>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ state: 'loading' });
    void evalClient.suites(controller.signal).then(
      (listing) => { if (!controller.signal.aborted) setState(Object.freeze({ state: 'ready', suites: listing.suites })); },
      () => { if (!controller.signal.aborted) setState(Object.freeze({ state: 'unavailable' })); },
    );
    return () => controller.abort();
  }, [evalClient, revision]);
  return state;
};

const SourceGeneratedDiff = ({ generated, source, target }: {
  readonly generated: DocumentState;
  readonly source: DocumentState;
  readonly target?: string;
}): React.ReactNode => {
  if (source.state !== 'ready') return <p className="inspector-empty" role="status">{source.summary}</p>;
  if (generated.state !== 'ready') return <p className="inspector-empty" role="status">{generated.summary}</p>;
  const targetLabel = target ?? (generated.document.base.kind === 'generated' ? generated.document.base.target : 'this target');
  const summary = skillGenerationSummaryFor(source.document, generated.document, targetLabel);
  return <div className="skill-diff">
    <p className={`skill-translation-note skill-translation-note--${summary.kind}`}>{summary.message}</p>
    {summary.kind === 'identical' ? undefined : <div className="skill-diff-columns">
      <section><h3>Authored</h3><pre className="skill-source"><code>{source.document.markdown}</code></pre></section>
      <section><h3>Generated for {targetLabel}</h3><pre className="skill-source"><code>{generated.document.markdown}</code></pre></section>
    </div>}
  </div>;
};

/** Rendered Skill document in the center; comparison, frontmatter, resources, and coverage in the inspector. */
export const SkillWorkspace = ({ clients, leaf, status }: SkillWorkspaceProps): React.ReactNode => {
  const skillId = skillIdFor(leaf);
  const epoch = publishedEpochFor(status);
  const targetNames = useMemo(() => Object.keys(epoch?.targetDigests ?? {}).sort((left, right) => left.localeCompare(right)), [epoch]);
  const [target, setTarget] = useState<string>();
  const [document, setDocument] = useState<SkillDocumentKind>('source');
  const [view, setView] = useState<SkillView>('rendered');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<SkillInspectorTab>('diff');

  useEffect(() => {
    setTarget((previous) => previous !== undefined && targetNames.includes(previous) ? previous : targetNames[0]);
  }, [epoch?.id, targetNames]);

  const source = useSourceDocument(clients.skillClient, skillId, status.source.revision);
  const generated = useGeneratedDocument(clients.skillClient, skillId, epoch?.id, target);
  const suites = useSuites(clients.evalClient, status.source.revision);
  const shown = document === 'source' ? source : generated;
  const selected = shown.state === 'ready' ? shown.document : undefined;
  const translationSummary = document !== 'generated' || generated.state !== 'ready' || target === undefined
    ? undefined
    : source.state === 'ready'
      ? skillGenerationSummaryFor(source.document, generated.document, target).message
      : `Generated for ${target} — no authored counterpart is available for comparison.`;

  const evalCoverage = useMemo<SkillEvalCoverageState>(() => {
    if (selected === undefined || suites.state === 'loading') return Object.freeze({ state: 'loading' });
    if (suites.state === 'unavailable') {
      return Object.freeze({ state: 'unavailable', summary: 'Eval coverage is unavailable because authored suites could not be loaded.' });
    }
    return Object.freeze({ coverage: skillEvalCoverageFor(selected.name, suites.suites), state: 'ready' });
  }, [selected, suites]);

  const tabs: readonly InspectorTabDefinition<SkillInspectorTab>[] = [
    { id: 'diff', label: 'Source / generated', render: () => <SourceGeneratedDiff generated={generated} source={source} target={target} /> },
    { id: 'frontmatter', label: 'Frontmatter', render: () => selected === undefined
      ? <p className="inspector-empty" role="status">{shown.state === 'ready' ? 'No document.' : shown.summary}</p>
      : <SkillFrontmatter selected={selected} /> },
    { id: 'resources', label: 'Resources', render: () => selected === undefined
      ? <p className="inspector-empty" role="status">{shown.state === 'ready' ? 'No document.' : shown.summary}</p>
      : <SkillResourceTree document={selected} /> },
    { id: 'coverage', label: 'Eval coverage', render: () => <SkillEvalCoverage coverage={evalCoverage} /> },
  ];

  return <div className={inspectorOpen ? 'route-workspace route-workspace--inspecting skill-workspace' : 'route-workspace skill-workspace'} data-testid="route-workspace">
    <div className="route-workspace-main">
      <WorkspaceHeader leaf={leaf} />
      <SkillDocumentPanel
        document={document}
        onDocumentChange={setDocument}
        onTargetChange={setTarget}
        onViewChange={setView}
        selected={selected}
        summary={shown.state === 'ready' ? undefined : shown.summary}
        target={target}
        targetNames={targetNames}
        translationSummary={translationSummary}
        view={view}
      />
    </div>
    <InspectorDrawer
      label="Skill inspector"
      onTabChange={setInspectorTab}
      onToggle={() => setInspectorOpen((open) => !open)}
      open={inspectorOpen}
      tab={inspectorTab}
      tabs={tabs}
    />
  </div>;
};
