import { createElement, type PropsWithChildren, type ReactElement } from 'react';

const Result = ({ children }: PropsWithChildren): ReactElement =>
  createElement('agent-hook-result', null, children);

const AdditionalContext = ({ children }: PropsWithChildren): ReactElement =>
  createElement('agent-hook-additional-context', null, children);

export const Hook = { AdditionalContext, Result };
