import { Agent, MarkdownContent } from '@agent-bundle/runtime';
import React from 'react';

export interface Field {
  readonly label: string;
  readonly value: boolean | number | string;
}

export interface DataListProps {
  readonly fields: readonly Field[];
}

const singleLine = (value: Field['value']): string => String(value).replaceAll(/\s*\n\s*/gu, ' ');

export const DataList = ({ fields }: DataListProps) => (
  <MarkdownContent>
    <ul>
      {fields.map(({ label, value }) => (
        <li key={label}>
          <strong>{label}:</strong> {singleLine(value)}
        </li>
      ))}
    </ul>
  </MarkdownContent>
);

export interface FileListProps {
  readonly files: readonly string[];
}

export const FileList = ({ files }: FileListProps) => (
  <MarkdownContent>
    <ul>
      {files.map((file) => <li key={file}>{file}</li>)}
    </ul>
  </MarkdownContent>
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
