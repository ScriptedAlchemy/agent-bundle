import { basename } from 'node:path';

import { Hook } from '../runtime/elements.js';
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
