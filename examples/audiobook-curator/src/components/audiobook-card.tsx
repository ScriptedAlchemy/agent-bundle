import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import { DataList, type Field } from './primitives.tsx';
import type { EditionCardProps, FileCardProps } from './view-models.ts';

export type { EditionCardProps, FileCardProps } from './view-models.ts';

const seconds = (value: number): string => {
  const rounded = Math.max(0, Math.round(value));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor(rounded % 3600 / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${String(hours)}h ${String(minutes)}m ${String(remaining)}s`
    : `${String(minutes)}m ${String(remaining)}s`;
};

interface CardCoreProps {
  readonly fields: readonly Field[];
  readonly title: string;
}

const CardCore = ({ fields, title }: CardCoreProps) => (
  <>
    <Agent.Markdown>{`### ${title}`}</Agent.Markdown>
    <DataList fields={fields} />
  </>
);

export const FileCard = ({
  author,
  durationSeconds,
  format,
  narrator,
  path,
  title,
}: FileCardProps) => {
  const fields: Field[] = [
    { label: 'File', value: path },
    ...(author === undefined ? [] : [{ label: 'Author', value: author }]),
    ...(narrator === undefined ? [] : [{ label: 'Narrator', value: narrator }]),
    ...(durationSeconds === undefined ? [] : [{ label: 'Duration', value: seconds(durationSeconds) }]),
    ...(format === undefined ? [] : [{ label: 'Format', value: format }]),
  ];
  return <CardCore fields={fields} title={title} />;
};

export const EditionCard = ({
  asin,
  author,
  durationSeconds,
  format,
  narrator,
  region,
  title,
}: EditionCardProps) => {
  const fields: Field[] = [
    ...(author === undefined ? [] : [{ label: 'Author', value: author }]),
    ...(narrator === undefined ? [] : [{ label: 'Narrator', value: narrator }]),
    ...(durationSeconds === undefined ? [] : [{ label: 'Duration', value: seconds(durationSeconds) }]),
    ...(format === undefined ? [] : [{ label: 'Format', value: format }]),
    ...(region === undefined ? [] : [{ label: 'Region', value: region }]),
    ...(asin === undefined ? [] : [{ label: 'ASIN', value: asin }]),
  ];
  return <CardCore fields={fields} title={title} />;
};
