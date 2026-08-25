# Hooks and Scripts

From the repository root, launch this example with:

```bash
pnpm example:hooks
```

The example is credential-free. It provides a real session-start Hook and two
scripts so the Workbench can show canonical Hook simulation, successful and
failed script traces, and live Logs.

## Workbench walkthrough

1. Open **Hooks**, select the Codex `sessionStart` binding, enter a canonical
   event with `"source": "workbench"`, and run the simulation. The result adds
   `example session from workbench` and continues the session.
2. Press **Replay saved simulation** to rerun the exact epoch-bound Hook input.
3. Open **Playground** and run `succeed`. Its trace contains stdout, stderr, and
   a zero exit code.
4. Run `fail`. Its trace contains `example failure` and exit code 2.
5. Open **Logs** to filter the emitted records by producer, level, kind, or
   context, then open a record to inspect its details.

## Reversible diagnostic walkthrough

The checked-in project is healthy. To see last-good artifact behavior, replace
the body of `src/hooks/session-start.ts` temporarily with:

```ts
export default () => ({
```

Press **Rebuild**. The Workbench reports the new diagnostic while retaining the
previous active artifact. Restore the checked-in handler, press **Rebuild**
again, and confirm that a new active epoch replaces the stale state and clears
the diagnostic.

## Noninteractive checks

After the repository-level `pnpm build`, run the same public commands directly
from the example package:

```bash
cd examples/hooks-and-scripts
pnpm validate
pnpm build
pnpm dev
```

Use `pnpm check` for the noninteractive validation-and-build pair.
