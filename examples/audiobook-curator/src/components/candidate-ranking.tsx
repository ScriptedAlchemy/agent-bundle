import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { AudibleSearchReceipt, AudibleSelectionReceipt } from '../audible.ts';
import type { AcousticIdentifyReceipt } from '../evidence.ts';
import { AudiobookCard } from './audiobook-card.tsx';
import { Callout, DataList } from './primitives.tsx';

type RankingReceipt = AcousticIdentifyReceipt | AudibleSearchReceipt | AudibleSelectionReceipt;

export interface CandidateRankingProps {
  readonly receipt: RankingReceipt;
}

const maximumCandidates = 10;

const searchRanking = (receipt: AudibleSearchReceipt) => (
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
        <AudiobookCard edition={candidate} kind="edition" />
      </React.Fragment>
    ))}
    {receipt.candidates.length > maximumCandidates
      ? <Agent.Markdown>{`_+${String(receipt.candidates.length - maximumCandidates)} more candidates retained in the structured receipt._`}</Agent.Markdown>
      : null}
    {receipt.errors.length > 0
      ? <Callout tone="warning">{receipt.errors.map((row) => `${row.region}: ${row.error}`).join('; ')}</Callout>
      : null}
    <Callout tone="review">{receipt.reviewNote}</Callout>
  </>
);

const identifyRanking = (receipt: AcousticIdentifyReceipt) => (
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
        <AudiobookCard edition={attempt} kind="edition" />
      </React.Fragment>
    ))}
    {receipt.attempts.length > maximumCandidates
      ? <Agent.Markdown>{`_+${String(receipt.attempts.length - maximumCandidates)} more attempts retained in the structured receipt._`}</Agent.Markdown>
      : null}
    <Callout tone="review">{receipt.reviewNote}</Callout>
  </>
);

const selectionRanking = (receipt: AudibleSelectionReceipt) => (
  <>
    <DataList fields={[
      { label: 'Selected rank', value: receipt.candidateNumber },
      { label: 'Score', value: receipt.selected.evidence.score },
      { label: 'Region', value: receipt.selected.region },
    ]} />
    <AudiobookCard edition={receipt.selected} kind="edition" />
    <Callout tone="review">{receipt.reviewNote ?? 'The selected Audible edition was explicitly human-reviewed.'}</Callout>
  </>
);

export const CandidateRanking = ({ receipt }: CandidateRankingProps) => {
  switch (receipt.operation) {
    case 'audible-search':
      return searchRanking(receipt);
    case 'acoustic-identify':
      return identifyRanking(receipt);
    case 'audible-select':
      return selectionRanking(receipt);
    default: {
      const unhandled: never = receipt;
      throw new Error(`Unhandled candidate ranking: ${JSON.stringify(unhandled)}`);
    }
  }
};
