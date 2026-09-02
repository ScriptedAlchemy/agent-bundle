import { Agent } from '@agent-bundle/runtime';
import React from 'react';

export interface Field {
  readonly label: string;
  readonly value: boolean | number | string;
}

export interface DataListProps {
  readonly fields: readonly Field[];
}

export const DataList = ({ fields }: DataListProps) => (
  <Agent.Markdown>
    {fields.map(({ label, value }) => `- **${label}:** ${String(value).replaceAll(/\s*\n\s*/gu, ' ')}`).join('\n')}
  </Agent.Markdown>
);

export interface FileListProps {
  readonly files: readonly string[];
}

export const FileList = ({ files }: FileListProps) => (
  <Agent.Markdown>{files.map((file) => `- ${file}`).join('\n')}</Agent.Markdown>
);

export interface CalloutProps {
  readonly children: string;
  readonly tone: 'error' | 'review' | 'warning';
}

export const Callout = ({ children, tone }: CalloutProps) => {
  switch (tone) {
    case 'review':
      return <Agent.Context>{children}</Agent.Context>;
    case 'warning':
      return <Agent.Context>{`Warning: ${children}`}</Agent.Context>;
    case 'error':
      return <Agent.Error code="curator-report">{children}</Agent.Error>;
    default: {
      const unhandled: never = tone;
      throw new Error(`Unhandled callout tone: ${String(unhandled)}`);
    }
  }
};
