import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { AudibleSearchReceipt, AudibleSelectionReceipt } from '../audible.ts';
import type { AcousticIdentifyReceipt } from '../evidence.ts';
import { EditionCard } from './audiobook-card.tsx';
import { Callout, DataList } from './primitives.tsx';
import { editionCardModel } from './view-models.ts';

export interface SearchRankingProps {
  readonly receipt: AudibleSearchReceipt;
}

export interface IdentifyRankingProps {
  readonly receipt: AcousticIdentifyReceipt;
}

export interface SelectionRankingProps {
  readonly receipt: AudibleSelectionReceipt;
}

const maximumCandidates = 10;

export const SearchRanking = ({ receipt }: SearchRankingProps) => (
  <>
    <DataList fields={[
      { label: 'Candidates', value: receipt.candidates.length },
      { label: 'Regions with errors', value: receipt.errors.length },
      { label: 'Query', value: receipt.query.title },
    ]} />
    {receipt.candidates.slice(0, maximumCandidates).map((candidate, index) => (
      <React.Fragment key={`${candidate.region}/${String(candidate.asin ?? index)}`}>
        <Agent.Markdown>
          {`## Rank ${String(index + 1)} · score ${String(candidate.evidence.score)} · ${candidate.region}`}
        </Agent.Markdown>
        <EditionCard {...editionCardModel(candidate)} />
      </React.Fragment>
    ))}
    {receipt.candidates.length > maximumCandidates
      ? <Agent.Markdown>{`_+${String(receipt.candidates.length - maximumCandidates)} more candidates retained in the structured receipt._`}</Agent.Markdown>
      : null}
    {receipt.errors.map((row, index) => (
      <Callout key={`${row.region}/${String(index)}`} tone="warning">{`${row.region}: ${row.error}`}</Callout>
    ))}
    <Callout tone="review">{receipt.reviewNote}</Callout>
  </>
);

export const IdentifyRanking = ({ receipt }: IdentifyRankingProps) => (
  <>
    <DataList fields={[
      { label: 'Candidate attempts', value: receipt.attempts.length },
      { label: 'Top requested', value: receipt.top },
      { label: 'Stopped on match', value: receipt.stopOnMatch },
    ]} />
    {receipt.attempts.slice(0, maximumCandidates).map((attempt, index) => (
      <React.Fragment key={`${String(attempt.asin ?? 'candidate')}/${String(index)}`}>
        <Agent.Markdown>
          {`## Attempt ${String(index + 1)} · score ${String(attempt.score ?? 'unavailable')} · ${String(attempt.region ?? 'unknown region')} · ${String(attempt.status ?? 'unknown status')}`}
        </Agent.Markdown>
        <EditionCard {...editionCardModel(attempt)} />
      </React.Fragment>
    ))}
    {receipt.attempts.length > maximumCandidates
      ? <Agent.Markdown>{`_+${String(receipt.attempts.length - maximumCandidates)} more attempts retained in the structured receipt._`}</Agent.Markdown>
      : null}
    <Callout tone="review">{receipt.reviewNote}</Callout>
  </>
);

export const SelectionRanking = ({ receipt }: SelectionRankingProps) => (
  <>
    <DataList fields={[
      { label: 'Selected rank', value: receipt.candidateNumber },
      { label: 'Score', value: receipt.selected.evidence.score },
      { label: 'Region', value: receipt.selected.region },
    ]} />
    <EditionCard {...editionCardModel(receipt.selected)} />
    <Callout tone="review">{receipt.reviewNote ?? 'The selected Audible edition was explicitly human-reviewed.'}</Callout>
  </>
);
