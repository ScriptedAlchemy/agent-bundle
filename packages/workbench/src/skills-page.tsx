import { errorMessage as messageFrom } from './client-helpers.ts';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';
import type { ServedSkillDocument, SkillDocumentTree } from '../../agent-bundle/src/contracts/skills.ts';

import type { EvalClient } from './evals/eval-client.ts';
import { activeEpochFor } from './overview-model.ts';
import { SkillClient, SkillClientError } from './skill-client.ts';
import { SkillMarkdown } from './skill-markdown.tsx';
import { skillEvalCoverageFor, type SkillEvalCoverageState } from './skills-eval-coverage.ts';
import { resourceUrlFor } from './skills-model.ts';

export type SkillDocumentKind = 'generated' | 'source';

export type SkillView = 'markdown' | 'rendered';

type GeneratedTreeState =
  | Readonly<{ readonly state: 'loading'; readonly summary: string }>
  | Readonly<{ readonly state: 'ready'; readonly tree: SkillDocumentTree }>
  | Readonly<{ readonly state: 'unavailable'; readonly summary: string }>;

const documentTabs = ['source', 'generated'] as const;

const viewTabs = ['rendered', 'markdown'] as const;

const tabKey = (skillId: string): string => `skill-${skillId.replace(/^skill:/u, '').replaceAll(/[^a-z0-9_-]+/giu, '-').replaceAll(/^-+|-+$/gu, '')}`;

const tabIdFor = (skillId: string, group: 'document' | 'view', tab: string): string =>
  `${tabKey(skillId)}-${group}-tab-${tab}`;

const panelIdFor = (skillId: string): string => `${tabKey(skillId)}-panel`;

export interface SkillDocumentPanelProps {
  readonly document: SkillDocumentKind;
  readonly evalCoverage?: SkillEvalCoverageState;
  readonly onDocumentChange: (document: SkillDocumentKind) => void;
  readonly onTargetChange?: (target: string) => void;
  readonly onViewChange: (view: SkillView) => void;
  readonly selected?: ServedSkillDocument;
  readonly summary?: string;
  readonly target?: string;
  readonly targetNames?: readonly string[];
  readonly view: SkillView;
}

export interface SkillsPageProps {
  readonly client: SkillClient;
  readonly evalClient: EvalClient;
  readonly status: ProjectStatus;
}

const resourcePaths = (document: ServedSkillDocument): readonly string[] =>
  document.resources.map((resource) => resource.relativePath);

const ResourceTree = ({ document }: { readonly document: ServedSkillDocument }) => {
  const resources = resourcePaths(document);
  return <section aria-label="Resource tree" className="skill-resource-tree">
    <h2>Resource tree</h2>
    {document.resources.length === 0 ? <p className="empty-row">This Skill has no declared resources.</p> : <ul>
      {document.resources.map((resource) => {
        const href = resourceUrlFor(document.base, resource.relativePath, resources);
        return <li key={resource.relativePath}>{href === undefined
          ? resource.relativePath
          : <a href={href}>{resource.relativePath}</a>}<span>{resource.bytes} B</span></li>;
      })}
    </ul>}
  </section>;
};

const coverageKindLabels = { direct: 'Direct', indirect: 'Indirect', negative: 'Negative' } as const;

