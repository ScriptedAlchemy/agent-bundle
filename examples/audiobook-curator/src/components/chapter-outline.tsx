import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { ConvertReceipt } from '../conversion.ts';
import type { IntegrityAuditReceipt } from '../integrity-audit.ts';
import type { ChapterReceipt } from '../media-mutation.ts';

type ChapterSourceReceipt = ChapterReceipt | ConvertReceipt | IntegrityAuditReceipt;

export interface ChapterOutlineProps {
  readonly receipt: ChapterSourceReceipt;
}

interface DisplayChapter {
  readonly endSeconds: number;
  readonly number: number;
  readonly startSeconds: number;
  readonly title: string;
}

const maximumChapters = 20;

const timestamp = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const remaining = total % 60;
  return [hours, minutes, remaining].map((value) => String(value).padStart(2, '0')).join(':');
};

const chaptersFor = (receipt: ChapterSourceReceipt): readonly DisplayChapter[] => {
  switch (receipt.operation) {
    case 'apply-chapters':
      return receipt.chapters.map((chapter, index) => ({ ...chapter, number: index + 1 }));
    case 'convert':
      return receipt.expectedChapters;
    case 'audit':
      return receipt.chapters;
    default: {
      const unhandled: never = receipt;
      throw new Error(`Unhandled chapter source: ${JSON.stringify(unhandled)}`);
    }
  }
};

export const ChapterOutline = ({ receipt }: ChapterOutlineProps) => {
  const chapters = chaptersFor(receipt);
  return (
    <Agent.Markdown>
      {[
        `## Chapter outline (${String(chapters.length)})`,
        '',
        ...chapters.slice(0, maximumChapters).map((chapter) => (
          `${String(chapter.number)}. **${chapter.title || 'Untitled chapter'}** · ${timestamp(chapter.startSeconds)}–${timestamp(chapter.endSeconds)}`
        )),
        ...(chapters.length > maximumChapters
          ? [`_+${String(chapters.length - maximumChapters)} more chapters retained in the structured receipt._`]
          : []),
      ].join('\n')}
    </Agent.Markdown>
  );
};
