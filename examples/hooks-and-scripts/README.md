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
2. Open **Playground** and run `succeed`. Its trace contains stdout, stderr, and
   a zero exit code.
3. Run `fail`. Its trace contains `example failure` and exit code 2.
4. Open **Logs** to filter the emitted records by producer, level, kind, or
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

```bash
pnpm --filter @agent-bundle-example/hooks-and-scripts check
```
