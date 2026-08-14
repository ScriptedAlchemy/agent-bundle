import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectStatus } from '../../agent-bundle/src/dev/types.ts';
import type { ServedSkillDocument, SkillDocumentTree } from '../../agent-bundle/src/dev/skill-document-service.ts';

import { SkillClient, SkillClientError } from './skill-client.ts';
import { SkillMarkdown } from './skill-markdown.tsx';
import { resourceUrlFor } from './skills-model.ts';

export type SkillTab = 'generated' | 'rendered' | 'source';

export type GeneratedDocumentState =
  | Readonly<{ readonly document: ServedSkillDocument; readonly state: 'ready' }>
  | Readonly<{ readonly state: 'loading'; readonly summary: string }>
  | Readonly<{ readonly state: 'unavailable'; readonly summary: string }>;

type GeneratedTreeState =
  | Readonly<{ readonly state: 'loading'; readonly summary: string }>
  | Readonly<{ readonly state: 'ready'; readonly tree: SkillDocumentTree }>
  | Readonly<{ readonly state: 'unavailable'; readonly summary: string }>;

const skillTabs = ['rendered', 'source', 'generated'] as const;

const tabKey = (skillId: string): string => `skill-${skillId.replace(/^skill:/u, '').replaceAll(/[^a-z0-9_-]+/giu, '-').replaceAll(/^-+|-+$/gu, '')}`;

const tabIdFor = (skillId: string, tab: SkillTab): string => `${tabKey(skillId)}-tab-${tab}`;

const panelIdFor = (skillId: string, tab: SkillTab): string => `${tabKey(skillId)}-panel-${tab}`;

export interface SkillDocumentPanelProps {
  readonly generated: GeneratedDocumentState;
  readonly onTabChange: (tab: SkillTab) => void;
  readonly selected: ServedSkillDocument;
  readonly tab: SkillTab;
}

export interface SkillsPageProps {
  readonly client: SkillClient;
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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Skill documents could not be loaded.';

const artifactEpoch = (status: ProjectStatus) =>
  status.artifact.state === 'missing' ? undefined : status.artifact.activeEpoch;

const GeneratedView = ({ state }: { readonly state: GeneratedDocumentState }) => {
  if (state.state === 'ready') {
    return <div>
      <p className="skill-base-label">Generated base · {state.document.base.kind === 'generated'
        ? `${state.document.base.epochId}/${state.document.base.target}`
        : 'Unavailable'}</p>
      <SkillMarkdown base={state.document.base} body={state.document.body} resources={resourcePaths(state.document)} />
      <ResourceTree document={state.document} />
    </div>;
  }
  return <p className="empty-row" role="status">{state.summary}</p>;
};

/** The selected Skill body, its server-parsed metadata, and three synchronized views. */
export const SkillDocumentPanel = ({ generated, onTabChange, selected, tab }: SkillDocumentPanelProps) => {
  const tabs = useRef<Partial<Record<SkillTab, HTMLButtonElement | null>>>({});
  const selectTab = (next: SkillTab): void => {
    onTabChange(next);
    tabs.current[next]?.focus();
  };
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: SkillTab): void => {
    const index = skillTabs.indexOf(current);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? skillTabs[(index + 1) % skillTabs.length]!
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? skillTabs[(index + skillTabs.length - 1) % skillTabs.length]!
        : event.key === 'Home'
          ? skillTabs[0]
          : event.key === 'End'
            ? skillTabs[skillTabs.length - 1]
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    selectTab(next);
  };
  const tabId = tabIdFor(selected.id, tab);
  const panelId = panelIdFor(selected.id, tab);

  return <section aria-label={`${selected.name} Skill`} className="skill-detail">
    <div className="skill-detail-heading">
      <div>
        <p className="skill-eyebrow">Skill document</p>
        <h1>{selected.name}</h1>
        {selected.description === undefined ? undefined : <p className="skill-description">{selected.description}</p>}
      </div>
      <span className="skill-provenance">{selected.provenance?.kind ?? 'generated'}</span>
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
    <div aria-label="Skill document views" className="skill-tabs" role="tablist">
      {skillTabs.map((candidate) => (
        <button
          aria-controls={panelIdFor(selected.id, candidate)}
          aria-selected={tab === candidate}
          className={tab === candidate ? 'skill-tab skill-tab--active' : 'skill-tab'}
          id={tabIdFor(selected.id, candidate)}
          key={candidate}
          onClick={() => selectTab(candidate)}
          onKeyDown={(event) => onTabKeyDown(event, candidate)}
          ref={(element) => { tabs.current[candidate] = element; }}
          role="tab"
          tabIndex={tab === candidate ? 0 : -1}
          type="button"
        >
          {candidate[0]!.toUpperCase()}{candidate.slice(1)}
        </button>
      ))}
    </div>
    <section
      aria-label={tab === 'rendered' ? 'Rendered Skill document' : tab === 'source' ? 'Source Skill document' : 'Generated Skill document'}
      aria-labelledby={tabId}
      className="skill-document-view"
      id={panelId}
      role="tabpanel"
      tabIndex={0}
    >
      {tab === 'rendered' ? <>
        <p className="skill-base-label">Source base · {selected.id}</p>
        <SkillMarkdown base={selected.base} body={selected.body} resources={resourcePaths(selected)} />
        <ResourceTree document={selected} />
      </> : undefined}
      {tab === 'source' ? <>
        <p className="skill-base-label">Source base · {selected.id}</p>
        <pre className="skill-source"><code>{selected.markdown}</code></pre>
        <ResourceTree document={selected} />
      </> : undefined}
      {tab === 'generated' ? <GeneratedView state={generated} /> : undefined}
    </section>
  </section>;
};

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

