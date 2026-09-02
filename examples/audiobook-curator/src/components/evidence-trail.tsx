import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { AcousticIdentifyReceipt, AcousticReceipt, WhisperReceipt } from '../evidence.ts';
import { Callout, DataList } from './primitives.tsx';

type EvidenceReceipt = AcousticIdentifyReceipt | AcousticReceipt | WhisperReceipt;

export interface EvidenceTrailProps {
  readonly receipt: EvidenceReceipt;
}

const acousticTrail = (receipt: AcousticReceipt) => (
  <>
    <DataList fields={[
      { label: 'File', value: receipt.file },
      { label: 'Audible edition', value: `${receipt.region}/${receipt.asin}` },
      { label: 'Recording matched', value: receipt.verifiedRecording },
    ]} />
    <Agent.Markdown>
      {[
        '## Acoustic evidence trail',
        '',
        `1. Retrieved the reviewed ${receipt.region} Audible sample for ${receipt.asin}.`,
        `2. Compared the sample fingerprint with ${receipt.file}.`,
        `3. Matcher outcome: **${receipt.verifiedRecording ? 'same recording verified' : 'no match'}**.`,
        '',
        '```json',
        JSON.stringify(receipt.fingerprint, null, 2),
        '```',
      ].join('\n')}
    </Agent.Markdown>
    <Callout tone="review">
      {receipt.verifiedRecording
        ? 'Verified recording evidence: the local audio matched the reviewed Audible sample.'
        : 'Review required: the local audio did not match the reviewed Audible sample.'}
    </Callout>
  </>
);

const identifyTrail = (receipt: AcousticIdentifyReceipt) => (
  <>
    <Agent.Markdown>
      {[
        '## Acoustic attempt timeline',
        '',
        ...receipt.attempts.map((attempt, index) => (
          `${String(index + 1)}. ${String(attempt.region ?? 'unknown')}/${String(attempt.asin ?? 'missing ASIN')} — **${String(attempt.status ?? 'unknown')}**${attempt.reason === undefined ? '' : `: ${String(attempt.reason)}`}`
        )),
      ].join('\n')}
    </Agent.Markdown>
    <Callout tone="review">
      {receipt.verifiedRecording
        ? `Verified recording evidence: ${String(receipt.identified?.region ?? 'unknown')}/${String(receipt.identified?.asin ?? 'unknown')} matched acoustically.`
        : 'Review required: none of the attempted Audible candidates matched acoustically.'}
    </Callout>
  </>
);

const whisperTrail = (receipt: WhisperReceipt) => (
  <>
    <DataList fields={[
      { label: 'File', value: receipt.file },
      { label: 'Usable windows', value: `${String(receipt.usableWindows)} / ${String(receipt.maxWindows)}` },
      { label: 'Language requested', value: receipt.requestedLanguage },
      { label: 'Transcript status', value: receipt.status },
    ]} />
    <Agent.Markdown>
      {[
        '## Transcript evidence timeline',
        '',
        ...receipt.windows.map((window) => (
          `${String(window.index)}. ${window.startSeconds.toFixed(1)}s–${(window.startSeconds + window.sampleSeconds).toFixed(1)}s · ${window.usable ? 'usable' : 'insufficient'}\n   > ${window.text === '' ? '_No transcript text_' : window.text.replaceAll(/\s+/gu, ' ')}`
        )),
      ].join('\n')}
    </Agent.Markdown>
    <Callout tone="review">
      {`${receipt.status === 'transcript-ready' ? 'Transcript evidence is ready for review.' : 'Review required because too few spoken windows were usable.'} ${receipt.review}`}
    </Callout>
  </>
);

export const EvidenceTrail = ({ receipt }: EvidenceTrailProps) => {
  switch (receipt.operation) {
    case 'audiolocate':
      return acousticTrail(receipt);
    case 'acoustic-identify':
      return identifyTrail(receipt);
    case 'whisper-identity':
      return whisperTrail(receipt);
    default: {
      const unhandled: never = receipt;
      throw new Error(`Unhandled evidence trail: ${JSON.stringify(unhandled)}`);
    }
  }
};
