import { basename } from 'node:path';

import { Hook, Mcp, agent } from '@agent-bundle/rsc-runtime';
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
    <Hook.Result>
      <Hook.AdditionalContext>
        {`Recorded ${basename(edit.path)} from ${edit.host}. Shared state now contains ${editCount} ${editNoun}.`}
      </Hook.AdditionalContext>
    </Hook.Result>
  );
};

export const RenderEditTimeline = ({ snapshot }: { snapshot: RuntimeSnapshot }) => (
  <Mcp.Result structuredContent={{ edits: snapshot.edits, stateVersion: snapshot.stateVersion }}>
    <Mcp.Text>{`Showing ${snapshot.edits.length} recorded edits.`}</Mcp.Text>
  </Mcp.Result>
);

const STATUS_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

export const RuntimeStatus = ({ snapshot }: { snapshot: RuntimeSnapshot }) => {
  const editCount = snapshot.edits.length;
  const editNoun = editCount === 1 ? 'edit' : 'edits';

  return (
    <Mcp.Result structuredContent={{ editCount, stateVersion: snapshot.stateVersion }}>
      <Mcp.Text>{`Runtime state contains ${editCount} ${editNoun}.`}</Mcp.Text>
      <Mcp.Image data={STATUS_PNG_BASE64} mimeType="image/png" />
    </Mcp.Result>
  );
};
