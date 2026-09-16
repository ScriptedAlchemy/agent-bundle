import { basename } from 'node:path';

import { Agent, agent } from '@agent-bundle/runtime';
import type { CanonicalPostToolUse, RuntimeSnapshot } from '../runtime/contracts.js';

const hookServices = async (): Promise<{ edit: CanonicalPostToolUse; snapshot: RuntimeSnapshot }> => {
  const context = await agent();
  const edit = context.services.edit;
  const snapshot = context.services.snapshot;
  if (edit === undefined || snapshot === undefined) {
    throw new Error('Hook render requires edit and snapshot services');
  }
  return {
    edit: edit as CanonicalPostToolUse,
    snapshot: snapshot as RuntimeSnapshot,
  };
};

export const AfterFileEdit = async () => {
  const { edit, snapshot } = await hookServices();
  const editCount = snapshot.stateVersion;
  const editNoun = editCount === 1 ? 'edit' : 'edits';

  return (
    <Agent.Result>
      <Agent.Text>
        {`Recorded ${basename(edit.path)} from ${edit.host}. Shared state now contains ${editCount} ${editNoun}.`}
      </Agent.Text>
    </Agent.Result>
  );
};

export const RenderEditTimeline = ({ snapshot }: { snapshot: RuntimeSnapshot }) => (
  <Agent.Result value={{ edits: snapshot.edits.map((edit) => ({ ...edit })), stateVersion: snapshot.stateVersion }}>
    <Agent.Text>{`Showing ${snapshot.edits.length} recorded edits.`}</Agent.Text>
  </Agent.Result>
);

const STATUS_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

export const RuntimeStatus = ({ snapshot }: { snapshot: RuntimeSnapshot }) => {
  const editCount = snapshot.edits.length;
  const editNoun = editCount === 1 ? 'edit' : 'edits';

  return (
    <Agent.Result value={{ editCount, stateVersion: snapshot.stateVersion }}>
      <Agent.Text>{`Runtime state contains ${editCount} ${editNoun}.`}</Agent.Text>
      <Agent.Image data={STATUS_PNG_BASE64} mimeType="image/png" />
    </Agent.Result>
  );
};
