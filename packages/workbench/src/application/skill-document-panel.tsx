/**
 * The rendered Skill document (#600), lifted from the deleted Skills page: the
 * authored SKILL.md or the immutable host-generated document for one target,
 * rendered or as raw Markdown. The frontmatter, resource tree, eval coverage,
 * and source/generated comparison are separate panels the skill workspace
 * mounts in its inspector drawer.
 */
import React, { useRef } from 'react';

import type { ServedSkillDocument } from '../../../agent-bundle/src/contracts/skills.ts';
import { SkillMarkdown } from '../skill-markdown.tsx';
import type { SkillEvalCoverageState } from '../skills-eval-coverage.ts';
import { resourceUrlFor } from '../skills-model.ts';
import './workspace.css';

export type SkillDocumentKind = 'generated' | 'source';

export type SkillView = 'markdown' | 'rendered';

const documentTabs = ['source', 'generated'] as const;

const viewTabs = ['rendered', 'markdown'] as const;

const tabKey = (skillId: string): string => `skill-${skillId.replace(/^skill:/u, '').replaceAll(/[^a-z0-9_-]+/giu, '-').replaceAll(/^-+|-+$/gu, '')}`;

const tabIdFor = (skillId: string, group: 'document' | 'view', tab: string): string =>
  `${tabKey(skillId)}-${group}-tab-${tab}`;

const panelIdFor = (skillId: string): string => `${tabKey(skillId)}-panel`;

export interface SkillDocumentPanelProps {
  readonly document: SkillDocumentKind;
  readonly onDocumentChange: (document: SkillDocumentKind) => void;
  readonly onTargetChange?: (target: string) => void;
  readonly onViewChange: (view: SkillView) => void;
  readonly selected?: ServedSkillDocument;
  /** Shown in place of a document while one is loading or unavailable. */
  readonly summary?: string;
  readonly target?: string;
  readonly targetNames?: readonly string[];
  readonly translationSummary?: string;
  readonly view: SkillView;
}

const resourcePaths = (document: ServedSkillDocument): readonly string[] =>
  document.resources.map((resource) => resource.relativePath);

