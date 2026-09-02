import React from 'react';

import { Callout, FileList } from './primitives.tsx';

export interface CandidateGroupCalloutProps {
  readonly files: readonly string[];
  readonly identityKey: string;
  readonly kind: 'duplicate' | 'multipart';
  readonly reviewNote: string;
}

const candidateGroupLabel = {
  duplicate: 'Duplicate candidate group',
  multipart: 'Multipart candidate group',
} as const;

export const CandidateGroupCallout = ({
  files,
  identityKey,
  kind,
  reviewNote,
}: CandidateGroupCalloutProps) => (
  <>
    <Callout tone="review">
      {`${candidateGroupLabel[kind]} ${identityKey}. ${reviewNote}`}
    </Callout>
    <FileList files={files} />
  </>
);
