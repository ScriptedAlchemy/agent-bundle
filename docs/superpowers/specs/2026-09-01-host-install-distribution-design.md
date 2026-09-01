# Host Install and Distribution Design

## Status

Approved by the explicit implementation requirements in the host-install story.

## Goal

Every emitted target bundle explains an exact, evidence-backed installation
path. Claude and Codex use their public marketplace and install commands.
Cursor, which has no non-interactive plugin install command, uses a
framework-owned, safe local-plugin copy. Portable and composite bundles explain
which real hosts can consume them.

## Host contract

Pinned capability tables record an `install` section beside each host's plugin
contract:

- Claude: `claude plugin marketplace add ./`, then
  `claude plugin install <plugin>@<marketplace> --scope <scope>`.
- Codex: `codex plugin marketplace add ./`, then
  `codex plugin add <plugin>@<marketplace>`.
- Cursor: no shell install verb; copy a complete plugin to
  `~/.cursor/plugins/local/<plugin>`, then reload Cursor.
- Portable: no runtime or universal install location. The emitted Agent Plugin
  can be installed into a compatible host, including Cursor.
- Plugin: a multi-host distribution profile. Its document contains the exact
  Claude, Codex, and Cursor procedures.

The Claude and Codex target plans always emit their local marketplace
documents, because those documents are required for the public commands to work
against a built directory.

## Emitted surface

Every target root contains `INSTALL.md`. Commands use `./` and the real compiled
plugin and marketplace names, so a user runs them from that target root without
editing placeholders.

Cursor-compatible target roots (`cursor`, `portable`, and `plugin`) also contain
`install.mjs`. The script:

- resolves the user install root from `HOME`;
- copies through a sibling staging directory and atomically renames it;
- never invokes sudo or edits PATH;
- treats a byte-identical existing tree as an idempotent success;
- refuses an existing different version or different content;
- rejects symlinks and other unsupported filesystem entries in either tree;
- prints the installed or already-installed destination.

Both files are part of the artifact manifest and provenance table. Artifact
validation requires `INSTALL.md` for all five built-in targets and
`install.mjs` only for Cursor-compatible fallback targets.

## Built-in installer

`agent-bundle install <host> [--from <bundle-dir>] [--scope <scope>]` accepts
the real destination hosts `claude`, `codex`, and `cursor`.

- Claude and Codex validate the bundle's marketplace and plugin identity, check
  that the host executable exists, then execute the public CLI sequence without
  a shell.
- Cursor validates a Cursor Plugin manifest and performs the same safe copy as
  `install.mjs`; portable bundles use their emitted installer directly.
- `--from` accepts either a direct target root or an artifact root containing a
  matching target directory.
- Claude accepts `user`, `project`, and `local`; Codex and Cursor reject scopes
  their public contracts do not support.

Missing binaries, unsupported hosts/scopes, malformed bundles, unsafe trees,
and destination collisions fail as typed `DiagnosticError` diagnostics. Tests
inject a command runner and temporary home, so no real host binary is required.

## Verification

Unit tests cover exact generated documents and scripts for all targets, public
CLI argument delegation, missing-host diagnostics, Cursor copy/idempotency and
collision behavior, and artifact validation when an install surface is absent.
The landing bar is scoped tests, package build/typecheck, and lint.