/** The Skill's declared resources with links to the served copies. */
export const SkillResourceTree = ({ document }: { readonly document: ServedSkillDocument }): React.ReactNode => {
  const resources = resourcePaths(document);
  return <section aria-label="Resource tree" className="skill-resource-tree">
    <h3>Resource tree</h3>
    {document.resources.length === 0 ? <p className="inspector-empty">This Skill has no declared resources.</p> : <ul>
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

/** Which authored eval cases reference this Skill, and how. */
export const SkillEvalCoverage = ({ coverage }: { readonly coverage: SkillEvalCoverageState }): React.ReactNode => (
  <section aria-label="Eval coverage" className="skill-eval-coverage">
    <h3>Eval coverage</h3>
    {coverage.state === 'loading' ? <p className="inspector-empty" role="status">Loading eval coverage…</p>
      : coverage.state === 'unavailable' ? <p className="inspector-empty" role="status">{coverage.summary}</p>
        : coverage.coverage.entries.length === 0
          ? <p className="inspector-empty">No authored eval cases reference this Skill.</p>
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

/** Parsed frontmatter plus document identity (id, build, target, provenance). */
export const SkillFrontmatter = ({ selected }: { readonly selected: ServedSkillDocument }): React.ReactNode => <>
  <dl aria-label="Parsed frontmatter" className="skill-frontmatter">
    {Object.entries(selected.frontmatter).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => (
      <div key={name}><dt>{name}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>
    ))}
  </dl>
  <h3>Document details</h3>
  <dl className="inspector-rows">
    <div><dt>Document ID</dt><dd className="identifier">{selected.id}</dd></div>
    {selected.base.kind === 'generated' ? <>
      <div><dt>Build ID</dt><dd className="identifier">{selected.base.epochId}</dd></div>
      <div><dt>Generated target</dt><dd>{selected.base.target}</dd></div>
    </> : <div><dt>Provenance</dt><dd>{selected.provenance?.kind ?? 'source'}</dd></div>}
  </dl>
  {selected.diagnostics.length === 0 ? undefined : <div className="skill-diagnostics" role="status">
    {selected.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}>
      <strong>{diagnostic.code}</strong> {diagnostic.message}
    </p>)}
  </div>}
</>;

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
  ? `Generated for ${selected.base.target}`
  : 'Authored SKILL.md';

const provenanceLabel = (selected: ServedSkillDocument): string => selected.base.kind === 'generated'
  ? `Generated for ${selected.base.target}`
  : 'Authored';

export interface SkillGenerationSummary {
  readonly kind: 'identical' | 'modified';
  readonly message: string;
}

export const skillGenerationSummaryFor = (
  source: ServedSkillDocument,
  generated: ServedSkillDocument,
  target: string,
): SkillGenerationSummary => source.markdown === generated.markdown
  ? Object.freeze({
    kind: 'identical',
    message: `This target keeps the authored instructions unchanged. Agent Bundle only changes the ${target} package layout.`,
  })
  : Object.freeze({
    kind: 'modified',
    message: `Generated output differs from the authored Skill for ${target}. Review the generated document before shipping.`,
  });

const SkillDocumentTabs = ({ document, onDocumentChange, panelId, skillId }: {
  readonly document: SkillDocumentKind;
  readonly onDocumentChange: (document: SkillDocumentKind) => void;
  readonly panelId: string;
  readonly skillId: string;
}) => {
  const buttons = useRef<Partial<Record<SkillDocumentKind, HTMLButtonElement | null>>>({});
  const selectDocument = (next: SkillDocumentKind): void => {
    onDocumentChange(next);
    buttons.current[next]?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: SkillDocumentKind): void => {
    const next = nextTab(documentTabs, current, event);
    if (next !== undefined) selectDocument(next);
  };

  return <div aria-label="Skill document" className="skill-tabs skill-tabs--document" role="tablist">
    {documentTabs.map((candidate) => (
      <button
        aria-controls={panelId}
        aria-selected={document === candidate}
        className={document === candidate ? 'skill-tab skill-tab--active' : 'skill-tab'}
        id={tabIdFor(skillId, 'document', candidate)}
        key={candidate}
        onClick={() => selectDocument(candidate)}
        onKeyDown={(event) => onKeyDown(event, candidate)}
        ref={(element) => { buttons.current[candidate] = element; }}
        role="tab"
        tabIndex={document === candidate ? 0 : -1}
        type="button"
      >
        {candidate[0]!.toUpperCase()}{candidate.slice(1)}
      </button>
    ))}
  </div>;
};

/** The selected served Skill document and its rendered or raw Markdown view. */
export const SkillDocumentPanel = ({
  document,
  onDocumentChange,
  onTargetChange,
  onViewChange,
  selected,
  summary,
  target,
  targetNames = [],
  translationSummary,
  view,
}: SkillDocumentPanelProps) => {
  const viewTabButtons = useRef<Partial<Record<SkillView, HTMLButtonElement | null>>>({});
  const selectView = (next: SkillView): void => {
    onViewChange(next);
    viewTabButtons.current[next]?.focus();
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
    {selected === undefined ? undefined : <div className="skill-detail-heading">
      <div>
        <p className="skill-eyebrow">Skill document</p>
        <h2>{selected.name}</h2>
        {selected.description === undefined ? undefined : <p className="skill-description">{selected.description}</p>}
      </div>
      <span className="skill-provenance">{provenanceLabel(selected)}</span>
    </div>}
    <div className="skill-controls">
      <div className="skill-control-group">
        <span className="skill-control-label">Document</span>
        <SkillDocumentTabs document={document} onDocumentChange={onDocumentChange} panelId={panelId} skillId={selectedId} />
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
      data-testid="rendered-document"
      id={panelId}
      role="tabpanel"
      tabIndex={0}
    >
      {selected === undefined ? <p className="empty-row" role="status">{summary ?? 'Select a Skill to inspect its documentation.'}</p> : <>
        <p className="skill-base-label">{documentLabel(selected)}</p>
        {translationSummary === undefined ? undefined : <p className="skill-translation-note">{translationSummary}</p>}
        {view === 'rendered'
          ? <SkillMarkdown base={selected.base} body={selected.body} resources={resourcePaths(selected)} />
          : <pre className="skill-source"><code>{selected.markdown}</code></pre>}
      </>}
    </section>
  </section>;
};
