import React, { useEffect, useMemo, useState } from 'react';

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
    return <section aria-label="Generated Skill document" className="skill-document-view">
      <p className="skill-base-label">Generated base · {state.document.base.kind === 'generated'
        ? `${state.document.base.epochId}/${state.document.base.target}`
        : 'Unavailable'}</p>
      <SkillMarkdown base={state.document.base} body={state.document.body} resources={resourcePaths(state.document)} />
      <ResourceTree document={state.document} />
    </section>;
  }
  return <p className="empty-row" role="status">{state.summary}</p>;
};

/** The selected Skill body, its server-parsed metadata, and three synchronized views. */
export const SkillDocumentPanel = ({ generated, onTabChange, selected, tab }: SkillDocumentPanelProps) => (
  <section aria-label={`${selected.name} Skill`} className="skill-detail">
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
      {(['rendered', 'source', 'generated'] as const).map((candidate) => (
        <button
          aria-selected={tab === candidate}
          className={tab === candidate ? 'skill-tab skill-tab--active' : 'skill-tab'}
          key={candidate}
          onClick={() => onTabChange(candidate)}
          role="tab"
          type="button"
        >
          {candidate[0]!.toUpperCase()}{candidate.slice(1)}
        </button>
      ))}
    </div>
    {tab === 'rendered' ? <section aria-label="Rendered Skill document" className="skill-document-view">
      <p className="skill-base-label">Source base · {selected.id}</p>
      <SkillMarkdown base={selected.base} body={selected.body} resources={resourcePaths(selected)} />
      <ResourceTree document={selected} />
    </section> : undefined}
    {tab === 'source' ? <section aria-label="Source Skill document" className="skill-document-view">
      <p className="skill-base-label">Source base · {selected.id}</p>
      <pre className="skill-source"><code>{selected.markdown}</code></pre>
      <ResourceTree document={selected} />
    </section> : undefined}
    {tab === 'generated' ? <GeneratedView state={generated} /> : undefined}
  </section>
);

const SkillTree = ({ onSelect, selectedId, tree }: {
  readonly onSelect: (id: string) => void;
  readonly selectedId: string | undefined;
  readonly tree: SkillDocumentTree;
}) => <aside aria-label="Skills" className="skill-tree-pane">
  <div className="skill-tree-heading"><h2>Skills</h2><span>{tree.skills.length}</span></div>
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

/** Fetches source Skills once per source revision and generated content per selected immutable epoch. */
export const SkillsPage = ({ client, status }: SkillsPageProps) => {
  const [tree, setTree] = useState<SkillDocumentTree>();
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [tab, setTab] = useState<SkillTab>('rendered');
  const epoch = artifactEpoch(status);
  const targetNames = useMemo(() => Object.keys(epoch?.targetDigests ?? {}).sort((left, right) => left.localeCompare(right)), [epoch]);
  const [target, setTarget] = useState<string>();
  const selected = tree?.skills.find((skill) => skill.id === selectedId) ?? tree?.skills[0];
  const [generated, setGenerated] = useState<GeneratedDocumentState>(() => unavailable('No artifact epoch is active.'));

  useEffect(() => {
    let current = true;
    setError(undefined);
    void client.sourceTree().then(
      (next) => {
        if (!current) return;
        setTree(next);
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
      setGenerated(unavailable('No artifact epoch is active.'));
      return () => { current = false; };
    }
    if (selected === undefined || target === undefined) {
      setGenerated(unavailable('The selected artifact epoch has no generated targets.'));
      return () => { current = false; };
    }
    if (selected.targets !== undefined && !selected.targets.includes(target)) {
      setGenerated(unavailable(`${selected.name} is not emitted for ${target}.`));
      return () => { current = false; };
    }
    setGenerated(Object.freeze({ state: 'loading', summary: `Loading ${target} from epoch ${epoch.id}…` }));
    void client.generated(epoch.id, target, selected.id).then(
      (document) => { if (current) setGenerated(Object.freeze({ document, state: 'ready' })); },
      (reason) => {
        if (!current) return;
        const summary = reason instanceof SkillClientError && reason.code === 'SKILL_TARGET_UNAVAILABLE'
          ? reason.message
          : `Generated Skill is unavailable: ${errorMessage(reason)}`;
        setGenerated(unavailable(summary));
      },
    );
    return () => { current = false; };
  }, [client, epoch?.id, selected?.id, target]);

  return <div className="skills-layout">
    {tree === undefined ? <aside className="skill-tree-pane"><p className="empty-row">Loading Skills…</p></aside> : (
      <SkillTree onSelect={setSelectedId} selectedId={selected?.id} tree={tree} />
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
      {tree !== undefined && tree.diagnostics.length > 0 ? <div className="skill-diagnostics" role="status">
        {tree.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}><strong>{diagnostic.code}</strong> {diagnostic.message}</p>)}
      </div> : undefined}
      {selected === undefined ? <p className="empty-row">Select a normalized Skill to inspect its documentation.</p> : (
        <SkillDocumentPanel generated={generated} onTabChange={setTab} selected={selected} tab={tab} />
      )}
    </div>
  </div>;
};
