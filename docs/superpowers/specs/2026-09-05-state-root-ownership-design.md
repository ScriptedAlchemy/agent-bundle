# State Root Ownership Design

## Goal

Make state discovery informative and state deletion receipt-owned. A runtime
location is not deletion authority: `uninstall --purge-data` removes only the
subtrees this installation exclusively owns and retains every shared,
externally managed, unproven, or foreign-marked root.

Tracking issue: #644. Architectural context: #592.

## Three Separate Facts

1. **Runtime location** — the effective state root for each MCP server, using
   that server's declared environment and execution cwd with the same
   `resolvePluginRoot` semantics as `@agent-bundle/runtime`.
2. **Installation record** — the immutable set of per-server locations
   observed and persisted when this installation was created or replaced.
   An environment change during uninstall may change the current runtime
   observation, but never the recorded deletion candidates.
3. **Exclusive ownership** — evidence that authorizes recursive deletion of
   one recorded root. Discovery, a manifest declaration, or an environment
   variable is never ownership evidence by itself.

## Receipt Model

The format-2 receipt gains an optional frozen `state` object:

```ts
interface InstallReceiptState {
  readonly owner: {
    readonly id: string;
    readonly host: InstallHost;
    readonly mode: InstallReceiptMode;
    readonly plugin: string;
    readonly scope: InstallReceiptScope;
    readonly projectRoot?: string;
  };
  readonly roots: readonly InstallReceiptStateRoot[];
}

interface InstallReceiptStateRoot {
  readonly canonicalRoot: string;
  readonly ownership:
    | { readonly kind: 'derived' }
    | { readonly kind: 'marker'; readonly marker: string }
    | {
        readonly kind: 'unowned';
        readonly reason: 'foreign-marker' | 'pre-existing' | 'unproven';
      };
  readonly root: string;
  readonly servers: readonly string[];
  readonly source: 'declared' | 'derived';
}
```

Roots are deduplicated by resolved path while preserving every server name.
The owner id is a random UUID created once and retained across replacement,
`--keep-data` remnants, and receipt migration. Existing receipts without
`state` remain readable but authorize no external deletion.

## Runtime Resolution

State resolution reads every server in the installed host MCP document. For
each server:

- expand only the host/plugin-root tokens that the host expands;
- resolve its `cwd` first;
- pass the server environment, root fallback, user-data state anchor, home,
  and resolved execution cwd through a local packaging-safe equivalent of
  `resolvePluginRoot`;
- resolve relative `AGENT_BUNDLE_STATE_ROOT` against the execution cwd, as
  Node's `resolve()` does inside the runtime process;
- retain unresolved token values or a relative value without a provable cwd
  as an unproven runtime observation, never an owned root.

Declared server environment wins for that server. The current process
environment may be shown by Doctor as a current observation but is never
added to the receipt at uninstall time and never creates purge authority.

## Ownership Acquisition

The default user-data root
`<state-home>/agent-bundle/<plugin>-<digest16>` is exclusive by construction.
Installation records its lexical path and the canonical path obtained by
resolving the real state-home ancestor.

An explicit root is owned only when all of these are true:

1. it did not exist before installation;
2. the installer created the directory;
3. the installer atomically created
   `.agent-bundle-state-owner.json` inside it;
4. the marker names the same owner id and install identity as the receipt.

A pre-existing directory is recorded as `unowned: pre-existing`. A
marker-less directory is `unowned: unproven`. A marker naming another owner
is `unowned: foreign-marker`. Install never rewrites an override to a child
directory.

Marker creation is rolled back if installation or receipt persistence fails:
remove only the marker created by this attempt, then remove its directory only
if empty.

## Purge

`--plan` and confirmed purge operate only on receipt `state.roots`.

- `derived`: require the current lexical root to resolve to the recorded
  canonical root and require the leaf to be a real directory, not a symlink.
- `marker`: require the same canonical-root check and an exact marker identity
  match.
- `unowned`: retain with its recorded reason.
- missing roots: report absent; do not broaden the candidate.
- changed symlink ancestors, leaf symlinks, malformed markers, and foreign
  markers: retain with a safety reason.

Recursive deletion targets the validated root itself. It never targets an
override's parent or any shared base. Unrelated sentinels outside the owned
root therefore survive.

`--keep-data` carries the full state record into the remnant receipt. A later
purge applies the same evidence without rereading a removed manifest or the
caller's current environment.

Legacy `<plugin>/state` and receipted Cursor `PLUGIN_DATA` keep their existing
separate ownership rules. Web-data remains a distinct derived root and must
also be receipt-recorded before it is purgeable.

## Doctor

Doctor reports, per deduplicated root:

- servers using the root;
- current runtime location and source;
- whether it matches a receipt record;
- ownership (`derived`, `marker`, or `unowned` plus reason);
- existence and writability;
- purgeability and any failed evidence check.

Doctor continues to report legacy state separately. A new informational or
warning diagnostic is added only when needed to make retained/unproven state
machine-readable, and is documented in `docs/diagnostics.md`.

## Generated Installer

The emitted `install.mjs` uses the same receipt schema, marker format,
resolution rules, validation, plan output, keep-data remnant behavior, and
purge decisions. It remains self-contained and imports only Node built-ins.

## Tests

Temporary-directory tests cover:

- install environment differs from uninstall environment;
- two installations reference one configured base and unrelated sentinels
  survive;
- two servers declare different roots;
- relative overrides resolve against each server execution cwd;
- unchanged and changed symlink ancestors;
- foreign and missing markers;
- `--keep-data` followed by later purge;
- Doctor ownership and purgeability rows;
- generated installer parity;
- packed state-writing behavior.

All destructive tests place an unrelated sentinel outside each owned subtree
and assert that it survives.