const EvalCoverage = ({ coverage }: { readonly coverage: SkillEvalCoverageState }) => (
  <section aria-label="Eval coverage" className="skill-eval-coverage">
    <h2>Eval coverage</h2>
    {coverage.state === 'loading' ? <p className="empty-row" role="status">Loading eval coverage…</p>
      : coverage.state === 'unavailable' ? <p className="empty-row" role="status">{coverage.summary}</p>
        : coverage.coverage.entries.length === 0
          ? <p className="empty-row">No authored eval cases reference this Skill.</p>
          : <>
            <p className="skill-eval-coverage-counts">
              {(['direct', 'indirect', 'negative'] as const).map((kind) => (
                <span className={`skill-coverage-badge skill-coverage-badge--${kind}`} key={kind}>
                  {coverageKindLabels[kind]} {coverage.coverage[kind]}
                </span>
              ))}
            </p>
            <ul>
              {coverage.coverage.entries.map((entry) => (
                <li key={`${entry.suite}/${entry.caseId}`}>
                  <span className="identifier">{entry.suite} / {entry.caseId}</span>
                  <span>
                    {entry.kinds.map((kind) => (
                      <span className={`skill-coverage-badge skill-coverage-badge--${kind}`} key={kind}>
                        {coverageKindLabels[kind]}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </>}
  </section>
);

const errorMessage = (error: unknown): string => messageFrom(error, 'Skill documents could not be loaded.');

const nextTab = <Tab extends string>(tabs: readonly Tab[], current: Tab, event: React.KeyboardEvent<HTMLButtonElement>): Tab | undefined => {
  const index = tabs.indexOf(current);
  const next = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    ? tabs[(index + 1) % tabs.length]!
    : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
      ? tabs[(index + tabs.length - 1) % tabs.length]!
      : event.key === 'Home'
        ? tabs[0]
        : event.key === 'End'
          ? tabs[tabs.length - 1]
          : undefined;
  if (next !== undefined) event.preventDefault();
  return next;
};

const documentLabel = (selected: ServedSkillDocument): string => selected.base.kind === 'generated'
  ? `Generated document · ${selected.base.epochId}/${selected.base.target}`
  : `Source document · ${selected.id.replace(/^skill:/u, '')}`;

const provenanceLabel = (selected: ServedSkillDocument): string => selected.base.kind === 'generated'
  ? `Generated · ${selected.base.epochId}/${selected.base.target}`
  : selected.provenance === undefined
    ? 'Source document'
    : `Source · ${selected.provenance.kind}`;

/** The selected served Skill document and its rendered or raw Markdown view. */
export const SkillDocumentPanel = ({
  document,
  evalCoverage,
  onDocumentChange,
  onTargetChange,
  onViewChange,
  selected,
  summary,
  target,
  targetNames = [],
  view,
}: SkillDocumentPanelProps) => {
  const documentTabButtons = useRef<Partial<Record<SkillDocumentKind, HTMLButtonElement | null>>>({});
  const viewTabButtons = useRef<Partial<Record<SkillView, HTMLButtonElement | null>>>({});
  const selectDocument = (next: SkillDocumentKind): void => {
    onDocumentChange(next);
    documentTabButtons.current[next]?.focus();
  };
  const selectView = (next: SkillView): void => {
    onViewChange(next);
    viewTabButtons.current[next]?.focus();
  };
  const onDocumentTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: SkillDocumentKind): void => {
    const next = nextTab(documentTabs, current, event);
    if (next !== undefined) selectDocument(next);
  };
  const onViewTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: SkillView): void => {
    const next = nextTab(viewTabs, current, event);
    if (next !== undefined) selectView(next);
  };
  const selectedId = selected?.id ?? 'skills';
  const documentTabId = tabIdFor(selectedId, 'document', document);
  const viewTabId = tabIdFor(selectedId, 'view', view);
  const panelId = panelIdFor(selectedId);

  return <section aria-label={selected === undefined ? 'Skill documents' : `${selected.name} Skill`} className="skill-detail">
    {selected === undefined ? undefined : <>
      <div className="skill-detail-heading">
        <div>
          <p className="skill-eyebrow">Skill document</p>
          <h2>{selected.name}</h2>
          {selected.description === undefined ? undefined : <p className="skill-description">{selected.description}</p>}
        </div>
        <span className="skill-provenance">{provenanceLabel(selected)}</span>
      </div>
      <dl className="skill-frontmatter" aria-label="Parsed frontmatter">
        {Object.entries(selected.frontmatter).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => (
          <div key={name}><dt>{name}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>
        ))}
      </dl>
      {selected.diagnostics.length === 0 ? undefined : <div className="skill-diagnostics" role="status">
        {selected.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}>
          <strong>{diagnostic.code}</strong> {diagnostic.message}
        </p>)}
      </div>}
    </>}
    <div className="skill-controls">
      <div className="skill-control-group">
        <span className="skill-control-label">Document</span>
        <div aria-label="Skill document" className="skill-tabs skill-tabs--document" role="tablist">
          {documentTabs.map((candidate) => (
            <button
              aria-controls={panelId}
              aria-selected={document === candidate}
              className={document === candidate ? 'skill-tab skill-tab--active' : 'skill-tab'}
              id={tabIdFor(selectedId, 'document', candidate)}
              key={candidate}
              onClick={() => selectDocument(candidate)}
              onKeyDown={(event) => onDocumentTabKeyDown(event, candidate)}
              ref={(element) => { documentTabButtons.current[candidate] = element; }}
              role="tab"
              tabIndex={document === candidate ? 0 : -1}
              type="button"
            >
              {candidate[0]!.toUpperCase()}{candidate.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="skill-control-group">
        <span className="skill-control-label">View</span>
        <div aria-label="Document view" className="skill-tabs skill-tabs--view" role="tablist">
          {viewTabs.map((candidate) => (
            <button
              aria-controls={panelId}
              aria-selected={view === candidate}
              className={view === candidate ? 'skill-tab skill-tab--active' : 'skill-tab'}
              id={tabIdFor(selectedId, 'view', candidate)}
              key={candidate}
              onClick={() => selectView(candidate)}
              onKeyDown={(event) => onViewTabKeyDown(event, candidate)}
              ref={(element) => { viewTabButtons.current[candidate] = element; }}
              role="tab"
              tabIndex={view === candidate ? 0 : -1}
              type="button"
            >
              {candidate === 'markdown' ? 'Markdown' : 'Rendered'}
            </button>
          ))}
        </div>
      </div>
      {document === 'generated' && targetNames.length > 0 ? <label className="skill-target skill-target--toolbar">
        <span>Target</span>
        <select onChange={(event) => onTargetChange?.(event.target.value)} value={target ?? ''}>
          {targetNames.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label> : undefined}
    </div>
    <section
      aria-label={`${document === 'source' ? 'Source' : 'Generated'} ${view === 'rendered' ? 'rendered' : 'Markdown'} Skill document`}
      aria-labelledby={`${documentTabId} ${viewTabId}`}
      className="skill-document-view"
      id={panelId}
      role="tabpanel"
      tabIndex={0}
    >
      {selected === undefined ? <p className="empty-row" role="status">{summary ?? 'Select a Skill to inspect its documentation.'}</p> : <>
        <p className="skill-base-label">{documentLabel(selected)}</p>
        {view === 'rendered'
          ? <SkillMarkdown base={selected.base} body={selected.body} resources={resourcePaths(selected)} />
          : <pre className="skill-source"><code>{selected.markdown}</code></pre>}
        <ResourceTree document={selected} />
        {evalCoverage === undefined ? undefined : <EvalCoverage coverage={evalCoverage} />}
      </>}
    </section>
  </section>;
};

const selectedDocumentFor = (
  tree: SkillDocumentTree | undefined,
  selectedId: string | undefined,
): ServedSkillDocument | undefined =>
  tree?.skills.find((skill) => skill.id === selectedId) ?? tree?.skills[0];

const SkillTree = ({ label = 'Skills', onSelect, selectedId, tree }: {
  readonly label?: string;
  readonly onSelect: (id: string) => void;
  readonly selectedId: string | undefined;
  readonly tree: SkillDocumentTree;
}) => <aside aria-label="Skills" className="skill-tree-pane">
  <div className="skill-tree-heading"><h2>{label}</h2><span>{tree.skills.length}</span></div>
  {tree.skills.length === 0 ? <p className="empty-row">No normalized Skills are available.</p> : <div className="skill-tree">
    {tree.skills.map((skill) => <button
      aria-current={selectedId === skill.id ? 'page' : undefined}
      className={selectedId === skill.id ? 'skill-tree-item skill-tree-item--active' : 'skill-tree-item'}
      key={skill.id}
      onClick={() => onSelect(skill.id)}
      type="button"
    >
      <strong>{skill.name}</strong><span>{skill.description ?? skill.id}</span>
    </button>)}
  </div>}
</aside>;

const unavailableTree = (summary: string): GeneratedTreeState => Object.freeze({ state: 'unavailable', summary });

const loadingTree = (summary: string): GeneratedTreeState => Object.freeze({ state: 'loading', summary });

type SuiteSummaries = Parameters<typeof skillEvalCoverageFor>[1];

type SuitesState =
  | Readonly<{ readonly state: 'loading' }>
  | Readonly<{ readonly state: 'ready'; readonly suites: SuiteSummaries }>
  | Readonly<{ readonly state: 'unavailable' }>;

/** Fetches source Skills once per source revision and generated content per selected immutable epoch. */
export const SkillsPage = ({ client, evalClient, status }: SkillsPageProps) => {
  const [sourceTree, setSourceTree] = useState<SkillDocumentTree>();
  const [error, setError] = useState<string>();
  const [document, setDocument] = useState<SkillDocumentKind>('source');
  const [selectedIds, setSelectedIds] = useState<Partial<Record<SkillDocumentKind, string>>>({});
  const [suitesState, setSuitesState] = useState<SuitesState>({ state: 'loading' });
  const [view, setView] = useState<SkillView>('rendered');
  const epoch = activeEpochFor(status);
  const targetNames = useMemo(() => Object.keys(epoch?.targetDigests ?? {}).sort((left, right) => left.localeCompare(right)), [epoch]);
  const [target, setTarget] = useState<string>();
  const [generatedTree, setGeneratedTree] = useState<GeneratedTreeState>(() => unavailableTree('No artifact epoch is active.'));
  const selectedTree = document === 'source'
    ? sourceTree
    : generatedTree.state === 'ready'
      ? generatedTree.tree
      : undefined;
  const selected = selectedDocumentFor(selectedTree, selectedIds[document]);
  const generatedSummary = generatedTree.state === 'ready'
    ? 'The selected artifact epoch has no generated Skills for this target.'
    : generatedTree.summary;
  const detailSummary = document === 'generated'
    ? generatedSummary
    : error ?? (sourceTree === undefined ? 'Loading source Skills…' : 'Select a normalized Skill to inspect its documentation.');
  const selectSkill = (id: string): void => {
    setSelectedIds((previous) => ({ ...previous, [document]: id }));
  };

  useEffect(() => {
    let current = true;
    setError(undefined);
    setSourceTree(undefined);
    void client.sourceTree().then(
      (next) => {
        if (!current) return;
        setSourceTree(next);
      },
      (reason) => { if (current) setError(errorMessage(reason)); },
    );
    return () => { current = false; };
  }, [client, status.source.revision]);

  useEffect(() => {
    let current = true;
    setSuitesState({ state: 'loading' });
    void evalClient.suites().then(
      (listing) => { if (current) setSuitesState(Object.freeze({ state: 'ready', suites: listing.suites })); },
      () => { if (current) setSuitesState(Object.freeze({ state: 'unavailable' })); },
    );
    return () => { current = false; };
  }, [evalClient, status.source.revision]);

  const evalCoverage = useMemo<SkillEvalCoverageState>(() => {
    if (selected === undefined || suitesState.state === 'loading') return Object.freeze({ state: 'loading' });
    if (suitesState.state === 'unavailable') {
      return Object.freeze({ state: 'unavailable', summary: 'Eval coverage is unavailable because authored suites could not be loaded.' });
    }
    return Object.freeze({ coverage: skillEvalCoverageFor(selected.name, suitesState.suites), state: 'ready' });
  }, [selected, suitesState]);

  useEffect(() => {
    setTarget((previous) => previous !== undefined && targetNames.includes(previous) ? previous : targetNames[0]);
  }, [epoch?.id, targetNames]);

  useEffect(() => {
    let current = true;
    if (epoch === undefined) {
      setGeneratedTree(unavailableTree('No artifact epoch is active.'));
      return () => { current = false; };
    }
    if (target === undefined) {
      setGeneratedTree(unavailableTree('The selected artifact epoch has no generated targets.'));
      return () => { current = false; };
    }
    setGeneratedTree(loadingTree(`Loading ${target} from epoch ${epoch.id}…`));
    void client.generatedTree(epoch.id, target).then(
      (tree) => { if (current) setGeneratedTree(Object.freeze({ state: 'ready', tree })); },
      (reason) => {
        if (!current) return;
        const summary = reason instanceof SkillClientError && reason.code === 'SKILL_TARGET_UNAVAILABLE'
          ? reason.message
          : `Generated Skills are unavailable: ${errorMessage(reason)}`;
        setGeneratedTree(unavailableTree(summary));
      },
    );
    return () => { current = false; };
  }, [client, epoch?.id, target]);

  return <div className="skills-layout">
    {selectedTree === undefined ? <aside className="skill-tree-pane"><p className="empty-row">{detailSummary}</p></aside> : (
      <SkillTree label={document === 'generated' ? 'Generated skills' : 'Source skills'} onSelect={selectSkill} selectedId={selected?.id} tree={selectedTree} />
    )}
    <div className="skills-content">
      <div className="page-heading skills-page-heading">
        <div><h1>Skills</h1><p>Server-parsed source and immutable generated documents.</p></div>
      </div>
      {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
      {document === 'source' && sourceTree !== undefined && sourceTree.diagnostics.length > 0 ? <div className="skill-diagnostics" role="status">
        {sourceTree.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}><strong>{diagnostic.code}</strong> {diagnostic.message}</p>)}
      </div> : undefined}
      <SkillDocumentPanel
        document={document}
        evalCoverage={evalCoverage}
        onDocumentChange={setDocument}
        onTargetChange={setTarget}
        onViewChange={setView}
        selected={selected}
        summary={detailSummary}
        target={target}
        targetNames={targetNames}
        view={view}
      />
    </div>
  </div>;
};
