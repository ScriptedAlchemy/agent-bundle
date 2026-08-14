import React, { useState } from 'react';
import { useApp } from '@modelcontextprotocol/ext-apps/react';

import type { EditEvent } from '../runtime/contracts.js';

type TimelineState = { stateVersion: number; edits: EditEvent[] };
export type RefreshState = 'idle' | 'refreshing' | 'error';

const standaloneTimeline: TimelineState = {
  edits: [
    {
      eventId: 'concept-1',
      host: 'claude',
      path: 'src/runtime/state.ts',
      recordedAt: '2026-08-14T10:24:31.000Z',
      sessionId: 'concept',
      toolName: 'Write',
    },
    {
      eventId: 'concept-2',
      host: 'codex',
      path: 'src/widget/App.tsx',
      recordedAt: '2026-08-14T10:21:07.000Z',
      sessionId: 'concept',
      toolName: 'Edit',
    },
    {
      eventId: 'concept-3',
      host: 'claude',
      path: 'README.md',
      recordedAt: '2026-08-14T10:17:42.000Z',
      sessionId: 'concept',
      toolName: 'Read',
    },
  ],
  stateVersion: 3,
};

const asTimelineState = (value: unknown): TimelineState | undefined => {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const state = value as Record<string, unknown>;
  if (!Number.isInteger(state.stateVersion) || !Array.isArray(state.edits)) {
    return undefined;
  }

  const edits = state.edits.filter(
    (edit): edit is EditEvent =>
      edit !== null &&
      typeof edit === 'object' &&
      typeof (edit as Record<string, unknown>).eventId === 'string' &&
      ((edit as Record<string, unknown>).host === 'claude' || (edit as Record<string, unknown>).host === 'codex') &&
      typeof (edit as Record<string, unknown>).path === 'string' &&
      typeof (edit as Record<string, unknown>).recordedAt === 'string' &&
      typeof (edit as Record<string, unknown>).sessionId === 'string' &&
      typeof (edit as Record<string, unknown>).toolName === 'string',
  );

  return edits.length === state.edits.length ? { edits, stateVersion: state.stateVersion as number } : undefined;
};

const displayTime = (recordedAt: string): string =>
  new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: true,
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(recordedAt));

export const RefreshStatus = ({ refresh }: { refresh: RefreshState }) => {
  const message =
    refresh === 'refreshing' ? 'Refreshing timeline.' : refresh === 'error' ? 'Unable to refresh timeline.' : '';

  return (
    <p aria-live="polite" className="timeline__status" role="status">
      {message}
    </p>
  );
};

export const App = () => {
  const standalone = window.parent === window;
  const [timeline, setTimeline] = useState<TimelineState>(standalone ? standaloneTimeline : { edits: [], stateVersion: 0 });
  const [refresh, setRefresh] = useState<RefreshState>('idle');
  const { app } = useApp({
    appInfo: { name: 'rsc-agent-runtime-timeline', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = (result) => {
        const state = asTimelineState(result.structuredContent);
        if (state !== undefined) {
          setTimeline(state);
          setRefresh('idle');
        }
      };
    },
  });

  const refreshTimeline = async (): Promise<void> => {
    setRefresh('refreshing');
    if (standalone) {
      setTimeline((state) => ({ ...state, stateVersion: state.stateVersion + 1 }));
      setRefresh('idle');
      return;
    }

    if (app === null) {
      setRefresh('error');
      return;
    }

    try {
      const result = await app.callServerTool({ name: 'recent_edits', arguments: { limit: 10 } });
      const state = asTimelineState(result.structuredContent);
      if (state === undefined) {
        throw new Error('The runtime returned an invalid timeline.');
      }

      setTimeline(state);
      setRefresh('idle');
    } catch {
      setRefresh('error');
    }
  };

  return (
    <main className="timeline" aria-live="polite">
      <header className="timeline__header">
        <div>
          <h1>Runtime edit timeline</h1>
          <p>Hook events, shared across processes.</p>
        </div>
        <button type="button" onClick={refreshTimeline} disabled={refresh === 'refreshing'}>
          Refresh
        </button>
      </header>
      <RefreshStatus refresh={refresh} />

      {timeline.edits.length === 0 ? (
        <p className="timeline__empty">No file edits recorded yet.</p>
      ) : (
        <ol className="timeline__events">
          {timeline.edits.map((edit) => (
            <li key={edit.eventId} className="timeline__event">
              <div className="timeline__node" aria-hidden="true" />
              <p className="timeline__path">{edit.path}</p>
              <div className="timeline__details">
                <span>{edit.host === 'claude' ? 'Claude' : 'Codex'}</span>
                <span aria-hidden="true">|</span>
                <span>{edit.toolName}</span>
                <time dateTime={edit.recordedAt}>{displayTime(edit.recordedAt)}</time>
              </div>
            </li>
          ))}
        </ol>
      )}

      <footer>State version {timeline.stateVersion}</footer>
    </main>
  );
};