const unavailable = (summary: string): GeneratedDocumentState => Object.freeze({ state: 'unavailable', summary });

const unavailableTree = (summary: string): GeneratedTreeState => Object.freeze({ state: 'unavailable', summary });

const loadingTree = (summary: string): GeneratedTreeState => Object.freeze({ state: 'loading', summary });

/** Fetches source Skills once per source revision and generated content per selected immutable epoch. */
export const SkillsPage = ({ client, status }: SkillsPageProps) => {
  const [sourceTree, setSourceTree] = useState<SkillDocumentTree>();
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [tab, setTab] = useState<SkillTab>('rendered');
  const epoch = artifactEpoch(status);
  const targetNames = useMemo(() => Object.keys(epoch?.targetDigests ?? {}).sort((left, right) => left.localeCompare(right)), [epoch]);
  const [target, setTarget] = useState<string>();
  const [generatedTree, setGeneratedTree] = useState<GeneratedTreeState>(() => unavailableTree('No artifact epoch is active.'));
  const selectedTree = tab === 'generated' && generatedTree.state === 'ready' ? generatedTree.tree : sourceTree;
  const selected = selectedTree?.skills.find((skill) => skill.id === selectedId) ?? selectedTree?.skills[0];
  const generatedSummary = generatedTree.state === 'ready'
    ? 'The selected artifact epoch has no generated Skills for this target.'
    : generatedTree.summary;
  const generated: GeneratedDocumentState = generatedTree.state === 'ready' && selected !== undefined
    ? Object.freeze({ document: selected, state: 'ready' })
    : generatedTree.state === 'loading'
      ? Object.freeze({ state: 'loading', summary: generatedTree.summary })
      : unavailable(generatedSummary);

  useEffect(() => {
    let current = true;
    setError(undefined);
    void client.sourceTree().then(
      (next) => {
        if (!current) return;
        setSourceTree(next);
        setSelectedId((previous) => next.skills.some((skill) => skill.id === previous)
          ? previous
          : next.skills[0]?.id);
      },
      (reason) => { if (current) setError(errorMessage(reason)); },
    );
    return () => { current = false; };
  }, [client, status.source.revision]);

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

  useEffect(() => {
    if (selectedTree === undefined) return;
    setSelectedId((previous) => selectedTree.skills.some((skill) => skill.id === previous)
      ? previous
      : selectedTree.skills[0]?.id);
  }, [selectedTree]);

  return <div className="skills-layout">
    {selectedTree === undefined ? <aside className="skill-tree-pane"><p className="empty-row">{tab === 'generated' ? generatedSummary : 'Loading Skills…'}</p></aside> : (
      <SkillTree label={tab === 'generated' ? 'Generated Skills' : 'Skills'} onSelect={setSelectedId} selectedId={selected?.id} tree={selectedTree} />
    )}
    <div className="skills-content">
      <div className="page-heading skills-page-heading">
        <div><h1>Skills</h1><p>Server-parsed source and immutable generated documents.</p></div>
        {targetNames.length > 0 ? <label className="skill-target">Generated target
          <select onChange={(event) => setTarget(event.target.value)} value={target ?? ''}>
            {targetNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label> : undefined}
      </div>
      {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
      {sourceTree !== undefined && sourceTree.diagnostics.length > 0 ? <div className="skill-diagnostics" role="status">
        {sourceTree.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}><strong>{diagnostic.code}</strong> {diagnostic.message}</p>)}
      </div> : undefined}
      {selected === undefined ? <p className="empty-row">{tab === 'generated' ? generatedSummary : 'Select a normalized Skill to inspect its documentation.'}</p> : (
        <SkillDocumentPanel generated={generated} onTabChange={setTab} selected={selected} tab={tab} />
      )}
    </div>
  </div>;
};
