import { basename } from 'node:path';

import { Hook } from '../runtime/elements.js';
import { Mcp } from '../runtime/elements.js';
import type { RuntimeSnapshot } from '../runtime/contracts.js';
import { useEdit, useRuntimeSnapshot } from '../runtime/request-context.js';

export const AfterFileEdit = () => {
  const edit = useEdit();
  const snapshot = useRuntimeSnapshot();
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
  <Mcp.Result structuredContent={snapshot}>
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
